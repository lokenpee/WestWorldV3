import { useEffect, useState } from 'react'
import type { createWorkspace } from '../lib/storage/workspace'
import { createModelService } from '../features/models/service'

type Scenario = 'success' | 'auth' | 'server-once' | 'server' | 'wait' | 'empty' | 'slow'
// 演示服务只生成隔离响应，模型调用和智能体循环沿用 Pi。
export function createModelAcceptance(workspace: ReturnType<typeof createWorkspace>) {
  let scenario: Scenario = 'success'
  let count = 0
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach(listener => listener())
  const models = createModelService(workspace, { fetch: async (input, init) => {
    count++; notify()
    if (String(input).endsWith('/models')) return Response.json({ data: [{ id: 'demo-extraction' }, { id: 'demo-aggregation' }] })
    if (scenario === 'slow') return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException('已取消演示等待', 'AbortError'))
      if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener('abort', abort, { once: true })
    })
    const status = scenario === 'auth' ? 401 : scenario === 'wait' ? 429 : scenario === 'server' || (scenario === 'server-once' && count === 1) ? 503 : undefined
    if (status) return new Response(JSON.stringify({ error: { message: status === 401 ? 'invalid key: demo-not-a-real-key' : '演示服务暂时不可用' } }), { status, headers: { 'Content-Type': 'application/json', ...(status === 429 ? { 'Retry-After': '60' } : {}) } })
    const body = JSON.parse(init?.body as string) as { model: string }
    const frame = (delta: object, finish_reason: string | null, usage?: object) => ({ id: 'model-demo', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })
    const chunks = [frame({ role: 'assistant', content: scenario === 'empty' ? '' : '好' }, null), frame({}, 'stop'), { ...frame({}, null, { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }), choices: [] }]
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  } })
  function Tools() {
    const [, refresh] = useState(0)
    const [message, setMessage] = useState('演示服务提供固定响应；正常工作台设置页用于真实连接。')
    useEffect(() => { const listener = () => refresh(value => value + 1); listeners.add(listener); return () => { listeners.delete(listener) } }, [])
    const choose = (value: Scenario) => { scenario = value; count = 0; notify() }
    async function configure() {
      try {
        await models.settings.save({ providerId: 'model-demo', api: 'openai-completions', baseUrl: 'https://model-demo.invalid/v1', extractionModel: 'demo-extraction', aggregationModel: 'demo-aggregation' }, 'demo-not-a-real-key')
        choose('success'); setMessage('演示配置已保存。打开设置，可测试提取与整理模型。')
      } catch (error) { setMessage(error instanceof Error ? error.message : '演示配置保存失败。') }
    }
    return <section className="acceptance-tools" aria-label="模型调用隔离验收"><div><strong>模型调用 · 独立验收库</strong><p role="status">{message} · 演示请求：{count} 次 · 场景：{scenario}</p></div><div className="acceptance-actions">
      <button onClick={() => void configure()}>填入演示配置</button>
      <button onClick={() => choose('success')}>正常回复</button><button onClick={() => choose('auth')}>鉴权失败</button><button onClick={() => choose('server-once')}>首次服务失败</button><button onClick={() => choose('server')}>持续服务失败</button><button onClick={() => choose('wait')}>限流等待</button><button onClick={() => choose('empty')}>空回复</button><button onClick={() => choose('slow')}>在途等待</button>
    </div></section>
  }
  return { models, Tools }
}
