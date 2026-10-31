import type { createWorkspace } from '../../lib/storage/workspace'
import type { AgentInput, GatewayEnvironment } from './gateway'
import { createModelConfigStore } from './config'
import { abortableDelay, awaitWithSignal, classifyError, retryable, retryDelay, summarizeUsage } from './policy'
import { ModelError, type Attempt, type CallMode, type CallOptions, type CallResult, type CatalogResult, type DirectRequest, type ModelConnection, type ModelRole } from './types'
import type { ToolProbeOptions } from '../agents/probe'

export function createModelService(workspace: ReturnType<typeof createWorkspace>, environment: GatewayEnvironment = {}) {
  const settings = createModelConfigStore(workspace)
  const now = environment.now ?? Date.now
  async function invoke<T>(role: ModelRole, mode: 'direct' | 'agent', options: CallOptions, direct?: DirectRequest<T>, agentInput?: AgentInput): Promise<CallResult & { value?: T }> {
    const started = now()
    let key = ''
    const controller = new AbortController()
    const abort = () => controller.abort(new ModelError('cancelled', '用户已取消本次调用。'))
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort()
    const timeout = options.timeoutMs ?? 180000
    const timer = Number.isSafeInteger(timeout) && timeout > 0 ? setTimeout(() => controller.abort(new ModelError('network', '本次调用已超时。')), Math.min(timeout, 180000)) : undefined
    try {
      for (const value of [options.maxRequests, options.timeoutMs, options.maxTokens]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new ModelError('validation', '请求预算、超时及输出长度须为正整数。')
      controller.signal.throwIfAborted()
      options.onProgress?.({ state: 'preparing', attempts: 0 })
      const { config, apiKey } = await awaitWithSignal(settings.load(), controller.signal); key = apiKey
      const [{ resolveModel }, gateway] = await awaitWithSignal(Promise.all([import('./registry'), import('./gateway')]), controller.signal)
      const resolved = await awaitWithSignal(resolveModel(config, apiKey, role), controller.signal)
      controller.signal.throwIfAborted()
      const effective = { ...options, signal: controller.signal, timeoutMs: Math.max(1, Math.min(timeout, 180000) - (now() - started)) }
      const result = mode === 'agent' ? await gateway.executeAgent(resolved, effective, environment, agentInput) : await gateway.executeDirect(resolved, direct ? { ...direct, ...effective } : { ...effective, role, context: { messages: [{ role: 'user', content: '回复一个字：好', timestamp: now() }] } }, environment)
      return { ...result, elapsedMs: now() - started }
    } catch (error) {
      return { ok: false, mode, text: '', elapsedMs: now() - started, attempts: [], usage: summarizeUsage([]), error: classifyError(controller.signal.aborted ? controller.signal.reason : error, [key]) }
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) }
  }
  return {
    settings,
    agent(input: AgentInput, options: CallOptions = {}) { return invoke('aggregation', 'agent', options, undefined, input) },
    async probeTools(options: ToolProbeOptions = {}) {
      const { runToolProbe } = await import('../agents/probe')
      return runToolProbe((input, callOptions = {}) => invoke('aggregation', 'agent', callOptions, undefined, input), options)
    },
    probe(mode: 'direct' | 'agent', options: CallOptions = {}) { return invoke(mode === 'direct' ? 'extraction' : 'aggregation', mode, { ...options, maxRequests: 3, timeoutMs: Math.min(options.timeoutMs ?? 30000, 30000), maxTokens: 8 }, undefined, mode === 'agent' ? { prompt: '回复一个字：好', systemPrompt: '请简短回答用户的问题。', finishTurn: () => ({ action: 'end' }) } : undefined) },
    generate<T>(request: DirectRequest<T>) { return invoke(request.role, 'direct', request, request) },
    async catalog(options: CallOptions = {}): Promise<CatalogResult> {
      const mode: CallMode = 'catalog'
      const attempts: Attempt[] = []
      const started = now()
      const controller = new AbortController()
      const abort = () => controller.abort(new ModelError('cancelled', '用户已取消目录请求。'))
      options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort()
      const timer = setTimeout(() => controller.abort(new ModelError('network', '模型目录请求已超时。')), 30000)
      let key = ''
      let connection: ModelConnection | undefined
      try {
        const { config, apiKey } = await awaitWithSignal(settings.load(), controller.signal); key = apiKey
        connection = { providerId: config.providerId, api: config.api, baseUrl: config.baseUrl }
        controller.signal.throwIfAborted()
        if (!apiKey) throw new ModelError('auth', '请先保存当前服务商的密钥。')
        const path = config.api === 'anthropic-messages' && !config.baseUrl.endsWith('/v1') ? '/v1/models' : '/models'
        const headers: Record<string, string> = config.api === 'anthropic-messages' ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } : { Authorization: `Bearer ${apiKey}` }
        for (let retry = 0; ; retry++) {
          controller.signal.throwIfAborted()
          const attempt: Attempt = { ordinal: attempts.length + 1, turn: 1, elapsedMs: 0 }; attempts.push(attempt)
          const requestStarted = now()
          let retryAfter: string | undefined
          options.onProgress?.({ state: 'requesting', attempts: attempts.length })
          try {
            const response = await (environment.fetch ?? globalThis.fetch)(config.baseUrl + path, { headers, signal: controller.signal, redirect: 'error' })
            attempt.status = response.status; retryAfter = response.headers.get('retry-after') ?? undefined
            if (!response.ok) throw new ModelError(classifyError('', [key], response.status).kind, `模型目录返回 HTTP ${response.status}。`, response.status)
            let body: unknown
            try { body = await response.json() } catch { throw new ModelError('validation', '模型目录返回了无效的 JSON 数据。') }
            if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data) || !body.data.every(row => !!row && typeof row === 'object' && typeof row.id === 'string' && row.id.trim())) throw new ModelError('validation', '模型目录结构不正确。')
            attempt.elapsedMs = now() - requestStarted
            const modelIds = [...new Set(body.data.map(row => row.id as string))].sort()
            return { ok: true, mode, text: `发现 ${modelIds.length} 个模型。`, modelIds, connection, elapsedMs: now() - started, attempts, usage: summarizeUsage(attempts) }
          } catch (error) {
            attempt.elapsedMs = now() - requestStarted
            const failure = classifyError(controller.signal.aborted ? controller.signal.reason : error, [key], attempt.status)
            attempt.errorKind = failure.kind
            if (!retryable(failure.kind) || retry >= 2 || controller.signal.aborted) throw new ModelError(failure.kind, failure.message, failure.status)
            const delayMs = Math.min(retryDelay(retry, retryAfter, (environment.random ?? Math.random)()), Math.max(0, 30000 - (now() - started)))
            options.onProgress?.({ state: 'waiting', attempts: attempts.length, delayMs })
            await (environment.wait ?? abortableDelay)(delayMs, controller.signal)
          }
        }
      } catch (error) { return { ok: false, mode, text: '', modelIds: [], connection, elapsedMs: now() - started, attempts, usage: summarizeUsage(attempts), error: classifyError(controller.signal.aborted ? controller.signal.reason : error, [key]) } }
      finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) }
    },
  }
}
export type ModelService = ReturnType<typeof createModelService>
