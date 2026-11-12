// 用法：
//   npm run prompts:sync            同步提示词哈希、请求示例，并跑治理检查
//   npm run prompts:sync -- --dry-run
//   npm run prompts:sync -- --full   再加 typecheck、全部测试和 OpenSpec 校验
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resources = path.join(root, 'docs/v2/resources')
const activePrompts = path.join(resources, 'v2.2/prompts/active')
const examplesDir = path.join(resources, 'v2.2/request-examples')
const manifest = JSON.parse(fs.readFileSync(path.join(resources, 'v2.2/prompt-call-manifest.json'), 'utf8'))
const ownershipPath = path.join(root, 'docs/v2/文档与资源归属.json')
const ownership = JSON.parse(fs.readFileSync(ownershipPath, 'utf8'))
const flags = new Set(process.argv.slice(2))
const dry = flags.has('--dry-run')
const full = flags.has('--full')
const normalize = value => value.replace(/\r\n/g, '\n')
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
  const prompt = normalize(fs.readFileSync(source, 'utf8'))
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
  if (normalize(before).trimEnd() === normalize(prompt).trimEnd()) continue
  changes.examples.push(name)
  writeJson(file, example)
}

if (changes.hashes.length) writeJson(ownershipPath, ownership)

console.log('提示词资源同步')
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
