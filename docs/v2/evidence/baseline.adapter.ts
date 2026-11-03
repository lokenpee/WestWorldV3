/** 原应用适配器，仅连接待测边界；独立断言/预期在acceptance，不在此计算。 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Type } from '@sinclair/typebox'
import { zipSync, strToU8 } from 'fflate'
import { getCanonDb, resetCanonDbForTest } from '../../../../app/src/core/db/canon.ts'
import { getSettingsDb, resetSettingsDbForTest } from '../../../../app/src/core/db/settings.ts'
import { importBook } from '../../../../app/src/core/pipeline/import-book.ts'
import { splitChapters, parseChapterRegex } from '../../../../app/src/core/pipeline/split-chapters.ts'
import { buildChapterWindows } from '../../../../app/src/core/pipeline/run-all.ts'
import { runP1 } from '../../../../app/src/core/pipeline/run-p1.ts'
import { runLink, validateLinkResult } from '../../../../app/src/core/pipeline/run-link.ts'
import { publishCanon, createNameResolver } from '../../../../app/src/core/pipeline/publish.ts'
import * as edit from '../../../../app/src/core/assets/edit.ts'
import { deleteAssetBook } from '../../../../app/src/core/assets/library.ts'
import { createCompileTools } from '../../../../app/src/core/tools/compile-tools.ts'
import { createEventBus } from '../../../../app/src/core/events/bus.ts'
import { twoPassAssetGroups } from '../../../../app/src/core/pipeline/asset-merge-policy.ts'
import { assignFrequencyWeights } from '../../../../app/src/core/pipeline/character-merge-policy.ts'
import { exportBook } from '../../../../app/src/core/export/export-book.ts'
import { importBackup, inspectBackup } from '../../../../app/src/core/export/import-book.ts'
import { saveApiKey, isApiKeyConfigured } from '../../../../app/src/core/config/settings.ts'
import { resetModelsForTest } from '../../../../app/src/core/llm/models.ts'
import * as sessions from '../../../../app/src/core/session/store.ts'
import { compactStoryContext } from '../../../../app/src/core/session/compaction.ts'
import { runAgent } from '../../../../app/src/core/agent/run.ts'

const OUT=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const originalFetch=globalThis.fetch
const clean=(v:any)=>v===undefined?undefined:JSON.parse(JSON.stringify(v))
const counts=async(db:any)=>Object.fromEntries(await Promise.all(db.tables.map(async(t:any)=>[t.name,await t.count()])))
function sse(turn:any,index:number) {
 const id=`replay_call_${index}`
 const chunks=[{choices:[{index:0,delta:{role:'assistant',reasoning_content:'核对测试样本。'},finish_reason:null}]},
 {choices:[{index:0,delta:{tool_calls:[{index:0,id,type:'function',function:{name:turn.tool,arguments:JSON.stringify(turn.args)}}]},finish_reason:null}]},
 {choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130}}]
 return new Response(chunks.map(c=>'data: '+JSON.stringify({id,object:'chat.completion.chunk',created:1,model:'deepseek-v4-pro',...c})+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
}
export async function createHarness(){
 const owned=new Set<string>()
 return {
  async reset(){await resetCanonDbForTest();await resetSettingsDbForTest();resetModelsForTest();globalThis.fetch=async()=>{throw new Error('UNEXPECTED_NETWORK: baseline is isolated')};},
  async load(seed:any){
   owned.add(seed.bookId)
   if(seed.books?.length)await getSettingsDb().books.bulkPut(seed.books)
   const db=getCanonDb(seed.bookId)
   for(const [name,rows]of Object.entries(seed.canon??{}))if((rows as any[]).length)await db.table(name).bulkPut(rows as any[])
  },
  async snapshot(bookId:string){
   const db=getCanonDb(bookId)
   const canon=Object.fromEntries(await Promise.all(db.tables.map(async t=>{let rows=await t.toArray();if(t.name==='storySessions')rows.sort((a:any,b:any)=>a.createdAt.localeCompare(b.createdAt)||(a.kind==='initial'?-1:1));return[t.name,clean(rows)]})))
   return {books:clean(await getSettingsDb().books.toArray()),canon}
  },
  async execute(command:string,a:any){
   const db=a.bookId?getCanonDb(a.bookId):undefined
   if(a.bookId)owned.add(a.bookId)
   switch(command){
    case'split':return splitChapters(a.text,a.regex?{regex:parseChapterRegex(a.regex)}:{})
    case'parseRegex':return parseChapterRegex(a.value).toString()
    case'import':owned.add(a.id);return importBook(a)
    case'updateCharacter':return edit.updateCharacterSnapshot(a.bookId,a.id,a.patch)
    case'updateNode':return edit.updateNode(a.bookId,a.id,a.patch)
    case'setRole':return edit.setCharacterRoleWeight(a.bookId,a.id,a.roleWeight)
    case'mergeCharacter':return edit.mergeCharacterSnapshots(a.bookId,a.keepId,a.mergeIds)
    case'deleteNode':return edit.deleteNode(a.bookId,a.id)
    case'deleteLine':return edit.deleteEventLine(a.bookId,a.id)
    case'publish':return publishCanon(a.bookId)
    case'resolveName':return createNameResolver(a.entries)(a.name)
    case'saveKey':return saveApiKey(a.key)
    case'keyConfigured':return isApiKeyConfigured()
    case'deleteBook':return deleteAssetBook(a.bookId)
    case'windows':{
     const chapters=Array.from({length:a.count},(_,i)=>({bookId:'test',chapterIndex:String(i+1),chapterName:'',charCount:1,order:i*2})).flatMap(c=>Number(c.chapterIndex)===a.splitChapter?[{...c,chapterIndex:c.chapterIndex+'.1'},{...c,chapterIndex:c.chapterIndex+'.2',order:c.order+1}]:[c]);return buildChapterWindows(chapters)
    }
    case'groups':return twoPassAssetGroups(a.records,{name:(r:any)=>r.name,aliases:(r:any)=>r.aliases,allowContainment:a.kind!=='location'})
    case'frequency':assignFrequencyWeights(a.entities,a.texts);return a.entities
    case'tool':{
     const tools=await createCompileTools(a.bookId,{profile:'story_editor',sessionId:''});return clean(await tools.find(t=>t.tool.name===a.name)!.execute(a.args))
    }
    case'validateLink':return validateLinkResult(a.bookId,a.proposal,new Map((await db!.nodes.toArray()).map(n=>[n.id,n])),new Map((await db!.eventLines.toArray()).map(l=>[l.id,l])))
    case'runP1':case'runLink':{
     const requests:any[]=[];let at=0;const control=new AbortController()
     const call=async(opts:any)=>{
      const kind=opts.schema?.properties?.characters?'world':opts.schema?.properties?.nodes?'narrative':'link'
      requests.push(clean({kind,role:opts.role,system:opts.system,messages:opts.messages,schema:opts.schema}))
      const response=a.responses[at++];if(!response)throw new Error('Missing scripted response')
      if(a.abortAfterResponse===at)control.abort()
      return structuredClone(response)
     }
     const result=command==='runP1'?await runP1(a.bookId,{concurrency:1,signal:control.signal,bus:createEventBus(),deps:{call:call as any}}):await runLink(a.bookId,{bus:createEventBus(),deps:{call:call as any},stage:'P2'})
     return {...result,requests}
    }
    case'backupRoundTrip':{
     const b=await exportBook(a.bookId);const inspect=await inspectBackup(b.bytes);const restored=await importBackup(b.bytes);owned.add(restored.bookId)
     return {inspect,newTitle:(await getSettingsDb().books.get(restored.bookId))!.title,originalStillExists:!!(await getSettingsDb().books.get(a.bookId)),sameBookId:restored.bookId===a.bookId,restoredCounts:await counts(getCanonDb(restored.bookId))}
    }
    case'inspectInvalid':{
     if(a.kind==='notZip')return inspectBackup(new Uint8Array([0,1,2]))
     const files:any={}
     if(a.kind==='newer'||a.kind==='missingStats')files['manifest.json']=strToU8(JSON.stringify({format:'westworld-v2',formatVersion:a.kind==='newer'?999:4,book:{title:'fixture'},checksums:{}}))
     return inspectBackup(zipSync(files))
    }
    case'newSession':return sessions.ensureStorySession(a.bookId,a.newReview)
    case'sessionWithMessages':{
     const ref=await sessions.ensureStorySession(a.bookId);const owner=await sessions.acquireStorySession(ref)
     try{for(let i=0;i<3;i++)await sessions.appendSessionMessage(ref,{role:'user',content:'甲'.repeat(a.chars),timestamp:i},owner)}finally{await sessions.releaseStorySession(ref,owner)}
     return ref
    }
    case'compact':{
     const ref={bookId:a.bookId,id:a.id};const owner=await sessions.acquireStorySession(ref)
     try{await compactStoryContext(ref,owner,{contextWindow:8192,force:true,summarize:async()=>a.summaryFailure?{ok:false,stopReason:'error',attempts:1,attemptsUsage:[]}:{ok:true,data:{summary:a.summary},stopReason:'toolUse',attempts:1,attemptsUsage:[]}})}finally{await sessions.releaseStorySession(ref,owner)}
     const entries=await sessions.sessionEntries(ref);const comp=entries.filter(e=>e.type==='compaction');return {compactions:comp.length,originalMessageCount:entries.filter(e=>e.type==='message').length,summary:(comp.at(-1)as any)?.summary}
    }
    case'pipelineHttp':case'agentHttp':{
     await saveApiKey('test-only-not-a-real-key')
     const requests:any[]=[];let turn=0
     globalThis.fetch=async(input:any,init:any)=>{
      if(turn>=a.script.length)throw new Error('Missing HTTP replay response')
      requests.push({url:String(input),body:JSON.parse(init.body)})
      return sse(a.script[turn],turn++)
     }
     try{
      const tools=await createCompileTools(a.bookId,{profile:'asset_editor'})
      const result=command==='pipelineHttp'?(a.stage==='p1'?await runP1(a.bookId,{concurrency:1,bus:createEventBus()}):await runLink(a.bookId,{stage:'P2',bus:createEventBus()})):await runAgent({role:'aggregation',system:'核对测试样本后提交answer字符串。',messages:[{role:'user',content:'核对当前节点。',timestamp:0}],schema:Type.Object({answer:Type.String()},{additionalProperties:false}),tools,agentProfile:'asset_editor'})
      const record={script:a.script,requests,result:clean(result)}
      const label=command==='pipelineHttp'?(a.stage==='p1'?'p1-world-and-narrative':a.script[0].tool==='query_nodes'?'link-query-commit':'link-invalid-repair'):(a.script.length===2&&a.script[0].tool==='query_nodes'?'agent-query-submit':typeof a.script.at(-1).args.answer==='string'?'agent-submit-repair':'agent-submit-failure')
      await fs.writeFile(path.join(OUT,'resources/replays',label+'.json'),JSON.stringify(record,null,2))
      return {result,requestCount:requests.length}
     }finally{globalThis.fetch=async()=>{throw new Error('UNEXPECTED_NETWORK')}}
    }
    default:throw new Error('Unsupported adapter command: '+command)
   }
  },
  async close(){await resetCanonDbForTest();await resetSettingsDbForTest();globalThis.fetch=originalFetch;resetModelsForTest()},
 }
}
