import { ModelError, type Attempt, type ErrorKind, type ModelFailure, type UsageSummary, type ModelSnapshot } from './types'

export function redact(text: string, secrets: string[] = []) {
  let value = text
  for (const secret of secrets.filter(Boolean)) for (const version of new Set([secret, encodeURIComponent(secret)])) value = value.split(version).join('[已隐藏]')
  return value.replace(/\bBearer\s+[^\s,"'}]+/gi, 'Bearer [已隐藏]')
}
export function classifyError(error: unknown, secrets: string[] = [], status?: number): ModelFailure {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  let kind: ErrorKind = error instanceof ModelError ? error.kind : 'unknown'
  const lower = text.toLowerCase()
  if (!(error instanceof ModelError)) {
    if (/budget:|实际请求上限|请求预算已用完/i.test(text)) kind = 'budget'
    else if (error instanceof DOMException && error.name === 'AbortError') kind = 'cancelled'
    else if (status === 401 || status === 403 || /401|403|auth|invalid.?key|api key/.test(lower)) kind = 'auth'
    else if (status === 429 || /429|rate.?limit|quota/.test(lower)) kind = 'rate_limit'
    else if ((status !== undefined && status >= 500) || /\b5\d\d\b|internal|bad gateway|unavailable/.test(lower)) kind = 'server'
    else if (/context.?length|context window|too many tokens|maximum.*tokens/.test(lower)) kind = 'context_length'
    else if (/content.?policy|content.?filter|safety|blocked/.test(lower)) kind = 'content_policy'
    else if (!lower || /network|fetch|timeout|timed out|econnreset|connection error|failed to load/.test(lower)) kind = 'network'
  }
  const labels: Record<ErrorKind, string> = { network: '网络请求失败，请检查网络与服务跨域设置。', rate_limit: '服务请求受限。', server: '服务暂时不可用。', auth: '鉴权失败，请检查当前服务商密钥。', context_length: '输入超过模型上下文容量。', content_policy: '服务拒绝了本次内容。', validation: '调用校验失败。', budget: '本子任务请求预算已用完。', cancelled: '已取消。', unsupported_provider: '当前服务或协议不受支持。', unsupported_capability: '模型缺少所需能力。', unknown: '模型调用失败。' }
  const detail = redact(text, secrets).slice(0, 1200)
  return { kind, message: detail.startsWith(labels[kind]) ? detail : `${labels[kind]}${detail ? ` ${detail}` : ''}`, ...(status === undefined ? {} : { status }) }
}
export const retryable = (kind: ErrorKind) => ['network', 'server', 'rate_limit'].includes(kind)
export function retryDelay(index: number, retryAfter?: string, random = Math.random()) {
  const requested = retryAfter && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) * 1000 : undefined
  return requested !== undefined && Number.isSafeInteger(requested) ? requested : Math.round(1000 * 2 ** index * (0.5 + random))
}
export function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}
export function awaitWithSignal<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    pending.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
export function summarizeUsage(attempts: Attempt[], snapshot?: ModelSnapshot): UsageSummary {
  const sum: UsageSummary = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costStatus: snapshot?.pricingStatus ?? 'unknown' }
  const valid = (value: number) => Number.isFinite(value) && value >= 0 ? value : 0
  let cost = 0
  for (const attempt of attempts) if (attempt.usage) {
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) sum[field] += valid(attempt.usage[field])
    cost += valid(attempt.usage.cost.input) + valid(attempt.usage.cost.output)
  }
  if (snapshot?.pricingStatus === 'estimated' && sum.totalTokens > 0) { sum.cost = cost; sum.currency = snapshot.pricingCurrency }
  else sum.costStatus = 'unknown'
  return sum
}
