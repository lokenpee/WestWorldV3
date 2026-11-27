import { finishReview, scheduleReview, twoStepMode } from './twoStepReview'
import { indexReviewGroups, type ReviewIndex } from './eventReviewGroups'
import { synchronizeOutline } from './outline'
import { formatLinkNodeInput } from './narrativeInput'
import { canonical, records, strings, text } from '../agents/contracts'
import type { AgentStore, Row } from '../agents/repository'
import type { NarrativeAssets, NarrativePlan, NarrativeTask } from './narrativePlan'

const membersOf = (e: Row) => strings(e.nodeIds)
const eventIdList = (a: NarrativeAssets, id: unknown) => a.events.filter(e => membersOf(e).includes(text(id))).map(e => text(e.id))
const nodeCard = (r: Row) => ({node_id:r.id, name:r.name, summary:r.summary})
export function nodeDetails(r: Row, a: NarrativeAssets) {
  return { ...nodeCard(r), detail:r.process ?? null, quote:r.quote ?? null,
    source_position:{ chapter:r.chapterIndex, order:r.order }, event_ids:eventIdList(a,r.id) }
}
const fieldMap: Record<string,string> = {name:'title', overview:'summary', latest_progress:'latestProgress',
  unresolved:'unresolved', status:'status', clues:'clues', nodeIds:'nodeIds'}
export function eventFields(e: Row): Row {
  return {event_id:e.id, ...Object.fromEntries(Object.entries(fieldMap).map(([key,stored]) => [key,e[stored]]))}
}
function eventDetail(e: Row, a: NarrativeAssets) {
  const members = new Set(membersOf(e))
  return {...eventFields(e), members:a.nodes.filter(r => members.has(text(r.id))).map(nodeCard)}
}
const boundary = (e: Row) => canonical([e.title,e.summary,e.latestProgress,e.unresolved,e.clues,e.status,e.nodeIds])
export function nodeMaterial(node:Row,a:NarrativeAssets,index:number) {
  const next=a.nodes.slice(index+1,index+6)
  const current = {
    ...nodeCard(node),
    detail: node.process ?? null,
    event_ids: eventIdList(a,node.id),
    actors: node.actors,
    locationNames: node.locationNames,
    clues: node.clues,
    new_facts: node.new_facts,
    world_delta: node.world_delta,
    time_text: node.time_text,
  }
  return {当前节点:current,后文概览:next.length ?
    next.map(n=>({node_id:n.id,summary:text(n.summary)||'概览缺失'})) : '无后续节点'}
}
export function scheduleEvent(plan: NarrativePlan, a: NarrativeAssets, reviewIndex?:ReviewIndex): NarrativeTask | undefined {
  const index=plan.reviewOnly ? -1 : a.nodes.findIndex(n=>!Object.hasOwn(plan.nodes,text(n.id)))
  if (index<0) return scheduleReview(plan,a,reviewIndex ?? indexReviewGroups(a))
  const node=a.nodes[index]
  const task:NarrativeTask={id:crypto.randomUUID(),mode:'link_node',part:'batch',ids:[text(node.id)],
    prompt:formatLinkNodeInput(nodeMaterial(node,a,index),[],a.events.length),basis:{}}
  plan.active=task
  return task
}
function searchPriorNodes(a: NarrativeAssets, before: number, args: Row) {
  const items: Row[] = []
  let total = 0
  const terms = (args.groups as string[][]).map(group => group.map(term => term.trim()))
  const fields = args.return_fields === undefined ? ['summary'] : strings(args.return_fields)
  if (terms.some(group => group.includes(''))) throw Error('检索词不能为空。')
  for (let i = before - 1; i >= 0; i--) {
    const node = a.nodes[i]
    const process = text(node.process)
    if (!terms.some(group => group.every(term => process.includes(term)))) continue
    total++
    if (items.length === 20) continue
    const data: Row = args.return_fields === undefined ? nodeCard(node) : nodeDetails(node,a)
    items.push(Object.fromEntries(['node_id',...fields].map(key => [key,data[key]])))
  }
  return {items,total,truncated:items.length < total}
}

export function readEventTool(name: string, args: Row, task: NarrativeTask, a: NarrativeAssets): Row {
  const link = task.mode === 'link_node'
  const index = a.nodes.findIndex(n => n.id === task.ids[0])
  if (link && index < 0) throw Error('当前节点已移除。')
  if (name === 'search_prior_nodes' && link) return searchPriorNodes(a,index,args)
  const readable = link ? a.nodes.slice(0,index+6) : a.nodes
  if (name === 'get_nodes') {
    const ids = strings(args.node_ids)
    const nodes = new Map(readable.map(n => [n.id,n]))
    return {items:ids.flatMap(id => nodes.has(id) ? [nodeDetails(nodes.get(id)!,a)] : []),not_found_ids:ids.filter(id=>!nodes.has(id))}
  }
  if (name === 'get_event') {
    const e = a.events.find(r=>r.id===args.event_id)
    return e ? eventDetail(e,a) : {event_id:args.event_id,status:'not_found'}
  }
  if (name !== 'search_events' && (name !== 'search_nodes' || link)) throw Error('当前任务没有此查询工具。')
  const groups = args.groups as string[][]
  if (groups.some(group => group.some(term => !term.trim()))) throw Error('检索词不能为空。')
  const matches = (body:string) => groups.some(group => group.every(term => body.includes(term.trim())))
  let items: Row[]
  if (name === 'search_events') {
    items = a.events.filter(e => matches([e.title,e.summary].join('\n'))).map(eventFields)
  } else {
    const pos = (id:unknown, fallback:number) => {
      if (id == null) return fallback
      const i = a.nodes.findIndex(n=>n.id===id)
      if (i < 0 || !readable.includes(a.nodes[i])) throw Error('区间端点不存在或不在可查范围。')
      return i
    }
    const after = pos(args.after_node_id,-1), before = pos(args.before_node_id,a.nodes.length)
    if (after >= before) throw Error('检索区间顺序错误。')
    const excluded = args.exclude_event_id && a.events.find(e=>e.id===args.exclude_event_id)
    if (args.exclude_event_id && !excluded) throw Error('排除的事件不存在。')
    const omit = new Set(excluded ? membersOf(excluded as Row) : [])
    items = a.nodes.slice(after+1,before).filter(n=>!omit.has(text(n.id)) && matches(text(n.process))).map(n=>nodeDetails(n,a))
  }
  const fields = args.return_fields === undefined ? ['name',name==='search_events'?'overview':'summary'] : strings(args.return_fields)
  const idKey = name === 'search_events' ? 'event_id':'node_id'
  return {groups, scope:'全书', after_node_id:args.after_node_id, before_node_id:args.before_node_id,
    exclude_event_id:args.exclude_event_id,total:items.length, truncated:items.length>100,
    items:items.slice(0,100).map(r=>Object.fromEntries([idKey,...fields].map(k=>[k,r[k]])))}
}
export async function editEvents(store: AgentStore, bookId:string, args:Row, task:NarrativeTask, plan:NarrativePlan, a:NarrativeAssets) {
  const link = task.mode === 'link_node'
  const position = a.nodes.findIndex(n=>n.id===task.ids[0])
  const knownNodes = new Set(a.nodes.map(n=>n.id))
  const allowed = link ? new Set(a.nodes.slice(0,position+1).map(n=>n.id)) : knownNodes
  const events = new Map(a.events.map(e => [text(e.id),e]))
  const known = new Set(events.keys())
  const touched = new Set<string>()
  const deleted:string[] = [], saved:Row[] = [], changes:Row[] = []
  const previous = new Set(a.events.flatMap(membersOf))
  const replacements = new Set<string>()
  for (const op of records(args.changes)) {
    if (!text(op.reason).trim()) throw Error('请说明修改理由。')
    const create = op.op==='create'
    const id = create ? crypto.randomUUID() : text(op.event_id)
    if (task.mode==='review_sequence' && (op.op!=='update' || id!==task.ids[0])) throw Error('逐件主审只可修改当前事件，结构调整请转回宏观。')
    const old = events.get(id)
    if ((!create && !known.has(id)) || touched.has(id)) throw Error('事件编号不存在或整批重复修改。')
    touched.add(id)
    const evidence = strings(op.evidence_node_ids)
    if (evidence.some(n=>!allowed.has(n))) throw Error('证据节点超过本轮范围。')
    if (op.op==='delete') {
      if (link) throw Error('串联阶段不能删除事件。')
      for (const target of strings(op.replacement_event_ids)) {
        if (target===id || !known.has(target)) throw Error('替代事件须为已存在的其他事件。')
        replacements.add(target)
      }
      deleted.push(id)
      events.delete(id)
    } else {
      const fields = op.fields as Row
      if (Object.values(fields).some(v=>typeof v==='string' && v.trim()!==v)) throw Error('文本字段首尾不能留空。')
      const next:Row = {...old,id,bookId,revision:Number(old?.revision ?? 0)+1}
      for (const [k,v] of Object.entries(fields)) next[fieldMap[k]]=v
      const ids = membersOf(next)
      const previousMembers = new Set(membersOf(old ?? {}))
      if (ids.some(n=>!knownNodes.has(n) || (!allowed.has(n) && !previousMembers.has(n)))) throw Error('节点不存在或超出本轮范围。')
      if (link && old && [...previousMembers].some(n=>!ids.includes(n))) throw Error('串联阶段须保留已有成员。')
      const set = new Set(ids)
      next.nodeIds=a.nodes.filter(n=>set.has(text(n.id))).map(n=>n.id)
      if (old && boundary(old)===boundary(next)) next.revision=old.revision
      events.set(id,next)
      saved.push(next)
    }
    const before = membersOf(old ?? {}), after = membersOf(events.get(id) ?? {})
    changes.push({event_id:id, added:after.filter(n=>!before.includes(n)), removed:before.filter(n=>!after.includes(n)),
      reason:op.reason, evidence_node_ids:evidence, replacement_event_ids:op.replacement_event_ids ?? []})
  }
  if ([...replacements].some(id=>!events.has(id))) throw Error('替代事件在本次修改后须存在。')
  const assigned = new Set([...events.values()].flatMap(membersOf))
  for (const e of saved) await store.put('storyEvents',e)
  for (const id of deleted) await store.remove('storyEvents',id)
  const changedMembers=new Set(changes.filter(c=>strings(c.added).length || strings(c.removed).length).map(c=>text(c.event_id)))
  const removed=new Set(deleted)
  const linked=a.lines.filter(line=>strings(line.eventIds).some(id=>changedMembers.has(id) || removed.has(id)))
  if (linked.length) {
    const timestamp=new Date().toISOString()
    for (const line of linked) {
      const original=strings(line.eventIds), remaining=original.filter(id=>!removed.has(id))
      if (remaining.length!==original.length) await store.put('eventLines',{...line,eventIds:remaining,
        revision:Number(line.revision ?? 0)+1,updatedAt:timestamp})
    }
    await synchronizeOutline(store,timestamp,false)
  }
  const lost = [...previous].filter(id=>!assigned.has(id))
  for (const id of lost) plan.retained[id]=changes.filter(c=>strings(c.removed).includes(id)).map(c=>text(c.reason)).join('；')
  for (const id of assigned) delete plan.retained[id]
  if (plan.eventReview) {
    const affectedMembers = new Set<string>()
    for (const id of touched) {
      delete plan.eventReview.checked[id]
      delete plan.eventReview.pending[id]
      const before = a.events.find(e => e.id === id), after = events.get(id)
      if (before && after && boundary(before) === boundary(after)) continue
      for (const row of [before,after]) if (row) for (const member of membersOf(row)) affectedMembers.add(member)
    }
    for (const e of events.values()) {
      if (membersOf(e).some(id => affectedMembers.has(id))) delete plan.eventReview.checked[text(e.id)]
    }
  }
  if (plan.twoStep) {
    for (const id of touched) {
      delete plan.twoStep.checked[id]
      delete plan.twoStep.pending[id]
    }
  }
  return {ok:true,...(link && {current_node_assigned:assigned.has(task.ids[0])}),events:saved.map(eventFields),deleted_event_ids:deleted,unassigned_node_ids:lost,changes}
}
export function confirmEvent(plan:NarrativePlan, a:NarrativeAssets, args:Row) {
  const task = plan.active!, id = task.ids[0]
  if (twoStepMode(task.mode)) return finishReview(plan,a,args)
  if (task.mode==='link_node') {
    if (args.result!=='completed' || args.pending_issues) throw Error('节点串联请确认 completed。')
    if (!eventIdList(a,id).length) {
      if (!text(args.unassigned_reason).trim()) throw Error('请填写当前节点的未归属理由。')
      plan.retained[id]=text(args.unassigned_reason)
    }
    plan.nodes[id]='completed'
    plan.batches.event++
  } else {
    const state = plan.eventReview!
    if (state.retryIds) state.retryIds=state.retryIds.filter(target=>target!==id)
    if (args.unassigned_reason) throw Error('事件复核不接受节点保留理由。')
    if (args.result==='pending_review') {
      if (!a.events.some(e=>e.id===id) || !records(args.pending_issues).length || args.reviewed_event_ids) throw Error('待核实的当前事件须存在，且须填写问题、已查范围与原因。')
      state.pending[id]=records(args.pending_issues)
    } else {
      if (args.pending_issues) throw Error('待核实问题须以 pending_review 确认。')
      for (const target of [id,...strings(args.reviewed_event_ids)]) {
        const e = a.events.find(row=>row.id===target)
        if (!e && target!==id) throw Error('复核事件不存在。')
        if (e) state.checked[target]=boundary(e)
        delete state.pending[target]
      }
    }
  }
  delete plan.active
}

