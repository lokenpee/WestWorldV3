/** 核对提取契约和样本；需原仓库依赖，不进行真实模型调用。 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const out=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root=path.resolve(out,'../../..')
const app=path.join(root,'app')
const require=createRequire(path.join(app,'package.json'))
const { unzipSync, strFromU8 }=require('fflate')
const ts=require('typescript')
for(const name of ['tsconfig.json','tsconfig.app.json','tsconfig.node.json']) {
 const result=ts.parseConfigFileTextToJson(name,await fs.readFile(path.join(out,'resources/runtime',name),'utf8'))
 if(result.error)throw new Error(`Invalid JSONC: ${name}`)
}
const originals=await import(pathToFileURL(path.join(app,'src/core/schema/index.ts')).href)
const exported=JSON.parse(await fs.readFile(path.join(out,'resources/schemas.json'),'utf8'))
for(const [name,schema] of Object.entries(exported)) if(JSON.stringify(schema)!==JSON.stringify(originals[name])) throw new Error(`Schema drift: ${name}`)
const mappings:Record<string,string>={book:'BookSchema',chapters:'ChapterSchema',characterSnapshots:'StoredCharacterSnapshotSchema',locationSnapshots:'StoredLocationSnapshotSchema',characters:'CharacterSchema',locations:'StoredLocationSchema',nodes:'StoredNodeSchema',eventLines:'EventLineSchema',compileProgress:'CompileProgressSchema',storyEditorMemory:'StoryEditorMemorySchema',storyEditorNotes:'StoryEditorNoteSchema',storyEditorCheckpoints:'StoryEditorCheckpointSchema',storySessions:'StorySessionSchema',storySessionEntries:'StorySessionEntrySchema'}
let rows=0
for(const name of ['人工资产样本.wwv2','UI导出结果.wwv2']) {
 const files=unzipSync(new Uint8Array(await fs.readFile(path.join(out,'resources/fixtures',name))))
 for(const [file,schema] of Object.entries(mappings)) {
  const raw=JSON.parse(strFromU8(files[`data/${file}.json`]))
  for(const row of file==='book'?[raw]:raw) {
   const checked=originals.validate(originals[schema],row)
   if(!checked.ok)throw new Error(`${name}:${file}: ${checked.errors.join(';')}`)
   rows++
  }
 }
}
const split=await import(pathToFileURL(path.join(app,'src/core/pipeline/split-chapters.ts')).href)
const freq=await import(pathToFileURL(path.join(app,'src/core/pipeline/asset-merge-policy.ts')).href)
const graph=await import(pathToFileURL(path.join(app,'src/core/graph/chapter-timeline.ts')).href)
const golden=JSON.parse(await fs.readFile(path.join(out,'resources/golden-results.json'),'utf8'))
for(const c of golden.split)if(JSON.stringify(split.splitChapters(c.input))!==JSON.stringify(c.result))throw new Error('split golden mismatch')
for(const c of golden.alias)if(freq.aliasSimilarity(c.a,c.b)!==c.value)throw new Error('alias golden mismatch')
const g=golden.graph
if(JSON.stringify(graph.buildChapterTimeline(g.input.lines,g.input.nodes,g.input.chapters))!==JSON.stringify(g.result))throw new Error('graph golden mismatch')
const report={schemasMatched:Object.keys(exported).length,sampleRowsValidated:rows,goldenSplitCases:golden.split.length,goldenAliasCases:golden.alias.length,graphGoldenMatched:true,externalRequests:false,independentApplicationRebuilt:false}
await fs.writeFile(path.join(out,'evidence/contract-validation.json'),JSON.stringify(report,null,2))
console.log(JSON.stringify(report))
