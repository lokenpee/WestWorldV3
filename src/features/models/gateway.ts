import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import type { AssistantMessage, AssistantMessageEvent, Context, Usage } from '@earendil-works/pi-ai'
import type { Agent, AgentEvent, AgentMessage, AgentOptions, AgentTool, FinishTurn } from '@earendil-works/pi-agent-core'
import { abortableDelay, awaitWithSignal, classifyError, redact, retryable, retryDelay, summarizeUsage } from './policy'
import { loadProtocol } from './registry'
import { withContextDiscipline } from '../agents/output-discipline'
import { ModelError, type Attempt, type CallMode, type CallOptions, type CallResult, type DirectRequest, type ModelFailure, type ResolvedModel, type SkippedToolCall } from './types'

export interface GatewayEnvironment { fetch?: typeof fetch; now?: () => number; random?: () => number; wait?: typeof abortableDelay; beforeRequest?: () => Promise<void> }
export interface AgentInput {
  prompt: string; systemPrompt: string; finishTurn?: FinishTurn; tools?: AgentTool[]; getTools?: () => AgentTool[]; messages?: AgentMessage[]; agent?: Agent
  beforeToolCall?: AgentOptions['beforeToolCall']; afterToolCall?: AgentOptions['afterToolCall']; prepareRequest?: AgentOptions['prepareRequest']
  observeEvent?: (event: AgentEvent) => void; onEvent?: (event: AgentEvent) => Promise<void>; onAgent?: (agent: Agent) => void; beforeRequest?: () => Promise<void>; validateFinal?: () => void
  recoverContext?: (context: Context, model: ResolvedModel['model']) => Promise<Context | undefined>
}
const textOf = (message: AssistantMessage) => message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
const estimateTokens = (value: string) => { let weight = 0; for (const char of value) weight += /[㐀-鿿぀-ヿ가-힯]/u.test(char) ? 1.5 : char.codePointAt(0)! > 127 ? 1 : 0.25; return Math.ceil(weight) }
function recoverToolsAtOutputLimit(message: AssistantMessage, events: AssistantMessageEvent[]) {
  if (message.stopReason !== 'length') return { message, skippedTools: [] as SkippedToolCall[] }
  const argumentChunks = new Map<number, string[]>()
  for (const event of events) {
    if (event.type !== 'toolcall_delta') continue
    const chunks = argumentChunks.get(event.contentIndex) ?? []
    chunks.push(event.delta)
    argumentChunks.set(event.contentIndex, chunks)
  }
  const skippedTools: SkippedToolCall[] = []
  const content = message.content.flatMap<AssistantMessage['content'][number]>((part, contentIndex) => {
    if (part.type !== 'toolCall') return [part]
    // SDK 的 arguments 可能由半截 JSON 补齐。这里只接受原始流已完整给出的参数。
    try {
      const parsed = JSON.parse(argumentChunks.get(contentIndex)?.join('') ?? '')
      if (part.id && part.name && parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return [{ ...part, arguments: parsed }]
    } catch { /* 原始参数没有形成完整 JSON。 */ }
    skippedTools.push({ id: part.id, name: part.name, contentIndex, reason: '模型达到本次输出上限，工具参数未完整返回。' })
    return []
  })
  // 同轮有截断的操作时，先补齐漏项再确认任务。
  if (skippedTools.length) for (const [contentIndex, part] of message.content.entries())
    if (part.type === 'toolCall' && part.name === 'confirm' && !skippedTools.some((tool) => tool.contentIndex === contentIndex))
      skippedTools.push({ id: part.id, name: part.name, contentIndex, reason: '同轮还有工具参数未完整返回，待补齐后再确认。' })
  const retained = skippedTools.length ? content.filter((part) => part.type !== 'toolCall' || part.name !== 'confirm') : content
  return { message: { ...message, content: retained, stopReason: retained.some((part) => part.type === 'toolCall') ? 'toolUse' as const : 'length' as const }, skippedTools }
}

const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })

// 保留服务商原生协议，仅把随轮次变化的消息数组放到请求体末尾。
function messagesLast(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  const { messages, input, ...fixed } = payload as Record<string,unknown>
  return { ...fixed, ...(messages !== undefined ? {messages} : {}), ...(input !== undefined ? {input} : {}) }
}

// 调用与实际请求预算遵循 docs/decisions/model-connection.md。
class CallSession {
  readonly controller = new AbortController()
  readonly attempts: Attempt[] = []
  readonly started: number
  readonly now: () => number
  readonly maxRequests: number
  readonly timeoutMs: number
  private timer?: ReturnType<typeof setTimeout>
  private externalAbort: () => void
  private turn = 0
  private status?: number
  private retryAfter?: string
  private transportFailure?: ModelError
  private requestId?: string
  private client?: ReturnType<typeof createModels>
  readonly resolved: ResolvedModel
  readonly mode: CallMode
  readonly options: CallOptions
  readonly environment: GatewayEnvironment

  constructor(resolved: ResolvedModel, mode: CallMode, options: CallOptions, environment: GatewayEnvironment) {
    this.resolved = resolved; this.mode = mode; this.options = options; this.environment = environment
    this.now = environment.now ?? Date.now
    this.started = this.now()
    for (const value of [options.maxRequests, options.timeoutMs, options.requestTimeoutMs, options.maxTokens]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new ModelError('validation', '请求预算、超时及输出长度须为正整数。')
    if (options.temperature !== undefined && (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)) throw new ModelError('validation', '采样温度须为0到2之间的数字。')
    const ceiling = mode === 'agent' ? options.cooperativeTimeout ? 20 : 6 : 3
    this.maxRequests = options.unboundedRequests ? options.maxRequests ?? 1_000_000 : Math.min(options.maxRequests ?? ceiling, ceiling)
    this.timeoutMs = Math.min(options.timeoutMs ?? 180000, options.cooperativeTimeout ? 300000 : 180000)
    if (!Number.isSafeInteger(this.maxRequests) || this.maxRequests < 1 || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1))) throw new ModelError('validation', '请求预算、超时及输出长度须为正整数。')
    this.externalAbort = () => this.controller.abort(options.signal?.reason instanceof ModelError ? options.signal.reason : new ModelError('cancelled', '用户已取消本次调用。'))
    options.signal?.addEventListener('abort', this.externalAbort, { once: true })
    if (options.signal?.aborted) this.externalAbort()
    if (!options.cooperativeTimeout) this.timer = setTimeout(() => this.controller.abort(new ModelError('network', '本次调用已超时。')), this.timeoutMs)
  }
  close() { clearTimeout(this.timer); this.options.signal?.removeEventListener('abort', this.externalAbort) }
  lastRequestId() { return this.requestId }
  private ensureActive() {
    this.controller.signal.throwIfAborted()
    if (this.attempts.length >= this.maxRequests) throw new ModelError(this.mode === 'agent' ? 'budget' : 'validation', this.mode === 'agent' ? 'BUDGET:已达到本子任务实际请求上限。' : '已达到本次实际请求上限。')
    if (!this.options.cooperativeTimeout && this.now() - this.started >= this.timeoutMs) throw new ModelError('network', '本次调用已超时。')
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
    await this.options.beforeRequest?.()
    await this.environment.beforeRequest?.()
    this.ensureActive()
    const start = this.now()
    const attempt: Attempt = { ordinal: this.attempts.length + 1, turn: this.turn, elapsedMs: 0, requestId: this.requestId, attemptId: crypto.randomUUID(), startedAt: new Date(start).toISOString() }
    this.attempts.push(attempt)
    this.options.onProgress?.({ state: 'requesting', attempts: this.attempts.length })
    try {
      if (this.options.trace?.request && this.requestId) {
        try {
          const body = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : undefined
          if (body) this.options.trace.request({ requestId: this.requestId, attemptId: attempt.attemptId!, rawBody: body, body: JSON.parse(body) as Record<string, unknown> })
        } catch { /* 观测失败不改变请求或阻断调用 */ }
      }
      const response = await (this.environment.fetch ?? globalThis.fetch)(input, init)
      this.status = response.status; attempt.status = response.status
      this.retryAfter = response.headers.get('retry-after') ?? undefined
      return response
    } finally { attempt.elapsedMs = this.now() - start; attempt.finishedAt = attempt.finishedAt ?? new Date(this.now()).toISOString() }
  }
  async runTurn(context: Context, traceOptions: { parentRequestId?: string; purpose?: 'work' | 'compaction' | 'repair' } = {}): Promise<{ message: AssistantMessage; events: AssistantMessageEvent[]; requestId: string; skippedTools?: SkippedToolCall[] }> {
    context = withContextDiscipline(context)
    this.turn++
    this.requestId = crypto.randomUUID()
    const requestId = this.requestId
    const requestedReasoning = this.options.reasoning
    const reasoning = typeof requestedReasoning === 'function' ? requestedReasoning() : requestedReasoning
    const attemptsBefore = this.attempts.length
    const trace = this.options.trace
    try { trace?.start({ requestId, ...(traceOptions.parentRequestId ? { parentRequestId: traceOptions.parentRequestId } : {}), purpose: traceOptions.purpose ?? this.options.tracePurpose ?? 'work', model: { providerId: this.resolved.snapshot.providerId, modelId: this.resolved.snapshot.modelId }, context, turn: this.turn, startedAt: new Date(this.now()).toISOString() }) } catch { /* 观测失败不影响模型调用 */ }
    const traceEnd = (value: { message?: AssistantMessage; usage?: Usage; status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted'; error?: ReturnType<CallSession['failure']>; skippedTools?: SkippedToolCall[] }) => { try { trace?.modelEnd({ requestId, attempts: this.attempts.slice(attemptsBefore), ...value }) } catch { /* 观测失败不影响模型调用 */ } }
    let client: Awaited<ReturnType<CallSession['models']>>
    try { client = await this.models() } catch (error) { traceEnd({ status: this.controller.signal.aborted ? 'cancelled' : 'failed', error: this.failure(this.controller.signal.aborted ? this.controller.signal.reason : error) }); throw error }
    try {
      for (let retry = 0; ; retry++) {
        this.ensureActive()
        this.status = undefined; this.retryAfter = undefined; this.transportFailure = undefined
        const before = this.attempts.length
        const started = this.now()
        const stream = client.streamSimple(this.resolved.model, context, { signal: this.controller.signal, fetch: this.transport, ...(this.options.messagesLast ? {onPayload: messagesLast} : {}), maxRetries: 0, transport: 'sse', timeoutMs: Math.max(1, Math.min(this.options.requestTimeoutMs ?? 180000, this.options.cooperativeTimeout ? Infinity : this.timeoutMs - (this.now() - this.started))), maxTokens: Math.min(this.options.maxTokens ?? 8192, this.resolved.model.maxTokens), ...(this.options.temperature === undefined ? {} : { temperature: this.options.temperature }), ...(this.resolved.model.reasoning && reasoning ? { reasoning } : {}) })
        const events: AssistantMessageEvent[] = []
        for await (const event of stream) { events.push(event); try { trace?.delta?.({ requestId, event }) } catch { /* 观测失败不影响模型调用 */ } }
        const raw = await stream.result()
        const attempt = this.attempts.length > before ? this.attempts.at(-1) : undefined
        if (attempt) { attempt.usage = raw.usage; attempt.elapsedMs = this.now() - started; attempt.finishedAt = new Date(this.now()).toISOString(); attempt.estimatedInput = estimateTokens(JSON.stringify(context)); attempt.outputReserve = Math.min(this.options.maxTokens ?? 8192, this.resolved.model.maxTokens) }
        if (raw.stopReason !== 'error' && raw.stopReason !== 'aborted') {
          const recovered = this.options.useModelToolOutput ? recoverToolsAtOutputLimit(raw, events) : { message: raw, skippedTools: [] }
          traceEnd({ message: raw, usage: raw.usage, status: 'succeeded', skippedTools: recovered.skippedTools })
          const skipped = new Set(recovered.skippedTools.map((tool) => tool.contentIndex))
          return {
            message: recovered.message,
            events: skipped.size ? events.filter((event) => !('contentIndex' in event && event.type.startsWith('toolcall_') && skipped.has(event.contentIndex))) : events,
            requestId,
            skippedTools: recovered.skippedTools,
          }
        }
        const failure = this.failure(this.transportFailure ?? (this.controller.signal.aborted ? this.controller.signal.reason : raw.errorMessage ?? ''), raw.stopReason)
        if (attempt) attempt.errorKind = failure.kind
        if (!retryable(failure.kind) || retry >= 2 || this.attempts.length >= this.maxRequests || !attempt || this.controller.signal.aborted) {
          traceEnd({ message: raw, usage: raw.usage, status: this.controller.signal.aborted ? 'cancelled' : 'failed', error: failure })
          throw Object.assign(new ModelError(failure.kind, failure.message, failure.status), { stopReason: raw.stopReason })
        }
        const delayMs = Math.min(retryDelay(retry, this.retryAfter, (this.environment.random ?? Math.random)()), Math.max(0, this.timeoutMs - (this.now() - this.started)))
        this.options.onProgress?.({ state: 'waiting', attempts: this.attempts.length, delayMs })
        await (this.environment.wait ?? abortableDelay)(delayMs, this.controller.signal)
      }
    } catch (error) {
      if (error instanceof ModelError && (error as ModelError & { stopReason?: string }).stopReason === undefined) traceEnd({ status: this.controller.signal.aborted ? 'cancelled' : 'failed', error: this.failure(this.controller.signal.aborted ? this.controller.signal.reason : error) })
      throw error
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
  let parentRequestId: string | undefined
  try {
    for (let repair = 0; ; repair++) {
      const turn = await session.runTurn(context, { ...(parentRequestId ? { parentRequestId } : {}), ...(repair ? { purpose: 'repair' as const } : {}) })
      parentRequestId ??= turn.requestId
      last = turn.message
      try {
        if (request.validate ? !['stop', 'toolUse'].includes(last.stopReason) : last.stopReason !== 'stop' || !textOf(last).trim()) throw new ModelError('validation', last.stopReason === 'length' ? '模型回复达到输出长度上限。' : '模型未正常结束或返回了空文本。')
        const value = request.validate ? request.validate(last) : undefined
        return { ...session.result(last), ...(value === undefined ? {} : { value }) }
      } catch (error) {
        if (repair >= Math.min(2, request.repairAttempts ?? 1) || !request.repairPrompt) throw error instanceof ModelError ? error : new ModelError('validation', '模型回复未通过结果校验。')
        const detail = error instanceof Error ? error.message : '结果校验未通过。'
        const results = last.content.flatMap(part => part.type === 'toolCall' ? [{ role: 'toolResult' as const, toolCallId: part.id, toolName: part.name, content: [{ type: 'text' as const, text: `结果校验未通过：${detail}` }], isError: true, timestamp: Date.now() }] : [])
        context = { ...context, messages: [...context.messages, last, ...results, { role: 'user', content: `${request.repairPrompt}\n实际错误：${detail}`, timestamp: Date.now() }] }
      }
    }
  } catch (error) { return session.result(last, error) }
  finally { session.close() }
}

export async function executeAgent(resolved: ResolvedModel, options: CallOptions, environment: GatewayEnvironment = {}, input?: AgentInput): Promise<CallResult> {
  const reserve = Math.min(32768, Math.max(128, Math.floor(resolved.model.contextWindow / 4)))
  const maxTokens = options.useModelToolOutput
    ? Math.min(options.maxTokens ?? resolved.model.maxTokens, resolved.model.maxTokens, resolved.model.contextWindow)
    : Math.min(options.maxTokens ?? resolved.model.maxTokens ?? 8192, reserve)
  const session = new CallSession(resolved, 'agent', { ...options, maxTokens }, { ...environment, beforeRequest: input?.beforeRequest ?? environment.beforeRequest })
  let last: AssistantMessage | undefined
  try {
    if (!input) throw new ModelError('validation', '请提供智能体任务输入。')
    const { Agent } = await awaitWithSignal(import('@earendil-works/pi-agent-core'), session.controller.signal)
    let contextRecovered = false
    let skippedTools: SkippedToolCall[] = []
    const streamFn: AgentOptions['streamFn'] = (_model, context) => {
        const currentTools = input.getTools?.() ?? input.tools ?? []
        const turnContext = currentTools.length ? { ...context, tools: currentTools } : context
        const output = new AssistantMessageEventStream()
        void (async () => {
          try {
            let turn
            let firstRequestId: string | undefined
            try { turn = await session.runTurn(turnContext); firstRequestId = turn.requestId }
            catch (error) {
              if (classifyError(error).kind !== 'context_length' || contextRecovered || !input.recoverContext) throw error
              contextRecovered = true
              const recovered = await input.recoverContext(turnContext, resolved.model)
              if (!recovered) throw error
              const recoveredContext = currentTools.length ? { ...recovered, tools: currentTools } : recovered
              turn = await session.runTurn(recoveredContext, { ...(firstRequestId ?? session.lastRequestId() ? { parentRequestId: firstRequestId ?? session.lastRequestId() } : {}), purpose: 'repair' })
            }
            skippedTools = turn.skippedTools ?? []
            for (const event of turn.events) {
              // done 本身会锁定流的最终结果，必须携带同一份已恢复的消息。
              output.push(event.type === 'done'
                ? { ...event, message: turn.message, reason: turn.message.stopReason === 'toolUse' ? 'toolUse' : event.reason }
                : event)
            }
            output.end(turn.message)
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
    agent.finishTurn = (turn, signal) => {
      if (skippedTools.length && !signal?.aborted) {
        const names = [...new Set(skippedTools.map((tool) => tool.name || tool.id || '未收到名称的工具'))]
        skippedTools = []
        agent.steer({
          role: 'user',
          content: '上一轮参数截断，以下调用未执行：' + names.join('、') +
            '。核对已执行结果，只重新发送尚未完成的调用及完整参数。',
          timestamp: environment.now?.() ?? Date.now(),
        })
        return { action: 'continue' }
      }
      return input.finishTurn?.(turn, signal)
    }; agent.beforeToolCall = input.beforeToolCall; agent.prepareRequest = input.prepareRequest
    agent.afterToolCall = input.afterToolCall
    if (input.agent && input.messages) agent.state.messages = input.messages
    input.onAgent?.(agent)
    let eventTail = Promise.resolve()
    let eventFailure: unknown
    const unsubscribe = input.onEvent || input.observeEvent ? agent.subscribe(event => {
      // 运行观测以事件到达顺序关联请求，持久业务日志可以异步排队。
      try { input.observeEvent?.(event) } catch { /* 观测失败不影响模型调用 */ }
      if (input.onEvent) eventTail = eventTail.then(() => input.onEvent!(event)).catch(error => { eventFailure = error; agent.abort() })
    }) : undefined
    const abort = () => agent.abort()
    session.controller.signal.addEventListener('abort', abort, { once: true })
    try { session.controller.signal.throwIfAborted(); await agent.prompt(input.prompt); await agent.waitForIdle(); await eventTail; if (eventFailure) throw eventFailure }
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
