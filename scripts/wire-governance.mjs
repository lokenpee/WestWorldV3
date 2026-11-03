import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const folder = path.join(root, '.agents/skills')
const marker = '<!-- project-governance:begin -->'
const block = `${marker}
## 项目规则入口

执行此工作流前读取仓库根目录 AGENTS.md，并从 openspec/需求池.md 定位需求编号。需求分级、讨论结论、独立接手材料、授权、文档归属、用户验收、规格同步及归档条件统一按该文件执行。小修改使用其简化路径，中大型需求选择项目工作流。下方为 OpenSpec 操作说明，项目取舍由 AGENTS.md 规定。

使用 npm run openspec -- <命令> 调用本仓库锁定版本。工具更新后运行 npm run governance:wire 恢复此入口，并执行 npm run governance:check。
<!-- project-governance:end -->

`

let count = 0
for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith('openspec-')) continue
  const file = path.join(folder, entry.name, 'SKILL.md')
  const original = fs.readFileSync(file, 'utf8')
  const text = original.replace(/<!-- project-governance:begin -->[\s\S]*?<!-- project-governance:end -->\s*/g, '')
  const header = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)
  if (!header) throw new Error(`技能缺少元数据：${entry.name}`)
  const result = header[0] + '\n' + block + text.slice(header[0].length).trimStart()
  if (result !== original) fs.writeFileSync(file, result)
  count++
}
console.log(`已连接 ${count} 个 OpenSpec 技能到 AGENTS.md。`)
