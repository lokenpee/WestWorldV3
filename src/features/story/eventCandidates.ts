import type { VectorCache } from './eventVectorCache'
import { strings, text } from '../agents/contracts'
import type { Row } from '../agents/repository'

export interface CandidateModels {
  embeddings(inputs: string[], signal: AbortSignal): Promise<number[][]>
  rerank(query: string, documents: string[], signal: AbortSignal): Promise<number[]>
}

type Assets = {nodes: Row[]; events: Row[]}
const normalize = (s: string) => s.normalize('NFKC').trim().toLowerCase()
const segmenter = new Intl.Segmenter('zh', {granularity:'word'})
const fieldLength = (s: string) => [...segmenter.segment(s)].filter(w => w.isWordLike).length
const clueList = (e: Row) => strings(e.clues)
const unresolvedText = (event: Row) => {
  const question = text(event.unresolved)
  // 旧提示词指定的闭环占位语与空值含义相同。
  return event.status === '已闭环' && question.trim() === '事件已结束，暂无待解决问题' ? '' : question
}
const eventFields = (e: Row) => [text(e.title), text(e.summary), text(e.latestProgress), unresolvedText(e), clueList(e).join('\n')]
const cosine = (a: number[], b: number[]) => {
  if (!a.length || a.length !== b.length) throw Error('向量维度不一致')
  let dot = 0, left = 0, right = 0
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; left += a[i]**2; right += b[i]**2 }
  if (!left || !right) throw Error('检索模型返回了零向量')
  return dot / Math.sqrt(left * right)
}

type VectorProgress = (ready: number, total: number) => void

class EventVectors {
  private values = new Map<string, number[]>()
  private remote: CandidateModels
  private cache?: VectorCache
  constructor(remote: CandidateModels, cache?: VectorCache) { this.remote = remote; this.cache = cache }
  get(body: string) { return this.values.get(body) }
  async prepare(texts: string[], signal: AbortSignal, prune: boolean, report?: VectorProgress) {
    signal.throwIfAborted()
    const unique = [...new Set(texts.filter(s => s.trim()))]
    const missing = unique.filter(s => !this.values.has(s))
    let ready = unique.length - missing.length
    if (missing.length || prune) report?.(ready,unique.length)
    for (let i = 0; i < missing.length; i += 16) {
      signal.throwIfAborted()
      const batch = missing.slice(i,i+16)
      const stored = await this.cache?.read(batch)
      const fresh = batch.filter((s,k) => {
        const value = stored?.[k]
        if (!value) return true
        this.values.set(s,value)
        return false
      })
      ready += batch.length - fresh.length
      if (fresh.length) {
        if (fresh.length < batch.length) report?.(ready,unique.length)
        const values = await this.remote.embeddings(fresh,signal)
        signal.throwIfAborted()
        await this.cache?.save(fresh,values)
        fresh.forEach((s,k) => this.values.set(s,values[k]))
      }
      ready += fresh.length
      report?.(ready,unique.length)
    }
    signal.throwIfAborted()
    if (prune) await this.cache?.retain(unique)
  }
}

function keywords(node: Row) {
  const weights = new Map<string, number>()
  for (const [field, weight] of [['clues',0.5],['actors',0.3],['locationNames',0.2]] as const) {
    for (const term of new Set(strings(node[field]).map(normalize).filter(Boolean))) {
      weights.set(term,(weights.get(term) ?? 0) + weight)
    }
  }
  return weights
}

function indexedEvent(e: Row, fields: string[], terms: Map<string,number>) {
  const index = fields.map(field => {
    const body = normalize(field)
    const hits = new Map<string,number>()
    for (const term of terms.keys()) {
      const tf = body.split(term).length - 1
      if (tf) hits.set(term,tf)
    }
    return {length:fieldLength(body), hits}
  })
  return {id:text(e.id), fields, index, matched:new Set(index.flatMap(f=>[...f.hits.keys()])), similarity:undefined as number | undefined}
}
type IndexedEvent = ReturnType<typeof indexedEvent>
type Ranking = {
  degraded?: string
  ranked: {id:string; routes:string[]; matched_terms:string[]; rerank_score?:number}[]
}

function keywordScores(rows: IndexedEvent[], terms: Map<string,number>) {
  const scores = new Map(rows.map(row=>[row.id,0]))
  for (let f=0; f<5; f++) {
    const df = new Map<string,number>()
    let length = 0
    for (const row of rows) {
      const field = row.index[f]
      length += field.length
      for (const term of field.hits.keys()) df.set(term,(df.get(term) ?? 0)+1)
    }
    const average = length / rows.length || 1
    for (const row of rows) {
      const field = row.index[f]
      let score = 0
      for (const [term,tf] of field.hits) {
        const count = df.get(term)!
        const idf = Math.log1p((rows.length-count+0.5)/(count+0.5))
        score += terms.get(term)! * idf * (2.2*tf)/(tf+1.2*(0.25+0.75*field.length/average))
      }
      scores.set(row.id,scores.get(row.id)!+0.2*score)
    }
  }
  return scores
}
const ranked = (scores: Map<string,number>, limit: number) =>
  [...scores].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,limit).map(([id])=>id)
function rrf(routes: string[][]) {
  const scores = new Map<string,number>()
  for (const route of routes) route.forEach((id,i)=>scores.set(id,(scores.get(id) ?? 0)+1/(61+i)))
  return ranked(scores,30)
}

// 每个节点只保留一份预取结果。交接时重新核对当前事件数据，并复用可证明相同的计算。
class NodeLookup {
  private indexed = new Map<string,IndexedEvent>()
  private reranked = new Map<string,{body:string; score:number}>()
  private key = ''
  private previous?: Ranking
  private remote: CandidateModels
  private vectors: EventVectors
  constructor(remote: CandidateModels, vectors: EventVectors) {
    this.remote = remote
    this.vectors = vectors
  }

  async rank(node: Row, events: Row[], signal: AbortSignal, initialError?: string) {
    signal.throwIfAborted()
    const terms = keywords(node), detail = text(node.process), summary = text(node.summary)
    const key = JSON.stringify([[...terms],detail,summary])
    if (this.key !== key) { this.indexed.clear(); this.reranked.clear(); this.previous = undefined; this.key = key }
    const rows = events.map(event=>{
      const before = this.indexed.get(text(event.id))
      const fields = eventFields(event)
      if (before && fields.every((v,i)=>v===before.fields[i])) return before
      const row = indexedEvent(event,fields,terms)
      if (before && before.fields[3] === fields[3]) row.similarity = before.similarity
      return row
    })
    if (!initialError && this.previous && !this.previous.degraded && rows.length === this.indexed.size &&
        rows.every(row => this.indexed.get(row.id) === row)) return this.previous
    this.indexed = new Map(rows.map(row=>[row.id,row]))
    const localScores = keywordScores(rows,terms)
    const local = ranked(localScores,20)
    let selected = local.slice(0,10), semantic: string[] = [], degraded = initialError
    if (!degraded && rows.length) {
      try {
        const source = this.vectors.get(detail)
        const similarities = new Map<string,number>()
        for (const row of rows) {
          const target = this.vectors.get(row.fields[3])
          if (!source || !target) continue
          row.similarity ??= cosine(source,target)
          similarities.set(row.id,row.similarity)
        }
        semantic = ranked(similarities,20)
        const shortlist = rrf([local,semantic])
        const scored = new Map<string,{body:string; score:number}>()
        const missing: {id:string;body:string}[] = []
        for (const id of shortlist) {
          const body = this.indexed.get(id)!.fields.join('\n')
          const saved = this.reranked.get(id)
          if (saved?.body === body) scored.set(id,saved)
          else missing.push({id,body})
        }
        if (missing.length) {
          if (!summary.trim()) throw Error('当前节点缺少用于重排的概述')
          const scores = await this.remote.rerank(summary,missing.map(item=>item.body),signal)
          missing.forEach((item,i)=>scored.set(item.id,{body:item.body,score:scores[i]}))
        }
        this.reranked = scored
        selected = shortlist.sort((a,b)=>scored.get(b)!.score-scored.get(a)!.score).slice(0,10)
      } catch (error) {
        signal.throwIfAborted()
        semantic = []
        degraded = error instanceof Error ? error.message : '检索服务不可用'
      }
    }
    this.previous = {degraded, ranked:selected.map(id=>({
      id, routes:[...(local.includes(id)?['关键词']:[]),...(semantic.includes(id)?['向量']:[])],
      matched_terms:[...this.indexed.get(id)!.matched],
      rerank_score:degraded ? undefined : this.reranked.get(id)?.score,
    }))}
    return this.previous
  }
}

function materialize(result: Awaited<ReturnType<NodeLookup['rank']>>, assets: Assets) {
  const events = new Map(assets.events.map(e=>[text(e.id),e]))
  return {degraded:result.degraded, ranking:result.ranked, candidates:result.ranked.map(({id})=>{
    const e = events.get(id)!
    const memberIds = new Set(strings(e.nodeIds))
    return {event_id:id, name:e.title, overview:e.summary, latest_progress:e.latestProgress, unresolved:unresolvedText(e),
      clues:clueList(e), status:e.status, members:assets.nodes.filter(n=>memberIds.has(text(n.id)))
        .map(n=>({node_id:n.id,name:n.name}))}
  })}
}

export class EventCandidateLoader {
  private vectors: EventVectors
  private initialized = false
  private active?: {id:string; lookup:NodeLookup}
  private pending?: {id:string; lookup:NodeLookup; done:Promise<void>}
  private remote: CandidateModels
  private signal: AbortSignal
  constructor(remote: CandidateModels, signal:AbortSignal, cache?:VectorCache) {
    this.remote = remote
    this.signal = signal
    this.vectors = new EventVectors(remote,cache)
  }
  private async ensureVectors(assets: Assets, report?: VectorProgress) {
    try {
      const texts = [...assets.nodes.map(n=>text(n.process)), ...assets.events.map(unresolvedText)]
      await this.vectors.prepare(texts,this.signal,!this.initialized,report)
      this.initialized = true
    } catch (error) {
      this.signal.throwIfAborted()
      const reason = error instanceof Error ? error.message : '检索服务不可用'
      return '向量未完成，已使用本地关键词继续。'+reason
    }
  }
  async prepare(assets: Assets, report?: VectorProgress) {
    await this.pending?.done
    return this.ensureVectors(assets,report)
  }
  async load(id: string, assets: Assets) {
    return this.rankPrepared(id,assets,await this.prepare(assets))
  }
  async rankPrepared(id: string, assets: Assets, error?: string) {
    const node = assets.nodes.find(n=>n.id===id)
    if (!node) throw Error('当前节点已移除，请核对本书节点。')
    const pending = this.pending
    if (pending) {
      this.pending = undefined
      if (pending.id===id) this.active = pending
    }
    if (this.active?.id!==id) this.active = {id,lookup:new NodeLookup(this.remote,this.vectors)}
    const result = await this.active.lookup.rank(node,assets.events,this.signal,error)
    return materialize(result,assets)
  }
  prefetch(id: string, assets: Assets) {
    if (this.pending?.id===id) return
    const node = assets.nodes.find(n=>n.id===id)
    if (!node) return
    const lookup = new NodeLookup(this.remote,this.vectors)
    const done = (async () => {
      const error = await this.ensureVectors(assets)
      await lookup.rank(node,assets.events,this.signal,error)
    })().catch(()=>{ /* 暂停或预取失败时，正式任务从最新资料重新读取。 */ })
    this.pending = {id,lookup,done}
  }
}
