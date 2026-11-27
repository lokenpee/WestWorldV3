import { canonical, inputSchema, toolContracts, resultContracts } from '../src/features/agents/contracts'
import { indexReviewGroups, rankCluePairs } from '../src/features/story/eventReviewGroups'
import { finishReview } from '../src/features/story/twoStepReview'
import { eventToolsSchema } from '../src/features/story/eventToolsSchema'
import { historicalEventReply } from '../src/features/story/eventToolReply'
import { expect, it } from 'vitest'
import { createMemoryAgentRepository, type Row } from '../src/features/agents/repository'
import { narrativeTools } from '../src/features/story/narrativeTools'
import { newNarrativePlan, scheduleNarrative, type NarrativeAssets } from '../src/features/story/narrativePlan'
import { narrativeVersions } from '../src/features/story/narrativeBasis'
import { readEventTool } from '../src/features/story/eventWorkflow'
import { buildEventTaskOutcome } from '../src/features/story/eventTaskOutcome'

const nodes=Array.from({length:8},(_,i)=>({id:'N'+i,name:'节点'+i,summary:'公开审案',process:i===0?'范仪呈上账册':i===1?'呈上账册':'查明冤案',revision:1,order:i,chapterIndex:String(i)}))
const event={id:'E',bookId:'b',title:'朝廷查办冤案',summary:'朝廷接到范仪递交的冤案材料',nodeIds:['N0'],revision:1}
const a:NarrativeAssets={nodes,events:[event],lines:[],notes:[]}
const fields={name:'朝廷清查案卷',overview:'朝廷接到范仪递交的冤案材料',latest_progress:'相关案卷已由御史正式接收',unresolved:'尚需核对案卷中涉及的相关人证',clues:['冤案'],status:'进行中',nodeIds:['N1']}

it('各表的存储契约和模型工具只校验文本非空，不按写作字数拒收',()=>{
  function check(schema:unknown, path:string) {
    if (!schema || typeof schema !== 'object') return
    const rule=schema as Row
    if ('maxLength' in rule || Number(rule.minLength)>1) throw Error('字段设置了字数限制：'+path)
    for (const [key,value] of Object.entries(rule)) check(value,path+'/'+key)
  }
  check(inputSchema('StoryEvent'),'storage')
  check(toolContracts,'tools')
  check(Object.fromEntries(resultContracts),'results')
  for (const mode of ['link_node','review_event']) check(eventToolsSchema(mode),mode)
})

it('串联请求只发送一次详细经过，保留人物和线索，省略内部绑定信息',()=>{
  const node={...nodes[0],quote:'核对原文',chapterName:'第一章',offset:8,time_hint:'上午',actors:['范仪'],clues:['案卷'],targetBindings:[],actorIds:['C1']}
  const task=scheduleNarrative(newNarrativePlan(),{...a,nodes:[node]})!
  expect(task.prompt.split(node.process)).toHaveLength(2)
  const current=JSON.parse(task.prompt.split('【当前节点概览开始】')[1].split('【当前节点概览结束】')[0])
  expect(current).toMatchObject({detail:node.process,actors:['范仪'],clues:['案卷']})
  for(const key of ['process','actorIds','targetBindings','quote','source_position','chapterName','offset','time_hint']) expect(current).not.toHaveProperty(key)
})

it('节点搜索仅供复核，串联可按编号读取可见节点与按条件搜事件',()=>{
  const plan=newNarrativePlan()
  plan.nodes.N0='completed'
  const task=scheduleNarrative(plan,a)!
  const query=(name:string,args:Row)=>readEventTool(name,args,task,a)
  const reviewQuery=(name:string,args:Row)=>readEventTool(name,args,{...task,mode:'review_event'},a)
  expect(()=>query('search_nodes',{groups:[['账册']]})).toThrow()
  expect(reviewQuery('search_nodes',{groups:[['范仪','账册'],['别名']],return_fields:['detail']})).toMatchObject({
    total:1,items:[{node_id:'N0',detail:'范仪呈上账册'}]})
  expect(reviewQuery('search_nodes',{groups:[['公开审案']]}).total).toBe(0)
  expect(reviewQuery('search_nodes',{groups:[['范仪']],exclude_event_id:'E'}).total).toBe(0)
  expect(query('get_nodes',{node_ids:['N1','N6','N7']})).toMatchObject({items:[{node_id:'N1'},{node_id:'N6'}],not_found_ids:['N7']})
  expect(query('search_events',{groups:[['范仪']],return_fields:['name']})).toMatchObject({items:[{event_id:'E',name:'朝廷查办冤案'}]})
})
it('前序搜索以任务节点为界，只查详细经过；默认只回编号与概述，可指定其他字段',()=>{
  const plan=newNarrativePlan()
  const current=scheduleNarrative(plan,a)!
  const rows=Array.from({length:24},(_,i)=>({...nodes[0],id:'P'+i,clues:['内应'],process:'蔡权透露泄密'}))
  const assets={...a,nodes:rows,events:[{...event,nodeIds:['P20']}]}
  const task={...current,ids:['P22']}
  const args={groups:[['蔡权','泄密'],['通贼']]}
  const result=readEventTool('search_prior_nodes',args,task,assets)
  const items=result.items as Row[]
  expect(result).toMatchObject({total:22,truncated:true})
  expect(items.map(n=>n.node_id)).toEqual(rows.slice(2,22).reverse().map(n=>n.id))
  expect(items[1]).toEqual({node_id:'P20',summary:rows[20].summary})
  expect(readEventTool('search_prior_nodes',{groups:[['内应','泄密'],['公开审案'],['节点0']]},task,assets).total).toBe(0)
  expect((readEventTool('search_prior_nodes',{...args,return_fields:['detail','event_ids']},task,assets).items as Row[])[1])
    .toEqual({node_id:'P20',detail:'蔡权透露泄密',event_ids:['E']})
  expect(readEventTool('get_nodes',{node_ids:['P20']},task,assets)).toMatchObject({items:[{node_id:'P20',event_ids:['E']}]})
  expect(readEventTool('search_prior_nodes',args,{...task,ids:['P0']},assets)).toEqual({items:[],total:0,truncated:false})
  expect(()=>readEventTool('search_prior_nodes',args,{...task,mode:'review_event'},assets)).toThrow()
})

it('整批回滚，已读成员才可替换，可共享历史成员，重启后同一操作只执行一次',async()=>{
  const plan=newNarrativePlan()
  plan.nodes.N0='completed'
  const task=scheduleNarrative(plan,a)!
  const bookId='b',runId='run',owner='owner'
  const repo=createMemoryAgentRepository(bookId,{
    nodes:nodes.map(r=>({...r,bookId})),storyEvents:[{...event,nodeIds:['N0','N7']}],pipelineRuns:[
      {id:'lease:narrative',bookId,owner,runId,expiresAt:Date.now()+60000},
      {id:runId,bookId,narrative:plan,tasks:[{taskId:task.id,input:task}]},
      {id:task.id,bookId,observed:{'node:N0':'1','node:N1':'1','event:E':'1'}}]})
  const tools=()=>narrativeTools(repo,{bookId,runId,owner,taskId:task.id,profile:'story_editor',phase:'window_link',outline:true,workItemIds:[]},task).tools
  async function invoke(name:string,args:Row,key:string=crypto.randomUUID()) {
    const result = await tools().find(t=>t.name===name)!.execute(key,args)
    const body = result.content[0]
    expect(body.type === 'text' && JSON.parse(body.text)).toEqual(result.details)
    return result.details as Row
  }
  expect(await invoke('search_prior_nodes',{groups:[['账册']]},'lookup')).toEqual({items:[
    {node_id:'N0',summary:'公开审案'}],total:1,truncated:false})
  expect(await repo.transaction(false,s=>s.get('pipelineRuns',task.id+':lookup'))).toBeUndefined()
  const progress = '查明账册缺页，仍须核对原件。'.repeat(4)
  const change = {op:'update',event_id:'E',fields:{latest_progress:progress},reason:'核对账册'}
  const prepare = tools().find(t=>t.name==='edit_events')!.prepareArguments!
  expect(prepare({changes:[change]})).toEqual({changes:[change]})
  expect(()=>prepare({changes:[{...change,fields:{latest_progress:42}}]})).toThrow(/changes\/0\/fields\/latest_progress/)
  expect(await invoke('edit_events',{changes:[change]})).toMatchObject({ok:true})
  expect(await repo.transaction(false,s=>s.get('storyEvents','E'))).toMatchObject({latestProgress:progress})
  const invalid = await invoke('edit_events',{changes:[change,{...change,fields:{latest_progress:42}}]})
  expect(invalid).toMatchObject({ok:false,operationNumber:2,fields:['/changes/1/fields/latest_progress']})
  expect(invalid.reason).not.toMatch(/oneOf|schema is false|equal to constant|required properties name/)
  const add={op:'create',fields:{...fields,status:'已闭环',unresolved:'',nodeIds:['N0','N1']},reason:'御史已接收案卷'}
  expect(await invoke('edit_events',{changes:[add,{...add,fields:{...fields,nodeIds:['N2']}}]})).toMatchObject({ok:false})
  expect(await repo.transaction(false,s=>s.rows('storyEvents'))).toHaveLength(1)
  const update={op:'update',event_id:'E',fields:{nodeIds:['N1','N0','N7']},reason:'补上范仪申冤的早期证据',evidence_node_ids:['N0','N1']}
  expect(await invoke('edit_events',{changes:[update]})).toMatchObject({ok:false})
  const detail=await invoke('get_event',{event_id:'E'})
  expect(detail).not.toHaveProperty('nodeIds')
  expect((detail.members as Row[])[0]).toEqual({node_id:'N0',name:'节点0'})
  expect(await invoke('get_nodes',{node_ids:['N1'],return_fields:['quote']})).toEqual({items:[{node_id:'N1',quote:null}]})
  expect(await invoke('search_events',{groups:[['范仪']]})).toEqual({total:1,truncated:false,items:[{event_id:'E',name:event.title,overview:event.summary}]})
  const saved=await invoke('edit_events',{changes:[update,add]},'stable')
  expect(saved).toEqual({ok:true,current_node_assigned:true,
    created:[{event_id:expect.any(String),name:fields.name,added:['N0','N1']}],
    updated:[{event_id:'E',added:['N1'],saved_fields:{nodeIds:['N0','N1','N7']}}]})
  const receipt=await repo.transaction(false,s=>s.get('pipelineRuns',task.id+':stable'))
  expect(receipt?.result).toMatchObject({events:[{event_id:'E',nodeIds:['N0','N1','N7']},{status:'已闭环',unresolved:''}],
    changes:[{reason:update.reason,evidence_node_ids:update.evidence_node_ids},{reason:add.reason}]})
  const view=buildEventTaskOutcome(task,[receipt!])
  expect(view.cards.map(c=>c.action)).toEqual(['已有事件','本轮新建'])
  expect(view.cards[0].members.map(n=>[n.id,n.badge])).toEqual([['N0',''],['N1','新加入 · 当前节点'],['N7','']])
  expect(view.cards[0].members[1].summary).toBe(nodes[1].summary)
  expect(view.cards[1].members.map(n=>n.badge)).toEqual(['新加入 · 历史补挂','新加入 · 当前节点'])
  const {display: _display,...legacy}=receipt!.result as Row
  expect(buildEventTaskOutcome(task,[{...receipt,result:legacy}]).cards[0]).toMatchObject({latestOnly:true,added:1})
  expect(await invoke('edit_events',{changes:[update,add]},'stable')).toEqual(saved)
  // 旧版凭据只有完整事件；按同一调用键重放时也只回传本次变动。
  await repo.transaction(true,async store=>{
    const old = {...receipt!.result as Row}
    delete old.current_node_assigned
    await store.put('pipelineRuns',{...receipt!,result:old})
  })
  expect(await invoke('edit_events',{changes:[update,add]},'stable')).toEqual(saved)
  expect(await invoke('edit_events',{changes:[{op:'delete',event_id:'E',reason:'撤销'}]})).toMatchObject({ok:false})
  expect(await invoke('confirm',{result:'completed',reviewed_event_ids:['aeda97c2-e5f0-4a04-9b7e-ce03cc29d693']},'finish')).toMatchObject({confirmed:true})
  expect(await invoke('confirm',{result:'completed',reviewed_event_ids:['aeda97c2-e5f0-4a04-9b7e-ce03cc29d693']},'finish')).toMatchObject({confirmed:true})
  expect(await repo.transaction(false,s=>s.get('pipelineRuns',runId))).toMatchObject({narrative:{nodes:{N1:'completed'},batches:{event:1}}})
})


it('宏观组内合并，确认不抵扣微观主审',async()=>{
  const events=[{...event,id:'B',nodeIds:['N0','N1']},{...event,id:'D',nodeIds:['N0','N1','N3']}]
  const plan=newNarrativePlan()
  plan.reviewOnly=true
  const assets={...a,nodes:[nodes[0],nodes[1],nodes[3]],events}
  const task=scheduleNarrative(plan,assets)!
  const input=JSON.parse(task.prompt)
  expect(task.mode).toBe('review_boundaries')
  expect(input.本组事件.map((e:Row)=>e.event_id)).toEqual(['B','D'])
  expect(input.节点时间表.map((n:Row)=>n.node_id)).toEqual(['N0','N1','N3'])
  expect(input.节点时间表[0]).not.toHaveProperty('detail')
  const observed = {...narrativeVersions(assets,new Set(nodes.map(n=>n.id)),true),...task.basis}
  const repo = createMemoryAgentRepository('b',{nodes,storyEvents:events,pipelineRuns:[
    {id:'lease:narrative',bookId:'b',runId:'r',owner:'o',expiresAt:Date.now()+60000},
    {id:'r',bookId:'b',narrative:plan,tasks:[{taskId:task.id,input:task}]},{id:task.id,bookId:'b',observed}]})
  const tools = narrativeTools(repo,{bookId:'b',runId:'r',owner:'o',taskId:task.id,profile:'story_editor',phase:'window_link',workItemIds:[]},task).tools
  const invoke = async(name:string,args:Row)=>(await tools.find(t=>t.name===name)!.execute(crypto.randomUUID(),args)).details
  expect(await invoke('confirm',{result:'completed',reviewed_event_ids:['C']})).toMatchObject({ok:false})
  expect(await invoke('edit_events',{changes:[
    {op:'update',event_id:'B',fields:{nodeIds:['N0','N1','N3']},reason:'承接遗漏成员'},
    {op:'delete',event_id:'D',replacement_event_ids:['B'],reason:'同一事项已并入 B'},
  ]})).toMatchObject({ok:true,deleted_event_ids:['D']})
  expect(await invoke('confirm',{result:'completed'})).toMatchObject({confirmed:true})
  const next = await repo.transaction(false,async store=>scheduleNarrative((await store.get('pipelineRuns','r'))!.narrative as typeof plan,
    {...assets,events:await store.rows('storyEvents')}))
  expect(next).toMatchObject({mode:'review_sequence',ids:['B']})
})

it('复核组外事件只改状态不会取得完整成员权限，读过的成员可沿用',async()=>{
  const other={...event,id:'B',status:'进行中',nodeIds:['N0','N1','N3']}
  const plan=newNarrativePlan()
  plan.nodes=Object.fromEntries(nodes.map(n=>[n.id,'completed']))
  const events=[{...event,nodeIds:['N7']},{...event,id:'F',nodeIds:['N7']},other]
  const task=scheduleNarrative(plan,{...a,events})!
  const repo=createMemoryAgentRepository('b',{nodes,storyEvents:events,pipelineRuns:[
    {id:'lease:narrative',bookId:'b',runId:'r',owner:'o',expiresAt:Date.now()+60000},
    {id:'r',bookId:'b',narrative:plan,tasks:[{taskId:task.id,input:task}]},
    {id:task.id,bookId:'b',observed:{'node:N0':'1','node:N3':'1','event:B':'1','full:event:B':'1'}}]})
  const tools=narrativeTools(repo,{bookId:'b',runId:'r',owner:'o',taskId:task.id,profile:'story_editor',phase:'window_link',workItemIds:[]},task).tools
  const invoke=async(name:string,args:Row)=>(await tools.find(t=>t.name===name)!.execute(crypto.randomUUID(),args)).details
  const edit=(fields:Row)=>invoke('edit_events',{changes:[{op:'update',event_id:'B',fields,reason:'复核组外事件'}]})
  expect(await edit({status:'暂时搁置'})).toMatchObject({ok:true})
  expect(await edit({nodeIds:['N0']})).toMatchObject({ok:false})
  expect(await repo.transaction(false,s=>s.get('storyEvents','B'))).toMatchObject({nodeIds:['N0','N1','N3']})
  await invoke('get_event',{event_id:'B'})
  expect(await edit({status:'进行中'})).toMatchObject({ok:true})
  expect(await edit({nodeIds:['N0','N3'],latest_progress:'已核对当时保留下来的案卷'})).toMatchObject({ok:true})
  const receipts=await repo.transaction(false,s=>s.rows('pipelineRuns'))
  const card=buildEventTaskOutcome(task,receipts.filter(r=>r.recordType==='narrative_receipt')).cards[0]
  expect(card).toMatchObject({action:'已有事件',initialCount:3,resultCount:2,removed:1})
  expect(card.members.map(n=>[n.id,n.badge])).toEqual([['N0',''],['N1','本次移除'],['N3','']])
  expect(card.fields.map(f=>f.key)).toEqual(['latest_progress'])
  expect(card.edits).toHaveLength(3)
})

it.each([true,false])('旧调用按原始归属 %s 和本任务此前的编辑还原，后来归入另一事件不改写早期结果',async(initiallyAssigned)=>{
  const plan=newNarrativePlan()
  plan.nodes.N0='completed'
  const task=scheduleNarrative(plan,{...a,events:[event,...(initiallyAssigned?[{...event,id:'A',nodeIds:['N1']}]:[])]})!
  const editArgs={changes:[{op:'update',event_id:'E',fields:{status:'进行中'},reason:'复核状态'}]}
  const saved={ok:true,events:[{event_id:'E',nodeIds:['N0'],status:'进行中'}],changes:[{event_id:'E',added:[],removed:[]}]}
  const keys=['z-first','y-attach','a-last']
  const receipts=keys.map((key,i)=>({id:task.id+':'+key,runId:'r',taskId:task.id,name:'edit_events',recordType:'narrative_receipt',
    status:'completed',startedAt:'same-time',signature:canonical(['edit_events',editArgs]),arguments:editArgs,
    result:i===1 ? {...saved,events:[{event_id:'B',nodeIds:['N1']}],changes:[{event_id:'B',added:['N1'],removed:[]}]} : saved}))
  const repo=createMemoryAgentRepository('b',{pipelineRuns:[
    {id:'lease:narrative',runId:'r',bookId:'b',owner:'o',expiresAt:Date.now()+60000},{id:'r',narrative:plan},...receipts],
    storySessionEntries:[{id:'input',taskId:task.id,type:'message',ordinal:1,message:{role:'user',content:task.prompt}},
      {id:'calls',taskId:task.id,type:'message',ordinal:2,message:{role:'assistant',content:keys.map(id=>({type:'toolCall',id}))}}]})
  const tools=narrativeTools(repo,{bookId:'b',runId:'r',owner:'o',taskId:task.id,profile:'story_editor',phase:'window_link',workItemIds:[]},task).tools
  const edit=tools.find(t=>t.name==='edit_events')!
  expect((await edit.execute(keys[2],editArgs)).details).toMatchObject({current_node_assigned:true})
  expect((await edit.execute(keys[0],editArgs)).details).toMatchObject({current_node_assigned:initiallyAssigned})
  const short={ok:true,created:[],updated:[{event_id:'E'}]}
  const restored=await repo.transaction(false,async store=>historicalEventReply(store,task)(keys[0],'edit_events',editArgs,short))
  expect(restored).toEqual({...short,current_node_assigned:initiallyAssigned})
})

it('微观携证据转回宏观；宏观确认后逐件重审，未关联事件保持已审',()=>{
  const plan=newNarrativePlan()
  plan.reviewOnly=true
  const assets={...a,nodes:nodes.slice(0,3),events:['A','B','C'].map((id,i)=>({...event,id,nodeIds:['N'+i]}))}
  const next=()=>scheduleNarrative(plan,assets)!
  expect(next()).toMatchObject({mode:'review_sequence',ids:['A']})
  finishReview(plan,assets,{result:'completed'})
  expect(next().ids).toEqual(['B'])
  finishReview(plan,assets,{result:'completed'})
  expect(next().ids).toEqual(['C'])
  finishReview(plan,assets,{result:'return_to_macro',event_ids:['B','C'],evidence_node_ids:['N1','N2'],reason:'书信转交是否同一承诺'})
  const group=next()
  expect(group.mode).toBe('review_boundaries')
  const input=JSON.parse(group.prompt)
  expect(input.节点时间表.map((n:Row)=>n.node_id)).toEqual(['N1','N2'])
  expect(input.转回依据.reason).toBe('书信转交是否同一承诺')
  finishReview(plan,assets,{result:'completed',reason:'两次分别交给不同收件人'})
  expect(next()).toMatchObject({mode:'review_sequence',ids:['B']})
  expect(plan.twoStep!.checked).toEqual({A:'1'})
  finishReview(plan,assets,{result:'completed'})
  expect(JSON.parse(next().prompt).宏观处理意见).toBe('两次分别交给不同收件人')
  finishReview(plan,assets,{result:'completed'})
  expect(next()).toBeUndefined()
})

it('单点重合和零重合的具体线索对一起重排，人物名不能单独触发',async()=>{
  const e=(id:string,nodeIds:string[],clues:string[])=>({...event,id,title:id,nodeIds,clues,latestProgress:'查'+id})
  const index=indexReviewGroups({...a,events:[
    e('A',['N0','N1'],['范仪','范仪冤案','湖北学政文书']),
    e('B',['N1','N2'],['范仪冤案','湖北学政文书']),
    e('C',['N3','N4'],['范仪冤案']),
    e('D',['N0','N5'],['范仪']),
  ]},['范仪'])
  const groups=index.semantic.map(p=>p.ids.join(''))
  expect(index.overlap).toHaveLength(0)
  expect(groups).toEqual(['AB','AC','BC'])
  const calls:string[]=[]
  await rankCluePairs(index,{embeddings:async()=>[],rerank:async(q,docs)=>{
    calls.push(q);return docs.map(d=>Number(q==='查B' && d.startsWith('A')))
  }},new AbortController().signal,new Map())
  expect(calls.sort()).toEqual(['查A','查B','查C'])
  expect(index.semantic[0]).toMatchObject({ids:['A','B'],shared:['N1'],score:1})
})

it('有未归属节点时从宏观直接到微观，时间表只含本任务的成员',()=>{
  const plan=newNarrativePlan()
  plan.reviewOnly=true
  const assets={...a,events:[{...event,id:'A',nodeIds:['N0']},{...event,id:'B',nodeIds:['N0']}]}
  const seen:string[]=[]
  for(let i=0;i<5;i++){
    const task=scheduleNarrative(plan,assets)
    if(!task) break
    const data=JSON.parse(task.prompt)
    expect((data.节点时间表 ?? data.成员时间表).map((n:Row)=>n.node_id)).toEqual(['N0'])
    seen.push(task.mode+'/'+task.part)
    finishReview(plan,assets,{result:'completed'})
  }
  expect(seen).toEqual(['review_boundaries/structure','review_sequence/structure','review_sequence/structure'])
  expect(plan.complete).toBe(true)
})
