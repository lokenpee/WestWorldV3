import type { Row } from '../../src/features/agents/repository'
const contentOf = (content: unknown) => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : ''
export function agentStream(calls: { name: string; args: unknown }[]) {
  const chunk = (delta: unknown, finish_reason: string | null) => ({ id: 'agent-test', object: 'chat.completion.chunk', created: 1, model: 'test-agent', choices: [{ index: 0, delta, finish_reason }] })
  return new Response([chunk({ role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: `call-${index}-${crypto.randomUUID()}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, null), chunk({}, 'tool_calls')].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
}

export function agentResponse(body: { tools: { function: { name: string } }[]; messages: unknown[] }): Response {
    const story = body.tools.some((tool: { function: { name: string } }) => tool.function.name === 'get_editor_memory')
    const messages = body.messages as { role: string; content: unknown; tool_calls?: unknown[] }[]
    const user = messages.filter(row => row.role === 'user').map(row => contentOf(row.content)).join('\n')
    const current = messages.findLast(row => row.role === 'user' && contentOf(row.content).includes('operationKey'))
    let input: Row = {}; try { input = JSON.parse(contentOf(current?.content)) as Row } catch { /* 文本探针采用固定模板。 */ }
    const operationKey = input.operationKey ?? user.match(/operationKey[=：]([^，。\s]+)/)?.[1] ?? 'probe-operation'
    const begin = Math.max(0, messages.findLastIndex(row => row.role === 'user' && contentOf(row.content).includes('operationKey')))
    const toolResults = messages.slice(begin).filter(row => row.role === 'tool').flatMap(row => { try { return [JSON.parse(contentOf(row.content)) as Row] } catch { return [] } })
    const commit = toolResults.find(row => row.ok === true && row.commitId)
    const reads = toolResults.filter(row => row.memory || row.data || row.text)
    if (commit) return agentStream([{ name: 'submit_result', args: { status: 'completed', commitIds: [commit.commitId], summary: '工具读写已确认', remainingWorkIds: [], reviewedItems: input.workItemId ? [{ workItemId: input.workItemId, outcome: 'no_change', reason: '节点已核对，工作记忆已更新。' }] : [] } }])
    if (reads.length) return agentStream([{ name: story ? 'commit_story_changes' : 'commit_asset_changes', args: { operationKey, payload: story ? { event_line_ops: [], new_nodes: [], memory_update: { workingSummary: '隔离探针摘要', notes: [] } } : { groups: [{ kind: 'character', keepId: 'C1-P001', memberIds: ['C1-P001', 'C2-P001'], canonicalName: '沈青', reason: '原文明示同一人', confidence: 1, evidence: [{ chapterIndex: '2', quote: '第二章的沈青就是第一章的沈青。', memberIds: ['C1-P001', 'C2-P001'] }] }] } } }])
    return agentStream(story ? [...(input.workItemId ? [{ name: 'get_node_detail', args: { ids: ['C1-N001'] } }] : []), { name: 'get_editor_memory', args: {} }] : [{ name: 'get_character_detail', args: { ids: ['C1-P001', 'C2-P001'] } }, { name: 'read_original', args: { chapter_range: ['2', '2'] } }])
}
