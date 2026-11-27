import { canonical, records, strings, text } from '../agents/contracts'
import type { AgentStore, Row } from '../agents/repository'
import type { NarrativeTask } from './narrativePlan'

export function inputAssignment(prompt: string, nodeId: string): boolean | undefined {
  const block = /【当前节点概览开始】([\s\S]*?)【当前节点概览结束】/.exec(prompt)
  try {
    const node = block ? JSON.parse(block[1]) : JSON.parse(prompt).当前节点
    if (node?.node_id === nodeId && Array.isArray(node.event_ids)) return node.event_ids.length > 0
  } catch { /* 跳过普通用户消息，继续寻找任务原始输入。 */ }
}

/** 仅旧回执缺少布尔值时读取历史。串联只追加成员，因此可从任务开始逐笔还原。 */
export function historicalEventReply(store: AgentStore, task: NarrativeTask, sessionId?: string) {
  let history: Promise<Map<string,boolean>> | undefined
  async function readAssignments() {
    const nodeId = task.ids[0]
    const entries = (sessionId && store.sessionEntries
      ? await store.sessionEntries(sessionId) : await store.rows('storySessionEntries'))
      .filter(e => e.taskId === task.id && e.type === 'message').sort((a,b) => Number(a.ordinal)-Number(b.ordinal))
    const order = new Map<string,number>()
    let assigned: boolean | undefined
    for (const entry of entries) {
      const m = entry.message as Row
      if (m.role === 'user' && assigned === undefined) {
        const content = typeof m.content === 'string' ? m.content : records(m.content).map(p => text(p.text)).join('')
        assigned = inputAssignment(content,nodeId)
      }
      if (m.role === 'assistant') for (const part of records(m.content))
        if (part.type === 'toolCall') order.set(task.id+':'+part.id,order.size)
    }
    const snapshot = await store.get('pipelineRuns',task.id)
    assigned ??= typeof snapshot?.initialNodeAssigned === 'boolean' ? snapshot.initialNodeAssigned : inputAssignment(task.prompt,nodeId)
    const receipts = (await store.rows('pipelineRuns'))
      .filter(r => r.taskId === task.id && r.recordType === 'narrative_receipt' && r.name === 'edit_events' && r.status === 'completed')
      .sort((a,b) => text(a.startedAt).localeCompare(text(b.startedAt)) ||
        (order.get(text(a.id)) ?? Infinity) - (order.get(text(b.id)) ?? Infinity))
    const result = new Map<string,boolean>()
    for (const receipt of receipts) {
      const saved = receipt.result as Row
      if (typeof saved.current_node_assigned === 'boolean') assigned = saved.current_node_assigned
      else if (records(saved.events).some(e => strings(e.nodeIds).includes(nodeId))) assigned = true
      if (assigned !== undefined) result.set(text(receipt.id),assigned)
    }
    return result
  }
  return async (callId: string, name: string, args: Row, result: Row) => {
    const reply = eventToolReply(name,args,result,task)
    if (task.mode !== 'link_node' || name !== 'edit_events' || reply.ok !== true || typeof reply.current_node_assigned === 'boolean') return reply
    history ??= readAssignments()
    const assigned = (await history).get(task.id+':'+callId)
    if (assigned === undefined) throw Error('缺少原始节点输入或编辑凭据，无法还原本次编辑后的归属。')
    return {...reply,current_node_assigned:assigned}
  }
}

/** 模型回包只取本次操作所需的信息；存储回执保留完整的保存结果。 */
export function eventToolReply(name: string, args: Row, result: Row, task: NarrativeTask): Row {
  if (result.ok === false) return result
  if (name === 'confirm') return {confirmed:true, result:result.result}
  if (name === 'search_events' || name === 'search_nodes')
    return {items:result.items, total:result.total, truncated:result.truncated}
  if (name === 'get_nodes') {
    const fields = args.return_fields === undefined ? ['name','detail'] : strings(args.return_fields)
    const missing = strings(result.not_found_ids)
    return {
      items:records(result.items).map(node => Object.fromEntries(
        ['node_id',...fields].filter(key => Object.hasOwn(node,key)).map(key => [key,node[key]]))),
      ...(missing.length && {not_found_ids:missing}),
    }
  }
  if (name === 'get_event' && Array.isArray(result.members)) {
    const {nodeIds: _ids, members, ...event} = result
    return {...event, members:records(members).map(({node_id,name}) => ({node_id,name}))}
  }
  if (name !== 'edit_events' || !Array.isArray(result.events)) return result

  const events = new Map(records(result.events).map(event => [event.event_id,event]))
  const created: Row[] = [], updated: Row[] = [], deleted: unknown[] = []
  const operations = records(args.changes)
  for (const [index,change] of records(result.changes).entries()) {
    const id = change.event_id
    const event = events.get(id)
    if (!event) { deleted.push(id); continue }
    const op = operations[index]
    const item: Row = {event_id:id}
    if (op?.op === 'create') item.name = event.name
    for (const key of ['added','removed'])
      if (strings(change[key]).length) item[key] = change[key]
    const adjusted = Object.entries((op?.fields ?? {}) as Row)
      .filter(([key,value]) => canonical(value) !== canonical(event[key]))
    if (adjusted.length) item.saved_fields = Object.fromEntries(adjusted.map(([key]) => [key,event[key]]))
    if (op?.op === 'create') created.push(item)
    else updated.push(item)
  }
  const reply: Row = {ok:true, created, updated}
  if (task.mode === 'link_node') {
    if (typeof result.current_node_assigned === 'boolean') reply.current_node_assigned = result.current_node_assigned
    else if ([...events.values()].some(event => strings(event.nodeIds).includes(task.ids[0])))
      reply.current_node_assigned = true
  } else {
    if (deleted.length) reply.deleted_event_ids = deleted
    if (strings(result.unassigned_node_ids).length) reply.unassigned_node_ids = result.unassigned_node_ids
  }
  return reply
}
