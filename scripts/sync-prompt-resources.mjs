// 用法：
//   npm run prompts:sync            同步提示词哈希、请求示例，并跑治理检查
//   npm run prompts:sync -- --dry-run
//   npm run prompts:sync -- --full   再加 typecheck、全部测试和 OpenSpec 校验
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { formatNarrativeInput, narrativeSystemPrompt } from '../src/features/story/narrativeInput.ts'
import { narrativeToolDescription, narrativeToolSchemas } from '../src/features/story/narrativeToolSchema.ts'
import { compactOutlineParameters } from '../src/features/story/outlineToolSchema.ts'
import { storyPagePrompt, storyPageReasoning } from '../src/features/story/readingPresentation.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resources = path.join(root, 'docs/v2/resources')
const activePrompts = path.join(resources, 'v2.2/prompts/active')
const storyToolNames = ['search_story_context', 'get_story_detail', 'save_story_outline', 'save_story_notes', 'navigate_story_pages', 'finish_story_batch']
const examplesDir = path.join(resources, 'v2.2/request-examples')
const manifest = JSON.parse(fs.readFileSync(path.join(resources, 'v2.2/prompt-call-manifest.json'), 'utf8'))
const ownershipPath = path.join(root, 'docs/v2/文档与资源归属.json')
const ownership = JSON.parse(fs.readFileSync(ownershipPath, 'utf8'))
const flags = new Set(process.argv.slice(2))
const dry = flags.has('--dry-run')
const full = flags.has('--full')
const normalize = value => value.replace(/\r\n/g, '\n')
// 串联正文是分类判例的维护入口，复核与快检收到相同的正文。
const standardPattern = /## 共同分类标准[\s\S]*?(?=\n## )/
const standard = normalize(fs.readFileSync(path.join(activePrompts, 'p3-outline-story.md'), 'utf8')).match(standardPattern)?.[0]
if (!standard) throw new Error('串联提示词缺少共同分类标准')
for (const name of ['p3-outline-review.md', 'p3-quick-check.md']) {
  const file = path.join(activePrompts, name)
  const source = normalize(fs.readFileSync(file, 'utf8'))
  if (!standardPattern.test(source)) throw new Error(name + ' 缺少共同分类标准')
  const updated = source.replace(standardPattern, () => standard)
  if (source !== updated) {
    if (dry) throw new Error(name + ' 分类标准尚未同步')
    fs.writeFileSync(file, updated)
  }
}
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const writeJson = (file, value) => {
  const eol = fs.readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n'
  const text = JSON.stringify(value, null, 2).replace(/\n/g, eol) + eol
  if (!dry) fs.writeFileSync(file, text)
}
const calls = [...manifest.calls].sort((a, b) => b.id.length - a.id.length)
const callOf = id => calls.find(call => id === call.id || id.startsWith(`${call.id}-`))
const promptFile = call => call?.prompt ? path.join(resources, call.prompt) : undefined
const changes = { hashes: [], examples: [], missing: [] }

const manifestFile = path.join(resources, 'v2.2/prompt-call-manifest.json')
let manifestChanged = false
for (const call of calls.filter(item => ['PROMPT-P3-WINDOW', 'PROMPT-P3-GLOBAL', 'PROMPT-P3-NARRATIVE-V4'].includes(item.id))) {
  const digest = sha256(promptFile(call))
  if (call.promptSha256 === digest) continue
  manifestChanged = true
  call.promptSha256 = digest
}
if (manifestChanged) writeJson(manifestFile, manifest)

for (const asset of ownership.runtimeAssets ?? []) {
  if (!String(asset.path).startsWith('docs/v2/resources/v2.2/prompts/')) continue
  const file = path.join(root, asset.path)
  if (!fs.existsSync(file)) { changes.missing.push(asset.path); continue }
  const digest = sha256(file)
  if (digest === asset.sha256) continue
  changes.hashes.push({ path: asset.path, from: asset.sha256, to: digest })
  asset.sha256 = digest
}

for (const name of fs.readdirSync(examplesDir).filter(name => name.endsWith('.json') && name !== 'index.json')) {
  const file = path.join(examplesDir, name)
  const example = JSON.parse(fs.readFileSync(file, 'utf8'))
  const call = callOf(String(example.id ?? ''))
  const source = promptFile(call)
  if (!source || !fs.existsSync(source)) continue
  const beforeExample = JSON.stringify(example)
  let prompt = normalize(fs.readFileSync(source, 'utf8'))
  if (call.id === 'PROMPT-P3-NARRATIVE-V4') {
    const contract = JSON.parse(fs.readFileSync(path.join(resources,'v2.2/tool-contracts.json'),'utf8'))
    const spec = contract.profiles.story_editor.find(t=>t.name==='save_story_outline').parameters
    const schemas = narrativeToolSchemas(example.input, contract.narrativeV4, spec)
    const tools = Object.entries(schemas).map(([name,parameters])=>({name,description:narrativeToolDescription(name,example.input),parameters}))
    const discipline=normalize(fs.readFileSync(path.join(activePrompts,'output-discipline.txt'),'utf8')).trim()
    example.context = {messages:[{role:'system',content:narrativeSystemPrompt(prompt,example.input)+'\n\n'+discipline,toolsAdded:tools,timestamp:0},{role:'user',content:formatNarrativeInput(example.input),timestamp:1}],tools}
    if (beforeExample !== JSON.stringify(example)) { changes.examples.push(name); writeJson(file, example) }
    continue
  }
  const extractionSchema = call.id === 'PROMPT-P1-WORLD' ? 'WorldAssetsExtractionSchema' : call.id === 'PROMPT-P1-NARRATIVE' ? 'NarrativeAssetsExtractionSchema' : undefined
  if (extractionSchema) {
    prompt = prompt.replace(/^---[\s\S]*?---\s*/, '')
    example.context.messages[0].content = `${example.input.chapterName}\n\n${example.input.text}`
    example.context.tools.find(tool => tool.name === 'submit_result').parameters = JSON.parse(fs.readFileSync(path.join(resources, 'schemas.json'), 'utf8'))[extractionSchema]
  }
  const story = call.id === 'PROMPT-P3-WINDOW' || call.id === 'PROMPT-P3-GLOBAL'
  if (story) {
    const review = call.id === 'PROMPT-P3-GLOBAL'
    const contracts = JSON.parse(fs.readFileSync(path.join(resources, 'v2.2/tool-contracts.json'), 'utf8')).profiles.story_editor
    example.context.tools = storyToolNames.filter(name => review || name !== 'search_story_context').map(name => {
      const tool = contracts.find(item => item.name === name)
      const parameters = structuredClone(tool.outlineParameters ?? tool.parameters)
      if (!review) delete parameters.properties.noteResults
      delete parameters.properties.operationKey
      return { name, description: tool.description,
        parameters: !review && name === 'save_story_outline' ? compactOutlineParameters(parameters) : parameters }
    })
    const input = example.input
    const hints = input.contextHints ?? { assigned: input.workItems.map(item => ({ kind: item.kind, id: item.id, title: '三河帮的线索', summary: '发现三河帮活动的迹象', chapters: ['1'] })), related: [] }
    const page = { id: review ? 'orphans:1' : 'nodes:1', pageNumber: 1, totalPages: 1, type: 'node_page', ids: input.workItems.map(item => item.id) }
    const brief = input.page ? input : { phase: input.phase, queue: input.queue, page, remainingCount: input.remainingCount, workItems: hints.assigned, related: hints.related, moreRelated: hints.truncated === true, workingSummary: input.memory?.workingSummary ?? '' }
    const view = row => row.kind === 'node' ? { id: row.id, kind: 'node', name: row.name ?? row.title, chapterIndex: row.chapterIndex ?? row.chapters?.[0] ?? '' } : row.kind === 'eventLine' ? { id: row.id, kind: 'eventLine', title: row.title, summary: row.summary ?? [row.cause, row.process, row.result].filter(Boolean).join('\n\n'), nodeIds: row.nodeIds ?? [], lineStatus: row.lineStatus ?? 'open' } : row
    brief.workItems = brief.workItems.map(row => row.kind === 'node' ? { ...view(row), chapterName: row.chapterName ?? '第一章' } : view(row))
    if (review) {
      brief.outlineReview = true
      brief.independent = true
      brief.queue = 'event_lines'
      brief.page = { id: 'directory_open::0', pageNumber: 1, totalPages: 3, type: 'directory_open', ids: [] }
      brief.outline = { lines: [], events: [], orphans: brief.workItems.map(row => ({ id: row.id, name: row.name, chapterIndex: row.chapterIndex, kind: 'node' })) }
      brief.directoryNotes = []
    }
    else {
      brief.outline ??= { lines: [], events: [] }
      if (brief.page.pageNumber === 1) brief.preview = brief.workItems.map(row => ({ 章: row.chapterIndex, 节点: row.name }))
    }
    for (const field of ['remainingCount', 'related', 'moreRelated', 'workingSummary']) delete brief[field]
    example.input = brief
    example.inputSchema = 'prompt-inputs.schema.json#/$defs/StoryReadingBrief'
    const discipline = normalize(fs.readFileSync(path.join(activePrompts, 'output-discipline.txt'), 'utf8')).trim()
    example.context.messages = [
      { role: 'system', content: `${prompt.trimEnd()}\n\n${discipline}`, toolsAdded: example.context.tools, timestamp: 0 },
      { role: 'user', content: storyPagePrompt(brief), timestamp: 1 },
    ]
    delete example.options.maxSteps
    delete example.options.timeoutMs
    example.options.requestTimeoutMs = 120000
    example.options.reasoning = storyPageReasoning(brief.phase, brief.page.type)
    if (beforeExample !== JSON.stringify(example)) { changes.examples.push(name); writeJson(file, example) }
    continue
  }
  let before = ''
  if (typeof example.context?.systemPrompt === 'string') {
    before = example.context.systemPrompt
    example.context.systemPrompt = prompt
  } else {
    const message = example.context?.messages?.[0]
    const content = typeof message?.content === 'string' ? message.content : ''
    const startMarker = '【业务职责正文】\n'
    const start = content.indexOf(startMarker)
    const end = content.indexOf('【结束约束】')
    if (start < 0 || end < 0) continue
    before = content.slice(start + startMarker.length, end)
    message.content = `${content.slice(0, start + startMarker.length)}${prompt.trimEnd()}\n\n${content.slice(end)}`
  }
  if (extractionSchema ? beforeExample === JSON.stringify(example) : normalize(before).trimEnd() === normalize(prompt).trimEnd()) continue
  changes.examples.push(name)
  writeJson(file, example)
}

if (changes.hashes.length) writeJson(ownershipPath, ownership)

console.log('提示词资源同步')
console.log(`  项目目录：${root}`)
console.log(`  提示词目录：${activePrompts}`)
console.log(`  哈希更新：${changes.hashes.length}`)
for (const item of changes.hashes) console.log(`    ${item.path}`)
console.log(`  请求示例更新：${changes.examples.length}`)
for (const name of changes.examples) console.log(`    ${name}`)
if (changes.missing.length) {
  console.log(`  缺失资源：${changes.missing.length}`)
  for (const item of changes.missing) console.log(`    ${item}`)
}
if (dry) console.log('  （dry-run：没有写入文件）')

if (!dry) {
  const commands = ['npm run governance:check']
  if (full) commands.unshift('npm run typecheck', 'npm run test:unit', 'npm run openspec -- validate --all --strict')
  let failed = false
  for (const command of commands) {
    console.log(`\n> ${command}`)
    const result = spawnSync(command, { cwd: root, stdio: 'inherit', shell: true })
    if (result.status !== 0) failed = true
  }
  if (failed) process.exitCode = 1
}
