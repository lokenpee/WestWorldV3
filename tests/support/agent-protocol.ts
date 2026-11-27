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
    if (body.tools.some(t=>t.function.name==='get_nodes')) {
      const messages=body.messages as {role:string;content:unknown}[]
      const count=messages.filter(m=>m.role==='tool').length
      if (!count) return agentStream([{name:'get_nodes',args:{node_ids:['N001']}}])
      if (count===1) return agentStream([{name:'edit_events',args:{changes:[{op:'create',reason:'守卫接过密信',fields:{
        name:'信使向守卫交信',overview:'信使将密信送至村口交由守卫接收',latest_progress:'守卫已当场收下信使交来的密信',
        unresolved:'密信尚待守卫转交给指定收件人',clues:['密信'],status:'进行中',nodeIds:['N001']}}]}}])
      return agentStream([{name:'confirm',args:{result:'completed'}}])
    }
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
  if (content.startsWith('【当前节点概览开始】')) {
    const section = (name: string) => content.split('【' + name + '开始】\n')[1].split('\n【' + name + '结束】')[0]
    const candidates = section('排序召回事件')
    value = {当前节点:JSON.parse(section('当前节点概览')), 候选事件:candidates.startsWith('[') ? JSON.parse(candidates.split('\n')[0]) : []}
  } else {
    try { value = JSON.parse(content) } catch { return undefined }
  }
  if (value?.mode && value.targets) return value
  if (value?.当前节点) return {mode:'link_node',part:'batch',targets:[{id:value.当前节点.node_id}],material:value}
  if (value?.主审事件) return {mode:'review_sequence',part:'structure',targets:[{id:value.主审事件.event_id}],material:value}
  if (Array.isArray(value?.本组事件)) return {mode:'review_boundaries',part:value.本组事件.length ? 'structure':'unassigned',targets:value.本组事件.map((e:Row)=>({id:e.event_id})),material:value}
  if (value?.本轮重点事件及直接关联事件) return {mode:'review_event',part:'structure',targets:[{id:value.本轮重点事件及直接关联事件.重点事件ID}],material:value}
  if (value?.当前事件) return {mode:'review_event',part:'structure',targets:[{id:value.当前事件.event_id}],material:value}
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
    if (task.mode === 'link_node') {
      const results=body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(contentOf(m.content)))
      if (results.some(r=>r.ok && Array.isArray(r.created))) return call('confirm',{result:'completed'})
      const previous = task.material.候选事件[0]
      if (previous && !results.some(r=>r.event_id===previous.event_id)) return call('get_event',{event_id:previous.event_id})
      if (previous) return call('edit_events',{changes:[{op:'update',event_id:previous.event_id,
        fields:{nodeIds:[...results.find(r=>r.event_id===previous.event_id).members.map((member:Row)=>member.node_id),...targets]},reason:'密信继续传递'}]})
      return call('edit_events',{changes:[{op:'create',reason:'信使开始递交密信',fields:{
        name:'信使向守卫交信',overview:'信使将密信送至村口交由守卫接收',latest_progress:'守卫已当场收下信使交来的密信',
        unresolved:'密信尚待守卫转交给指定收件人',clues:['密信'],status:'进行中',nodeIds:targets}}]})
    }
    if (['review_sequence','review_boundaries','review_event'].includes(task.mode)) return call('confirm',{result:'completed'})
    if (!called && task.mode === 'event_group') return call('edit_storylines',{operations:[
      {op:'create_line',ref:'line',title:'追查密信',coreClue:'封印完整'},
      ...targets.map((eventId:string)=>({op:'attach_event',eventId,lineId:'$line'})),
    ]})
    if (!called && task.part === 'descriptions') {
      const event = task.mode === 'event_review'
      return call(event?'edit_events':'edit_storylines',{operations:targets.map((id:string)=>({op:event?'update_event':'update_line',[event?'eventId':'lineId']:id,summary:'密信抵达并引发追查',coreClue:'信上留有印记'}))})
    }
    return call('confirm', {})
}
