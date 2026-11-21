import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { ExecutionChainView } from '../../src/features/agents/ExecutionChainView'
import type { ExecutionChain } from '../../src/features/agents/trace'
import { projectRequestConversation } from '../../src/features/agents/executionChain'
import { executionStats } from '../../src/features/agents/executionStats'

export function mountExecutionProbe() {
  const calls: string[] = []
  const container = document.createElement('div'); container.id = 'execution-probe'; document.body.append(container)
  const initial = [
    { role: 'system', content: '首轮实际系统提示词' },
    { role: 'user', content: '程序注入人物档案' },
    { role: 'user', content: '真实用户消息' },
  ]
  const tool = (index: number) => ({ toolCallId: `c${index}`, name: 'read_original', arguments: { chapter_indices: [String(index)] }, result: { content: [{ type: 'text', text: `工具返回 ${index}` }] }, state: 'succeeded' })
  const output = (index: number) => [
    { role: 'assistant', content: null, tool_calls: [{ id: `c${index}`, function: { name: 'read_original', arguments: JSON.stringify(tool(index).arguments) } }] },
    { role: 'tool', tool_call_id: `c${index}`, content: `工具返回 ${index}` },
  ]
  const requestRows = [1, 2, 3].map(index => ({
    requestId: `r${index}`, requestOrdinal: index, model: '固定样本', status: 'succeeded', startedAt: `2026-11-19T00:00:0${index}Z`,
    usage: { input: 100, output: 10, totalTokens: 110 }, thinking: `思考 ${index}`, toolCalls: [tool(index)],
    input: { messageFormat: 'provider-request/v1', toolSchemaSnapshotId: 'first-tools', messages: [
      ...initial, { role: 'user', content: `本轮新增运行消息 ${index}` }, ...(index >= 2 ? output(1) : []), ...(index === 3 ? output(2) : []),
    ], requestParameters: { model: 'first-model', reasoning_effort: 'low' } },
  }))
  const snapshots = new Map([['first-tools', { schema: [{ name: 'read_original', parameters: { properties: { chapter_indices: { type: 'array' } } } }] }]])
  const requestHeads = requestRows.map(({ input, toolCalls, thinking, ...request }, index) => ({ ...request,
    requestOrdinal: index === 2 ? 1 : request.requestOrdinal, timelineOrdinal: index + 1, toolSchemaSnapshotId: input.toolSchemaSnapshotId,
  }))
  const core: ExecutionChain = { entries: [], requests: requestRows, snapshots }
  const actualEvents = new Map(projectRequestConversation(core, true).map(event => [event.key, event]))
  const eventHeads = [...actualEvents.values()].map(event => ({ ...event, content: '', thinking: '', entry: { requestId: `r${event.apiIndex}`, hasResult: event.execution?.result !== undefined } }))
  const chain: ExecutionChain = { entries: [], requests: [requestHeads[0], requestHeads[2]], firstRequest: requestHeads[0], snapshots: new Map(), summary: { stats: executionStats(requestRows), duration: '2 秒', model: '固定样本' } }
  chain.paging = {
    events: eventHeads.filter(event => event.apiIndex !== 2), hasEarlier: true,
    loadEvent: async header => { calls.push(header.key); return actualEvents.get(header.key)! },
    loadRequest: async row => { calls.push(`request:${row.requestId}`); return { request: requestRows.find(request => request.requestId === row.requestId)!, snapshots } },
    loadEarlier: async () => { calls.push('earlier'); return { ...chain, requests: requestHeads, paging: { ...chain.paging!, hasEarlier: false, events: eventHeads } } },
  }
  function Probe() { const [value, setValue] = useState(chain); return <ExecutionChainView folded chain={value} edits={[]} onChainChange={setValue} /> }
  const root = createRoot(container); root.render(<Probe />)
  return { calls, unmount: () => { root.unmount(); container.remove() } }
}
