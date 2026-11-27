import { canonical, records, strings, text } from '../agents/contracts'
import type { Row } from '../agents/repository'
import type { NarrativeAssets, NarrativePlan, NarrativeTask } from './narrativePlan'
import { withReviewMaterialGuide } from './narrativeInput'
import { eventVersion, nextReviewGroup, pairKey, pairVersion, type ReviewIndex } from './eventReviewGroups'

type Referral = {ids:string[]; nodes:string[]; reason:string}
export interface TwoStepState {
  phase:'macro'|'micro'
  macroIssue?:Row[]
  retryMacro?:boolean
  retryIds?:string[]
  pausedGroup?:{ids:string[];orphanIds?:string[]}
  pairs:Record<string,string>
  checked:Record<string,string>
  pending:Record<string,Row[]>
  referral?:Referral
  answers:Record<string,{reason:string; question:string; version:string}>
}
export function newReviewState():TwoStepState {
  return {phase:'macro',pairs:{},checked:{},pending:{},answers:{}}
}
export const twoStepMode=(mode:string)=>mode==='review_boundaries' || mode==='review_sequence'
function card(e:Row) {
  return {event_id:e.id,name:text(e.title),overview:text(e.summary),latest_progress:text(e.latestProgress),unresolved:text(e.unresolved),clues:strings(e.clues),status:text(e.status)}
}
export function scheduleReview(plan:NarrativePlan,a:NarrativeAssets,index:ReviewIndex) {
  const state=plan.twoStep ??= newReviewState()
  for (const id of Object.keys(state.pending)) if (!index.events.has(id)) delete state.pending[id]
  if (state.referral && !state.referral.ids.some(id=>index.events.has(id))) delete state.referral
  const referral=state.referral
  if (state.macroIssue && !state.retryMacro) throw Error('事件复核待核实，补充依据后可继续。')
  const group=state.pausedGroup?.ids.filter(id=>index.events.has(id)) ?? referral?.ids.filter(id=>index.events.has(id)) ?? (state.phase==='macro' ? nextReviewGroup(index,state.pairs,plan.config.eventGroupSize) : undefined)
  let ids=group ?? []
  let mode:'review_boundaries'|'review_sequence'='review_boundaries'
  if (!ids.length) {
    state.phase='micro'
    const event=a.events.find(e=>state.checked[text(e.id)]!==eventVersion(e) && (!state.pending[text(e.id)] || state.retryIds?.includes(text(e.id))))
    if (!event) {
      if (Object.keys(state.pending).length) throw Error('事件复核待核实，补充依据后可继续。')
      return
    }
    mode='review_sequence'
    ids=[text(event.id)]
  }
  const selected=ids.map(id=>index.events.get(id)!)
  const members=new Set([...selected.flatMap(e=>strings(e.nodeIds)),...(referral?.nodes ?? [])])
  const timeline=a.nodes.filter(n=>members.has(text(n.id))).map(n=>({
    node_id:n.id,name:text(n.name),summary:text(n.summary),
    event_ids:(index.owners.get(text(n.id)) ?? []).map(id=>({event_id:id,name:index.events.get(id)?.title})),
  }))
  const id=ids[0], micro=mode==='review_sequence'
  const input=micro ? {主审事件:card(selected[0]),成员时间表:timeline,上次待核实事项:state.pending[id],
    宏观处理意见:state.answers[id]?.reason,本轮任务:'核验当前事件从起因到结果的经过，只确认本件。'} :
    {本组事件:selected.map(card),节点时间表:timeline,转回依据:referral,待核实事项:state.macroIssue,本轮任务:'比较本组事件的边界和成员，处理后确认本组。'}
  const basis:Record<string,string>={}
  for (const e of selected) for (const prefix of ['members:event:','read:event:']) basis[prefix+e.id]=eventVersion(e)
  const task:NarrativeTask={id:crypto.randomUUID(),mode,part:'structure',ids,
    prompt:JSON.stringify(withReviewMaterialGuide(input)),basis}
  plan.active=task
  return task
}
export function finishReview(plan:NarrativePlan,a:NarrativeAssets,args:Row) {
  const task=plan.active!, state=plan.twoStep!, id=task.ids[0]
  const events=new Map(a.events.map(e=>[text(e.id),e]))
  if (task.mode==='review_sequence') {
    state.retryIds=state.retryIds?.filter(i=>i!==id)
    const e=events.get(id)
    if (!e) throw Error('主审事件已不存在。')
    if (args.result==='return_to_macro') {
      delete state.pending[id]
      const ids=[...new Set([id,...strings(args.event_ids)])]
      const nodes=strings(args.evidence_node_ids)
      if (ids.some(i=>!events.has(i)) || nodes.some(i=>!a.nodes.some(n=>n.id===i))) throw Error('转回的事件或证据节点不存在。')
      const version=eventVersion(e)
      if (state.answers[id]?.version===version && state.answers[id]?.question===text(args.reason))
        throw Error('该结构疑点已有处理意见。如仍缺依据，可提交待核实事项。')
      state.phase='macro'
      state.referral={ids,nodes,reason:text(args.reason)}
    } else if (args.result==='pending_review') {
      state.pending[id]=records(args.pending_issues)
    } else {
      state.checked[id]=eventVersion(e)
      delete state.pending[id]
    }
  } else {
    if (args.result==='pending_review') {
      state.macroIssue=records(args.pending_issues)
      state.retryMacro=false
      state.pausedGroup={ids:task.ids}
      delete plan.active
      return
    }
    delete state.macroIssue
    delete state.pausedGroup
    delete state.retryMacro
    const live=task.ids.filter(i=>events.has(i))
    for (let i=0;i<live.length;i++) for (const other of live.slice(i+1)) {
      const pair=[live[i],other]
      state.pairs[pairKey(pair)]=pairVersion(pair,events)
    }
    if (state.referral) {
      for (const i of live) {
        delete state.checked[i]
        state.answers[i]={version:eventVersion(events.get(i)!),question:state.referral.reason,reason:text(args.reason)||'已核对分界，请依据当前事件和最新成员重审。'}
      }
      delete state.referral
    }
  }
  delete plan.active
}

export const reviewIndexKey=(a:NarrativeAssets)=>canonical([a.events.map(e=>[e.id,e.revision]),a.nodes.map(n=>[n.id,n.revision])])
