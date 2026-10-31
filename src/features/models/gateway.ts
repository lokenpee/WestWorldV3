import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import type { AssistantMessage, AssistantMessageEvent, Context, Usage } from '@earendil-works/pi-ai'
import type { Agent, AgentEvent, AgentMessage, AgentOptions, AgentTool, FinishTurn } from '@earendil-works/pi-agent-core'
import { abortableDelay, awaitWithSignal, classifyError, redact, retryable, retryDelay, summarizeUsage } from './policy'
import { loadProtocol } from './registry'
import { ModelError, type Attempt, type CallMode, type CallOptions, type CallResult, type DirectRequest, type ModelFailure, type ResolvedModel } from './types'

export interface GatewayEnvironment { fetch?: typeof fetch; now?: () => number; random?: () => number; wait?: typeof abortableDelay; beforeRequest?: () => Promise<void> }
export interface AgentInput {
  prompt: string; systemPrompt: string; finishTurn?: FinishTurn; tools?: AgentTool[]; messages?: AgentMessage[]; agent?: Agent
  beforeToolCall?: AgentOptions['beforeToolCall']; afterToolCall?: AgentOptions['afterToolCall']; prepareRequest?: AgentOptions['prepareRequest']
  onEvent?: (event: AgentEvent) => Promise<void>; onAgent?: (agent: Agent) => void; beforeRequest?: () => Promise<void>; validateFinal?: () => void
  recoverContext?: (context: Context, model: ResolvedModel['model']) => Promise<Context | undefined>
}
const textOf = (message: AssistantMessage) => message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })

// 调用与实际请求预算遵循 docs/decisions/model-connection.md。
class CallSession {
  readonly controller = new AbortController()
  readonly attempts: Attempt[] = []
  readonly started: number
  readonly now: () => number
  readonly maxRequests: number
  readonly timeoutMs: number
  private timer: ReturnType<typeof setTimeout>
  private externalAbort: () => void
  private turn = 0
  private status?: number
  private retryAfter?: string
  private transportFailure?: ModelError
  private client?: ReturnType<typeof createModels>
  readonly resolved: ResolvedModel
  readonly mode: CallMode
  readonly options: CallOptions
  readonly environment: GatewayEnvironment

  constructor(resolved: ResolvedModel, mode: CallMode, options: CallOptions, environment: GatewayEnvironment) {
    this.resolved = resolved; this.mode = mode; this.options = options; this.environment = environment
    this.now = environment.now ?? Date.now
    this.started = this.now()
    for (const value of [options.maxRequests, options.timeoutMs, options.maxTokens]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new ModelError('validation', '请求预算、超时及输出长度须为正整数。')
    if (options.temperature !== undefined && (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)) throw new ModelError('validation', '采样温度须为0到2之间的数字。')
    const ceiling = mode === 'agent' ? 6 : 3
    this.maxRequests = Math.min(options.maxRequests ?? ceiling, ceiling)
    this.timeoutMs = Math.min(options.timeoutMs ?? 180000, 180000)
    if (!Number.isSafeInteger(this.maxRequests) || this.maxRequests < 1 || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1))) throw new ModelError('validation', '请求预算、超时及输出长度须为正整数。')
    this.externalAbort = () => this.controller.abort(options.signal?.reason instanceof ModelError ? options.signal.reason : new ModelError('cancelled', '用户已取消本次调用。'))
    options.signal?.addEventListener('abort', this.externalAbort, { once: true })
    if (options.signal?.aborted) this.externalAbort()
    this.timer = setTimeout(() => this.controller.abort(new ModelError('network', '本次调用已超时。')), this.timeoutMs)
  }
  close() { clearTimeout(this.timer); this.options.signal?.removeEventListener('abort', this.externalAbort) }
  private ensureActive() {
    this.controller.signal.throwIfAborted()
    if (this.attempts.length >= this.maxRequests) throw new ModelError('validation', '已达到本次实际请求上限。')
    if (this.now() - this.started >= this.timeoutMs) throw new ModelError('network', '本次调用已超时。')
  }
  private async models() {
    if (this.client) return this.client
    const api = await awaitWithSignal(loadProtocol(this.resolved.snapshot.api), this.controller.signal)
    this.controller.signal.throwIfAborted()
    const client = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } })
    client.setProvider(createProvider({ id: this.resolved.snapshot.providerId, models: [this.resolved.model], api,
      auth: { apiKey: { name: '本地模型凭据', resolve: async () => ({ auth: { apiKey: this.resolved.apiKey } }) } },
    }))
    this.client = client
    return client
  }
  private transport: typeof fetch = async (input, init) => {
    try { this.ensureActive() } catch (error) { this.transportFailure = error instanceof ModelError ? error : new ModelError('cancelled', '本次调用已取消。'); throw error }
    await this.environment.beforeRequest?.()
    this.ensureActive()
    const attempt: Attempt = { ordinal: this.attempts.length + 1, turn: this.turn, elapsedMs: 0 }
    this.attempts.push(attempt)
    const start = this.now()
    this.options.onProgress?.({ state: 'requesting', attempts: this.attempts.length })
    try {
      const response = await (this.environment.fetch ?? globalThis.fetch)(input, init)
      this.status = response.status; attempt.status = response.status
      this.retryAfter = response.headers.get('retry-after') ?? undefined
      return response
    } finally { attempt.elapsedMs = this.now() - start }
  }
  async runTurn(context: Context): Promise<{ message: AssistantMessage; events: AssistantMessageEvent[] }> {
    this.turn++
    const client = await this.models()
    for (let retry = 0; ; retry++) {
      this.ensureActive()
      this.status = undefined; this.retryAfter = undefined; this.transportFailure = undefined
      const before = this.attempts.length
      const started = this.now()
      const stream = client.streamSimple(this.resolved.model, context, { signal: this.controller.signal, fetch: this.transport, maxRetries: 0, transport: 'sse', timeoutMs: Math.max(1, this.timeoutMs - (this.now() - this.started)), maxTokens: Math.min(this.options.maxTokens ?? 8192, this.resolved.model.maxTokens), ...(this.options.temperature === undefined ? {} : { temperature: this.options.temperature }) })
      const events: AssistantMessageEvent[] = []
      for await (const event of stream) events.push(event)
      const raw = await stream.result()
      const attempt = this.attempts.length > before ? this.attempts.at(-1) : undefined
      if (attempt) { attempt.usage = raw.usage; attempt.elapsedMs = this.now() - started }
      if (raw.stopReason !== 'error' && raw.stopReason !== 'aborted') return { message: raw, events }
      const failure = this.failure(this.transportFailure ?? (this.controller.signal.aborted ? this.controller.signal.reason : raw.errorMessage ?? ''), raw.stopReason)
      if (attempt) attempt.errorKind = failure.kind
      if (!retryable(failure.kind) || retry >= 2 || this.attempts.length >= this.maxRequests || !attempt || this.controller.signal.aborted) throw Object.assign(new ModelError(failure.kind, failure.message, failure.status), { stopReason: raw.stopReason })
      const delayMs = Math.min(retryDelay(retry, this.retryAfter, (this.environment.random ?? Math.random)()), Math.max(0, this.timeoutMs - (this.now() - this.started)))
      this.options.onProgress?.({ state: 'waiting', attempts: this.attempts.length, delayMs })
      await (this.environment.wait ?? abortableDelay)(delayMs, this.controller.signal)
    }
  }
  failure(error: unknown, stopReason?: string): ModelFailure {
    return { ...classifyError(error, [this.resolved.apiKey], this.status), ...(stopReason ? { stopReason } : {}) }
  }
  errorMessage(error: unknown): AssistantMessage {
    const failure = this.failure(this.controller.signal.aborted ? this.controller.signal.reason : error)
    return { role: 'assistant', content: [], api: this.resolved.model.api, provider: this.resolved.model.provider, model: this.resolved.model.id, usage: emptyUsage(), stopReason: failure.kind === 'cancelled' ? 'aborted' : 'error', errorMessage: failure.message, timestamp: this.now() }
  }
  result(message?: AssistantMessage, error?: unknown): CallResult {
    const failure = error === undefined ? undefined : this.failure(this.controller.signal.aborted ? this.controller.signal.reason : error, message?.stopReason ?? (error as { stopReason?: string })?.stopReason)
    const visible = message && { ...message, content: message.content.map(part => part.type === 'text' ? { ...part, text: redact(part.text, [this.resolved.apiKey]) } : part), ...(message.errorMessage ? { errorMessage: redact(message.errorMessage, [this.resolved.apiKey]) } : {}) }
    return { ok: !failure, mode: this.mode, snapshot: this.resolved.snapshot, text: visible ? textOf(visible) : '', elapsedMs: this.now() - this.started, attempts: [...this.attempts], usage: summarizeUsage(this.attempts, this.resolved.snapshot), ...(failure ? { error: failure } : {}), ...(visible ? { message: visible } : {}) }
  }
}

export async function executeDirect<T>(resolved: ResolvedModel, request: DirectRequest<T>, environment: GatewayEnvironment = {}): Promise<CallResult & { value?: T }> {
  const session = new CallSession(resolved, 'direct', request, environment)
  let context = request.context
  let last: AssistantMessage | undefined
  try {
    for (let repair = 0; ; repair++) {
      last = (await session.runTurn(context)).message
      try {
        if (request.validate ? !['stop', 'toolUse'].includes(last.stopReason) : last.stopReason !== 'stop' || !textOf(last).trim()) throw new ModelError('validation', last.stopReason === 'length' ? '模型回复达到输出长度上限。' : '模型未正常结束或返回了空文本。')
        const value = request.validate ? request.validate(last) : undefined
        return { ...session.result(last), ...(value === undefined ? {} : { value }) }
      } catch (error) {
        if (repair || !request.repairPrompt) throw error instanceof ModelError ? error : new ModelError('validation', '模型回复未通过结果校验。')
        const results = last.content.flatMap(part => part.type === 'toolCall' ? [{ role: 'toolResult' as const, toolCallId: part.id, toolName: part.name, content: [{ type: 'text' as const, text: '结果校验未通过，请按要求修正。' }], isError: true, timestamp: Date.now() }] : [])
        context = { ...context, messages: [...context.messages, last, ...results, { role: 'user', content: request.repairPrompt, timestamp: Date.now() }] }
      }
    }
  } catch (error) { return session.result(last, error) }
  finally { session.close() }
}

export async function executeAgent(resolved: ResolvedModel, options: CallOptions, environment: GatewayEnvironment = {}, input?: AgentInput): Promise<CallResult> {
  const reserve = Math.min(32768, Math.max(128, Math.floor(resolved.model.contextWindow / 4)))
  const session = new CallSession(resolved, 'agent', { ...options, maxTokens: Math.min(options.maxTokens ?? resolved.model.maxTokens ?? 8192, reserve) }, { ...environment, beforeRequest: input?.beforeRequest ?? environment.beforeRequest })
  let last: AssistantMessage | undefined
  try {
    if (!input) throw new ModelError('validation', '请提供智能体任务输入。')
    const { Agent } = await awaitWithSignal(import('@earendil-works/pi-agent-core'), session.controller.signal)
    let contextRecovered = false
    const streamFn: AgentOptions['streamFn'] = (_model, context) => {
        const output = new AssistantMessageEventStream()
        void (async () => {
          try {
            let turn
            try { turn = await session.runTurn(context) }
            catch (error) {
              if (classifyError(error).kind !== 'context_length' || contextRecovered || !input.recoverContext) throw error
              contextRecovered = true
              const recovered = await input.recoverContext(context, resolved.model)
              if (!recovered) throw error
              turn = await session.runTurn(recovered)
            }
            for (const event of turn.events) output.push(event); output.end(turn.message)
          }
          catch (error) { const message = session.errorMessage(error); output.push({ type: 'error', reason: message.stopReason === 'aborted' ? 'aborted' : 'error', error: message }); output.end(message) }
        })()
        return output
      }
    const agent = input.agent ?? new Agent({ initialState: { model: resolved.model, tools: input.tools ?? [], systemPrompt: input.systemPrompt, ...(input.messages?.length ? { messages: input.messages } : {}) }, toolExecution: 'sequential', streamFn,
      finishTurn: input.finishTurn,
      beforeToolCall: input.beforeToolCall, afterToolCall: input.afterToolCall, prepareRequest: input.prepareRequest,
    })
    agent.streamFunction = streamFn; agent.state.model = resolved.model; agent.state.tools = input.tools ?? []
    agent.finishTurn = input.finishTurn; agent.beforeToolCall = input.beforeToolCall; agent.prepareRequest = input.prepareRequest
    agent.afterToolCall = input.afterToolCall
    if (input.agent && input.messages) agent.state.messages = input.messages
    input.onAgent?.(agent)
    const unsubscribe = input.onEvent ? agent.subscribe(input.onEvent) : undefined
    const abort = () => agent.abort()
    session.controller.signal.addEventListener('abort', abort, { once: true })
    try { session.controller.signal.throwIfAborted(); await agent.prompt(input.prompt); await agent.waitForIdle() }
    finally { session.controller.signal.removeEventListener('abort', abort); unsubscribe?.() }
    last = agent.state.messages.findLast((message): message is AssistantMessage => message.role === 'assistant')
    if (!last) throw new ModelError('validation', '智能体未返回模型回复。')
    if (last.stopReason === 'error' || last.stopReason === 'aborted') throw session.controller.signal.aborted ? session.controller.signal.reason : new ModelError(last.stopReason === 'aborted' ? 'cancelled' : classifyError(last.errorMessage).kind, last.errorMessage ?? '智能体调用失败。')
    if (input.validateFinal) input.validateFinal()
    else if (last.stopReason !== 'stop' || !textOf(last).trim() || last.content.some(part => part.type === 'toolCall')) throw new ModelError('validation', '智能体基础回复未正常完成。')
    return session.result(last)
  } catch (error) { return session.result(last, error) }
  finally { session.close() }
}
