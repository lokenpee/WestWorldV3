import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createModelService } from '../src/features/models/service'
import { defaultConfig, ModelError, type ModelConfig } from '../src/features/models/types'
import { abortableDelay, classifyError, redact, retryDelay } from '../src/features/models/policy'
import type { GatewayEnvironment } from '../src/features/models/gateway'
import { Type } from 'typebox'
import { anthropicBody, responsesBody } from './support/model-streams'

const opened: ReturnType<typeof createWorkspace>[] = []
const savedConfig: ModelConfig = { ...defaultConfig, providerId: 'custom', baseUrl: 'https://models.example/v1', extractionModel: 'saved-extraction', aggregationModel: 'saved-aggregation' }
const key = 'fixture-key-do-not-display'
async function setup(fetcher: typeof fetch, extra: GatewayEnvironment = {}) {
  const id = crypto.randomUUID()
  const workspace = createWorkspace({ settingsName: `models-${id}`, bookPrefix: `models-book-${id}-` }); opened.push(workspace)
  const service = createModelService(workspace, { fetch: fetcher, wait: async (_ms, signal) => signal.throwIfAborted(), random: () => 0.5, ...extra })
  await service.settings.save(savedConfig, key)
  return { workspace, service }
}
function stream(text = '好', tool?: { arguments: string }) {
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'submit_result', arguments: tool.arguments } }] } : { role: 'assistant', content: text }
  const chunk = (delta: object, finish: string | null, usage?: object) => ({ id: 'completion', object: 'chat.completion.chunk', created: 1, model: 'saved-extraction', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })
  const chunks = [chunk(delta, null), chunk({}, tool ? 'tool_calls' : 'stop'), { ...chunk({}, null, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }), choices: [] }]
  return new Response(chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
}
function httpError(status: number, text = 'temporary failure', headers: HeadersInit = {}) { return new Response(JSON.stringify({ error: { message: text } }), { status, headers: { 'Content-Type': 'application/json', ...headers } }) }
afterEach(async () => {
  vi.restoreAllMocks()
  for (const workspace of opened.splice(0)) { workspace.close(); for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name) }
})

describe('模型配置与统一调用', () => {
  it('先保存服务连接即可拉取模型，按角色选择后再生成', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ data: [{ id: 'selected-model' }] })).mockResolvedValueOnce(stream())
    const { service } = await setup(fetcher)
    await service.settings.saveDraft({ ...savedConfig, extractionModel: '', aggregationModel: '' }, key)
    expect(await service.settings.read()).toMatchObject({ config: { extractionModel: '', aggregationModel: '' }, configured: true })
    expect(await service.catalog()).toMatchObject({ ok: true, modelIds: ['selected-model'], connection: { providerId: 'custom', baseUrl: savedConfig.baseUrl, api: savedConfig.api } })
    expect(await service.probe('direct')).toMatchObject({ ok: false, attempts: [], error: { kind: 'validation', message: expect.stringContaining('先选择提取模型') } })
    expect(fetcher).toHaveBeenCalledOnce()
    await expect(service.settings.save({ ...savedConfig, extractionModel: '', aggregationModel: '' })).rejects.toMatchObject({ kind: 'validation' })
    await service.settings.saveDraft({ ...savedConfig, extractionModel: 'selected-model', aggregationModel: '' })
    expect(await service.probe('direct')).toMatchObject({ ok: true, snapshot: { modelId: 'selected-model' } })
    expect(await service.probe('agent')).toMatchObject({ ok: false, attempts: [], error: { kind: 'validation', message: expect.stringContaining('先选择整理模型') } })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('凭据状态按当前选择的服务商读取，切换保留各自已存密钥', async () => {
    const { service } = await setup(vi.fn())
    expect(await service.settings.isCredentialConfigured('custom')).toBe(true)
    expect(await service.settings.isCredentialConfigured('another')).toBe(false)
    await service.settings.saveDraft({ ...savedConfig, providerId: 'another', extractionModel: '', aggregationModel: '' }, 'another-fixture')
    expect(await service.settings.isCredentialConfigured('custom')).toBe(true)
    expect(await service.settings.isCredentialConfigured('another')).toBe(true)
    await service.settings.clearCredential('another')
    expect(await service.settings.isCredentialConfigured('custom')).toBe(true)
    expect(await service.settings.isCredentialConfigured('another')).toBe(false)
  })

  it('配置和服务商凭据持久保存，空白密钥保留原值，清除只作用目标服务商', async () => {
    const { service, workspace } = await setup(vi.fn())
    expect(await service.settings.read()).toEqual({ config: savedConfig, configured: true })
    expect(JSON.stringify(await service.settings.read())).not.toContain(key)
    await service.settings.save({ ...savedConfig, extractionModel: ' updated ' }, '  ')
    expect((await service.settings.load()).apiKey).toBe(key)
    await service.settings.save({ ...savedConfig, providerId: 'another' }, 'another-fixture')
    await service.settings.clearCredential('another')
    expect((await service.settings.read()).configured).toBe(false)
    expect((await workspace.settings.table('credentials').get('custom')).key).toBe(key)
    for (const aggregationContextWindow of [NaN, Infinity, 8191, 8192.5]) await expect(service.settings.save({ ...savedConfig, aggregationContextWindow })).rejects.toMatchObject({ kind: 'validation' })
    await expect(service.settings.save({ ...savedConfig, baseUrl: 'https://user:password@example.com' })).rejects.toMatchObject({ kind: 'validation' })
    await expect(service.settings.save({ ...savedConfig, api: 'unknown-api' as ModelConfig['api'] })).rejects.toMatchObject({ kind: 'unsupported_provider' })
  })

  it('通过真实Pi适配器使用保存的模型、地址和密钥，未知价格明确标记，回复内容完整', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(stream('好'.repeat(1600)))
    const { service, workspace } = await setup(fetcher)
    const result = await service.probe('direct')
    expect(result.ok).toBe(true)
    expect(result.text).toHaveLength(1600)
    expect(result.snapshot).toMatchObject({ modelId: 'saved-extraction', providerId: 'custom', metadataStatus: 'estimated', pricingStatus: 'unknown', credentialRef: 'custom' })
    expect(result.usage).toMatchObject({ input: 2, output: 3, totalTokens: 5, costStatus: 'unknown' })
    expect(result.usage).not.toHaveProperty('cost')
    expect(fetcher).toHaveBeenCalledOnce()
    const [input, init] = fetcher.mock.calls[0]
    expect(String(input)).toBe('https://models.example/v1/chat/completions')
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${key}`)
    const body = JSON.parse(init?.body as string)
    expect(body.model).toBe('saved-extraction')
    expect(body.max_completion_tokens ?? body.max_tokens).toBe(8)
    expect(JSON.stringify(result)).not.toContain(key)
    expect(await workspace.settings.books.count()).toBe(0)
    expect((await Dexie.getDatabaseNames()).some(name => name.startsWith(workspace.scope.bookPrefix))).toBe(false)
  })

  it('运行中修改配置与凭据，当前请求保持快照，下次请求读取新值', async () => {
    let release: (response: Response) => void = () => undefined
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve })).mockResolvedValueOnce(stream())
    const { service } = await setup(fetcher)
    const current = service.probe('direct')
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    await service.settings.save({ ...savedConfig, extractionModel: 'next-model' }, 'next-key')
    release(stream())
    expect((await current).snapshot?.modelId).toBe('saved-extraction')
    expect((await service.probe('direct')).snapshot?.modelId).toBe('next-model')
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('authorization')).toBe(`Bearer ${key}`)
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get('authorization')).toBe('Bearer next-key')
  })

  it('鉴权错误仅一次请求，服务返回的密钥在所有诊断中脱敏', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => httpError(401, `invalid key ${key}`))
    const { service } = await setup(fetcher)
    const result = await service.probe('direct')
    expect(result).toMatchObject({ ok: false, error: { kind: 'auth', status: 401 } })
    expect(result.attempts).toHaveLength(1)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(JSON.stringify(result)).not.toContain(key)
  })

  it('服务故障总共三次实际请求，Pi内部重试关闭', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => httpError(503))
    const { service } = await setup(fetcher)
    const result = await service.probe('direct')
    expect(result).toMatchObject({ ok: false, error: { kind: 'server' } })
    expect(result.attempts.map(row => row.ordinal)).toEqual([1, 2, 3])
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetcher.mock.calls.every(([, init]) => new Headers(init?.headers).get('x-stainless-retry-count') === '0')).toBe(true)
  })

  it('限流读取整数Retry-After，重发成功后保留全部请求统计', async () => {
    const wait = vi.fn(async (_ms: number, signal: AbortSignal) => signal.throwIfAborted())
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(httpError(429, 'rate limit', { 'Retry-After': '7' })).mockResolvedValueOnce(stream())
    const { service } = await setup(fetcher, { wait })
    const result = await service.probe('direct')
    expect(result.ok).toBe(true)
    expect(wait.mock.calls[0][0]).toBe(7000)
    expect(result.attempts.map(row => row.errorKind)).toEqual(['rate_limit', undefined])
    expect(result.attempts).toHaveLength(2)
  })

  it('空文本响应判为失败，不触发网络重试；缺少凭据时不发请求', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(stream(''))
    const { service } = await setup(fetcher)
    expect(await service.probe('direct')).toMatchObject({ ok: false, error: { kind: 'validation' } })
    expect(fetcher).toHaveBeenCalledOnce()
    await service.settings.clearCredential('custom')
    expect(await service.probe('direct')).toMatchObject({ ok: false, attempts: [], error: { kind: 'auth' } })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('取消退避立即结束，取消后不再发送请求', async () => {
    const controller = new AbortController()
    const waiting = vi.fn(abortableDelay)
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => httpError(429, 'rate limit', { 'Retry-After': '60' }))
    const { service } = await setup(fetcher, { wait: waiting })
    const pending = service.probe('direct', { signal: controller.signal })
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledOnce())
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'cancelled' } })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('取消在途请求，随后可发起新的独立测试', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce((_input, init) => new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }) })).mockResolvedValueOnce(stream())
    const { service } = await setup(fetcher)
    const controller = new AbortController()
    const pending = service.probe('direct', { signal: controller.signal })
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'cancelled' } })
    expect((await service.probe('direct')).ok).toBe(true)
  })

  it('网络重发和结果修正共用三次额度，修正请求保留原回复', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(httpError(500)).mockResolvedValueOnce(stream('bad json')).mockResolvedValueOnce(stream('{"ok":true}'))
    const { service } = await setup(fetcher)
    const result = await service.generate({ role: 'extraction', context: { messages: [{ role: 'user', content: '请返回JSON', timestamp: 1 }] }, validate: message => { const text = message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join(''); const value = JSON.parse(text); if (value.ok !== true) throw new Error('invalid'); return value }, repairPrompt: '请修正为有效JSON' })
    expect(result).toMatchObject({ ok: true, value: { ok: true } })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(result.usage.totalTokens).toBe(10)
    const repaired = JSON.parse(fetcher.mock.calls[2][1]?.body as string)
    expect(repaired.messages.some((row: { role: string; content: string }) => row.role === 'assistant' && row.content === 'bad json')).toBe(true)
  })

  it('额度耗尽后不补发修正，且每次调用最多修正一次', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(httpError(500)).mockResolvedValueOnce(httpError(503)).mockResolvedValueOnce(stream('bad')).mockResolvedValueOnce(stream('bad')).mockResolvedValueOnce(stream('bad'))
    const { service } = await setup(fetcher)
    const request = { role: 'extraction' as const, context: { messages: [{ role: 'user' as const, content: 'JSON', timestamp: 1 }] }, validate: () => { throw new Error('invalid') }, repairPrompt: '修正' }
    expect(await service.generate(request)).toMatchObject({ ok: false, error: { kind: 'validation', message: expect.stringContaining('已达到本次实际请求上限') } })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(await service.generate(request)).toMatchObject({ ok: false, error: { kind: 'validation' } })
    expect(fetcher).toHaveBeenCalledTimes(5)
  })

  it('Agent基础调用复用整理模型、凭据与实际请求边界', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(stream())
    const { service } = await setup(fetcher)
    const result = await service.probe('agent')
    expect(result).toMatchObject({ ok: true, mode: 'agent', text: '好', snapshot: { modelId: 'saved-aggregation', modelRole: 'aggregation' } })
    expect(result.attempts).toHaveLength(1)
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string).model).toBe('saved-aggregation')
  })

  it('共享Agent入口使用调用者任务输入，默认由Pi在工具结果后继续运行', async () => {
    const { executeAgent } = await import('../src/features/models/gateway')
    const { resolveModel } = await import('../src/features/models/registry')
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(stream('', { arguments: '{"ok":true}' })).mockResolvedValueOnce(stream('任务回复'))
    const resolved = await resolveModel(savedConfig, key, 'aggregation')
    const result = await executeAgent(resolved, { maxRequests: 3, maxTokens: 128 }, { fetch: fetcher }, { prompt: '请执行调用者的任务', systemPrompt: '使用当前任务要求。' })
    expect(result).toMatchObject({ ok: true, text: '任务回复' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    const first = JSON.parse(fetcher.mock.calls[0][1]?.body as string)
    expect(first.messages.some((message: { role: string; content: string | { type: string; text?: string }[] }) => message.role === 'user' && (typeof message.content === 'string' ? message.content : message.content.map(part => part.text ?? '').join('')) === '请执行调用者的任务')).toBe(true)
    const continued = JSON.parse(fetcher.mock.calls[1][1]?.body as string)
    expect(continued.messages.some((message: { role: string; tool_call_id?: string }) => message.role === 'tool' && message.tool_call_id === 'call-1')).toBe(true)
  })

  it('Agent基础调用失败同样受三次探测预算约束', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => httpError(503))
    const { service } = await setup(fetcher)
    expect(await service.probe('agent')).toMatchObject({ ok: false, mode: 'agent', error: { kind: 'server' } })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('目录发现读取保存配置并返回编号，目录响应不被当作生成测试', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ data: [{ id: 'z-model' }, { id: 'a-model' }, { id: 'z-model' }] }))
    const { service } = await setup(fetcher)
    expect(await service.catalog()).toMatchObject({ ok: true, mode: 'catalog', modelIds: ['a-model', 'z-model'] })
    expect(String(fetcher.mock.calls[0][0])).toBe('https://models.example/v1/models')
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('authorization')).toBe(`Bearer ${key}`)
  })

  it('结构化直接调用修正时配对工具结果，结构确认由调用者校验', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(stream('', { arguments: '{"ok":false}' })).mockResolvedValueOnce(stream('', { arguments: '{"ok":true}' }))
    const { service, workspace } = await setup(fetcher)
    const result = await service.generate({ role: 'extraction', context: { messages: [{ role: 'user', content: '调用submit_result返回ok=true', timestamp: 1 }], tools: [{ name: 'submit_result', description: '提交结果', parameters: Type.Object({ ok: Type.Boolean() }) }] }, validate: message => { const call = message.content.find(part => part.type === 'toolCall'); if (call?.type !== 'toolCall' || call.arguments.ok !== true) throw new Error('invalid'); return call.arguments }, repairPrompt: '请修正结果' })
    expect(result).toMatchObject({ ok: true, value: { ok: true } })
    const body = JSON.parse(fetcher.mock.calls[1][1]?.body as string)
    expect(body.messages.some((row: { role: string; tool_call_id?: string }) => row.role === 'tool' && row.tool_call_id === 'call-1')).toBe(true)
    expect(await workspace.settings.books.count()).toBe(0)
  })

  it('模型目录的价格与容量单独标注；手动容量仅作用整理模型', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => stream())
    const { service } = await setup(fetcher)
    await service.settings.save({ ...defaultConfig, aggregationContextWindow: 16384 }, key)
    const extraction = await service.probe('direct')
    expect(extraction).toMatchObject({ ok: true, snapshot: { modelId: 'deepseek-flash', contextWindow: 1000000, contextSource: 'catalog' } })
    expect(extraction.usage).toMatchObject({ costStatus: 'estimated', currency: 'USD' })
    expect(extraction.usage.cost).toBeGreaterThan(0)
    expect(await service.probe('agent')).toMatchObject({ ok: true, snapshot: { modelId: 'deepseek-v4-pro', contextWindow: 16384, contextSource: 'configured' } })
  })

  it('模型输出能力保留Pi目录原值，测试的短输出限制由调用入口提供', async () => {
    const { deepseekProvider } = await import('@earendil-works/pi-ai/providers/deepseek')
    const nativeModel = deepseekProvider().getModels().find(model => model.id === 'deepseek-flash')!
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(stream())
    const { service } = await setup(fetcher)
    await service.settings.save(defaultConfig, key)
    const result = await service.probe('direct')
    expect(result.ok).toBe(true)
    expect(result.snapshot?.maxTokens).toBe(nativeModel.maxTokens)
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string).max_tokens).toBe(8)
  })

  it.each([key, '1'])('原始结构化回复经过校验后保留内容，凭据%s只在展示层脱敏', async credential => {
    const expected = { amount: 10, description: 'Bearer symbol belongs to the story' }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(stream(JSON.stringify(expected)))
    const { service } = await setup(fetcher)
    await service.settings.save(savedConfig, credential)
    const result = await service.generate({ role: 'extraction', context: { messages: [{ role: 'user', content: '返回结构化结果', timestamp: 1 }] }, validate: message => JSON.parse(message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')) })
    expect(result).toMatchObject({ ok: true, value: expected })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('Agent在途取消后停稳，随后可重新测试', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce((_input, init) => new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }) })).mockResolvedValueOnce(stream())
    const { service } = await setup(fetcher)
    const controller = new AbortController()
    const pending = service.probe('agent', { signal: controller.signal })
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'cancelled' } })
    expect((await service.probe('agent')).ok).toBe(true)
  })

  it('总时限会终止慢请求，非法预算在发送前报错', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }) }))
    const { service } = await setup(fetcher)
    const result = await service.probe('direct', { timeoutMs: 30 })
    expect(result).toMatchObject({ ok: false, error: { kind: 'network' } })
    expect(result.elapsedMs).toBeLessThan(1000)
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(1)
    fetcher.mockClear()
    expect(await service.generate({ role: 'extraction', context: { messages: [] }, maxRequests: Infinity })).toMatchObject({ ok: false, attempts: [], error: { kind: 'validation' } })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['openai-responses', 'anthropic-messages'] as const)('%s使用Pi协议实现和规范化地址', async api => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(api === 'openai-responses' ? responsesBody() : anthropicBody(), { headers: { 'Content-Type': 'text/event-stream' } }))
    const { service } = await setup(fetcher)
    await service.settings.save({ ...savedConfig, api }, key)
    const result = await service.probe('direct')
    expect(result).toMatchObject({ ok: true, text: '好' })
    const url = new URL(String(fetcher.mock.calls[0][0]))
    expect(url.origin + url.pathname).toBe(`https://models.example/v1/${api === 'openai-responses' ? 'responses' : 'messages'}`)
    if (api === 'anthropic-messages') expect(url.searchParams.get('beta')).toBe('true')
  })
})

describe('错误分类与有限退避', () => {
  it.each([[401, 'auth'], [403, 'auth'], [429, 'rate_limit'], [500, 'server'], [503, 'server']])('HTTP %s归类为%s', (status, kind) => expect(classifyError('', [], status as number).kind).toBe(kind))
  it('密钥与Bearer信息脱敏，错误正文保留诊断长度；退避只接受整数秒', () => {
    expect(redact(`Bearer abc ${key} ${encodeURIComponent(key)}`, [key])).not.toMatch(/abc|fixture-key/)
    expect(classifyError(new ModelError('validation', 'x'.repeat(2000))).message.length).toBeLessThan(1300)
    expect(retryDelay(0, '7', 0.5)).toBe(7000)
    expect(retryDelay(0, '7.5', 0.5)).toBe(1000)
    expect(retryDelay(1, undefined, 0.5)).toBe(2000)
  })
})
