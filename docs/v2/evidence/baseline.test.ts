import { it, expect } from 'vitest'
import fs from 'node:fs/promises'
import { runSuite } from '../acceptance/suite.mjs'
import { createHarness } from './baseline.adapter.ts'
it('独立断言套件连接原应用边界',async()=>{
 const report=await runSuite(createHarness)
 await fs.writeFile(new URL('./portable-baseline-results.json',import.meta.url),JSON.stringify(report,null,2))
 expect(report.cases.filter((x:any)=>x.status==='failed')).toEqual([])
},60000)
