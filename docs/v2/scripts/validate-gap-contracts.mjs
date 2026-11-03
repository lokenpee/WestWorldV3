import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');const repo=path.resolve(root,'../../..');const r=path.join(root,'resources/v2.2');
const require=createRequire(fs.realpathSync(path.join(repo,'app/node_modules/eslint/package.json')));const Ajv=require('ajv');const ajv=new Ajv({allErrors:true,jsonPointers:true});
const read=n=>JSON.parse(fs.readFileSync(path.join(r,n),'utf8'));const checks=[];
function check(name,pass,detail=''){checks.push({name,passed:!!pass,...(!pass?{detail}: {})});}
const P=read('prompt-inputs.schema.json').$defs;const E=read('execution.schema.json').$defs;const D=read('storage.schema.json').$defs;const M=read('model-output-contract.json').schemas;
const manifest=read('prompt-call-manifest.json');
check('ten-call-definitions',manifest.calls.length===10);
check('no-missing-bindings',!JSON.stringify(manifest).includes('incomplete')&&!JSON.stringify(manifest).includes('"missing"'));
for(const c of manifest.calls){
 if(c.prompt){const body=fs.readFileSync(path.join(root,'resources',c.prompt));check('prompt-hash:'+c.id,crypto.createHash('sha256').update(body).digest('hex')===c.promptSha256);}
 check('input-schema:'+c.id,!!ajv.compile({$defs:P,$ref:c.inputSchema.split('#')[1]?'#'+c.inputSchema.split('#')[1]:''}));
}
const index=read('request-examples/index.json');check('sixteen-request-fixtures',index.examples.length===16);
for(const filename of index.examples){
 const x=read('request-examples/'+filename);const validator=ajv.compile({$defs:P,$ref:'#'+x.inputSchema.split('#')[1]});
 check('fixture-input:'+x.id,validator(x.input),JSON.stringify(validator.errors));
 for(const tool of x.context.tools??[])check('tool-schema:'+x.id+':'+tool.name,!!ajv.compile(tool.parameters));
 const pending=new Map();let paired=true;
 for(const m of x.context.messages){
  if(m.role==='assistant')for(const b of m.content??[])if(b.type==='toolCall')pending.set(b.id,b.name);
  if(m.role==='toolResult'){paired &&=pending.get(m.toolCallId)===m.toolName;pending.delete(m.toolCallId);}
  if((m.role==='user'||m.role==='system')&&pending.size)paired=false;
 }
 check('tool-message-pairs:'+x.id,paired&&!pending.size);
 const unresolved=JSON.stringify(x.context).match(/\{(?:businessPrompt|taskJson|roleInstruction|resumeJson|commitIdsJson|remainingIdsJson|maxSteps)\}/g);
 check('templates-rendered:'+x.id,!unresolved,String(unresolved));
 if(x.id.includes('FINAL-'))check('final-only-tools:'+x.id,x.context.tools.length===1&&x.context.tools[0].name==='submit_result');
}
const records=read('execution-examples.json');
for(const [key,def]of [['task','TaskRecord'],['coverageItem','CoverageItem'],['preparedIntent','CommandIntent']]){
 const v=ajv.compile({$defs:E,$ref:'#/$defs/'+def});check('execution-record:'+key,v(records[key]),JSON.stringify(v.errors));
}
const runValidator=ajv.compile({$defs:D,$ref:'#/$defs/PipelineRun'});check('new-run-record',runValidator(records.run),JSON.stringify(runValidator.errors));
const missing=structuredClone(records.run);delete missing.tasks;check('reject-new-run-without-tasks',!runValidator(missing));
const finalValidator=ajv.compile(M.AgentTaskSummarySchema);
check('reject-old-four-field-summary',!finalValidator({status:'completed',commitIds:[],summary:'done',remainingWorkIds:[]}));
check('accept-five-field-summary',finalValidator({status:'completed',commitIds:[],summary:'无变更',remainingWorkIds:[],reviewedItems:[]}));
const cases=read('acceptance/recovery-cases.json').cases;check('six-recovery-fixtures',cases.length===6);
for(const c of cases){
 const run=c.seed.tables.pipelineRuns.find(x=>x.recordType==='run');check('case-run-schema:'+c.id,runValidator(run),JSON.stringify(runValidator.errors));
 check('case-fixed-expectations:'+c.id,c.steps.length>0&&c.steps.every(s=>s.expect&&s.operation&&s.input));
}
const compiler=spawnSync(process.execPath,[path.join(repo,'app/node_modules/typescript/bin/tsc'),'--noEmit','--strict','--target','ES2022','--lib','ES2022,DOM','--skipLibCheck',path.join(r,'architecture-ports.ts')],{cwd:repo,encoding:'utf8',windowsHide:true});
check('architecture-ports-typecheck',compiler.status===0,(compiler.stdout??'')+(compiler.stderr??''));
const syntax=spawnSync(process.execPath,['--check',path.join(r,'acceptance/run.mjs')],{encoding:'utf8',windowsHide:true});check('acceptance-runner-syntax',syntax.status===0,syntax.stderr);
const noAdapter=spawnSync(process.execPath,[path.join(r,'acceptance/run.mjs')],{encoding:'utf8',windowsHide:true});check('runner-refuses-missing-adapter',noAdapter.status!==0&&noAdapter.stderr.includes('Usage:'));
const before=JSON.parse(fs.readFileSync(path.join(root,'evidence/2026-10-23-app-before.json'),'utf8'));let untouched=true;
for(const [file,hash]of Object.entries(before)){const p=path.join(repo,file);untouched&&=fs.existsSync(p)&&crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')===hash;}
check('151-application-files-unchanged',untouched);
const report={date:'2026-10-24 Asia/Shanghai',kind:'contract-validation-not-application-execution',passed:checks.filter(x=>x.passed).length,failed:checks.filter(x=>!x.passed).length,checks,applicationExecuted:false,recoveryCasesExecuted:false,realModelCalled:false,independentRebuild:false,limitations:['Ajv6 checks the draft-07 compatible subset plus $defs pointers, not all draft2020 features','Six recovery cases have no rebuilt adapter yet','Message pairing/Schema checks do not prove provider compatibility or transactional behavior']};
fs.writeFileSync(path.join(root,'evidence/2026-10-24-gap-validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,failed:report.failed,errors:checks.filter(x=>!x.passed)},null,2));process.exitCode=report.failed?1:0;
