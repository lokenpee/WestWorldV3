import { narrativeMaterial } from './support/agent-protocol'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { createImportService } from '../src/lib/storage/importService'
import { createBackupService } from '../src/features/backup/service'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createModelService } from '../src/features/models/service'
import { defaultConfig } from '../src/features/models/types'
import { createStoryService } from '../src/features/story/service'
import { agentStream, agentTextStream, narrativeResponse } from './support/agent-protocol'
import { storyResponse, storyTask } from './support/story-protocol'
import { createBookAgentRepository, createMemoryAgentRepository } from '../src/features/agents/repository'
import { appendEntry } from '../src/features/agents/commands'
import { sessionProjection } from '../src/features/agents/compaction'
import { navigateStoryReading, readingBrief, refreshReading, saveReading } from '../src/features/story/reading'
import { applyOutline } from '../src/features/story/outlineCommands'
import { presentStoryPage } from '../src/features/story/readingPresentation'
import { emptyTables, tableNames } from '../src/features/backup/data'
import { encodeBackup, inspectBackup, restoredTables } from '../src/features/backup/codec'

type Row = Record<string, unknown>
const opened: ReturnType<typeof createWorkspace>[] = []
afterEach(async () => {
  for (const workspace of opened.splice(0)) {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name)
  }
})

async function setup(count = 25, fetcher: typeof fetch = vi.fn(async (_url, init) => storyResponse(JSON.parse(init?.body as string))), clock?:()=>number) {
  const key = crypto.randomUUID(), workspace = createWorkspace({ settingsName: `reading-${key}`, bookPrefix: `reading-${key}-book-` })
  opened.push(workspace)
  await workspace.settings.books.put({ id: 'a', title: '分页信件', sourceFileName: '信件.txt', createdAt: new Date().toISOString() })
  const db = workspace.openBook('a'), source = '同一封信逐步传递，后来揭示了早先疑问。'
  await db.chapters.bulkPut(Array.from({ length: count }, (_, i) => ({ bookId: 'a', chapterIndex: String(i + 1), chapterName: `第${i + 1}章`, order: i, charCount: source.length })))
  await db.table('chapterTexts').bulkPut(Array.from({ length: count }, (_, i) => ({ bookId: 'a', chapterIndex: String(i + 1), text: source })))
  await db.table('extractionReceipts').bulkPut(Array.from({ length: count }, (_, i) => ['worldAssets', 'narrativeAssets'].map(substep => ({ key: `${i + 1}:${substep}`, bookId: 'a', chapterIndex: String(i + 1), substep, originIds: [] }))).flat())
  await db.table('nodes').bulkPut(Array.from({ length: count }, (_, i) => ({ id: `N${String(i + 1).padStart(3, '0')}`, bookId: 'a', name: `信件事件${i + 1}`, summary: '同一封信继续流转', process: source, actors: [], quote: source, confidence: 1, revision: 1, createdBy: 'P1', chapterIndex: String(i + 1), chapterName: `第${i + 1}章`, order: 0, eventLineIds: [] })))
  const models = createModelService(workspace, { fetch: fetcher, now:clock, wait: async (_ms, signal) => signal.throwIfAborted() })
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://reading-fixture.invalid/v1', aggregationContextWindow: 65536 }, 'fixture-only')
  return { workspace, db, models, service: createStoryService(workspace, models), fetcher }
}
const bodyOf = (init?: RequestInit) => JSON.parse(init?.body as string)

it('逐节点串联后逐事件复核，外部不可用时保存降级，复核待核实时暂停归线', async () => {
  const inputs:string[]=[]
  let hold=true
  const {service,db,workspace} = await setup(2, async (_url,init) => {
    const body = bodyOf(init)
    const task = body.messages.map((m:Row)=>narrativeMaterial(messageText(m.content))).find(Boolean)
    if (task.mode === 'link_node') {
      const count = task.targets[0].id === 'N001' ? 0 : 1
      const material = body.messages.map((m:Row)=>messageText(m.content)).find((s:string)=>s.startsWith('【当前节点概览开始】'))
      expect(material).toContain('事件库共 ' + count + ' 条，已列出全部事件')
      expect(body.tools.map((tool:{function:{name:string}})=>tool.function.name)).not.toContain('search_nodes')
      expect(messageText(body.messages[0].content)).toContain('6. **按事实维护状态**')
      const results = body.messages.filter((m:Row)=>m.role==='tool')
      if (results.length) {
        expect(results).toHaveLength(1)
        expect(JSON.parse(messageText(results[0].content))).toMatchObject({ok:true})
        return agentStream([{name:'confirm',args:{result:'completed',reviewed_event_ids:['aeda97c2-e5f0-4a04-9b7e-ce03cc29d693']}}])
      }
      const candidate = task.material.候选事件[0]
      if (candidate) return agentStream([{name:'edit_events',args:{changes:[{op:'update',event_id:candidate.event_id,
        fields:{nodeIds:[...candidate.members.map((n:Row)=>n.node_id),task.targets[0].id]},reason:'密信继续传递'}]}}])
    }
    if (task.mode === 'review_sequence' && hold) {
      expect(task.material.主审事件.event_id).toBeTruthy()
      expect(task.material.成员时间表.map((n:Row)=>n.node_id)).toEqual(['N001','N002'])
      const rules = messageText(body.messages[0].content)
      expect(rules).toContain('微观复核 · 逐事件核实经过')
      expect(rules).toContain('return_to_macro')
      expect(rules).not.toContain('【事件串联规则开始】')
      expect(body.tools.map((tool:{function:{name:string}})=>tool.function.name)).toContain('search_nodes')
      hold=false
      return agentStream([{name:'confirm',args:{result:'pending_review',pending_issues:[{issue:'交付对象待查',checked_scope:'前两章',reason:'证词有冲突'}]}}])
    }
    return narrativeResponse(body, inputs)
  })
  const nodes = await db.table('nodes').toArray()
  await db.table('nodes').bulkPut(nodes.map(node => ({...node, clues:['密信']})))
  await service.narrative.start('a')
  const paused = await service.narrative.read('a')
  expect(paused?.status,service.narrative.message('a')).toBe('paused')
  expect(paused?.error).toContain('待核实')
  expect(await db.table('eventLines').count()).toBe(0)
  const tasks = await service.narrativeTasks('a',paused!.runId)
  expect(tasks.filter(t=>t.mode==='link_node').map(t=>t.ids)).toEqual([['N001'],['N002']])
  expect(tasks[1].degraded).toContain('向量未完成，已使用本地关键词继续。')
  expect(tasks[1].degraded).toContain('密钥')
  await service.narrative.start('a')
  expect(await service.narrative.read('a')).toMatchObject({status:'paused',plan:{awaitingStorylines:true,complete:false}})
  const events=await db.table('storyEvents').toArray()
  expect(events).toMatchObject([{nodeIds:['N001','N002'],status:'进行中'}])
  expect(await db.table('eventLines').count()).toBe(0)
  const callsAtCheckpoint = inputs.length
  await service.narrative.start('a')
  expect(inputs).toHaveLength(callsAtCheckpoint)
  expect(await service.narrative.read('a')).toMatchObject({runId:paused!.runId,status:'paused',plan:{awaitingStorylines:true}})
  for (const r of await db.table('extractionReceipts').toArray())
    await db.table('extractionReceipts').put({...r,inputFingerprint:'test',committedAt:new Date().toISOString(),runId:'p1-test'})
  const importer=createImportService(workspace)
  try {
    const backups=createBackupService(workspace,importer)
    const archive=await backups.exportBook('a')
    const inspected=await inspectBackup(archive.bytes)
    expect(inspected.ok,JSON.stringify(inspected.errors)).toBe(true)
    const copy=await backups.createNarrativeCopy('a'), dest=workspace.openBook(copy.id)
    expect(await dest.table('nodes').count()).toBe(2)
    expect(await dest.table('storyEvents').count()).toBe(0)
    expect(await dest.table('eventLines').count()).toBe(0)
    expect(await db.table('storyEvents').get(events[0].id)).toEqual(events[0])
  } finally { importer.close() }
},60000)

it.each([false,true])('继续第二个节点，来源变更 %s，等待向量落库并使用对应版本的输入',async(changed)=>{
  let resume = false
  let unblock!: () => void
  let waiting!: () => void
  const requestStarted = new Promise<void>(resolve=>{waiting=resolve})
  const release = new Promise<void>(resolve=>{unblock=resolve})
  const agentCalls:string[] = []
  const {service,db,workspace} = await setup(2,async(url,init)=>{
    const body = bodyOf(init)
    if (String(url).endsWith('/embeddings')) {
      if (resume) { waiting(); await release }
      return Response.json({data:body.input.map((_:string,index:number)=>({index,embedding:[1,0]}))})
    }
    if (String(url).endsWith('/rerank')) return Response.json({results:body.documents.map((_:string,index:number)=>({index,relevance_score:1}))})
    const task = body.messages.map((m:Row)=>narrativeMaterial(messageText(m.content))).find(Boolean)
    if (['review_sequence','review_boundaries'].includes(task.mode)) return agentStream([{name:'confirm',args:{result:'completed'}}])
    const id = task.targets[0].id
    if (id==='N002' && resume && changed) {
      expect(task.material.当前节点).toMatchObject({detail:'暂停后修订的经过',summary:'新的摘要'})
      expect(task.material.候选事件.map((e:Row)=>e.event_id)).toEqual(['E'])
    }
    agentCalls.push(id)
    if (id==='N002' && !resume) return new Response(null,{status:401})
    return agentStream([{name:'confirm',args:{result:'completed',unassigned_reason:'场景过渡'}}])
  })
  await workspace.settings.table('credentials').put({providerId:'p3-siliconflow-retrieval',type:'api_key',key:'fixture'})
  await service.narrative.start('a')
  const paused = await service.narrative.read('a')
  expect(paused).toMatchObject({status:'paused',plan:{active:{ids:['N002'],retrieval:{configVersion:expect.any(String)}},nodes:{N001:'completed'}}})
  if (changed) {
    await db.table('nodes').update('N002',{process:'暂停后修订的经过',summary:'新的摘要',revision:2})
    await db.table('storyEvents').put({id:'E',bookId:'a',title:'暂停期间补录的事件',nodeIds:['N001'],clues:[],unresolved:'',revision:1})
  }
  await db.table('eventRetrievalVectors').clear()
  resume=true
  agentCalls.length=0
  const run=service.narrative.start('a')
  try {
    await Promise.race([requestStarted,run.then(()=>{throw Error('恢复任务跳过向量准备')})])
    expect(service.narrative.message('a')).toContain('正在计算向量 · 已就绪 0/' + (changed ? 2 : 1))
    expect(agentCalls).toEqual([])
    expect((await service.narrativeTasks('a',paused!.runId)).at(-1)?.status).toBe('running')
  } finally {unblock();await run}
  expect(agentCalls).toEqual(['N002'])
  expect(await db.table('eventRetrievalVectors').count()).toBe(changed ? 2 : 1)
  expect(await service.narrative.read('a')).toMatchObject({runId:paused!.runId,plan:{nodes:{N001:'completed',N002:'completed'}}})
},15000)

it('当前书独立复核从宏观到逐件，暂停恢复沿用编辑，主流程进度保留',async()=>{
  const seen:string[]=[]
  const reasoning:unknown[]=[]
  let resumed=false
  const {service,db,models}=await setup(2,async(_url,init)=>{
    const body=bodyOf(init)
    const task=body.messages.map((m:Row)=>narrativeMaterial(messageText(m.content))).find(Boolean)
    expect(body.messages.filter((m:Row)=>m.role==='user' && narrativeMaterial(messageText(m.content)))).toHaveLength(1)
    expect(Object.keys(task.material)[0]).toBe('资料说明')
    seen.push(task.mode)
    reasoning.push([body.thinking?.type,body.reasoning_effort])
    const saved=body.messages.some((m:Row)=>m.role==='tool' && messageText(m.content).includes('updated'))
    if (task.mode==='review_boundaries') {
      expect(task.material.本组事件.map((e:Row)=>e.event_id).sort()).toEqual(['A','B'])
      return agentStream([{name:'confirm',args:{result:'completed'}}])
    }
    const id=task.targets[0].id
    if (id==='A' && !saved) return agentStream([{name:'edit_events',args:{changes:[{op:'update',event_id:id,
      fields:{latest_progress:'暂停之前已保存'},reason:'模拟保存后中断'}]}}])
    if (id==='A' && !resumed) return new Response(null,{status:401})
    return agentStream([{name:'confirm',args:{result:'completed'}}])
  })
  await models.settings.save({...defaultConfig,aggregationModel:'deepseek-v4-pro'},'fixture-only')
  await db.table('storyEvents').bulkPut(['A','B'].map(id=>({bookId:'a',id,title:'事件'+id,nodeIds:['N001','N002'],
    summary:'传递密信',latestProgress:'送信',unresolved:'',status:'进行中',clues:['密信'],revision:1})))
  const original=await db.table('compileProgress').get('P3')
  await service.narrative.start('a',true)
  expect(await service.narrative.read('a',true)).toMatchObject({status:'paused',plan:{active:{mode:'review_sequence',ids:['A']}}})
  const checkpoint=await service.narrative.read('a',true)
  const runs=db.table('pipelineRuns')
  const run=await runs.get(checkpoint!.runId)
  const active=run.narrative.active
  const material=JSON.parse(active.prompt)
  delete material.资料说明
  const old={...active,prompt:JSON.stringify(material)}
  await runs.put({...run,narrative:{...run.narrative,active:old}})
  await runs.update(active.id,{taskInputVersion:1,snapshot:old})
  resumed=true
  await service.narrative.start('a',true)
  expect(await service.narrative.read('a',true)).toMatchObject({status:'completed',stats:{microDone:2,macroDone:1}})
  expect(await db.table('compileProgress').get('P3')).toEqual(original)
  expect((await db.table('pipelineRuns').toArray()).filter(r=>r.name==='edit_events')).toHaveLength(1)
  expect(seen[0]).toBe('review_boundaries')
  expect(seen).toContain('review_sequence')
  expect(reasoning).toEqual(seen.map(()=>['enabled','high']))
},30000)

it.each([false,true])('取消本书 P3 后复核从首组重开（取消时正在执行 %s）',async inFlight=>{
  const modes:string[]=[]
  let reached!:()=>void
  const atMicro=new Promise<void>(resolve=>{reached=resolve})
  let restarting=false
  let firstRequest: {names: string[]; containsToolResult:boolean} | undefined
  const {service,db}=await setup(2, async (_url,init)=>{
    const {messages}=bodyOf(init)
    const task=messages.map((m:Row)=>narrativeMaterial(messageText(m.content))).find(Boolean)
    modes.push(task.mode)
    if (restarting) {
      firstRequest={names:task.material.本组事件?.map((e:Row)=>String(e.name)) ?? [],
        containsToolResult:messages.some((m:Row)=>m.role==='tool')}
      return new Response(null,{status:401})
    }
    if (task.mode==='review_boundaries') return agentStream([{name:'confirm',args:{result:'completed'}}])
    reached()
    if (!inFlight) return new Response(null,{status:401})
    return new Promise<Response>((_,reject)=>init!.signal!.addEventListener('abort',()=>reject(Error('取消')),{once:true}))
  })
  const runs=db.table('pipelineRuns')
  await runs.put({bookId:'a',id:'main',recordType:'run',status:'paused',stage:'P3'})
  await db.table('compileProgress').put({bookId:'a',stage:'P3',planKey:'narrative-events-v1',runId:'main',status:'paused'})
  await db.table('storyEvents').bulkPut(['A','B'].map(id=>({bookId:'a',id,title:id,nodeIds:['N001','N002'],
    summary:'传递密信',latestProgress:'送信',unresolved:'',status:'进行中',clues:['密信'],revision:1})))
  const started=service.narrative.start('a',true)
  await Promise.race([atMicro,started.then(()=>{if (!modes.includes('review_sequence')) throw Error('未进入逐件复核')})])
  if (!inFlight) await started
  const previous=(await service.narrative.read('a',true))!
  expect(previous.stats.macroDone).toBe(1)
  await service.narrative.stop('a',true)
  await started
  expect(await db.table('compileProgress').get('P3')).toMatchObject({status:'cancelled'})
  expect(await runs.get('main')).toMatchObject({status:'cancelled'})
  const oldRun=await runs.get(previous.runId)
  expect(oldRun.status).toBe('cancelled')
  expect(modes).toEqual(['review_boundaries','review_sequence'])
  await db.table('storyEvents').update('A',{title:'更新后的事件名称',revision:2})
  restarting=true
  await service.narrative.start('a',true)
  const fresh=(await service.narrative.read('a',true))!
  expect(modes.at(-1)).toBe('review_boundaries')
  expect(firstRequest?.names).toContain('更新后的事件名称')
  expect(firstRequest?.containsToolResult).toBe(false)
  expect(fresh.stats.macroDone).toBe(0)
  expect(fresh.runId).not.toBe(previous.runId)
  const newRun=await runs.get(fresh.runId)
  expect(newRun.sessionId).not.toBe(oldRun.sessionId)
  expect(newRun.tasks).toHaveLength(1)
  expect((await runs.get(previous.runId)).tasks).toEqual(oldRun.tasks)
},15000)

it('宏观组超过保留轮数及恢复后仍发送已读详情，下一任务不带入', async () => {
  const evidence = '黄泰先前已托儿子求援'
  let round = 0
  let resumed = false
  const {service,db} = await setup(2,async (_url,init) => {
    const {messages} = bodyOf(init)
    const task = messages.map((m:Row)=>narrativeMaterial(messageText(m.content))).find(Boolean)
    const replies = messages.filter((m:Row)=>m.role==='tool').map((m:Row)=>messageText(m.content))
    if (task.mode==='review_sequence') {
      expect(replies.join('')).not.toContain(evidence)
      return agentStream([{name:'confirm',args:{result:'completed'}}])
    }
    round++
    if (round===1) return agentStream([
      {name:'get_nodes',args:{node_ids:['N001']}},
      {name:'get_event',args:{event_id:'A'}},
    ])
    if (round<=3) return agentStream([{name:'search_events',args:{groups:[['密信']]}}])
    expect(replies.some((s:string)=>s.includes(evidence))).toBe(true)
    expect(replies.some((s:string)=>s.includes('"members"') && s.includes('N002'))).toBe(true)
    if (!resumed) return new Response(null,{status:401})
    return agentStream([{name:'confirm',args:{result:'completed'}}])
  })
  await db.table('nodes').update('N001',{process:evidence})
  await db.table('storyEvents').bulkPut(['A','B'].map(id=>({bookId:'a',id,title:'事件'+id,nodeIds:['N001','N002'],
    summary:'传递密信',latestProgress:'送信',unresolved:'',status:'进行中',clues:['密信'],revision:1})))
  await service.narrative.start('a',true)
  const paused=await service.narrative.read('a',true)
  expect(paused?.status).toBe('paused')
  expect(round).toBe(4)
  // 旧版本已为第一轮存过占位。恢复时仍以该任务的原始消息为据。
  await db.table('pipelineRuns').update(paused!.plan.active!.id,{placeholders:{'1':'[第 1 轮] get_nodes 执行成功，返回正文已省略'}})
  resumed=true
  await service.narrative.start('a',true)
  expect(await service.narrative.read('a',true)).toMatchObject({status:'completed',stats:{microDone:2,macroDone:1}})
  expect(round).toBe(5)
},30000)

it('继续旧未归属节点页时保留历史并直接主审存续事件',async()=>{
  let resume=false
  const requests:string[]=[]
  const {service,db}=await setup(2,async(_url,init)=>{
    if(!resume) return new Response(null,{status:401})
    const task=bodyOf(init).messages.map((m:Row)=>narrativeMaterial(messageText(m.content))).find(Boolean)
    requests.push(task.mode)
    return agentStream([{name:'confirm',args:{result:'completed'}}])
  })
  await db.table('storyEvents').put({id:'E',bookId:'a',title:'已存事件',nodeIds:['N001'],revision:1})
  await service.narrative.start('a',true)
  const checkpoint=(await service.narrative.read('a',true))!
  const runs=db.table('pipelineRuns'), run=await runs.get(checkpoint.runId)
  const old={...run.narrative.active,mode:'review_boundaries',part:'unassigned',ids:[],orphanIds:['N002'],prompt:'旧页资料'}
  const snapshot=await runs.get(old.id)
  await runs.put({...snapshot,snapshot:old,systemPrompt:'旧页规则'})
  await runs.put({...run,narrative:{...run.narrative,active:old,twoStep:{...run.narrative.twoStep,phase:'macro',
    pausedGroup:{ids:[],orphanIds:['N002']},macroIssue:[{issue:'旧页疑点'}]}},
    tasks:run.tasks.map((t:Row)=>({...t,input:old}))})
  resume=true
  await service.narrative.start('a',true)
  expect(requests).toEqual(['review_sequence'])
  expect(await runs.get(old.id)).toMatchObject({status:'cancelled',systemPrompt:'旧页规则'})
  expect(await db.table('storyEvents').get('E')).toMatchObject({revision:1,nodeIds:['N001']})
  expect(await service.narrative.read('a',true)).toMatchObject({status:'completed',stats:{microDone:1,macroDone:0}})
})

it('向量准备中暂停或取消，活动节点详情随主运行更新',async()=>{
  let started!:()=>void
  const calculating=new Promise<void>(resolve=>{started=resolve})
  const {service,workspace}=await setup(1,async(url,init)=>{
    if (!String(url).endsWith('/embeddings')) throw Error('准备中不应调用 Agent')
    started()
    return new Promise<Response>((_,reject)=>init!.signal!.addEventListener('abort',()=>reject(Error('已暂停')),{once:true}))
  })
  await workspace.settings.table('credentials').put({providerId:'p3-siliconflow-retrieval',type:'api_key',key:'fixture'})
  const running=service.narrative.start('a')
  await Promise.race([calculating,running.then(()=>{throw Error('未进入向量准备')})])
  await service.narrative.stop('a')
  await running
  const paused=await service.narrative.read('a')
  expect(paused?.status).toBe('paused')
  expect((await service.narrativeTasks('a',paused!.runId))[0]).toMatchObject({ids:['N001'],status:'paused'})
  await service.narrative.stop('a',true)
  expect((await service.narrativeTasks('a',paused!.runId))[0].status).toBe('cancelled')
},15000)

it('文字总结及经过五分钟均留在原任务，只有 confirm 切换任务',async()=>{
  let time=1_000_000,calls=0
  const inputs:string[]=[]
  const {service}=await setup(2,async(_url,init)=>{
    const body=bodyOf(init)
    if(++calls===1){time+=6*60_000;return agentTextStream('已经整理完成。')}
    if(calls===2){
      const state=await service.narrative.read('a')
      expect(state?.plan).toMatchObject({batches:{event:0,line:0},active:{mode:'link_node'}})
      expect(JSON.stringify(body.messages)).toContain('当前任务尚未确认')
    }
    return narrativeResponse(body,inputs)
  },()=>time)
  await service.narrative.start('a')
  expect(await service.narrative.read('a')).toMatchObject({status:'paused',plan:{awaitingStorylines:true}})
},30000)
const reading = async (service: ReturnType<typeof createStoryService>) => (await service.read('a')).reading
const messageText = (value: unknown) => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => typeof part?.text === 'string' ? part.text : '').join('') : ''
function thinkingLengthStream(thinking: string, content?: string) {
  const chunk = (delta: unknown, finish_reason: string | null, usage?: object) => ({ id: 'story-thinking-truncated', object: 'chat.completion.chunk', created: 1, model: 'test-agent', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })
  const chunks = [
    chunk({ role: 'assistant', reasoning_content: thinking, ...(content === undefined ? {} : { content }) }, null),
    chunk({}, 'length', { prompt_tokens: 7, completion_tokens: 13, total_tokens: 20 }),
  ]
  return new Response(chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
}

it('翻页回执重放不会跳过下一页，过期页号返回当前页而不丢进度', async () => {
  const nodes = Array.from({ length: 21 }, (_, i) => ({ id: `N${i}`, bookId: 'a', name: `信件${i}`, summary: '独立进展', chapterIndex: '1', revision: 1, order: i }))
  const repo = createMemoryAgentRepository('a', { nodes, chapters: [{ bookId: 'a', chapterIndex: '1', order: 0 }], pipelineRuns: [{ id: 'r', bookId: 'a' }] })
  const scope = { bookId: 'a', runId: 'r', taskId: 't', sessionId: 's', phase: 'window_link' }
  const first = await repo.transaction(true, async store => {
    const state = await refreshReading(store, 'r', 's', 'window_link'); await saveReading(store, 'r', 'window_link', state)
    return state.currentPageId
  })
  const move = (callId: string, currentPageId?: string) => repo.transaction(true, store => navigateStoryReading(store, scope, { direction: 'next', ...(currentPageId ? { currentPageId } : {}) }, callId))
  const advanced = await move('next-1', first!)
  expect(advanced.page).toMatchObject({ page: { pageNumber: 2 } })
  const replay = await move('next-1', first!)
  expect(replay.page).toMatchObject({ page: { pageNumber: 2 } })
  const stale = await move('next-2', first!)
  expect(stale).toMatchObject({ ok: true, complete: false })
  expect(stale.page).toMatchObject({ page: { pageNumber: 2 } })
})

it('当前页增加节点时先返回更新后的本页，重放同次翻页不会把新内容标为已读', async () => {
  const nodes = Array.from({ length: 11 }, (_, i) => ({ id: `N${i}`, bookId: 'a', name: `信件${i}`, summary: '独立进展', chapterIndex: '1', revision: 1, order: i }))
  const repo = createMemoryAgentRepository('a', { nodes, chapters: [{ bookId: 'a', chapterIndex: '1', order: 0 }], pipelineRuns: [{ id: 'r', bookId: 'a' }] })
  const scope = { bookId: 'a', runId: 'r', taskId: 't', sessionId: 's', phase: 'window_link' }
  const first = await repo.transaction(true, async store => {
    const state = await refreshReading(store, 'r', 's', 'window_link'); await saveReading(store, 'r', 'window_link', state)
    await store.put('nodes', { ...nodes[0], id: 'N-new', name: '补出的伏笔', order: 0.5 })
    return state.currentPageId
  })
  const move = (callId: string) => repo.transaction(true, store => navigateStoryReading(store, scope, { direction: 'next' }, callId))
  const updated = await move('same-navigation')
  expect(updated).toMatchObject({ ok: true, complete: false, page: { page: { id: first, pageNumber: 1, ids: expect.arrayContaining(['N-new']) } } })
  const replay = await move('same-navigation')
  expect(replay).toMatchObject({ complete: false, page: { page: { id: first, pageNumber: 1 } } })
  const state = await repo.transaction(false, store => refreshReading(store, 'r', 's', 'window_link'))
  expect(state.pages.every(page => page.checkedFingerprint !== page.fingerprint)).toBe(true)
  expect(await move('read-updated-page')).toMatchObject({ complete: false, page: { page: { pageNumber: 2 } } })
})

it.each([true, false])('孤立节点挂入事件线后不跳过新出现的阅读页（提供页号：%s）', async withPageId => {
  const nodes = [1, 2].map(i => ({ id: `N${i}`, bookId: 'a', name: `信件${i}`, summary: '独立进展', chapterIndex: '1', revision: 1, order: i }))
  const line = { id: 'L1', bookId: 'a', title: '信件流转', nodeIds: ['N1'], cause: '收到匿名信', process: '信件流传', result: '继续流转', lineStatus: 'open', revision: 1 }
  const repo = createMemoryAgentRepository('a', { nodes, chapters: [{ bookId: 'a', chapterIndex: '1', order: 0 }], eventLines: [line], pipelineRuns: [{ id: 'r', bookId: 'a' }] })
  const scope = { bookId: 'a', runId: 'r', taskId: 't', sessionId: 's', phase: 'global_review' }
  const first = await repo.transaction(true, async store => {
    const state = await refreshReading(store, 'r', 's', 'global_review'); await saveReading(store, 'r', 'global_review', state)
    await store.put('eventLines', { ...line, nodeIds: ['N1', 'N2'], revision: 2 }); return state.currentPageId
  })
  const move = (callId: string, pageId?: string) => repo.transaction(true, store => navigateStoryReading(store, scope, { direction: 'next', ...(withPageId ? { currentPageId: pageId } : {}) }, callId))
  const refreshed = await move('orphan-finished', first!)
  expect(refreshed).toMatchObject({ complete: false, page: { page: { type: 'line_segment', ids: ['N1', 'N2'] } } })
  const currentId = (refreshed.page!.page as Row).id as string
  const saved = await repo.transaction(false, async store => ((await store.get('pipelineRuns', 'r'))!.storyReading as Row).global_review as Row)
  expect(saved.currentPageId).toBe(currentId)
  expect((saved.pages as Row[]).every(page => page.checkedFingerprint !== page.fingerprint)).toBe(true)
  expect(await move('orphan-finished', first!)).toMatchObject({ complete: false, page: { page: { id: currentId } } })
  expect(await move('line-segment-finished', currentId)).toMatchObject({ complete: false, page: { page: { type: 'line_summary' } } })
})

it('复核依次阅读孤立节点、长线分段、整线及本会话疑点，未解线索保留也能完成', async () => {
  const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `N${i + 1}`, bookId: 'a', name: `信件${i + 1}`, summary: '独立进展', chapterIndex: '1', revision: 1, order: i }))
  const note = { id: 'note-a', bookId: 'a', sessionId: 's', title: '来信者仍未揭晓', status: 'active', nodeIds: ['N1'], lineIds: ['L1'], revision: 1 }
  const repo = createMemoryAgentRepository('a', {
    nodes, chapters: [{ bookId: 'a', chapterIndex: '1', order: 0 }], pipelineRuns: [{ id: 'r', bookId: 'a' }],
    eventLines: [{ id: 'L1', bookId: 'a', title: '信件流转', nodeIds: nodes.slice(0, 11).map(node => node.id), cause: '收到匿名信', process: '信件流传', result: '来信者未知', lineStatus: 'open', revision: 1 }],
    storyEditorNotes: [note, { ...note, id: 'note-other', sessionId: 'other-session' }],
  })
  const scope = { bookId: 'a', runId: 'r', taskId: 't', sessionId: 's', phase: 'global_review' }
  const state = await repo.transaction(true, async store => {
    const value = await refreshReading(store, 'r', 's', 'global_review'); await saveReading(store, 'r', 'global_review', value); return value
  })
  expect(state.pages.map(page => page.type)).toEqual(['node_page', 'line_segment', 'line_segment', 'line_summary', 'note_page'])
  expect(state.pages[0].ids).toEqual(['N12'])
  expect(state.pages.at(-1)?.ids).toEqual(['note-a'])
  const briefs: Row[] = [await repo.transaction(false, store => readingBrief(store, 'a', 's', 'global_review', state)) as Row]
  let complete = false
  for (const [index, page] of state.pages.entries()) {
    const result = await repo.transaction(true, store => navigateStoryReading(store, scope, { direction: 'next', currentPageId: page.id, reason: '原文尚未揭晓，保留线索。' }, `review-${index}`))
    complete = result.complete
    if (result.page) briefs.push(result.page)
  }
  expect(complete).toBe(true)
  expect(briefs[1].page).toMatchObject({ segment: 1, totalSegments: 2 })
  expect((briefs[3].workItems as Row[])[0]).toMatchObject({ kind: 'eventLine', id: 'L1' })
  expect(await repo.transaction(false, store => store.get('storyEditorNotes', note.id))).toEqual(note)
})

it('全书复核为共享事件只建一页概况，中文页只送真实归属与成员资料', async () => {
  const nodes = [1, 2].map(i => ({ id: `N${i}`, bookId: 'a', name: `账目进展${i}`, summary: '查账发现新的侵吞证据', process: '核对前院交回的账册', clues: ['账册钤印'], new_facts: ['旧事实'], chapterIndex: String(i), revision: 1, order: i }))
  const event = { id: 'E1', bookId: 'a', title: '清查赖家', nodeIds: ['N1', 'N2'], summary: '核查赖家账目并发现侵吞证据。', coreClue: '赖大是否侵吞公中财物。', revision: 1 }
  const lines = [
    { id: 'L1', bookId: 'a', title: '赖家线', summary: '围绕查账和追赃展开。', coreClue: '赖大贪污及其牵连范围。', eventIds: ['E1'], nodeIds: [], revision: 1 },
    { id: 'L2', bookId: 'a', title: '荣府账目线', eventIds: ['E1'], nodeIds: [], revision: 1 },
  ]
  const repo = createMemoryAgentRepository('a', { nodes, storyEvents: [event], eventLines: lines, chapters: nodes.map((node, order) => ({ bookId: 'a', chapterIndex: node.chapterIndex, order })), pipelineRuns: [{ id: 'r', bookId: 'a', storyOutlineVersion: 1 }] })
  const state = await repo.transaction(false, store => refreshReading(store, 'r', 's', 'global_review'))
  expect(state.pages.filter(page => page.type === 'event_summary')).toHaveLength(1)
  expect(state.pages.map(page => page.type)).toEqual(['line_segment', 'event_summary', 'line_summary', 'line_summary'])
  expect(state.pages.filter(page => page.type === 'line_summary')).toHaveLength(2)
  expect(state.pages.findIndex(page => page.type === 'line_summary')).toBeGreaterThan(state.pages.findLastIndex(page => page.type === 'event_summary'))
  const eventPage = state.pages.find(page => page.type === 'event_summary')!
  const brief = await repo.transaction(false, store => readingBrief(store, 'a', 's', 'global_review', { ...state, currentPageId: eventPage.id }, true))
  expect(brief?.event).toMatchObject({ id: 'E1', summary: event.summary, coreClue: event.coreClue })
  expect(presentStoryPage(brief)).toMatchObject({ 阶段: '全书复核', 本页: { 类型: '事件说明' }, 事件成员索引: [{ 编号: 'N1' }, { 编号: 'N2' }] })
  const linePage = state.pages.find(page => page.type === 'line_summary')!
  const lineBrief = await repo.transaction(false, store => readingBrief(store, 'a', 's', 'global_review', { ...state, currentPageId: linePage.id }, true))
  expect(lineBrief?.line).toMatchObject({ id: 'L1', summary: lines[0].summary, coreClue: lines[0].coreClue })
  expect(presentStoryPage(lineBrief)).toMatchObject({ 本页: { 类型: '故事线说明' }, 所属事件: [{ 编号: 'E1', 名称: event.title, 概况: event.summary, 核心关键线索: event.coreClue }] })
  expect(lineBrief).not.toHaveProperty('related')
  const members = await repo.transaction(false, store => readingBrief(store, 'a', 's', 'global_review', state, true))
  expect(JSON.stringify(presentStoryPage(members))).not.toMatch(/核对前院交回的账册|账册钤印|详细经过/)
  expect(presentStoryPage(members)).toMatchObject({ 本页: { 类型: '成员复核' }, 本页待阅读节点: [{ 节点: [{ 编号: 'N1' }] }, { 节点: [{ 编号: 'N2' }] }] })
  expect(JSON.stringify(presentStoryPage(members))).not.toContain('旧事实')
})

it('旧运行误标完成的空白说明重新待检，字段写齐才可翻页', async () => {
  const scope = { bookId: 'a', runId: 'r', taskId: 't', sessionId: 's', phase: 'global_review', outline: true }
  const node = { id: 'N1', bookId: 'a', chapterIndex: '1', name: '查账', summary: '查看公中账目' }
  const event = { id: 'E1', bookId: 'a', title: '查账', nodeIds: ['N1'], summary: '', coreClue: '' }
  const line = { id: 'L1', bookId: 'a', title: '赖家线', eventIds: ['E1'], nodeIds: ['N1'], summary: '查账引出追赃', coreClue: '  ' }
  const repo = createMemoryAgentRepository('a', { nodes: [node], storyEvents: [event], eventLines: [line], pipelineRuns: [{ id: 'r', bookId: 'a', storyOutlineVersion: 1 }] })
  await repo.transaction(true, async store => {
    const state = await refreshReading(store, 'r', 's', 'global_review')
    await saveReading(store, 'r', 'global_review', { ...state, currentPageId: null, pages: state.pages.map(page => ({ ...page, checkedFingerprint: page.fingerprint })) })
    const refreshed = await refreshReading(store, 'r', 's', 'global_review')
    expect(refreshed.currentPageId).toBe('event_summary:E1:0')
    await saveReading(store, 'r', 'global_review', refreshed)
  })
  const next = (id: string) => repo.transaction(true, store => navigateStoryReading(store, scope, { direction: 'next' }, id))
  await expect(next('empty-event')).rejects.toThrow('两项均为必填')
  await repo.transaction(true, store => store.put('storyEvents', { ...event, summary: '查看公中账目', coreClue: '公中账目的亏空引发清查' }))
  expect(await next('written-event')).toMatchObject({ complete: false, page: { page: { type: 'line_summary' } } })
  await expect(next('empty-line')).rejects.toThrow('两项均为必填')
  await repo.transaction(true, store => store.put('eventLines', { ...line, coreClue: '公中财物能否追回' }))
  expect(await next('written-line')).toMatchObject({ complete: true })
})

it('AI未翻页而提前结束时只保留当前页，程序不自动送入后页', async () => {
  const bodies: Row[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    bodies.push(bodyOf(init))
    return agentStream([{ name: 'finish_story_batch', args: { summary: '这页尚需查证，先保留进度。' } }])
  })
  const { service, db } = await setup(25, fetcher)
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect(bodies).toHaveLength(1)
  const { input } = storyTask(bodies[0])
  expect(input.page).toMatchObject({ pageNumber: 1, totalPages: 3 })
  expect(input.directory).toMatchObject({ 故事线数量: 0, 事件数量: 0 })
  expect(input.workItems[0].process).toBeUndefined()
  expect(input.workItems.map((item: Row) => item.id)).toEqual(Array.from({ length: 10 }, (_, i) => `N${String(i + 1).padStart(3, '0')}`))
  expect(await reading(service)).toMatchObject({ pageNumber: 1, checked: 0, complete: false })
  expect(await db.table('eventLines').count()).toBe(0)
})

it('同一条模型回复调用两次下一页，只推进一次并返回尚未阅读的第二页', async () => {
  const pages: number[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const { input } = storyTask(bodyOf(init)); pages.push(input.page.pageNumber)
    return pages.length === 1
      ? agentStream([{ name: 'navigate_story_pages', args: { direction: 'next' } }, { name: 'navigate_story_pages', args: { direction: 'next' } }])
      : agentStream([{ name: 'finish_story_batch', args: { summary: '已收到下一页，暂存进度。' } }])
  })
  const { service } = await setup(25, fetcher)
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect(pages).toEqual([1, 2])
  expect(await reading(service)).toMatchObject({ checked: 1, pageNumber: 2, complete: false })
})

it('同一会话由AI翻过三页，多次保存持续续接原事件', async () => {
  const bodies: Row[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => { const body = bodyOf(init); bodies.push(body); return storyResponse(body) })
  const { service, db, workspace } = await setup(25, fetcher)
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  const lines = await db.table('eventLines').toArray()
  expect(lines).toHaveLength(1)
  expect(lines[0].nodeIds).toHaveLength(25)
  expect(lines[0].summary).toBe('')
  const events = await db.table('storyEvents').toArray()
  expect(events).toMatchObject([{ title: '传递信件', nodeIds: lines[0].nodeIds }])
  expect(lines[0].process).toBe('')
  expect(await reading(service)).toMatchObject({ checked: 3, totalPages: 3, complete: true })
  expect([...new Set(bodies.map(body => storyTask(body).input.page.pageNumber))]).toEqual([1, 2, 3])
  const lastMessages = bodies.at(-1)!.messages as { role: string; content?: unknown }[]
  expect(lastMessages.filter(row => row.role === 'user' && messageText(row.content).startsWith('【当前阅读页】'))).toHaveLength(1)
  expect(storyTask(bodies.find(body => storyTask(body).input.page.pageNumber === 2)!).input.directory).toMatchObject({ 故事线数量: 1, 事件数量: 1, 故事线: [{ 名称: '信件流转', 事件: [{ 名称: '传递信件', 节点编号: expect.arrayContaining(['N001']) }] }] })
  expect(await db.table('storySessions').count()).toBe(1)
  const progress = await db.table('compileProgress').get('P3'), run = await db.table('pipelineRuns').get(progress.runId)
  expect(run.appliedCommands).toHaveLength(3)
  const book = (await workspace.settings.books.get('a'))!
  const tables = emptyTables()
  for (const name of tableNames) if (name !== 'extractionReceipts') tables[name] = await db.table(name).toArray()
  const backup = await encodeBackup({ book, tables })
  expect(backup.manifest.formatVersion).toBe(15)
  const inspected = await inspectBackup(backup.bytes)
  expect(inspected.ok).toBe(true)
  const restored = await restoredTables(inspected.data!, 'copy')
  expect(restored.storyEvents).toMatchObject([{ id: events[0].id, bookId: 'copy', nodeIds: lines[0].nodeIds }])
}, 30000)

it('第二页上下文超长且翻页回执被压缩掉后，重建精确当前页并继续到第三页', async () => {
  let rejected = false, compactions = 0
  const workRequests: Row[] = [], recoveredRequests: Row[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = bodyOf(init), messages = body.messages as { role: string; content?: unknown }[]
    if (messages.some(row => messageText(row.content).includes('【需要压缩的原始会话数据】'))) {
      compactions++
      return agentStream([{ name: 'submit_result', args: { summary: '此前已核对部分资料，后续请根据程序提供的当前资料继续。' } }])
    }
    workRequests.push(body)
    const { input } = storyTask(body)
    if (input.page.pageNumber === 2 && !rejected) {
      rejected = true
      await repository.transaction(true, async store => {
        const session = (await store.rows('storySessions'))[0]
        await appendEntry(store, { bookId: 'a', profile: 'story_editor', phase: 'window_link', runId: '', taskId: '', sessionId: String(session.id), owner: '', workItemIds: [] }, {
          type: 'message', message: { role: 'user', content: `第二页长历史标记：${'本段核对旧信的来由与去向，详细内容见原记录。'.repeat(2500)}`, timestamp: Date.now() },
        })
      })
      return new Response(JSON.stringify({ error: { message: 'maximum context length exceeded', type: 'invalid_request_error', code: 'context_length_exceeded' } }), { status: 400 })
    }
    if (rejected) recoveredRequests.push(body)
    return agentStream([{ name: 'navigate_story_pages', args: { direction: 'next', currentPageId: input.page.id } }])
  })
  const { service, workspace } = await setup(25, fetcher)
  const repository = createBookAgentRepository(workspace, 'a')
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect(rejected).toBe(true)
  expect(compactions).toBeGreaterThan(0)
  expect(workRequests.map(body => storyTask(body).input.page.pageNumber)).toEqual([1, 2, 2, 3])
  const restoredMessages = recoveredRequests[0].messages as { role: string; content?: unknown }[]
  const restoredTasks = restoredMessages.filter(row => row.role === 'user' && messageText(row.content).startsWith('【当前阅读页】')).map(row => {
    const content = messageText(row.content); return JSON.parse(content.slice(content.indexOf('{')))
  })
  expect(restoredTasks).toHaveLength(1)
  expect(restoredTasks[0].本页).toMatchObject({ 页码: 2, 总页数: 3 })
  expect(storyTask(recoveredRequests[0]).input.page.ids).toEqual(Array.from({ length: 10 }, (_, i) => `N${String(i + 11).padStart(3, '0')}`))
  expect(restoredMessages.filter(row => row.role === 'tool')).toHaveLength(0)
  expect(JSON.stringify(restoredMessages)).not.toContain('本段核对旧信的来由与去向，详细内容见原记录。'.repeat(100))
  expect(await reading(service)).toMatchObject({ checked: 3, totalPages: 3, complete: true })
  const state = await service.read('a')
  const projection = await sessionProjection(repository, state.session.id!)
  expect(projection.messages.some(row => row.role === 'user' && messageText(row.content).startsWith('【当前阅读页】') && messageText(row.content).includes('"页码": 2'))).toBe(true)
}, 30000)

it('可以回看上一页，没有修改也可往返翻页，不制造写入', async () => {
  let returned = false, movingBack = false
  const pages: number[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const { input } = storyTask(bodyOf(init)); pages.push(input.page.pageNumber)
    if (input.page.pageNumber === 2 && !returned) { returned = true; movingBack = true; return agentStream([{ name: 'navigate_story_pages', args: { direction: 'previous' } }]) }
    if (movingBack) { expect(input.page.pageNumber).toBe(1); movingBack = false }
    return agentStream([{ name: 'navigate_story_pages', args: { direction: 'next', reason: '这些独立事件已核对。' } }])
  })
  const { service, db } = await setup(15, fetcher)
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect(pages).toEqual([1, 2, 1, 2])
  expect(await reading(service)).toMatchObject({ checked: 2, complete: true })
  const progress = await db.table('compileProgress').get('P3'), run = await db.table('pipelineRuns').get(progress.runId)
  expect(run.appliedCommands).toEqual([])
})

it('取消串联后默认在新会话快检既有进度，已保存的线继续使用', async () => {
  let interrupted = false, restoring = false
  const restoredPages: number[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = bodyOf(init), { input } = storyTask(body)
    if (!restoring && input.page.pageNumber === 2) {
      interrupted = true
      return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('取消', 'AbortError')), { once: true }) })
    }
    if (restoring) restoredPages.push(input.page.pageNumber)
    return storyResponse(body)
  })
  const { service, workspace, models, db } = await setup(25, fetcher)
  const pending = service.start('a')
  await vi.waitFor(() => expect(interrupted).toBe(true), { timeout: 10000 })
  service.cancel('a'); await pending
  const line = (await db.table('eventLines').toArray())[0]
  expect(line.nodeIds).toHaveLength(10)
  const sessionId = (await db.table('storySessions').toArray())[0].id
  restoring = true
  const resumed = createStoryService(workspace, models)
  await resumed.start('a')
  expect(resumed.state('a')?.error).toBeUndefined()
  expect(restoredPages[0]).toBe(1)
  expect(restoredPages).toContain(2)
  expect(await reading(resumed)).toMatchObject({ complete: true })
  expect(await db.table('eventLines').toArray()).toMatchObject([{ id: line.id, nodeIds: expect.any(Array) }])
  expect((await db.table('eventLines').get(line.id)).nodeIds).toHaveLength(25)
  expect((await db.table('compileProgress').get('P3')).editorSessionId).not.toBe(sessionId)
}, 30000)

it.each(['window_link', 'global_review'])('%s普通说明后继续查询、保存及翻页，不用总结校验结束', async phase => {
  let explanations = 0, sawContinuation = false
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = bodyOf(init), { input } = storyTask(body)
    if (input.phase === phase) {
      if (explanations++ < 2) return agentTextStream('先核对这条故事线的前因后果，再继续查阅。')
      sawContinuation = true
      expect(JSON.stringify(body.messages)).toContain('先核对这条故事线的前因后果')
    }
    return storyResponse(body)
  })
  const { db, service } = await setup(2, fetcher)
  await service.start('a')
  if (phase === 'global_review') await service.review('a')
  expect(sawContinuation).toBe(true)
  expect(service.state('a')?.error).toBeUndefined()
  expect((await service.read('a')).progress?.status).toBe('completed')
  expect(await db.table('eventLines').count()).toBe(1)
  expect(JSON.stringify(await db.table('storySessionEntries').toArray())).toContain('先核对这条故事线的前因后果')
})

it.each(['window_link', 'global_review'] as const)('%s连续两次仅思考被截断后暂停，保留当前页、思考和用量，继续可以完成', async phase => {
  let resuming = false
  const interruptedBodies: Row[] = [], resumedPages: string[] = [], resumedEfforts: string[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = bodyOf(init), { input } = storyTask(body)
    if (input.phase === phase) {
      if (resuming) { resumedPages.push(input.page.id); resumedEfforts.push(body.reasoning_effort) }
      else {
        interruptedBodies.push(body)
        if (interruptedBodies.length <= 2) return thinkingLengthStream(`截断思考-${phase}-${interruptedBodies.length}：正在判断信件流转。`, phase === 'global_review' ? ' \n ' : undefined)
        return new Response(JSON.stringify({ error: { message: 'fixture stopped unexpected third request' } }), { status: 402 })
      }
    }
    return storyResponse(body)
  })
  const { db, service, workspace, models } = await setup(2, fetcher)
  await models.settings.save({ ...defaultConfig, aggregationModel: 'deepseek-flash', aggregationContextWindow: 65536 }, 'fixture-only')
  if (phase === 'global_review') await service.start('a')
  await (phase === 'window_link' ? service.start('a') : service.review('a'))
  expect(interruptedBodies).toHaveLength(2)
  const expectedEffort = phase === 'global_review' ? 'high' : 'low'
  expect(interruptedBodies.map(body => body.reasoning_effort)).toEqual([expectedEffort, expectedEffort])
  expect(service.state('a')?.error).toContain('THINKING_TRUNCATED')
  const pageId = storyTask(interruptedBodies[0]).input.page.id
  expect(storyTask(interruptedBodies[1]).input.page.id).toBe(pageId)
  expect(await reading(service)).toMatchObject({ checked: 0, pageNumber: 1, complete: false })
  const progress = await db.table('compileProgress').get('P3'), run = await db.table('pipelineRuns').get(progress.runId)
  expect(progress).toMatchObject({ status: 'paused', phase })
  expect(run.storyReading[phase].currentPageId).toBe(pageId)
  expect(run.storyReading[phase].pages.every((page: Row) => page.checkedFingerprint !== page.fingerprint)).toBe(true)
  expect(run.usage).toMatchObject({ input: 14, output: 26, totalTokens: 40 })
  const entries = await db.table('storySessionEntries').toArray()
  const traces = entries.filter(row => row.type === 'request_trace' && String(row.thinking).includes(`截断思考-${phase}`))
  expect(traces).toHaveLength(2)
  expect(traces.map(row => row.usage)).toEqual([expect.objectContaining({ input: 7, output: 13, totalTokens: 20 }), expect.objectContaining({ input: 7, output: 13, totalTokens: 20 })])
  const assistants = entries.filter(row => row.type === 'message' && row.message?.role === 'assistant' && row.message.stopReason === 'length')
  expect(assistants).toHaveLength(2)
  expect(JSON.stringify(assistants)).toContain(`截断思考-${phase}-1`)
  expect(JSON.stringify(assistants)).toContain(`截断思考-${phase}-2`)
  resuming = true
  const resumed = createStoryService(workspace, models)
  await (phase === 'window_link' ? resumed.start('a') : resumed.review('a'))
  expect(resumedPages[0]).toBe(pageId)
  expect(resumedEfforts[0]).toBe(expectedEffort)
  expect(resumed.state('a')?.error).toBeUndefined()
  expect((await resumed.read('a')).progress?.status).toBe('completed')
  expect(await reading(resumed)).toMatchObject({ complete: true })
  expect(await db.table('eventLines').count()).toBe(1)
}, 30000)

it('成功保存事件线清除此前的思考截断计数，后续两次截断暂停并保留提交，继续不重复创建', async () => {
  let resuming = false, interruptedRequests = 0, savedLineId = ''
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = bodyOf(init), { input } = storyTask(body)
    if (resuming) {
      expect(JSON.stringify(body.messages)).toContain(savedLineId)
      return agentStream([{ name: 'navigate_story_pages', args: { direction: 'next', currentPageId: input.page.id } }])
    }
    interruptedRequests++
    if (interruptedRequests === 2) return agentStream([{ name: 'save_story_outline', args: { operations: [
      { op: 'create_line', ref: 'letter', title: '信件流转' },
      { op: 'create_event', ref: 'delivery', title: '传递信件', lineId: '$letter', nodeIds: input.workItems.map((item: Row) => item.id) },
    ] } }])
    if (interruptedRequests <= 4) return thinkingLengthStream(`已保存前后的截断思考-${interruptedRequests}`)
    return new Response(JSON.stringify({ error: { message: 'fixture stopped unexpected fifth request' } }), { status: 402 })
  })
  const { db, service, workspace, models } = await setup(2, fetcher)
  await service.start('a')
  expect(interruptedRequests).toBe(4)
  expect(service.state('a')?.error).toContain('THINKING_TRUNCATED')
  expect(await reading(service)).toMatchObject({ checked: 0, complete: false })
  const lines = await db.table('eventLines').toArray()
  expect(lines).toHaveLength(1)
  expect(lines[0].nodeIds).toEqual(['N001', 'N002'])
  savedLineId = lines[0].id
  const progress = await db.table('compileProgress').get('P3'), beforeRun = await db.table('pipelineRuns').get(progress.runId)
  expect(beforeRun.appliedCommands).toHaveLength(1)
  expect(beforeRun.usage).toMatchObject({ input: 21, output: 39, totalTokens: 60 })
  const commitId = beforeRun.appliedCommands[0].commitId
  resuming = true
  const resumed = createStoryService(workspace, models)
  await resumed.start('a')
  expect(resumed.state('a')?.error).toBeUndefined()
  expect(await reading(resumed)).toMatchObject({ complete: true })
  expect(await db.table('eventLines').toArray()).toEqual(lines)
  const afterRun = await db.table('pipelineRuns').get(progress.runId)
  expect(afterRun.appliedCommands).toHaveLength(1)
  expect(afterRun.appliedCommands[0].commitId).toBe(commitId)
  expect(JSON.stringify(await db.table('storySessionEntries').toArray())).toContain('已保存前后的截断思考-4')
}, 30000)

it.each([
  { name: 'navigate_story_pages', args: { direction: 'invalid-direction' }, detail: 'direction' },
  { name: 'unavailable_tool', args: {}, detail: 'not found' },
])('$name重复失败保留真实错误和未完成页，不冒充完成或继续请求', async ({ name, args, detail }) => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => agentStream([{ name, args }]))
  const { db, service } = await setup(2, fetcher)
  await service.start('a')
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(service.state('a')?.error).toContain('同一工具调用重复失败')
  expect(service.state('a')?.error).toContain(detail)
  expect(service.state('a')?.error).not.toContain('任务总结')
  expect((await service.read('a')).progress?.status).toBe('paused')
  expect((await reading(service))?.checked).toBe(0)
  expect(await db.table('eventLines').count()).toBe(0)
})

it('普通说明后API报错立即退出，保留实际错误而不是总结错误', async () => {
  let requests = 0
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => ++requests === 1
    ? agentTextStream('继续检查当前事件。')
    : new Response(JSON.stringify({ error: { message: 'Insufficient Balance', type: 'insufficient_balance_error' } }), { status: 402 }))
  const { service } = await setup(2, fetcher)
  await service.start('a')
  expect(requests).toBe(2)
  expect(service.state('a')?.error).toContain('Insufficient Balance')
  expect(service.state('a')?.error).not.toContain('完成确认')
  expect((await service.read('a')).progress?.status).toBe('paused')
  expect((await reading(service))?.checked).toBe(0)
})

it('全书复核从目录起步，成批核查成员后重读目录，使用独立复核提示词', async () => {
  const reviewPages: Row[] = [], systems: string[] = [], efforts: Row[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = bodyOf(init)
    if (body.messages.some((message: Row) => messageText(message.content).includes('【需要压缩的原始会话数据】'))) return storyResponse(body)
    const { input } = storyTask(body)
    efforts.push({ type: input.page.type, phase: input.phase, thinking: body.thinking?.type, effort: body.reasoning_effort })
    if (input.phase === 'global_review') {
      reviewPages.push(input.page)
      systems.push((body.messages as { role: string; content: string }[]).filter(row => row.role === 'system').map(row => row.content).join('\n'))
    }
    return storyResponse(body)
  })
  const { service, models } = await setup(25, fetcher)
  await models.settings.save({ ...defaultConfig, aggregationModel: 'deepseek-flash', aggregationContextWindow: 65536 }, 'fixture-only')
  await service.start('a'); await service.review('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect([...new Map(reviewPages.map(page => [page.id, page.type])).values()]).toEqual(['directory_open', 'member_batch', 'member_batch', 'member_batch', 'directory_final', 'event_summary', 'line_summary'])
  expect(efforts.some(row => row.phase === 'window_link')).toBe(true)
  for (const row of efforts) {
    const directory = row.phase === 'global_review' && ['directory_open', 'directory_final'].includes(String(row.type))
    expect(row).toMatchObject({ thinking: 'enabled', effort: directory ? 'high' : 'low' })
  }
  expect(reviewPages.at(-1)?.type).toBe('line_summary')
  expect(systems.every(system => system.includes('复核'))).toBe(true)
  expect((await service.read('a')).progress).toMatchObject({ phase: 'global_review', status: 'completed' })
}, 30000)


it('P3重新开始显式开新轮：复用不发模型请求，全量重新检查且保留事件线', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => storyResponse(bodyOf(init)))
  const { service, db } = await setup(12, fetcher)
  await service.start('a')
  const first = (await db.table('compileProgress').get('P3')).runId
  const calls = fetcher.mock.calls.length
  await service.start('a', 'reuse')
  expect(service.state('a')?.error).toBeUndefined()
  expect((await db.table('compileProgress').get('P3')).runId).not.toBe(first)
  expect(fetcher.mock.calls.length).toBe(calls)
  expect(await reading(service)).toMatchObject({ complete: true, reused: 12 })
  await service.start('a', 'all')
  expect(service.state('a')?.error).toBeUndefined()
  expect(fetcher.mock.calls.length).toBeGreaterThan(calls)
  expect(await db.table('eventLines').count()).toBe(1)
  await service.review('a')
  expect(service.state('a')?.error).toBeUndefined()
  const reviewed = fetcher.mock.calls.length
  await service.review('a', 'reuse')
  expect(service.state('a')?.error).toBeUndefined()
  expect(fetcher.mock.calls.length).toBe(reviewed)
  expect(await reading(service)).toMatchObject({ complete: true })
}, 30000)

it('快检保留大纲，覆盖重串清空大纲，两者都另起模型上下文并保留历史', async () => {
  const bodies: Row[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = bodyOf(init)
    bodies.push(body)
    return storyResponse(body)
  })
  const { service, db, workspace } = await setup(12, fetcher)
  await service.start('a')
  const initial = await db.table('compileProgress').get('P3'), originalEvents = await db.table('storyEvents').toArray()
  const nodeIds = await db.table('nodes').toCollection().primaryKeys()
  const initialBody = bodies.length
  await service.start('a', 'quick')
  const quick = await db.table('compileProgress').get('P3')
  expect(quick.editorSessionId).not.toBe(initial.editorSessionId)
  expect((bodies[initialBody].messages as Row[]).every(row => ['system', 'user'].includes(String(row.role)))).toBe(true)
  expect(bodies.slice(initialBody).map(body => storyTask(body).input.quick)).toEqual([true, true])
  expect(await db.table('storyEvents').toArray()).toEqual(originalEvents)
  const quickEnd = bodies.length
  await service.start('a', 'replace')
  expect(service.state('a')?.error).toBeUndefined()
  const restarted = await db.table('compileProgress').get('P3')
  expect(restarted.editorSessionId).not.toBe(quick.editorSessionId)
  expect((bodies[quickEnd].messages as Row[]).every(row => ['system', 'user'].includes(String(row.role)))).toBe(true)
  expect(storyTask(bodies[quickEnd]).input.directory).toMatchObject({ 故事线数量: 0, 事件数量: 0 })
  expect((await db.table('storyEvents').toArray())[0].id).not.toBe(originalEvents[0].id)
  expect(await db.table('nodes').toCollection().primaryKeys()).toEqual(nodeIds)
  expect(await db.table('storySessions').get(initial.editorSessionId)).toMatchObject({ status: 'archived' })
  expect(await db.table('storySessionEntries').where('sessionId').equals(initial.editorSessionId).count()).toBeGreaterThan(0)
  const tables = emptyTables()
  for (const table of tableNames) if (table !== 'extractionReceipts') tables[table] = await db.table(table).toArray()
  const backup = await encodeBackup({ book: (await workspace.settings.books.get('a'))!, tables })
  expect((await inspectBackup(backup.bytes)).ok).toBe(true)
}, 30000)


it('首次目录和翻页目录直接构成读取依据，不用查详情就能保存', async () => {
  let eventId = '', savedPage = '', requests = 0
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    requests++
    const { input, messages } = storyTask(bodyOf(init))
    for (const message of messages.filter(message => message.role === 'tool')) {
      try { const result = JSON.parse(messageText(message.content)); if (result.created?.delivery) eventId = result.created.delivery } catch { /* 只读取写回执 */ }
    }
    if (savedPage === input.page.id) return agentStream([{ name: 'navigate_story_pages', args: { direction: 'next' } }])
    savedPage = input.page.id
    const nodeIds = input.workItems.map((item: Row) => item.id)
    return agentStream([{ name: 'save_story_outline', args: { operations: eventId ? [{ op: 'attach_nodes', eventId, nodeIds }] : [
      { op: 'create_line', ref: 'letter', title: '连续的信件' },
      { op: 'create_event', ref: 'delivery', title: '传递信件', lineId: '$letter', nodeIds },
    ] } }])
  })
  const { service, db } = await setup(12, fetcher)
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect(requests).toBe(4)
  expect((await db.table('eventLines').toArray())[0].nodeIds).toHaveLength(12)
})


it('启动失败清除旧轮活动身份，保留原成果且修正后能重试', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => storyResponse(bodyOf(init)))
  const { service, db, models } = await setup(1, fetcher)
  await models.settings.clearCredential('custom')
  await service.start('a')
  expect(service.state('a')).toMatchObject({ running: false, error: '请先保存整理模型与密钥。' })
  expect(service.state('a')?.runId).toBeUndefined()
  expect(await db.table('compileProgress').get('P3')).toBeUndefined()
  expect(fetcher).not.toHaveBeenCalled()
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://reading-fixture.invalid/v1', aggregationContextWindow: 65536 }, 'fixture-only')
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  const progress = await db.table('compileProgress').get('P3')
  expect(service.state('a')?.runId).toBe(progress.runId)
  const before = fetcher.mock.calls.length
  await models.settings.clearCredential('custom')
  await service.start('a', 'all')
  expect(service.state('a')?.error).toBe('请先保存整理模型与密钥。')
  expect(service.state('a')?.runId).toBeUndefined()
  expect(fetcher.mock.calls.length).toBe(before)
  expect(await db.table('compileProgress').get('P3')).toEqual(progress)
  expect(await db.table('eventLines').count()).toBe(1)
})

it('复核独立接手节点、事件、故事线及无引用的疑点，保留本轮逐项结论', async () => {
  const firstRequests: Row[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = bodyOf(init)
    if (storyTask(body).input.phase === 'global_review') firstRequests.push(body)
    return storyResponse(body)
  })
  const { db, service } = await setup(2, fetcher)
  await service.start('a')
  const linking = await db.table('compileProgress').get('P3')
  const [event] = await db.table('storyEvents').toArray()
  const [line] = await db.table('eventLines').toArray()
  const secondEvent = { ...event, id: 'E-other', title: '寄信人身份', nodeIds: ['N002'] }
  await db.table('storyEvents').put(secondEvent)
  await db.table('eventLines').put({ ...line, eventIds: [...line.eventIds, secondEvent.id] })
  const original = { bookId: 'a', sessionId: linking.editorSessionId, status: 'active', revision: 1, kind: 'review', stage: 'P3', evidence: [], basisFingerprint: '', nodeIds: [], lineIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  const references = [{ nodeIds: ['N001'] }, { eventIds: [event.id] }, { lineIds: [line.id] }, {}, { nodeIds: ['N002'] }, { eventIds: [event.id] }]
  await db.table('storyEditorNotes').bulkPut(references.map((ref, i) => ({ ...original, ...ref, id: 'old-' + i, key: '信件疑点' + i, statement: '核对收信与转交的承接' + i })))
  await db.table('storyEditorMemory').put({ id: linking.editorSessionId, workingSummary: '串联私有摘要', revision: 1 })
  await service.review('a')
  expect(service.state('a')?.error).toBeUndefined()
  const review = await db.table('compileProgress').get('P3')
  expect(review.editorSessionId).not.toBe(linking.editorSessionId)
  expect(JSON.stringify(firstRequests[0].messages)).not.toMatch(/串联私有摘要|本页待阅读节点.*已保存的大纲|按页维护剧情大纲/)
  expect(JSON.stringify(firstRequests[0].messages)).toContain('全书大纲目录')
  expect(JSON.stringify(firstRequests[0].messages)).toContain('寄信人身份')
  expect(firstRequests.some(body => storyTask(body).input.page?.type === 'member_batch')).toBe(true)
  const snapshots = (await db.table('pipelineRuns').get(review.runId)).stageDirectories
  expect(snapshots.window_link.events).toHaveLength(1)
  expect(snapshots.global_review.events).toHaveLength(2)
  expect((firstRequests[0].messages as Row[]).some(row => row.role === 'assistant' || row.role === 'tool')).toBe(false)
  expect((await service.history('a')).sessions.map(row => row.id)).toEqual(expect.arrayContaining([linking.editorSessionId, review.editorSessionId]))
  const progress = await reading(service)
  expect(progress?.complete).toBe(true)
  expect(progress?.conclusions).toHaveLength(6)
  expect(firstRequests.some(body => storyTask(body).input.eventGroup?.length === 2)).toBe(true)
  expect((await db.table('storyEvents').toArray()).every(row => row.summary && row.coreClue)).toBe(true)
  expect(progress?.conclusions.every(row => String(row.conclusion).includes('来信者'))).toBe(true)
  const calls = firstRequests.length
  await service.review('a', 'reuse')
  expect(service.state('a')?.error).toBeUndefined()
  expect(firstRequests.length).toBe(calls)
  const changed = await db.table('nodes').get('N001')
  await db.table('nodes').put({ ...changed, summary: '后文揭示寄信人' })
  await service.review('a', 'reuse')
  expect(service.state('a')?.error).toBeUndefined()
  expect(firstRequests.length).toBeGreaterThan(calls)
  expect((await reading(service))?.conclusions).toHaveLength(6)
}, 30000)

it('复核在途暂停后，从同一会话继续已保存的步骤', async () => {
  let reached!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { reached = resolve })
  const wait = new Promise<void>(resolve => { release = resolve })
  let pauseOnce = true
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = bodyOf(init)
    if (pauseOnce && storyTask(body).input.phase === 'global_review') {
      pauseOnce = false
      reached()
      await wait
    }
    return storyResponse(body)
  })
  const { workspace, db, models, service } = await setup(2, fetcher)
  await service.start('a')
  const work = service.review('a')
  await started
  service.pause('a')
  release()
  await work
  const paused = await db.table('compileProgress').get('P3')
  expect(paused).toMatchObject({ phase: 'global_review', status: 'paused' })
  const resumed = createStoryService(workspace, models)
  await resumed.review('a')
  expect(resumed.state('a')?.error).toBeUndefined()
  expect((await resumed.read('a')).progress).toMatchObject({ editorSessionId: paused.editorSessionId, runId: paused.runId, status: 'completed' })
}, 30000)

it('仍有归属和交接问题时拒绝提前写说明，未给疑点结论时停在原页', async () => {
  const bookId = 'a', sessionId = 'review', runId = 'r', phase = 'global_review'
  const repo = createMemoryAgentRepository(bookId, {
    pipelineRuns: [{ id: runId, bookId, storyOutlineVersion: 1 }],
    nodes: [{ id: 'N1', bookId, name: '传信', chapterIndex: '1' }],
    storyEvents: [{ id: 'E1', bookId, title: '转交信件', nodeIds: ['N1'] }],
    storyEditorNotes: [{ id: 'Q1', bookId, sessionId, key: '寄信人', statement: '核对来信者身份', status: 'active', eventIds: ['E1'] }],
  })
  const scope = { bookId, sessionId, runId, phase, taskId: 't', profile: 'story_editor' as const, owner: 'test', workItemIds: [] }
  await repo.transaction(true, async store => {
    await saveReading(store, runId, phase, { independent: true, pages: [], currentPageId: null, receipts: [] })
    await saveReading(store, runId, phase, await refreshReading(store, runId, sessionId, phase))
  })
  await expect(repo.transaction(true, store => applyOutline(store, scope, { operations: [{ op: 'update_event', eventId: 'E1', summary: '转交信件', coreClue: '来信下落' }] }, { records: [], queries: [] }, new Date().toISOString()))).rejects.toThrow('归属')
  await repo.transaction(true, store => navigateStoryReading(store, scope, { direction: 'next' }, 'directory'))
  await expect(repo.transaction(true, store => navigateStoryReading(store, scope, { direction: 'next' }, 'missing'))).rejects.toThrow('noteResults')
  const after = await repo.transaction(false, store => refreshReading(store, runId, sessionId, phase))
  const pending = after.pages.find(page => page.id === after.currentPageId)!
  expect(pending.checkedFingerprint).toBeUndefined()
  expect(pending.reviewNotes).toHaveProperty('Q1')
})

it('旧版查完的成员页不能跳过新目录，目录中按小说顺序列事件并呈现未归属对象', async () => {
  const bookId = 'a', phase = 'global_review'
  const oldPage = { id: 'line_segment:E2:1', type: 'line_segment', queue: 'event_lines', ids: ['N2'], fingerprint: 'old', checkedFingerprint: 'old' }
  const repo = createMemoryAgentRepository(bookId, {
    chapters: [{ chapterIndex: '1', order: 0 }, { chapterIndex: '2', order: 1 }],
    nodes: ['1', '2', '3'].map(n => ({ bookId, id: 'N' + n, chapterIndex: n, name: '节点' + n })),
    storyEvents: [{ bookId, id: 'E2', title: '后续', nodeIds: ['N2'] }, { bookId, id: 'E1', title: '前因', nodeIds: ['N1'] }, { bookId, id: 'E0', title: '未归线', nodeIds: [] }],
    eventLines: [{ bookId, id: 'L1', title: '交信', eventIds: ['E2', 'E1'] }],
    pipelineRuns: [{ bookId, id: 'r', storyOutlineVersion: 1, storyReading: { global_review: { independent: true, pages: [oldPage], currentPageId: oldPage.id, receipts: [] } } }],
  })
  await repo.transaction(false, async store => {
    const state = await refreshReading(store, 'r', 'review', phase)
    expect(state.pages.find(p => p.id === state.currentPageId)?.type).toBe('directory_open')
    const brief = await readingBrief(store, bookId, 'review', phase, state, true)
    const output = JSON.stringify(presentStoryPage(brief))
    expect(output).toContain('未归线事件')
    expect(output).toContain('节点3')
    expect(output.indexOf('前因')).toBeLessThan(output.indexOf('后续'))
    const members = state.pages.filter(p => p.type === 'member_batch')
    expect(members).toHaveLength(1)
    expect(members[0].eventIds).toEqual(expect.arrayContaining(['E1', 'E2']))
  })
})

it('首批标题预览横跨全书，后文仅供定范围，未当作本页已读节点', async () => {
  const nodes = Array.from({ length: 170 }, (_, order) => ({ id: 'N' + order, bookId: 'a', chapterIndex: '1', order, name: '标题' + order, process: '仅本页展示经过' }))
  const repo = createMemoryAgentRepository('a', { nodes, chapters: [{ chapterIndex: '1', order: 0 }], pipelineRuns: [{ id: 'r', bookId: 'a', storyOutlineVersion: 1 }] })
  await repo.transaction(false, async store => {
    const state = await refreshReading(store, 'r', 's', 'window_link')
    const brief = (await readingBrief(store, 'a', 's', 'window_link', state, true))!
    const preview = brief.preview as Row[]
    expect(preview).toHaveLength(150)
    expect(preview[0]).toEqual({ 章: '1', 节点: '标题0' })
    expect(preview.at(-1)).toEqual({ 章: '1', 节点: '标题169' })
    expect((brief.workItems as Row[]).map(row => row.id)).not.toContain('N169')
    state.currentPageId = state.pages[1].id
    expect(await readingBrief(store, 'a', 's', 'window_link', state, true)).not.toHaveProperty('preview')
  })
})

it('成员核对中的结构编辑交给最终目录复查，旧目录初查不反复打断同一轮', async () => {
  const bookId = 'a', runId = 'r', sessionId = 's', phase = 'global_review'
  const repo = createMemoryAgentRepository(bookId, {
    nodes: [{ id: 'N1', bookId, chapterIndex: '1', name: '回信' }],
    storyEvents: [{ id: 'E', bookId, title: '寄信', nodeIds: ['N1'] }],
    pipelineRuns: [{ id: runId, bookId, storyOutlineVersion: 1 }],
  })
  await repo.transaction(true, async store => {
    await saveReading(store, runId, phase, { independent: true, pages: [], receipts: [], currentPageId: null })
    await saveReading(store, runId, phase, await refreshReading(store, runId, sessionId, phase))
    const openingState = await refreshReading(store, runId, sessionId, phase)
    const openingPage = presentStoryPage(await readingBrief(store, bookId, sessionId, phase, openingState, true))
    expect(openingPage).toMatchObject({ 全书大纲目录: { 未归线事件: [
      { 编号: 'E', 名称: '寄信', 节点: [{ 编号: 'N1', 名称: '回信' }] },
    ] } })
    await navigateStoryReading(store, { bookId, runId, sessionId, phase, taskId: 't' }, { direction: 'next' }, 'first')
    const event = (await store.get('storyEvents', 'E'))!
    await store.put('storyEvents', { ...event, title: '送信与回信' })
    const updated = await refreshReading(store, runId, sessionId, phase)
    const opening = updated.pages.find(p => p.type === 'directory_open')!
    const final = updated.pages.find(p => p.type === 'directory_final')!
    expect(opening.fingerprint).toBe(opening.checkedFingerprint)
    expect(final.fingerprint).not.toBe(final.checkedFingerprint)
    expect(updated.currentPageId).not.toBe(opening.id)
  })
})

it.each(['paused', 'running'] as const)('取消 %s 复核，再次复核从新会话目录初查开始', async status => {
  let restart = false, waiting = false
  const reviewRequests: Row[] = []
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = bodyOf(init), { input } = storyTask(body)
    if (input.phase === 'global_review') {
      reviewRequests.push(body)
      if (!restart && input.page.type === 'member_batch') {
        if (status === 'paused') return agentStream([{ name: 'finish_story_batch', args: { summary: '旧复核会话标记' } }])
        waiting = true
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('取消', 'AbortError')), { once: true }))
      }
    }
    return storyResponse(body)
  })
  const { service, db, workspace, models } = await setup(2, fetcher)
  await service.start('a')
  const previous = service.review('a')
  if (status === 'paused') await previous
  else await vi.waitFor(() => expect(waiting).toBe(true))
  const old = await db.table('compileProgress').get('P3')
  expect(old.status).toBe(status)
  const savedEvents = await db.table('storyEvents').toArray()
  const count = reviewRequests.length
  await db.table('storyEditorMemory').put({ id: old.editorSessionId, workingSummary: '旧复核私有摘要', revision: 1 })
  await db.table('storyEditorNotes').put({ id: 'handoff-note', key: '收信人', sessionId: old.editorSessionId, bookId: 'a',
    stage: 'P3', kind: 'review', status: 'active', statement: '核实收信人是谁', nodeIds: ['N001'], lineIds: [],
    evidence: [], basisFingerprint: '', revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  const cancelService = status === 'paused' ? createStoryService(workspace, models) : service
  await cancelService.cancel('a', old.runId)
  await previous
  expect(reviewRequests).toHaveLength(count)
  expect(await db.table('compileProgress').get('P3')).toMatchObject({ status: 'cancelled', runId: old.runId })
  expect(await db.table('storyEvents').toArray()).toEqual(savedEvents)
  restart = true
  const reopened = createStoryService(workspace, models)
  await reopened.review('a')
  expect(reopened.state('a')?.error).toBeUndefined()
  const current = await db.table('compileProgress').get('P3')
  expect(current.status).toBe('completed')
  expect(current.runId).not.toBe(old.runId)
  expect(current.editorSessionId).not.toBe(old.editorSessionId)
  const first = reviewRequests[count]
  expect(storyTask(first).input.page.type).toBe('directory_open')
  expect((first.messages as Row[]).map(row => row.role)).toEqual(['system', 'user', 'user'])
  expect(messageText((first.messages as Row[])[2].content)).toContain('按当前页')
  expect(JSON.stringify(first.messages)).not.toMatch(/旧复核会话标记|旧复核私有摘要/)
  expect(JSON.stringify(first.messages)).toContain('核实收信人是谁')
  expect(JSON.stringify(first.messages)).toContain('独立复核编辑')
  expect((first.tools as { function: { name: string } }[]).map(tool => tool.function.name)).not.toContain('read_original')
  expect(await db.table('pipelineRuns').get(old.runId)).toMatchObject({ status: 'cancelled' })
}, 30000)
