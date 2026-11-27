import { canonical, records, strings, text } from '../agents/contracts'
import type { Row } from '../agents/repository'
import { eventFields } from './eventWorkflow'
import type { NarrativeAssets, NarrativeTask } from './narrativePlan'
import type { Outcome } from './narrativeOutcome'

const fieldLabels = {
  name:'事件名称', overview:'事件概述', latest_progress:'最新进展',
  unresolved:'待解决问题', clues:'核心线索', status:'事件状态',
}
type Member = {id:string; name:string; summary:string; order?:number}
type Edit = {
  op:string; before?:Row; after?:Row; revision?:number; delta:Row; submitted:Row
}

/** 此快照随本地回执保存，模型仍收到原生工具的短回包。 */
export function captureEventDisplay(a:NarrativeAssets, task:NarrativeTask, name:string, args:Row, result:Row) {
  const edits = name === 'edit_events'
  const touched = new Set(records(result.changes).map(c => text(c.event_id)))
  const reviewed = new Set([...task.ids,...strings(args.reviewed_event_ids)])
  const originals = a.events.filter(e => edits ? touched.has(text(e.id)) :
    task.mode === 'link_node' ? strings(e.nodeIds).includes(task.ids[0]) : reviewed.has(text(e.id)))
  const events = originals.map(e => ({...eventFields(e),revision:e.revision}))
  const ids = new Set([...originals,...records(result.events)].flatMap(e => strings(e.nodeIds)))
  const nodes = a.nodes.flatMap((n,order) => ids.has(text(n.id))
    ? [{id:text(n.id),name:text(n.name),summary:text(n.summary),order}] : [])
  return {events,nodes}
}

const showValue = (key:string,value:unknown) => Array.isArray(value) ? value.join('、') || '无' :
  text(value) || (key === 'unresolved' ? '无待解决问题' : '空')

// 旧版回执没有成员快照，可从当时已经保存的任务输入补出名称和概述。
function recordedMembers(task:NarrativeTask):Member[] {
  const block = (label:string) => {
    const line = task.prompt.split('【'+label+'开始】')[1]?.trimStart().split(/\r?\n/)[0]
    if (!line) return undefined
    try { return JSON.parse(line) } catch { return undefined }
  }
  let candidates:Row[] = [], material:Row[] = []
  if (task.mode === 'link_node') {
    candidates = records(block('排序召回事件'))
    const current = block('当前节点概览')
    if (current) material = [current]
  } else {
    try {
      const input = JSON.parse(task.prompt)
      material = records(input.本组成员时间表 ?? input.节点时间表 ?? input.成员时间表)
      candidates = [input.当前事件].filter(Boolean)
    } catch { return [] }
  }
  return [...candidates.flatMap(e=>records(e.members)),...material]
    .map(n=>({id:text(n.node_id),name:text(n.name),summary:text(n.summary)}))
}

function eventCard(id:string, edits:Edit[], nodes:Map<string,Member>, current:string, confirmed?:Row, fallback?:Outcome[number]) {
  // 同一事件的持久版本可区分同一毫秒内的多次成功写入。
  edits.sort((a,b) => a.revision !== undefined && b.revision !== undefined ? a.revision-b.revision : 0)
  const first = edits[0], last = edits.at(-1)
  const created = first?.op === 'create', deleted = last?.op === 'delete'
  const before = first?.before ?? (!first ? confirmed : undefined)
  const after = last ? last.after : confirmed
  const additions = new Set<string>(), removals = new Set<string>()
  for (const {delta} of edits) {
    for (const n of strings(delta.added)) if (!removals.delete(n)) additions.add(n)
    for (const n of strings(delta.removed)) if (!additions.delete(n)) removals.add(n)
  }
  const finalIds = after ? strings(after.nodeIds) : deleted ? [] : fallback?.items.map(n=>n.id) ?? []
  const all = new Set([...finalIds,...removals,...additions])
  const members = [...all].map(nodeId => {
    const n = nodes.get(nodeId)
    const badge = removals.has(nodeId) ? '本次移除' : additions.has(nodeId)
      ? current ? nodeId === current ? '新加入 · 当前节点' : '新加入 · 历史补挂' : '新加入' : ''
    return {id:nodeId,name:n?.name || fallback?.items.find(i=>i.id===nodeId)?.title || '',
      summary:n?.summary ?? '',order:n?.order,badge,current:nodeId === current}
  }).sort((a,b) => (a.order ?? Infinity)-(b.order ?? Infinity))
  const fields = Object.entries(fieldLabels).flatMap(([key,label]) => {
    if (!after || !edits.length || !Object.hasOwn(after,key)) return []
    if (before && canonical(before[key]) === canonical(after[key])) return []
    if (!before && !created && !edits.some(e=>Object.hasOwn(e.submitted,key))) return []
    const previous = created ? undefined : before && Object.hasOwn(before,key) ? showValue(key,before[key]) : '原值未记录'
    return [{key,label,previous,value:showValue(key,after[key])}]
  })
  const resultCount = after || deleted ? finalIds.length : undefined
  const initialCount = before ? strings(before.nodeIds).length : created ? 0 :
    resultCount === undefined || deleted ? undefined : resultCount-additions.size+removals.size
  const title = text(after?.name ?? last?.before?.name ?? before?.name) || fallback?.parent.title || id
  const action = deleted ? (created ? '本轮新建后撤销' : '本轮撤销') : created ? '本轮新建' :
    edits.length || confirmed ? '已有事件' : '确认时已归属'
  return {id,title,action,fields,members,initialCount,resultCount,added:additions.size,removed:removals.size,
    latestOnly:!!first && !created && !before, edits}
}

export function buildEventTaskOutcome(task:NarrativeTask, receipts:Row[], fallback:Outcome = []) {
  const history = new Map<string,Edit[]>(), nodes = new Map<string,Member>(), checked = new Map<string,Row>()
  if ((!receipts.length && fallback.length) || receipts.some(r=>!(r.result as Row | undefined)?.display)) {
    for (const n of recordedMembers(task)) nodes.set(n.id,n)
  }
  let confirm:Row | undefined
  for (const receipt of receipts) {
    if (receipt.status !== 'completed') continue
    const result = receipt.result as Row
    const args = receipt.arguments as Row
    const display = result?.display as Row | undefined
    for (const n of records(display?.nodes)) {
      const id = text(n.id)
      nodes.set(id,{id,name:text(n.name),summary:text(n.summary),order:Number(n.order)})
    }
    const originals = new Map(records(display?.events).map(e => [e.event_id,e]))
    if (receipt.name === 'confirm') {
      confirm = args
      for (const [id,event] of originals) checked.set(text(id),event)
    }
    if (receipt.name !== 'edit_events') continue
    const saved = new Map(records(result.events).map(e=>[e.event_id,e]))
    const ops = records(args.changes)
    for (const [index,delta] of records(result.changes).entries()) {
      const id = text(delta.event_id), before = originals.get(id), op = ops[index]
      const edits = history.get(id) ?? []
      edits.push({op:text(op?.op),before,after:saved.get(id),delta,submitted:(op?.fields ?? {}) as Row,
        revision:before ? Number(before.revision) : op?.op === 'create' ? 0 : undefined})
      history.set(id,edits)
    }
  }
  const link = task.mode === 'link_node'
  const groups = new Map(fallback.filter(g=>g.parent.id).map(g=>[g.parent.id,g]))
  const ids = new Set([...history.keys(),...checked.keys(),...groups.keys()])
  const cards = [...ids].map(id => eventCard(id,history.get(id) ?? [],nodes,link ? task.ids[0] : '',checked.get(id),groups.get(id)))
  const unassigned = text(confirm?.unassigned_reason) || fallback.find(g=>!g.parent.id)?.items.map(n=>n.title).join('、')
  const state = confirm?.result === 'return_to_macro' ? '已转回宏观' : confirm?.result === 'pending_review' ? '待核实' : unassigned ? '保留未归属' :
    confirm || fallback.length ? '已确认' : '尚未确认'
  return {link,state,unassigned,cards,issues:confirm?.result==='return_to_macro' ? [text(confirm.reason)] : records(confirm?.pending_issues).map(p=>[p.issue,p.checked_scope,p.reason].filter(Boolean).join(' · '))}
}
export type EventTaskResult = ReturnType<typeof buildEventTaskOutcome>
