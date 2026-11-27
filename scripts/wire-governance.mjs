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

const proposalGuidance = `本仓库执行下方提案步骤时，按 AGENTS.md 的“gstack 的使用约定”先判断只讨论和需求访谈，再按“需求分级”选择工作流。第 3、4 步中项目分级选定的工作流即已获指定，创建时显式传入对应的 --schema。涉及应用 Agent 时，按“Agent 方案材料”随方案交付逐任务设计，从 proposal.md 直接查阅。

第 7 步在全部方案材料齐备后执行 gstack 工程方案审查。请审查者同时通读提案和关联材料，核对术语入口并单列可读性结论，记录后提交用户确认。最终报告分别说明材料齐备情况、实际审查结果及待确认事项，依据 AGENTS.md 的接手条件判断是否可实施。`

let count = 0
for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith('openspec-')) continue
  const file = path.join(folder, entry.name, 'SKILL.md')
  const original = fs.readFileSync(file, 'utf8')
  const text = original.replace(/<!-- project-governance:begin -->[\s\S]*?<!-- project-governance:end -->\s*/g, '')
  const header = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)
  if (!header) throw new Error(`技能缺少元数据：${entry.name}`)
  const projectBlock = entry.name === 'openspec-propose'
    ? block.replace('<!-- project-governance:end -->', proposalGuidance + '\n<!-- project-governance:end -->')
    : block
  const result = header[0] + '\n' + projectBlock + text.slice(header[0].length).trimStart()
  if (result !== original) fs.writeFileSync(file, result)
  count++
}
console.log(`已连接 ${count} 个 OpenSpec 技能到 AGENTS.md。`)
