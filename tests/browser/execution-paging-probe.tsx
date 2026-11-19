import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { ExecutionChainView } from '../../src/features/agents/ExecutionChainView'
import type { ExecutionChain } from '../../src/features/agents/trace'
import type { ExecutionEvent } from '../../src/features/agents/executionChain'
import { executionStats } from '../../src/features/agents/executionStats'

export function mountExecutionProbe() {
  const calls: string[] = []
  const container = document.createElement('div'); container.id = 'execution-probe'; document.body.append(container)
  const request = { requestId: 'r2', requestOrdinal: 2, model: '固定样本', status: 'succeeded', startedAt: '2026-11-19T00:00:01Z', usage: { input: 100, output: 10, totalTokens: 110 }, toolCalls: [{ name: 'query', toolCallId: 'c2', arguments: { id: 'A' }, result: { ok: true }, state: 'succeeded' }], input: { messageFormat: 'provider-request/v1', messages: [{ role: 'user', content: '原始请求内容' }] }, text: '模型原始答复' }
  const event: ExecutionEvent = { key: 'r2:assistant', apiIndex: 2, kind: 'assistant', role: 'assistant', content: '', thinking: '', toolCalls: [{ id: 'c2', name: 'query' }], isError: false, entry: { requestId: 'r2', version: 1 } }
  const chain: ExecutionChain = { entries: [], requests: [request], snapshots: new Map(), summary: { stats: executionStats([request, { ...request, requestId: 'r1' }]), duration: '1 秒', model: '固定样本' } }
  chain.paging = {
    events: [event], hasEarlier: true,
    loadEvent: async header => { calls.push(header.key); return { ...header, thinking: '完整思考', content: header.key === 'r2:assistant' ? '模型原始答复' : '更早用户消息', toolCalls: [{ id: 'c2', name: 'query', arguments: { id: 'A' } }] } },
    loadRequest: async () => { calls.push('request'); return { request, snapshots: new Map() } },
    loadEarlier: async () => { calls.push('earlier'); return { ...chain, paging: { ...chain.paging!, hasEarlier: false, events: [{ ...event, key: 'r1:user', apiIndex: 1, kind: 'user', role: 'user', toolCalls: [], entry: { requestId: 'r1' } }, event] } } },
  }
  function Probe() { const [value, setValue] = useState(chain); return <ExecutionChainView chain={value} edits={[]} onChainChange={setValue} /> }
  const root = createRoot(container); root.render(<Probe />)
  return { calls, unmount: () => { root.unmount(); container.remove() } }
}
