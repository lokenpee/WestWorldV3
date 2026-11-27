import { canonical, strings, text } from '../agents/contracts'
import type { Row } from '../agents/repository'
import type { CandidateModels } from './eventCandidates'
import type { NarrativeAssets } from './narrativePlan'

export type ReviewPair = {ids:[string,string]; shared:string[]; run:number; coverage:number; order:number; score:number}
export type ReviewIndex = ReturnType<typeof indexReviewGroups>
export const pairKey = (ids:string[]) => JSON.stringify([...ids].sort())
export const eventVersion = (e:Row) => String(e.revision ?? 0)
export function pairVersion(ids:string[], events:Map<string,Row>) {
  return canonical([...ids].sort().map(id => [id,eventVersion(events.get(id)!)]))
}

function add(index:Map<string,string[]>, key:string, id:string) {
  const bucket = index.get(key)
  if (bucket) bucket.push(id)
  else index.set(key,[id])
}

export function indexReviewGroups(a:NarrativeAssets, excluded:Iterable<string> = [], compare=true) {
  const owners = new Map<string,string[]>(), clues = new Map<string,string[]>()
  const events = new Map(a.events.map(e => [text(e.id),e]))
  const overlap:ReviewPair[] = [], semantic:ReviewPair[] = []
  if (!compare) {
    for (const [id,e] of events) for (const n of new Set(strings(e.nodeIds))) add(owners,n,id)
    return {owners,events,overlap,semantic}
  }
  const positions = new Map(a.nodes.map((n,i) => [text(n.id),i]))
  const members = new Map<string,Map<string,number>>()
  const names = new Set(excluded)
  for (const n of a.nodes) {
    for (const value of [...strings(n.actors),...strings(n.locationNames)]) names.add(value)
  }
  for (const [id,e] of events) {
    const sorted = [...new Set(strings(e.nodeIds))].sort((x,y)=>(positions.get(x) ?? Infinity)-(positions.get(y) ?? Infinity))
    members.set(id,new Map(sorted.map((n,i)=>[n,i])))
    for (const n of sorted) add(owners,n,id)
    for (const clue of new Set(strings(e.clues))) if (clue && !names.has(clue)) add(clues,clue,id)
  }
  const pairs = new Map<string,ReviewPair>()
  function pair(a:string,b:string) {
    const ids:[string,string] = a < b ? [a,b] : [b,a]
    const key = pairKey(ids)
    let p = pairs.get(key)
    if (!p) {
      p = {ids,shared:[],run:0,coverage:0,order:Infinity,score:0}
      pairs.set(key,p)
    }
    return p
  }
  for (const [n,ids] of owners) {
    for (let i=0;i<ids.length;i++) for (const second of ids.slice(i+1)) pair(ids[i],second).shared.push(n)
  }
  for (const p of pairs.values()) {
    const [left,right] = p.ids.map(id=>members.get(id)!)
    const count = p.shared.length, smaller = Math.min(left.size,right.size)
    if (count < 2 && smaller !== 1) continue
    p.shared.sort((x,y)=>left.get(x)!-left.get(y)!)
    p.coverage = count / smaller
    p.order = positions.get(p.shared[0]) ?? Infinity
    let prevLeft=-2, prevRight=-2, length=0
    for (const n of p.shared) {
      const l=left.get(n)!, r=right.get(n)!
      length = l===prevLeft+1 && r===prevRight+1 ? length+1 : 1
      p.run=Math.max(p.run,length)
      prevLeft=l
      prevRight=r
    }
    overlap.push(p)
  }
  const queued=new Set(overlap.map(p=>pairKey(p.ids)))
  for (const ids of clues.values()) {
    for (let i=0;i<ids.length;i++) for (const second of ids.slice(i+1)) {
      const key = pairKey([ids[i],second])
      if (queued.has(key)) continue
      queued.add(key)
      semantic.push(pair(ids[i],second))
    }
  }
  overlap.sort((a,b)=>Number(b.shared.length>1)-Number(a.shared.length>1) || b.run-a.run || b.shared.length-a.shared.length ||
    b.coverage-a.coverage || a.order-b.order || pairKey(a.ids).localeCompare(pairKey(b.ids)))
  semantic.sort((a,b)=>pairKey(a.ids).localeCompare(pairKey(b.ids)))
  return {owners,events,overlap,semantic}
}

/** Progress/questions in either direction may lead to the other event. Batch documents per query. */
export async function rankCluePairs(index:ReviewIndex, models:CandidateModels, signal:AbortSignal, cache:Map<string,number>) {
  const batches = new Map<string,Set<string>>()
  for (const pair of index.semantic) for (const [from,to] of [pair.ids,[...pair.ids].reverse()]) {
    const source=index.events.get(from)!, target=index.events.get(to)!
    const query=[source.latestProgress,source.unresolved].filter(Boolean).join('\n')
    const doc=[target.title,target.summary].filter(Boolean).join('\n')
    if (!query || !doc || cache.has(JSON.stringify([query,doc]))) continue
    if (!batches.has(query)) batches.set(query,new Set())
    batches.get(query)!.add(doc)
  }
  for (const [query,docs] of batches) {
    const all=[...docs]
    for (let i=0;i<all.length;i+=32) {
      signal.throwIfAborted()
      const slice=all.slice(i,i+32)
      const scores=await models.rerank(query,slice,signal)
      slice.forEach((doc,j)=>cache.set(JSON.stringify([query,doc]),scores[j]))
    }
  }
  for (const p of index.semantic) {
    const [a,b]=p.ids.map(id=>index.events.get(id)!)
    const score=(x:Row,y:Row)=>cache.get(JSON.stringify([[x.latestProgress,x.unresolved].filter(Boolean).join('\n'),[y.title,y.summary].filter(Boolean).join('\n')])) ?? -Infinity
    p.score=Math.max(score(a,b),score(b,a))
  }
  index.semantic.sort((a,b)=>b.score-a.score || pairKey(a.ids).localeCompare(pairKey(b.ids)))
}

export function nextReviewGroup(index:ReviewIndex, checked:Record<string,string>, limit:number) {
  const needs=(ids:string[])=>checked[pairKey(ids)]!==pairVersion(ids,index.events)
  for (const pairs of [index.overlap,index.semantic]) for (const seed of pairs) {
    if (!needs(seed.ids)) continue
    const hits=new Map<string,number>()
    for (const n of seed.shared) for (const id of index.owners.get(n) ?? []) {
      if (!seed.ids.includes(id)) hits.set(id,(hits.get(id) ?? 0)+1)
    }
    const extras=[...hits].filter(([id,count])=>count>=2 && seed.ids.some(other=>needs([id,other])))
      .sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,Math.max(0,limit-2))
    return [...seed.ids,...extras.map(([id])=>id)]
  }
}
