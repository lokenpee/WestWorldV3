// Builds specification fixtures from supplied contracts only. No application imports or network.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base=path.join(root,'resources'); const r=path.join(base,'v2.2');
const read=n=>JSON.parse(fs.readFileSync(path.join(r,n),'utf8'));
const old=JSON.parse(fs.readFileSync(path.join(base,'schemas.json'),'utf8'));
const manifest=read('prompt-call-manifest.json'); const models=read('model-output-contract.json').schemas;
const declarations=read('tool-contracts.json'); const outputs=read('tool-results.schema.json').tools;
const text=n=>fs.readFileSync(path.join(r,'prompts/active',n),'utf8').replace(/\r\n/g,'\n');
const clone=x=>structuredClone(x);
const canonical=x=>JSON.stringify(x && typeof x==='object'?sort(x):x);
function sort(x){return Array.isArray(x)?x.map(sort):x && typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;}
function render(template,bindings){return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g,(all,key)=>Object.hasOwn(bindings,key)?String(bindings[key]):all);}
const now=1792800000000;
const emptyMemory={id:'session-example',sessionId:'session-example',bookId:'book-a',revision:0,workingSummary:'',dataFingerprint:'',updatedAt:''};
const work={workItemId:'ai_identity:fullBook:character:C1-P001',kind:'character',id:'C1-P001',revision:1,factFingerprint:'fixture-character-v1'};
const common={bookId:'book-a',runId:'run-example',taskId:'task-example',planVersion:'2.2',remainingCount:1,resume:{reason:'initial',appliedCommitIds:[],nextOperationKey:'task-example:1',remainingWorkIds:[work.workItemId]}};
const story={...clone(common),stage:'P3',phase:'window_link',sessionId:'session-example',queue:'window_nodes',window:{start:0,end:1,chapterIndices:['1']},workItems:[{...work,kind:'node',id:'C1-N001',workItemId:'window_link:0-1:node:C1-N001',factFingerprint:'fixture-node-v1'}],existingLines:[],memory:emptyMemory,afterWorkItemId:null};
story.resume.remainingWorkIds=[story.workItems[0].workItemId];
const inputs={
 'PROMPT-P1-WORLD':{chapterIndex:'1',chapterName:'码头',text:'沈青是船夫。沈青在码头收到来信。'},
 'PROMPT-P1-NARRATIVE':{chapterIndex:'1',chapterName:'码头',text:'沈青是船夫。沈青在码头收到来信。'},
 'PROMPT-P2-IDENTITY':{...clone(common),stage:'P2',phase:'ai_identity',kind:'character',scope:'fullBook',workItems:[work],afterId:null,pageLimit:100},
 'PROMPT-P2-CHARACTER':{stage:'P2',entities:[{id:'C1-P001',name:'沈青',aliases:[],revision:1,reason:'身份事实冗余',previous:{identity:'船夫'},facts:[{id:'F1',field:'identity',text:'船夫'}],conflicts:[]}]},
 'PROMPT-P2-LOCATION':{stage:'P2',id:'C1-L001',name:'码头',revision:1,description:'河边的码头',facts:[{id:'F1',field:'description',text:'河边的码头'}],conflicts:[]},
 'PROMPT-P3-WINDOW':story,
 'PROMPT-P3-GLOBAL':{...clone(story),phase:'global_review',queue:'orphans',window:null,workItems:[{...story.workItems[0],workItemId:'global_review:orphans:node:C1-N001'}]},
 'PROMPT-COMPACT':{previousSummary:'',transcript:'[原始条目 E1，角色 user]\n{"role":"user","content":"核对第一章","timestamp":1792800000000}'},
 'PROMPT-PROBE-DIRECT':{},
 'PROMPT-PROBE-AGENT':{suite:'asset',taskId:'probe-asset',operationKey:'probe-asset:1'},
};
inputs['PROMPT-P3-GLOBAL'].resume.remainingWorkIds=[inputs['PROMPT-P3-GLOBAL'].workItems[0].workItemId];
function characterSchema(input){
 const template=old.CharacterOptimizationBatchSchema.properties.entities.patternProperties['^(.*)$'];
 const props={};
 for(const entity of input.entities){
  const x=clone(template);const names=[...new Set([entity.name,...entity.aliases])];
  x.properties.entity.properties.name={enum:names};x.properties.entity.properties.aliases={type:'array',items:{enum:names}};
  x.properties.covered_fact_ids={type:'array',items:{enum:entity.facts.map(f=>f.id)},minItems:entity.facts.length,maxItems:entity.facts.length,uniqueItems:true}; props[entity.id]=x;
 }
 return {type:'object',additionalProperties:false,properties:{entities:{type:'object',additionalProperties:false,properties:props,required:Object.keys(props)}},required:['entities']};
}
function declaration(t){const result=outputs.find(o=>o.name===t.name);return {name:t.name,description:t.description,parameters:t.parameters,...(result?{outputSchema:result.success}:{})};}
function build(c,input){
 const business=c.prompt?fs.readFileSync(path.join(base,c.prompt),'utf8').replace(/\r\n/g,'\n'):'';
 let schema=c.outputSchema==='dynamic-character'?characterSchema(input):(models[c.outputSchema]??old[c.outputSchema]);
 if(c.id==='PROMPT-P2-LOCATION'){schema=clone(schema);schema.properties.coveredFactIds={type:'array',items:{enum:input.facts.map(f=>f.id)},minItems:input.facts.length,maxItems:input.facts.length,uniqueItems:true};}
 const submit=schema?{name:'submit_result',description:c.mode==='agent'?'总结当前task已提交确认、逐项判断与剩余工作；不得写业务。':'提交符合本次Schema的结构化结果；由调用方校验并应用。',parameters:schema,...(c.mode==='direct'?{constrainedSampling:{type:'json_schema',strict:'prefer'}}:{})}:null;
 const profile=c.profile==='probe'?(input.suite==='asset'?'asset_editor':'story_editor'):c.profile;
 const tools=c.mode==='agent'?[...declarations.profiles[profile].map(declaration),submit]:submit?[submit]:[];
 let user;
 switch(c.userTemplate){
 case 'chapter': user=`章节标识：${input.chapterIndex}\n章节名：${input.chapterName}\n\n--- 正文开始 ---\n${input.text}\n--- 正文结束 ---`;break;
 case 'identity': case 'story':user=render(text(c.userTemplate+'.txt'),{taskJson:canonical(input)});break;
 case 'compact':user=`【旧摘要】\n${input.previousSummary||'无'}\n【需要压缩的原始会话数据】\n${input.transcript}`;break;
 case 'direct-probe':user='回复一个字：好';break;
 case 'agent-probe':user=render(text('probe_'+input.suite+'.txt'),input);break;
 default:user=canonical(input);
 }
 const roleInstruction=profile==='asset_editor'?'只整理人物地点；不读故事会话/工作记忆，不改叙事实体。':'只整理节点、事件线和工作记忆；不合并人物地点，历史摘要不是原文事实。';
 const system=c.mode==='agent'&&c.profile!=='probe'?render(text('agent-wrapper.txt'),{bookId:input.bookId,runId:input.runId,taskId:input.taskId,profile,phase:input.phase,roleInstruction,maxSteps:c.maxSteps,businessPrompt:business}):business;
 const messages=c.mode==='agent'?[{role:'system',content:system,toolsAdded:tools,timestamp:now},{role:'user',content:user,timestamp:now}]:[{role:'user',content:user,timestamp:now}];
 const window=128000,reserve=Math.min(32768,Math.max(128,Math.floor(window/4)));
 let maxTokens=c.maxTokens;
 if(typeof maxTokens==='string')maxTokens=maxTokens.startsWith('omit')?undefined:c.id==='PROMPT-P2-CHARACTER'?Math.min(16384,reserve,8192):c.id==='PROMPT-COMPACT'?Math.min(16384,Math.max(128,Math.floor(window/8))):Math.min(8192,reserve);
 const extraction=c.role==='extraction'||c.id==='PROMPT-PROBE-DIRECT';
 return {id:c.id,kind:'synthetic-target-request-not-a-recording',inputSchema:c.inputSchema,input,mode:c.mode,modelSnapshot:{providerId:'deepseek',api:'openai-completions',baseUrl:'https://api.deepseek.com',modelId:extraction?'deepseek-flash':'deepseek-v4-pro',modelRole:extraction?'extraction':'aggregation',contextWindow:window,capabilities:{tools:true,structuredOutput:true},credentialRef:'deepseek'},options:{...(typeof c.temperature==='number'?{temperature:c.temperature}:{}),...(typeof maxTokens==='number'?{maxTokens}:{}),...(c.maxSteps?{maxSteps:c.maxSteps}:{}),...(c.timeoutMs?{timeoutMs:c.timeoutMs}:{})},context:{...(c.mode==='direct'&&system?{systemPrompt:system}:{}),messages,...(tools.length?{tools}:{})}};
}
const examples=manifest.calls.map(c=>build(c,inputs[c.id]));
examples.push(build(manifest.calls.find(c=>c.id==='PROMPT-PROBE-AGENT'),{suite:'story',taskId:'probe-story',operationKey:'probe-story:1'})); examples.at(-1).id+='-STORY';
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const assistant=(name,args,id)=>({role:'assistant',content:[{type:'toolCall',name,arguments:args,id}],api:'openai-completions',provider:'deepseek',model:'deepseek-v4-pro',usage,stopReason:'toolUse',timestamp:now});
const result=(name,id,value,error=false)=>({role:'toolResult',toolCallId:id,toolName:name,content:[{type:'text',text:canonical(value)}],details:value,isError:error,timestamp:now});
const source=examples.find(x=>x.id==='PROMPT-P3-WINDOW');
const finalOnly=clone(source);finalOnly.id='VARIANT-P3-FINAL-ONLY';
const ack={ok:true,commitId:'K1',operationKey:'task-example:1',alreadyApplied:false,summary:'摘要已提交'};
const payload={event_line_ops:[],new_nodes:[],memory_update:{workingSummary:'本窗保留独立节点。',notes:[]}};
finalOnly.context.messages.push(assistant('commit_story_changes',{operationKey:'task-example:1',payload},'call-1'),result('commit_story_changes','call-1',ack),{role:'user',content:'[代码提交确认] K1：摘要已提交。',timestamp:now});
const submit=finalOnly.context.tools.find(t=>t.name==='submit_result');
finalOnly.context.messages.push({role:'system',content:'本轮仅最终总结。',toolsRemoved:finalOnly.context.tools.filter(t=>t.name!=='submit_result').map(t=>({name:t.name})),timestamp:now},{role:'user',content:render(text('final_only.txt'),{commitIdsJson:'["K1"]',remainingIdsJson:canonical(story.workItems.map(w=>w.workItemId))}),timestamp:now});finalOnly.context.tools=[submit];examples.push(finalOnly);
const repaired=clone(examples[0]);repaired.id='VARIANT-DIRECT-REPAIR';const badAssistant=assistant('submit_result',{characters:'invalid'},'bad-1');badAssistant.model=repaired.modelSnapshot.modelId;repaired.context.messages.push(badAssistant,result('submit_result','bad-1',{error:'INVALID_ARGS',message:'characters必须为数组'},true),{role:'user',content:render(text('repair_direct.txt'),{error:'characters必须为数组'}),timestamp:now});examples.push(repaired);
const resume=clone(source);resume.id='VARIANT-P3-RECOVERY';resume.context.messages=[source.context.messages[0],{role:'user',content:render(text('compacted_history.txt'),{summary:'此前K1已经提交摘要，节点C1-N001尚待完成核查；原始条目E1可回查。'}),timestamp:now},{role:'user',content:render(text('recovery.txt'),{resumeJson:canonical({reason:'interrupted',appliedCommitIds:['K1'],nextOperationKey:'task-example:2',remainingWorkIds:story.workItems.map(w=>w.workItemId)})}),timestamp:now},source.context.messages[1]];examples.push(resume);
const repairWrite=clone(source);repairWrite.id='VARIANT-P3-WRITE-REPAIR';repairWrite.context.messages.push(assistant('commit_story_changes',{operationKey:'task-example:1',payload:{...payload,memory_update:{workingSummary:'',notes:[]}}},'write-bad'),result('commit_story_changes','write-bad',{error:'INVALID_ARGS',message:'workingSummary不能为空'},true),{role:'user',content:render(text('repair_write.txt'),{error:'workingSummary不能为空',operationKey:'task-example:1',nextOperationKey:'task-example:2'}),timestamp:now});examples.push(repairWrite);
const finalRepair=clone(finalOnly);finalRepair.id='VARIANT-P3-FINAL-REPAIR';finalRepair.context.messages.push(assistant('submit_result',{status:'completed',commitIds:['other-task-K'],summary:'错误确认',remainingWorkIds:[],reviewedItems:[]},'final-bad'),result('submit_result','final-bad',{error:'INVALID_ARGS',message:'commitIds不属于本task'},true),{role:'user',content:render(text('repair_final.txt'),{error:'commitIds不属于本task',commitIdsJson:'["K1"]'}),timestamp:now});examples.push(finalRepair);
const out=path.join(r,'request-examples');fs.mkdirSync(out,{recursive:true});
for(const x of examples)fs.writeFileSync(path.join(out,x.id+'.json'),JSON.stringify(x,null,2)+'\n');
fs.writeFileSync(path.join(out,'index.json'),JSON.stringify({contractRevision:'2026-10-24',kind:'synthetic-contract-fixtures',modelExecuted:false,examples:examples.map(x=>x.id+'.json')},null,2)+'\n');
const e=read('examples.json');e.agentFinalSummary.reviewedItems=[];fs.writeFileSync(path.join(r,'examples.json'),JSON.stringify(e,null,2)+'\n');
console.log(JSON.stringify({requestFixtures:examples.length,modelCalls:0,applicationImports:0}));
