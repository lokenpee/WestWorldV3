import { eventCandidateSection, lineCandidateSection, reviewMaterialSections } from '../../src/features/story/narrativeInput'
import type { Row } from '../../src/features/agents/repository'
const contentOf = (content: unknown) => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : ''
export function agentTextStream(content: string) {
  const chunk = { id: 'agent-text-test', object: 'chat.completion.chunk', created: 1, model: 'test-agent', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }] }
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
}
export function agentStream(calls: { name: string; args: unknown }[], thinking?: string) {
  const chunk = (delta: unknown, finish_reason: string | null) => ({ id: 'agent-test', object: 'chat.completion.chunk', created: 1, model: 'test-agent', choices: [{ index: 0, delta, finish_reason }] })
  return new Response([chunk({ role: 'assistant', ...(thinking ? { reasoning_content: thinking } : {}), tool_calls: calls.map((call, index) => ({ index, id: `call-${index}-${crypto.randomUUID()}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, null), chunk({}, 'tool_calls')].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
}

export function agentResponse(body: { tools: { function: { name: string } }[]; messages: unknown[] }): Response {
    const story = body.tools.some((tool: { function: { name: string } }) => ['get_editor_memory', 'commit_story_changes'].includes(tool.function.name))
    const messages = body.messages as { role: string; content: unknown; tool_calls?: unknown[] }[]
    const user = messages.filter(row => row.role === 'user').map(row => contentOf(row.content)).join('\n')
    const current = messages.findLast(row => row.role === 'user' && contentOf(row.content).includes('operationKey'))
    let input: Row = {}; try { input = JSON.parse(contentOf(current?.content)) as Row } catch { /* 文本探针采用固定模板。 */ }
    const operationKey = input.operationKey ?? user.match(/"operationKey"\s*:\s*"([^"]+)"|operationKey[=：]([^，。\s]+)/)?.slice(1).find(Boolean) ?? 'probe-operation'
    const begin = Math.max(0, messages.findLastIndex(row => row.role === 'user' && contentOf(row.content).includes('operationKey')))
    const toolResults = messages.slice(begin).filter(row => row.role === 'tool').flatMap(row => { try { return [JSON.parse(contentOf(row.content)) as Row] } catch { return [] } })
    const commit = toolResults.find(row => row.ok === true && row.commitId)
    const reads = toolResults.filter(row => row.memory || row.data || row.text)
    if (commit) return agentStream([{ name: 'submit_result', args: { status: 'completed', commitIds: [commit.commitId], summary: '工具读写已确认', remainingWorkIds: [], reviewedItems: input.workItemId ? [{ workItemId: input.workItemId, outcome: 'no_change', reason: '节点已核对，工作记忆已更新。' }] : [] } }])
    if (reads.length) return agentStream([{ name: story ? 'commit_story_changes' : 'commit_asset_changes', args: { operationKey, payload: story ? { event_line_ops: [], new_nodes: [], memory_update: { workingSummary: '隔离探针摘要', notes: [] } } : { groups: [{ kind: 'character', keepId: 'C1-P001', memberIds: ['C1-P001', 'C2-P001'], canonicalName: '沈青', reason: '原文明示同一人', confidence: 1, evidence: [{ chapterIndex: '2', quote: '第二章的沈青就是第一章的沈青。', memberIds: ['C1-P001', 'C2-P001'] }] }] } } }])
    return agentStream(story ? [...(input.workItemId ? [{ name: 'get_node_detail', args: { ids: ['C1-N001'] } }] : []), { name: 'get_editor_memory', args: {} }] : [{ name: 'get_character_detail', args: { ids: ['C1-P001', 'C2-P001'] } }, { name: 'read_original', args: { chapter_range: ['2', '2'] } }])
}

export function narrativeMaterial(content: string) {
  let value
  try { value = JSON.parse(content) } catch { return undefined }
  if (value?.mode && value.targets) return value
  if (!value?.任务说明) return undefined
  const part = value.任务说明.part as keyof typeof reviewMaterialSections
  return {...value.任务说明, targets:value.本批节点资料 ?? value.本组事件资料 ?? value[eventCandidateSection] ?? value[lineCandidateSection] ?? value[reviewMaterialSections[part]] ?? value.本段复核资料,
    evidence:value.本段查证材料,
    outline:value.事件与可见节点目录 ?? value.故事线与事件目录, config:value.运行参数, reviewProgress:value.本轮复核进度, periodIds:value.本周期范围, openDoubts:value.未决疑点 ?? []}
}

export function narrativeResponse(body: {messages: Row[]}, inputs:string[]) {
    const task = body.messages.map(m => narrativeMaterial(contentOf(m.content))).find(Boolean)
    if (!task || inputs.length > 36) throw new Error('任务输入或推进错误')
    inputs.push(task.mode + '/' + task.part)
    const targets = task.targets.map((r: Row) => r.id)
    const called = body.messages.some((m: Row) => m.role === 'tool')
    const call = (name: string, args: Row) => agentStream([{name,args}], '先按本段原文核实成员。')
    const alreadyGrouped = task.mode === 'node_batch' && targets.every((id: string) =>
      task.outline.events.some((event: Row) => (event.nodeIds as string[]).includes(id)))
    if (!called && task.mode === 'node_batch' && !alreadyGrouped) return call('edit_events',{operations:[{op:'create_event',ref:'scene',title:'密信抵达',summary:'信使交信',nodeIds:targets}]})
    if (!called && task.mode === 'event_group') return call('edit_storylines',{operations:[{op:'create_line',ref:'line',title:'追查密信',coreClue:'封印完整'},{op:'attach_event',eventId:targets[0],lineId:'$line'}]})
    if (!called && task.part === 'descriptions') {
      const event = task.mode === 'event_review'
      return call(event?'edit_events':'edit_storylines',{operations:targets.map((id:string)=>({op:event?'update_event':'update_line',[event?'eventId':'lineId']:id,summary:'密信抵达并引发追查',coreClue:'信上留有印记'}))})
    }
    return call('confirm', {})
}
