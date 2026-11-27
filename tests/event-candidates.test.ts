import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import { EventCandidateLoader } from '../src/features/story/eventCandidates'
import { bookVectorCache } from '../src/features/story/eventVectorCache'
import { createRetrievalSettings } from '../src/features/models/retrievalSettings'
import { retrievalModels } from '../src/features/models/eventRetrieval'
import { createWorkspace } from '../src/lib/storage/workspace'

const signal = new AbortController().signal
const nodes = [
  {id:'N1',name:'早期节点',summary:'第一条概述',process:'第一条经过',clues:['范仪冤案'],actors:['范仪'],locationNames:['京兆']},
  {id:'N2',name:'本轮节点',summary:'第二条概述',process:'第二条经过',clues:['范仪冤案']},
]
const event = (id:string,title:string,unresolved:string) => ({
  id,title,summary:'事件概述',latestProgress:'当前进展',unresolved,clues:['印信'],nodeIds:['N1'],
})

it('两个独立 Top20 融合取前三十，以节点概述和事件五个字段重排取十',async()=>{
  const events = Array.from({length:40},(_,i)=>event(String(i).padStart(2,'0'),i<20?'范仪冤案':'另案',i<20?'相反':'相关'+i))
  const remote = {
    embeddings:vi.fn(async (inputs:string[])=>inputs.map(t=>t==='相反' ? [-1,0] : [1,0])),
    rerank:vi.fn(async (query:string,docs:string[])=>{
      expect(query).toBe('第一条概述')
      expect(docs).toHaveLength(30)
      expect(docs.every(t=>t.split('\n').length===5 && !t.includes('早期节点'))).toBe(true)
      return docs.map((_,i)=>i)
    }),
  }
  const loader = new EventCandidateLoader(remote,signal)
  const result = await loader.load('N1',{nodes,events})
  expect(new Set(remote.embeddings.mock.calls.flatMap(([texts])=>texts))).toEqual(
    new Set([...nodes.map(n=>n.process),...events.map(e=>e.unresolved)]))
  expect(result.candidates).toHaveLength(10)
  expect(result.ranking[0].rerank_score).toBe(29)
  expect(result.candidates[0].members).toEqual([{node_id:'N1',name:'早期节点'}])
  for (const key of ['routes','matched_terms','rerank_score']) expect(result.candidates[0]).not.toHaveProperty(key)
})

it('预取后校正新增、删除、修改和成员变化；重新打开书库复用向量',async()=>{
  const settingsName = 'p3-vectors-'+crypto.randomUUID()
  const scope = {settingsName,bookPrefix:settingsName+'-'}
  const bookId = 'book'
  let workspace = createWorkspace(scope)
  const embed = vi.fn(async (inputs:string[])=>inputs.map(()=>[1,0]))
  const rerank = vi.fn(async (_q:string,docs:string[])=>docs.map((_,i)=>i))
  const models = {embeddings:embed,rerank}
  const original = [event('A','范仪冤案','甲'),event('B','旧名称','乙'),event('C','待删除','丙')]
  try {
    const loader = new EventCandidateLoader(models,signal,bookVectorCache(workspace,bookId,'sample'))
    await loader.load('N1',{nodes,events:original})
    loader.prefetch('N2',{nodes,events:original})
    const revised = [{...original[0],nodeIds:['N2','N1']},{...original[1],title:'新名称',unresolved:'新乙'},event('D','新建','丁')]
    const result = await loader.load('N2',{nodes,events:revised})
    expect(result.candidates.map(c=>c.event_id).sort()).toEqual(['A','B','D'])
    expect(result.candidates.find(c=>c.event_id==='A')?.members.map(n=>n.node_id)).toEqual(['N1','N2'])
    const calls = rerank.mock.calls.filter(([q])=>q==='第二条概述')
    expect(calls.map(([,docs])=>docs.map(d=>d.split('\n')[0]).sort())).toEqual([
      ['范仪冤案','旧名称','待删除'].sort(),['新名称','新建'].sort()])
    expect(embed.mock.calls.at(-1)?.[0].sort()).toEqual(['丁','新乙'].sort())
    const count = embed.mock.calls.length
    workspace.close()
    workspace = createWorkspace(scope)
    const reopened = new EventCandidateLoader(models,signal,bookVectorCache(workspace,bookId,'sample'))
    await reopened.load('N1',{nodes,events:revised})
    expect(embed).toHaveBeenCalledTimes(count)
  } finally { workspace.close(); await workspace.removeBookDatabase(bookId) }
})

it('外部不可用时使用三类原文关键词和五个事件字段，零命中也按排名列出',async()=>{
  const config = {modelId:'sample',baseUrl:'https://fixture.invalid',apiKey:'fixture'}
  const remote = retrievalModels({embedding:config,rerank:config},async()=>new Response('',{status:429}))
  const loader = new EventCandidateLoader(remote,signal)
  const events = [
    {...event('线','名称',''),clues:['范仪冤案']},
    {...event('人','名称',''),summary:'讯问范仪'},
    {...event('地','名称',''),latestProgress:'报到京兆'},
    event('无','第二条经过',''),
  ]
  const result = await loader.load('N1',{nodes,events})
  expect(result.degraded).toContain('429')
  expect(result.candidates.map(c=>c.event_id).sort()).toEqual(['人','地','线','无'].sort())
  expect(result.candidates.at(-1)?.event_id).toBe('无')
  expect(result.ranking.every(c=>c.routes.join()==='关键词')).toBe(true)
  expect((await loader.load('N1',{nodes,events:[events[3]]})).candidates.map(e=>e.event_id)).toEqual(['无'])
})

it('从独立配置拉取候选、验证和保存，正式召回使用对应服务与模型', async()=>{
  const workspace = createWorkspace({settingsName:crypto.randomUUID(),bookPrefix:'retrieval-test-'})
  const calls: string[] = []
  const embedded: string[] = []
  const send: typeof fetch = async (url,init)=>{
    const address = new URL(String(url))
    const role = address.hostname.split('.')[0]
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer '+role)
    if (address.pathname==='/v1/models') return Response.json({data:[
      {id:'vec',sub_type:'embedding'}, {id:'rank-alias'}, {id:'chat',type:'chat'},
    ]})
    const req = JSON.parse(String(init?.body))
    calls.push(role+' '+address.pathname+' '+req.model)
    if (role==='embedding') embedded.push(...req.input)
    if (role==='embedding') return Response.json({data:req.input.map((_:string,index:number)=>({index,embedding:[0.75,0.25]}))})
    return Response.json({results:req.documents.map((_:string,index:number)=>({index,relevance_score:index}))})
  }
  try {
    const settings = createRetrievalSettings(workspace,send)
    for (const role of ['embedding','rerank'] as const) {
      const list = await settings.catalog(role,'https://'+role+'.invalid/v1',role,signal)
      expect(list.modelIds).toEqual(role==='embedding' ? ['vec'] : [])
      expect(list.untypedIds).toEqual(['rank-alias'])
      await expect(list.testAndSave('chat',signal)).rejects.toThrow()
      await list.testAndSave(role==='embedding' ? 'vec' : 'rank-alias',signal)
    }
    const failed = createRetrievalSettings(workspace,async (url,init)=>
      String(url).endsWith('/models') ? send(url,init) : new Response(null,{status:401}))
    const other = await failed.catalog('rerank','https://second.invalid/v1','second',signal)
    await expect(other.testAndSave('rank-alias',signal)).rejects.toThrow('401')
    await expect(settings.catalog('embedding','https://new.invalid/v1','',signal)).rejects.toThrow('缺少密钥')
    calls.length = 0
    embedded.length = 0
    const runtime = await createRetrievalSettings(workspace,send).runtime()
    const result = await new EventCandidateLoader(runtime.models,signal).load('N1',{nodes,events:[
      event('A','甲案',''),event('B','乙案','问题二'),{...event('C','丙案','事件已结束，暂无待解决问题'),status:'已闭环'},
    ]})
    expect(result.degraded).toBeUndefined()
    expect(embedded).toEqual([...nodes.map(n=>n.process),'问题二'])
    expect(result.ranking.map(c=>c.rerank_score)).toEqual([2,1,0])
    expect(result.candidates.find(e=>e.event_id==='C')?.unresolved).toBe('')
    expect(result.ranking.find(r=>r.id==='A')?.routes).toEqual(['关键词'])
    expect(calls).toEqual(['embedding /v1/embeddings vec','rerank /v1/rerank rank-alias'])
  } finally {workspace.close();await workspace.settings.delete()}
})
