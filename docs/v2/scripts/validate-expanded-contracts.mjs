// Documentation-only verification. Does not import or execute application business code.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const repo=path.resolve(root,'../../..');
const require=createRequire(fs.realpathSync(path.join(repo,'app/node_modules/eslint/package.json')));
const Ajv=require('ajv');
// These schemas use only the draft-07-compatible keyword subset plus $defs JSON pointers.
// No claim is made that Ajv6 implements all of draft 2020-12.
const ajv=new Ajv({allErrors:true,jsonPointers:true,unknownFormats:'ignore'});
const read=n=>JSON.parse(fs.readFileSync(path.join(root,n),'utf8'));
const data=read('resources/v2.2/data-contract.json');
const schema=read('resources/v2.2/storage.schema.json');
const declarations=read('resources/v2.2/tool-contracts.json');
const results=read('resources/v2.2/tool-results.schema.json');
const checks=[];
const check=(name,ok,details='')=>checks.push({name,passed:!!ok,...(!ok?{details}: {})});
const canonical=x=>Array.isArray(x)?x.map(canonical):x && typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const stable=x=>JSON.stringify(canonical(x));
const doc3=fs.readFileSync(path.join(root,'03-Spec-数据与存储.md'),'utf8');
const doc11=fs.readFileSync(path.join(root,'11-AI工具返回与回放契约.md'),'utf8');
const validators={};
check('18-table-count',data.completeTableSchemas.length===18);
check('storage-and-data-definitions-identical',stable(schema.$defs)===stable(data.schemas.$defs));
for(const t of data.completeTableSchemas){
 const validate=ajv.compile({$defs:schema.$defs,$ref:t.schema}); validators[t.name]=validate;
 check('document-table:'+t.name,doc3.includes(`### ${t.id} · ${t.name}`));
 const examples=read(`resources/v2.2/table-examples/${t.name}.json`);
 for(const [i,row] of examples.entries()) check(`sample:${t.name}:${i}`,validate(row),stable(validate.errors));
}
const unique=new Map();
for(const [profile,group] of Object.entries(declarations.profiles)) for(const tool of group){
 const prior=unique.get(tool.name);
 if(prior) check(`shared-declaration:${tool.name}`,stable(prior.parameters)===stable(tool.parameters));
 unique.set(tool.name,tool);
 check(`profile-parameter-validation:${profile}:${tool.name}`,!!ajv.compile(tool.parameters));
}
check('business-tool-count',unique.size===16);
check('profile-counts',declarations.profiles.asset_editor.length===10 && declarations.profiles.story_editor.length===15);
for(const t of results.tools){
 check('declaration-and-result-input:'+t.name,stable(unique.get(t.name).parameters)===stable(t.input));
 check('document-tool:'+t.name,doc11.includes('· '+t.name));
 check('output-schema-compile:'+t.name,!!ajv.compile(t.success));
 check('error-schema-compile:'+t.name,!!ajv.compile(t.error));
 check('target-result-validation:'+t.name,t.runtimeChecksReturn===true);
}
const fresh=n=>structuredClone(read(`resources/v2.2/table-examples/${n}.json`)[0]);
let row=fresh('characters'); row.createdBy='P3'; check('reject-character-P3-source',!validators.characters(row));
row=fresh('locations'); row.mergeFacts=[{id:'F',field:'description',chapters:['1']}]; check('reject-location-fact-without-text',!validators.locations(row));
row=fresh('eventLines'); row.status=row.lineStatus; delete row.lineStatus; check('reject-lineStatus-misnaming',!validators.eventLines(row));
row=fresh('assetLifecycle'); row.state='deleted'; check('reject-deleted-with-currentId',!validators.assetLifecycle(row));
delete row.currentId; check('accept-deleted-tombstone',validators.assetLifecycle(row));
for(const name of ['query_nodes','query_locations','get_location_detail']){
 const validate=ajv.compile(unique.get(name).parameters);
 check('reject-model-bookId:'+name,!validate(name==='get_location_detail'?{ids:['x'],bookId:'other'}:{bookId:'other'}));
}
check('reject-empty-detail-ids',!ajv.compile(unique.get('get_location_detail').parameters)({ids:[]}));
const ack={ok:true,commitId:'K',operationKey:'merge-1',alreadyApplied:false,summary:'已合并'};
for(const name of ['commit_asset_changes','commit_story_changes']){
 const t=results.tools.find(t=>t.name===name);
 check('write-ack:'+name,ajv.compile(t.success)(ack));
 check('write-oversize-error:'+name,ajv.compile(t.error)({error:'TOO_LARGE',message:'缩小批次'}));
}
check('finalizer-ack',ajv.compile(declarations.finalizer.success)({accepted:true,status:'completed',commitIds:['K']}));
const before=read('evidence/2026-10-23-app-before.json');
for(const [file,hash] of Object.entries(before)){
 const p=path.join(repo,file);
 check('app-unchanged:'+file,fs.existsSync(p) && crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')===hash);
}
check('no-field-placeholder',!doc3.includes('【待补释义】'));
const report={checkedAt:new Date().toISOString(),kind:'documentation-only',validator:'Ajv 6, draft-07 compatible keyword subset; $defs resolved by JSON pointer',applicationTestsRun:false,independentRebuildRun:false,passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length,checks,limitations:['Native FileSystemDirectoryHandle requires browser validation','Pi original-message extension content follows locked SDK protocol, not arbitrary JSON business data','No target database migration, model call, browser concurrency or independent app execution']};
fs.writeFileSync(path.join(root,'evidence/2026-10-23-contract-validation.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:report.passed,failed:report.failed,errors:checks.filter(c=>!c.passed)},null,2));
process.exitCode=report.failed?1:0;
