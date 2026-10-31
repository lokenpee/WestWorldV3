import { agentStream } from './agent-protocol'

type Item = Record<string, unknown>
const contentOf = (value: unknown) => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => part.text ?? '').join('') : ''
export function storyTask(body: Item) {
  const messages = body.messages as { role: string; content: unknown }[]
  const index = messages.findLastIndex(row => row.role === 'user' && /"queue":"(window_nodes|orphans|event_lines|review_notes)"/.test(contentOf(row.content)))
  const content = contentOf(messages[index].content)
  return { input: JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)), messages: messages.slice(index) }
}
export function storyResponse(body: Item, options: { inputMemory?: boolean; reuseOldMembers?: boolean; readOnly?: boolean } = {}): Response {
  if ((body.messages as { role: string; content: unknown }[]).some(row => contentOf(row.content).includes('【需要压缩的原始会话数据】'))) return agentStream([{ name: 'submit_result', args: { summary: '已核对本书节点与信件流转，已提交结果以代码确认为准。按当前任务编号查询余项。' } }])
  const { input, messages } = storyTask(body)
  const results = messages.filter(row => row.role === 'tool').flatMap(row => { try { return [JSON.parse(contentOf(row.content))] } catch { return [] } })
  const commit = results.find(row => row.ok && row.commitId)
  const nodes = results.flatMap(row => row.data ?? []).filter((row: Item) => row.chapterIndex)
  const line = results.flatMap(row => row.data ?? []).find((row: Item) => row.nodeIds)
  if (input.phase === 'global_review' || options.readOnly) {
    if (results.length) return agentStream([{ name: 'submit_result', args: { status: 'completed', commitIds: [], summary: '按原文核对全书资料，保留当前关联与合理孤点。', remainingWorkIds: [], reviewedItems: input.workItems.map((item: Item) => ({ workItemId: item.workItemId, outcome: 'no_change', reason: '原文依据与现有资料一致，保留当前状态。' })) } }])
    const name = ['window_nodes', 'orphans'].includes(input.queue) ? 'get_node_detail' : input.queue === 'event_lines' ? 'get_event_line_detail' : 'get_editor_note_detail'
    return agentStream([...Array.from({ length: Math.ceil(input.workItems.length / 10) }, (_, i) => ({ name, args: { ids: input.workItems.slice(i * 10, i * 10 + 10).map((item: Item) => item.id) } })), ...(input.phase === 'window_link' ? [{ name: 'query_event_lines', args: { offset: 0, limit: 50 } }] : [])])
  }
  if (commit) return agentStream([{ name: 'submit_result', args: { status: 'completed', commitIds: [commit.commitId], summary: '已依据同一封信的连续经过串联。', remainingWorkIds: [], reviewedItems: input.workItems.map((item: Item) => ({ workItemId: item.workItemId, outcome: (nodes.find((row: Item) => row.id === item.id)?.eventLineIds ?? []).includes(line?.id) ? 'no_change' : 'changed', reason: '本节点属于同一封信的流转，复用已有事件线。' })) } }])
  if (results.some(row => row.memory) || options.inputMemory && nodes.length) return agentStream([{ name: 'commit_story_changes', args: { operationKey: input.resume.nextOperationKey, payload: { event_line_ops: [{ op: line ? 'append' : 'create', ...(line ? { line_id: line.id } : { title: '信件流转' }), node_ids: input.workItems.map((item: Item) => item.id), cause: '信件待转交', process: '交信、传信与归还', result: '按原文继续核对', line_status: 'open', confidence: 1, reason: '原文说明同一封信的连续事件', evidenceNodeIds: input.workItems.map((item: Item) => item.id) }], new_nodes: [], memory_update: { workingSummary: `窗口${input.window.start + 1}至${input.window.end}已核对信件流转。`, notes: [] } } } }])
  const ids = [...new Set<string>([...input.workItems.map((item: Item) => String(item.id)), ...(options.reuseOldMembers ? [] : input.existingLines.flatMap((item: Item) => item.nodeIds))])]
  const calls = []
  calls.push({ name: 'query_event_lines', args: { offset: 0, limit: 50 } })
  if (input.existingLines.length >= 50) calls.push({ name: 'query_event_lines', args: { offset: 50, limit: 50 } })
  for (let i = 0; i < ids.length; i += 20) calls.push({ name: 'get_node_detail', args: { ids: ids.slice(i, i + 20) } })
  for (let i = 0; i < input.existingLines.length; i += 10) calls.push({ name: 'get_event_line_detail', args: { ids: input.existingLines.slice(i, i + 10).map((item: Item) => item.id) } })
  if (!options.inputMemory) calls.push({ name: 'get_editor_memory', args: {} })
  return agentStream(calls)
}
