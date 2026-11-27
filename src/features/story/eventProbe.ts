import { createMemoryAgentRepository } from '../agents/repository'
import type { AgentRunner } from '../agents/runtime'
import type { ToolProbeOptions, ProbeResult } from '../agents/probe'
import { narrativeTools } from './narrativeTools'
import { newNarrativePlan, scheduleNarrative } from './narrativePlan'
import { narrativeSystemPrompt } from './narrativePrompts'
import sample from '../../../docs/v2/resources/v2.2/prompts/active/probe_story.txt?raw'

export async function probeEventTools(runner:AgentRunner, options:ToolProbeOptions):Promise<ProbeResult> {
  const started=Date.now(), bookId=crypto.randomUUID(),runId=crypto.randomUUID(),owner=crypto.randomUUID()
  const node={bookId,id:'N001',name:'信使交信',summary:'信使在村口交付密信',process:'守卫在村口从信使手中收下密信。',revision:1}
  const plan=newNarrativePlan()
  const task=scheduleNarrative(plan,{nodes:[node],events:[],lines:[],notes:[]})!
  const repo=createMemoryAgentRepository(bookId,{nodes:[node],pipelineRuns:[
    {id:'lease:narrative',bookId,runId,owner,expiresAt:started+60000},
    {id:runId,bookId,narrative:plan,tasks:[{taskId:task.id,input:task}]},
    {id:task.id,bookId,observed:{'node:N001':'1'}},
  ]})
  const tools=narrativeTools(repo,{bookId,taskId:task.id,runId,owner,outline:true,profile:'story_editor',phase:'window_link',workflow:'narrative_v4',workItemIds:[]},task)
  let readCalls=0,writeCalls=0,attempts=0
  let lastError=''
  const commitIds:string[]=[]
  const step=()=>readCalls ? writeCalls ? '确认节点' : '保存事件' : '读取节点'
  try {
    const response=await runner({systemPrompt:narrativeSystemPrompt(task),prompt:sample,tools:tools.tools,
      afterToolCall:async ()=>tools.confirmed ? {terminate:true}:undefined,
      observeEvent(event) {
        if(event.type==='turn_start') options.onProgress?.({suite:'story',step:'模型生成'})
        if(event.type!=='tool_execution_end') return
        options.onProgress?.({suite:'story',step:event.toolName})
        if(event.isError) {lastError=event.toolName;return}
        if(event.toolName==='get_nodes' && event.result.details?.items?.some((r:{node_id:string})=>r.node_id===node.id)) readCalls++
        if(event.toolName==='edit_events') {
          writeCalls++
          commitIds.push(...(event.result.details?.created ?? []).map((r:{event_id:string})=>r.event_id))
        }
      },
      beforeToolCall:async ({toolCall}) => (toolCall.name==='edit_events' && !readCalls || toolCall.name==='confirm' && !writeCalls)
        ? {block:true,reason:'请先'+step()}:undefined,
      finishTurn:({message})=>tools.confirmed || message.stopReason==='error' ? {action:'end'} :
        message.content.some(c=>c.type==='toolCall') ? undefined : {action:'continue'},
      validateFinal(){if (!tools.confirmed) throw Error(step()+'未完成。')},
    },{signal:options.signal,maxRequests:3,timeoutMs:30000,maxTokens:2048,useModelToolOutput:true})
    attempts=response.attempts.length
    const events=await repo.transaction(false,store=>store.rows('storyEvents'))
    if (!response.ok || !tools.confirmed || !readCalls || events.length!==1 || !commitIds.includes(String(events[0].id)))
      throw Error(step()+'未完成。'+(lastError || (!readCalls ? '模型未调用工具。':'') || response.error?.message || '请核对回执。'))
    return {suite:'story',ok:true,readCalls,writeCalls,commitIds,attempts,elapsedMs:Date.now()-started}
  } catch(error) {
    return {suite:'story',ok:false,error:error instanceof Error ? error.message:String(error),readCalls,writeCalls,commitIds,attempts,elapsedMs:Date.now()-started}
  }
}

