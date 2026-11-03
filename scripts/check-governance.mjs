import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8')
const exists = p => fs.existsSync(path.join(root, p))
const walk = p => fs.readdirSync(path.join(root, p), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(`${p}/${e.name}`) : [`${p}/${e.name}`])
const issues = []
const check = (ok, message) => { if (!ok) issues.push(message) }
const manifest = JSON.parse(read('docs/v2/文档与资源归属.json'))
const activeDocs = manifest.documents.filter(d => !['历史证据索引', '历史冲突记录'].includes(d.role)).map(d => d.path)
const markdown = ['AGENTS.md', 'README.md', ...activeDocs, ...walk('openspec').filter(p => p.endsWith('.md') && !p.includes('/templates/') && !p.includes('/archive/')), ...walk('docs/decisions').filter(p => p.endsWith('.md')), ...walk('docs/acceptance').filter(p => p.endsWith('.md') && !p.endsWith('/资产主线开发检查记录.md')), 'docs/v2/resources/README.md', 'docs/v2/resources/v2.2/prompts/active/README.md']
const slug = s => s.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')
function anchors(text) {
  const names = new Set(), counts = new Map()
  for (const m of text.matchAll(/^#{1,6} (.+)$/gm)) {
    const name = slug(m[1]), count = counts.get(name) ?? 0
    names.add(count ? `${name}-${count}` : name); counts.set(name, count + 1)
  }
  for (const m of text.matchAll(/<(?:a|span)\s+(?:id|name)="([^"]+)"/g)) names.add(m[1])
  return names
}
for (const file of markdown) {
  if (!exists(file)) { issues.push(`缺少文件：${file}`); continue }
  const body = read(file).replace(/```[\s\S]*?```/g, '')
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let url = match[1]
    if (/^(https?:|mailto:|codex:)/.test(url)) continue
    if (url.startsWith('<') && url.endsWith('>')) url = url.slice(1, -1)
    const [pathname, fragment] = url.split('#')
    const target = pathname ? path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURIComponent(pathname))) : file
    check(exists(target), `${file} 链接不存在：${url}`)
    if (exists(target) && fragment && target.endsWith('.md')) check(anchors(read(target)).has(decodeURIComponent(fragment)), `${file} 锚点不存在：${url}`)
  }
}
check(manifest.documents.length === 14, '原有14份文档未全部登记')
for (const entry of [...manifest.documents, ...manifest.resources]) check(exists(entry.path), `归属文件不存在：${entry.path}`)
for (const section of manifest.sections) check(exists(section.owner), `旧条款缺少目标：${section.source} ${section.heading}`)
for (const entry of manifest.requirementRows ?? []) check(exists(entry.owner), `旧编号缺少目标：${entry.source} ${entry.id}`)
for (const entry of manifest.pendingCapabilities ?? []) check(exists(entry.spec), `后续能力规格不存在：${entry.id}`)
for (const asset of manifest.resources) for (const consumer of asset.consumers) check(exists(consumer), `资源使用位置不存在：${consumer}`)
for (const capability of manifest.capabilities) {
  check(exists(capability.spec), `能力规格不存在：${capability.id}`)
  for (const p of [...capability.modules, ...capability.tests, capability.acceptance]) check(exists(p), `能力关联位置不存在：${p}`)
}
for (const asset of manifest.runtimeAssets) {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, asset.path))).digest('hex')
  check(digest === asset.sha256, `运行时资源内容变化，请按已确认需求核对并更新归属哈希：${asset.path}`)
  for (const consumer of asset.consumers) check(exists(consumer), `资源消费者不存在：${consumer}`)
}
const config = YAML.parse(read('openspec/config.yaml'))
check(config.context.includes('AGENTS.md'), '配置缺少规则来源')
for (const name of ['project-local', 'project-full']) {
  const schema = YAML.parse(read(`openspec/schemas/${name}/schema.yaml`))
  const ids = new Set(schema.artifacts.map(a => a.id))
  for (const artifact of schema.artifacts) {
    check(exists(`openspec/schemas/${name}/templates/${artifact.template}`), `缺少模板：${name}/${artifact.template}`)
    check(artifact.instruction.includes('AGENTS.md'), `产物缺少统一规则入口：${name}/${artifact.id}`)
    for (const dep of artifact.requires) check(ids.has(dep), `工作流依赖不存在：${name}/${dep}`)
  }
  const tasks = schema.artifacts.find(a => a.id === 'tasks')
  check(tasks.requires.includes('specs'), `${name} 任务未关联规格`)
  check(name === 'project-full' ? tasks.requires.includes('design') : !ids.has('design'), `${name} 与需求分级不符`)
  const proposalTemplate = read(`openspec/schemas/${name}/templates/proposal.md`)
  const detailTemplate = name === 'project-full' ? read(`openspec/schemas/${name}/templates/design.md`) : proposalTemplate
  for (const title of ['讨论结论', '接手说明']) check(proposalTemplate.includes(`## ${title}`), `${name} 提案模板缺少${title}`)
  for (const title of ['字段变化', '数据流转', '触发逻辑']) check(detailTemplate.includes(`## ${title}`), `${name} 模板缺少${title}`)
}

// 需求池只维护索引与整体状态，实施细节继续在对应变更中检查。
const poolPath = 'openspec/需求池.md'
const pool = read(poolPath)
const requestRows = pool.split(/\r?\n/).filter(line => /^\|\s*REQ-/.test(line)).map(line => line.split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim()))
const requestIds = new Set(), referencedChanges = new Set()
const allowedStates = new Set(['待澄清', '待设计', '待确认', '可实施', '实施中', '待验收', '已完成', '暂缓', '已取消'])
const implementationStates = new Set(['可实施', '实施中', '待验收', '已完成'])
check(requestRows.length > 0, '需求池没有需求记录')
for (const cells of requestRows) {
  if (cells.length !== 6) { issues.push(`需求池列数不正确：${cells[0]}`); continue }
  const [id, title, size, status, entry, next] = cells
  check(/^REQ-\d{3,}$/.test(id), `需求编号格式错误：${id}`)
  check(!requestIds.has(id), `需求编号重复：${id}`); requestIds.add(id)
  check(Boolean(title && next), `${id} 缺少名称或下一步`)
  check(['小修改', '中型', '大型'].includes(size), `${id} 需求级别错误：${size}`)
  check(allowedStates.has(status), `${id} 需求状态错误：${status}`)
  const match = entry.match(/\[[^\]]+\]\(([^)]+)\)/)
  if (!match) { issues.push(`${id} 缺少资料入口链接`); continue }
  const target = path.posix.normalize(path.posix.join('openspec', match[1].split('#')[0]))
  if (!exists(target)) continue // 链接检查已经报告具体目标。
  const changeMatch = target.match(/^(openspec\/changes\/(?:archive\/)?[^/]+)\//)
  if (changeMatch) referencedChanges.add(changeMatch[1])
  if (!implementationStates.has(status) || size === '小修改') continue
  if (!changeMatch) { issues.push(`${id} 中大型实施事项缺少变更目录`); continue }
  const changeDir = changeMatch[1]
  const proposalPath = `${changeDir}/proposal.md`, tasksPath = `${changeDir}/tasks.md`, metadataPath = `${changeDir}/.openspec.yaml`
  if (![proposalPath, tasksPath, metadataPath].every(exists)) { issues.push(`${id} 实施材料缺少提案、任务或工作流元数据`); continue }
  const proposal = read(proposalPath), metadata = YAML.parse(read(metadataPath))
  check(proposal.includes(id), `${id} 提案未关联需求编号`)
  for (const section of ['确认依据', '接手说明']) check(proposal.includes(`## ${section}`), `${id} 提案缺少${section}`)
  check(metadata.schema === (size === '大型' ? 'project-full' : 'project-local') || (size === '中型' && metadata.schema === 'project-full'), `${id} 工作流与需求规模不符`)
  const detailPath = metadata.schema === 'project-full' ? `${changeDir}/design.md` : proposalPath
  if (!exists(detailPath)) { issues.push(`${id} 缺少实施设计`); continue }
  const detail = read(detailPath)
  for (const section of ['字段变化', '数据流转', '触发逻辑']) check(detail.includes(`## ${section}`), `${id} 实施材料缺少${section}`)
  check(!/\b(?:TODO|TBD)\b|待填写/.test(proposal + detail), `${id} 实施材料仍含占位内容`)
  if (!metadata.skip_specs) check(exists(`${changeDir}/specs`) && walk(`${changeDir}/specs`).some(p => p.endsWith('.md')), `${id} 缺少差异规格`)
}
for (const entry of fs.readdirSync(path.join(root, 'openspec/changes'), { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === 'archive') continue
  const changeDir = `openspec/changes/${entry.name}`
  if (exists(`${changeDir}/.openspec.yaml`)) check(referencedChanges.has(changeDir), `活动变更未进入需求池：${entry.name}`)
}
for (const file of walk('.agents/skills').filter(p => p.endsWith('/SKILL.md') && p.includes('/openspec-'))) check(read(file).includes('<!-- project-governance:begin -->'), `技能缺少统一规则入口：${file}`)
check(!read('AGENTS.md').includes('严格根据施工计划'), '仓库指令仍以旧计划约束执行')
for (const file of activeDocs) {
  const body = read(file)
  check(!body.includes('> **阶段0修订'), `当前文档重复历史治理说明：${file}`)
  check(!body.includes('| 文档状态 | 2.2 目标规格待评审'), `文档状态过期：${file}`)
  check(!body.includes('当前代码仍raw HTTP'), `模型实现说明过期：${file}`)
}
check(!/^- \[[ x]\]/m.test(read('docs/分阶段实现与人工验收计划.md')), '旧计划仍在维护活动任务')
const counts = { capabilities: manifest.capabilities.length, pendingCapabilities: manifest.pendingCapabilities?.length ?? 0, requests: requestIds.size, documents: manifest.documents.length, sections: manifest.sections.length, requirementRows: manifest.requirementRows?.length ?? 0, resources: manifest.resources.length, runtimeAssets: manifest.runtimeAssets.length, markdown: markdown.length }
console.log(JSON.stringify({ ok: issues.length === 0, counts, issues }, null, 2))
if (issues.length) process.exitCode = 1
