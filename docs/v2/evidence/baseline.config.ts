import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../../app')
const r=createRequire(path.join(app,'package.json'))
export default {
 resolve:{alias:[
  {find:'@',replacement:path.join(app,'src')},
  {find:/^@sinclair\/typebox$/,replacement:r.resolve('@sinclair/typebox')},
  {find:/^fflate$/,replacement:r.resolve('fflate')},
  {find:/^vitest$/,replacement:path.join(path.dirname(r.resolve('vitest/package.json')),'dist/index.js')},
 ]},
 test:{environment:'node',include:['../docs/reverse-prd/v2/evidence/baseline.test.ts','../docs/reverse-prd/v2/evidence/capture-tools.test.ts'],setupFiles:['./tests/setup.ts']},
}
