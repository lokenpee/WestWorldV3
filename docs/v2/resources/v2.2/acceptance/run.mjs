// Invoke only with an adapter implemented by the reconstructed application.
// This runner does not import the original business implementation or calculate its own expected results.
import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const index=process.argv.indexOf('--adapter');
if(index<0||!process.argv[index+1])throw new Error('Usage: node run.mjs --adapter /absolute/path/rebuilt-adapter.mjs');
const adapterPath=path.resolve(process.argv[index+1]);
const adapter=await import(pathToFileURL(adapterPath));
for(const method of ['reset','dispatch','inspect','dispose'])assert.equal(typeof adapter[method],'function',`adapter must export ${method}`);
const casesIndex=process.argv.indexOf('--cases');
const casesPath=casesIndex>=0?path.resolve(process.argv[casesIndex+1]):path.join(here,'recovery-cases.json');
const cases=JSON.parse(fs.readFileSync(casesPath,'utf8')).cases;
function at(object,key){return key.split('.').reduce((value,part)=>value?.[part],object);}
const results=[];
for(const c of cases){
 try{await adapter.reset(structuredClone(c.seed));
  for(const [idx,step] of c.steps.entries()){
   const output=await adapter.dispatch(structuredClone({operation:step.operation,input:step.input}));
   for(const [key,value] of Object.entries(step.expect.output))assert.deepEqual(at(output,key),value,`${c.id} step ${idx} output.${key}`);
   const snapshot=await adapter.inspect({bookId:c.seed.binding.bookId,runId:c.seed.binding.runId});
   for(const [key,value] of Object.entries(step.expect.snapshot))assert.deepEqual(at(snapshot,key),value,`${c.id} step ${idx} snapshot.${key}`);
  } results.push({id:c.id,passed:true});
 }catch(error){results.push({id:c.id,passed:false,error:String(error)});}finally{await adapter.dispose();}
}
console.log(JSON.stringify({kind:'rebuilt-adapter-execution',results},null,2));
process.exitCode=results.every(x=>x.passed)?0:1;
