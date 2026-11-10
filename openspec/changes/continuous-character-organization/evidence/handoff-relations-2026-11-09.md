# 交接：P2 人物关系整理质量边界（2026-11-09）

## 一句话状态

关系质量边界、批量提交、统计口径和租约竞态已经修完并有单元测试；戴权（6 对）、贾赦（22 对）两个小样本真实运行通过，无提交失败循环。剩余工作不是“继续加严证据”，而是：约束无意义取证、修正报告语义、按步骤精简工具、跑完整检查并等待用户验收。

本轮没有提交 Git，没有修改正式书库，也没有在最后一次代码改动后重新调用真实模型。

## 已验证

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过（2026-11-09 11:09） |
| `npx vitest run tests/relation-quality.test.ts tests/lease-heartbeat.test.ts tests/relation-query.test.ts tests/ledger.test.ts` | 4 个文件、27 项通过 |
| 戴权真实小样本 | completed，3 次 API，41,635 token，$0.00566，1 verified / 1 unverified，0 失败 |
| 贾赦真实小样本 | completed，3 次 API，46,404 token，$0.00594，2 条修改均 verified，0 失败 |
| `npm test` | 57 个文件通过、4 跳过；520 项通过、5 跳过（2026-11-09 11:10） |
| `npm run lint` | 通过，只有 6 条既有 warning（`set-state-in-effect`、`exhaustive-deps`），无 error |
| `npm run build` | 通过（635ms） |
| `npm run governance:check` | `ok: true`，0 issues |
| `npm run openspec -- validate --all --strict` | 27 项通过，0 失败 |

贾赦证据：`test-results/live-jiashe-relations.json`、`live-jiashe-execution-chain.html`。
戴权证据：`test-results/live-daiquan-relations.json`、`live-daiquan-execution-chain.html`。
贾珩旧版失败记录：`test-results/jiaheng-32-failures.md`、`jiaheng-README.md`。

> 2026-11-09 20:13：运行 Playwright 单测时 `test-results/` 被测试框架清空，以上原始文件已不在磁盘；本文件与 `acceptance.md` 保留摘要和关键数字，重新生成需用户授权运行 live 测试。

## 本轮完成

| 主题 | 结论 | 主要位置 |
|---|---|---|
| 证据硬拦截放宽 | 普通去重/同义/包含/清理“未知”可直接提交；实质修改缺证据保存为 `unverified`；只有删除 active 整组关系强制依据 | `src/features/agents/organizationCommands.ts`、`src/features/assets/relationLabels.ts` |
| 逐条证据状态 | 每条 evidence 记录 `verified`/`reason`，整体 `verified`/`partial`/`unverified`；不再因一条引文不合拒绝整批 | `relationEdits.ts`、`types.ts` |
| `directionUnclear` 三态 | 省略表示保持原值；只有明确确认方向时才传 `false`。这是贾珩 12 次“缺证据”误判的根因 | `organizationCommands.ts`、工具契约 |
| 批量原子 + 一次报错 | 所有结构性错误先汇总返回，合法项也不写入；避免模型逐条试错 | `organizationCommands.ts` |
| 重复失败止损 | 相同 payload 原样再提交直接报 `REPEATED_FAILURE` | `organizationCommands.ts` |
| 关系概览与查询 | 全部关系精简概览；`query_relation_work` 支持 targetIds/fields/分页/证据续页；证据查询必须指定人物对 | `organizationData.ts`、`queries.ts` |
| 单人物 pairChecks 范围 | 单人物运行只同步当前人物相关关系对，不再膨胀为全库人物对（贾赦旧数据 282 条属于修复前） | `organizationReview.ts:62` |
| 本次/累计统计 | `applied` 只表示本次写入；`cumulativeApplied` 表示本次运行累计；空提交 `changed:false` | `organizationCommands.ts:365-423` |
| 租约收尾竞态 | `close()` 后晚到的续租失败不再 abort，修复贾赦第一次运行被误取消 | `src/features/world/leaseHeartbeat.ts`、`service.ts:292` |
| 费用与账本 | 费用优先 provider `cost.total`；账本写入真实起止时间、`ordinal`、`turn`、`traceEntryId` | `models/policy.ts`、`agents/ledger.ts` |
| 报告口径 | live 证据分 program / write / quality 三段，保存最终库值和 `writeSeq` | `tests/live-jiaheng-relations.test.ts` |
| 提示词 | 当前规则见 `docs/v2/resources/v2.2/prompts/active/p2-organization-relations.md` | 同左 |

## 用户要求的 5 项检查：结论

### 1. 贾赦 API #1 为什么查询邢夫人

事实：API #1 调用了 3 次 `get_character_relation`，分别是邢夫人（C20-P012）、嫣红（C11-P007）、翠云（C11-P008）。

初始概览里：

- 邢夫人：`forward:["丈夫"]`、`reverse:["妻子"]`，没有“未知”，没有 `unclear`。
- 嫣红、翠云：都含“未知”且 `unclear:true`。

结论：嫣红、翠云取证是合理的；邢夫人这一对没有必要，属于“为确认已经明确的关系而读取完整证据”。原因是提示词只写了“需要修改/方向不明/冲突时取证”，没有明确禁止对“两侧标签明确且无存疑”的人物对取证；同时模型沿用了逐对 `get_character_relation` 的旧习惯，没有用一次 `query_relation_work` 批量取证。

建议的最小修法（未实施）：

- 在关系提示词加一条：概览中没有“未知”、没有 `unclear`、两侧标签明确且不需要修改的人物对，直接视为保持不变，不要调用证据查询。
- 同一句补上：需要取证时用一次 `query_relation_work` 传多个 `targetIds`，不要逐对调用 `get_character_relation`。
- 同步 `docs/v2/文档与资源归属.json` 的提示词 hash。

### 2. 贾赦 9 uncertain / 2 changed / 11 unchanged 的语义

贾赦共 22 个关联人物对，分布正好是 2 + 9 + 11。含义必须分开看：

| 结果 | 准确语义 | 不能怎么说 |
|---|---|---|
| changed（2 对：嫣红、翠云） | 本次实际写入关系，evidence 逐字校验通过 | “模型认为这两对最可信” |
| uncertain（9 对） | 模型在 `uncertainPairs` 里显式标记待核对，有逐对原因 | “程序判断不确定” |
| no_change（11 对） | 本次没有提出修改；done 时由程序统一标记 | “模型逐对确认这 11 对正确” |
| verified | 仅指 evidence 引文逐字存在且本次读过该章，只对 2 条修改成立 | “全部 22 对已验证” |

另外两个口径问题：

- `program.checked = 1/1` 是人物级，不是关系对级；“检查完成”只代表这个工作项走完。
- 282 条 pairChecks 是修复前的数据（运行时间 02:10，修复时间 10:41）。修复后单人物运行只保留当前人物相关的 22 条，测试 `tests/relation-quality.test.ts` 已覆盖（fixture 期望 14 条）。

待决定的问题：pairChecks 里 22 条的 `reason` 和 `commitIds` 当前都写成最后一次提交的整批值，9 条 uncertain 的逐对原因只保留在工具调用参数里。若报告要逐对展示原因，需要把 pairChecks 写入改成逐对 reason/commitIds；这属于报告保真修复，不改变关系结果。

### 3. 空 changes + done=true 为什么曾返回 changed=true / applied 两对

原因：旧代码的 `applied` 使用累计集合 `changedTargets`，包含本次运行之前已经写入的人物对；`changed` 也看累计集合，所以最后一条空提交被误报为“本次修改了两对”。

现状（已修）：

- `appliedNow`：本次事务实际写入的目标，返回为 `applied`。
- `changedTargets`：本次运行累计，返回为 `cumulativeApplied`。
- `changed` 只看 `appliedNow`；空提交返回 `changed:false`、`applied:[]`、`cumulativeApplied:[...]`。
- `outcome` 仍是人物级累计结果（例如之前改过、最后空提交时仍可能是 `changed`/`uncertain`），这是人物工作项结论，不是本批统计。

测试：`tests/relation-quality.test.ts` 的“空 changes done=true 不把累计修改误报为本次 applied”验证了 `revision` 不变、`applied:[]`、`cumulativeApplied:['C4-P011']`。

### 4. 租约 closing 竞态回归测试

已新增 `tests/lease-heartbeat.test.ts`，4 项覆盖：

1. 正常续租成功，不触发失败。
2. 未关闭时续租失败触发失败回调。
3. 收尾 `close()` 后旧续租请求晚到失败，不再 abort（对应贾赦第一次被取消的竞态）。
4. `close()` 后定时器不再发起续租。

现状不足：没有 service 级“用户点击取消”测试；目前用 heartbeat 单元测试覆盖同一根因。若需要端到端覆盖，需要给 `runCharacterOrganization` 注入可控时钟或假 repository，成本较高，建议放到浏览器回归里做取消路径。

### 5. 关系整理阶段 26 个工具的分类与最小精简方案

贾赦运行时实际暴露 26 个工具，总计 34,327 字节 / 约 9,825 估算 Token，每次 API 请求都完整携带。

| 工具 | 字节 | 估算 Token | 分类 |
|---|---:|---:|---|
| submit_relation_review | 4,979 | 1,492 | 关系核心 |
| query_relation_work | 1,753 | 605 | 关系核心 |
| read_original | 1,199 | 383 | 关系核心 |
| get_character_detail | 606 | 191 | 关系核心 |
| get_legacy_relation_records | 508 | 152 | 关系核心（旧关系补查） |
| query_character_profile | 336 | 122 | 关系核心 |
| get_organization_progress | 226 | 77 | 关系核心 |
| set_character_relation | 2,628 | 733 | 关系低频（单对写入口） |
| delete_character_relation | 2,171 | 579 | 关系低频（单对写入口） |
| get_character_relation | 383 | 122 | 关系低频（可由 query_relation_work 替代） |
| edit_character | 2,691 | 709 | 资料写（单人物关系运行不需要） |
| edit_event_node | 3,004 | 778 | 资料写（同上） |
| edit_location | 2,299 | 593 | 资料写（同上） |
| edit_event_line | 2,282 | 586 | 资料写（同上） |
| merge_assets | 2,091 | 556 | 资料写（同上） |
| resolve_candidate_group | 1,858 | 482 | 第一/二步专用 |
| get_node_detail | 678 | 226 | 第一/二步专用 |
| get_event_line_detail | 672 | 221 | 第一/二步专用 |
| query_nodes | 637 | 204 | 第一/二步专用 |
| query_event_lines | 662 | 194 | 第一/二步专用 |
| save_candidate_group | 588 | 169 | 第一/二步专用 |
| query_characters | 451 | 148 | 第一/二步专用 |
| query_locations | 450 | 148 | 第一/二步专用 |
| query_character_catalog | 415 | 132 | 第一/二步专用 |
| get_location_detail | 394 | 115 | 第一/二步专用 |
| query_candidate_groups | 366 | 108 | 第一/二步专用 |

合计：34,327 字节 / 9,825 估算 Token。分类小计：关系核心 3,022；关系低频 1,434；资料写 3,222；第一/二步 2,147。

最小精简方案（只列方案，本轮不实施）：

- 方案 A（零行为风险，建议先做）：关系工作项隐藏 11 个第一/二步工具（候选组、目录、节点/事件线/地点查询）。每次请求省 2,147 Token（-22%），不影响任何关系能力，也不影响跨步骤纠错。
- 方案 B（需确认能力取舍）：再隐藏 4 个 `edit_*` 和 `merge_assets`。累计省 5,369 Token（-55%）。代价是关系步骤发现人物资料错误时不能直接改，只能标记待核对。现有设计 2.3 明确“新 P2 三步使用同一工具集”，实施 B 需要先改规格确认。
- 方案 C（需确认）：再隐藏 `get_character_relation` 和 `set/delete_character_relation`，统一走 `submit_relation_review`。累计省 6,803 Token（-69%）。代价是单对纠错入口消失，且这两个旧工具仍被 `assertBasis` 和资产编辑流程引用。

实现位置：`src/features/agents/tools.ts` 已有 `organizationAllows()` 按 `workKind` 裁剪的先例（当前只裁 `submit_profile_review`、`record_organization_progress`、`clear_candidate_groups`），方案 A 只是在该函数里增加名单，不需要重构工具系统。完整 P2 三步运行（`workKind` 为空）保持 26 个工具，跨步骤纠错不受影响。

不建议做：把所有工具合并成一个巨大工具；改 `submit_relation_review` 的 schema 结构；一次重构整个 P2 工具注册。

## 后续任务（按顺序）

1. **修报告语义（小改动，建议先做）**：pairChecks 逐对写入 `reason` 和 `commitIds`；报告明确区分“本次未修改”和“逐对确认无变化”。涉及 `organizationCommands.ts:401-413`。
2. **按需取证策略（小改动）**：按上面第 1 项改提示词，并同步资源 hash；用现有固定响应测试验证，不调用真实模型。
3. **工具精简方案 A（小改动）**：在 `tools.ts` 的 `organizationAllows()` 里隐藏 11 个第一/二步工具；补一条工具暴露测试，断言关系工作项只拿到预期名单。方案 B/C 需用户确认后再做。
4. **补 service 级取消测试**（可选，成本较高）。
5. **完整检查（已完成）**：`npm run typecheck`、`npm run lint`、`npm test`、`npm run build`、`npm run governance:check`、`npm run openspec -- validate --all --strict` 均通过。第 1–4 项实施后需要重跑同一组命令。
6. **文档同步**：把第 1–3 项的结论写入 `tasks.md`（12.x 状态、pairChecks 范围、空提交统计、heartbeat、工具方案）、`acceptance.md`、`openspec/缺陷池.md` 的 BUG-35 记录。用户尚未验收前保持活动变更，不归档。
7. **真实模型复测**：必须获得用户明确授权；在隔离副本运行，不改正式书库。建议先贾赦（22 对）复测第 1、2 项，再决定是否跑贾珩大样本。
8. **Git**：本轮所有改动未提交；提交需用户明确授权。

## 不要做

- 不要继续加严证据硬拦截，也不要恢复“实质修改必须提交原文证据”的硬规则。
- 不要为了减少提交批次再次优化提示词；当前优先质量与报告口径。
- 不要自动调用真实模型，不要修改正式书库。
- 不要机械合并工具或一次性重构整个 P2。
- 不要把 `toolCalls` 数组顺序当成时间线；最终值以副本数据库和 `writeSeq` 为准。
- 不要在用户未确认前实施方案 B/C（会改变“三步同工具集”的现有设计）。

## 关键入口

- 需求与任务：`openspec/changes/continuous-character-organization/proposal.md`、`design.md`、`tasks.md`（第 11、12 节）、`acceptance.md`
- 提示词：`docs/v2/resources/v2.2/prompts/active/p2-organization-relations.md`
- 工具契约：`docs/v2/resources/v2.2/tool-contracts.json`
- 关系提交：`src/features/agents/organizationCommands.ts`
- 关系质量判断：`src/features/assets/relationLabels.ts`
- 关系写入：`src/features/assets/relationEdits.ts`
- 单人物 pair 同步：`src/features/agents/organizationReview.ts`
- 租约：`src/features/world/leaseHeartbeat.ts`、`src/features/world/service.ts`
- 测试：`tests/relation-quality.test.ts`、`tests/lease-heartbeat.test.ts`、`tests/relation-query.test.ts`、`tests/ledger.test.ts`

## 2026-11-09 后续实施（本轮）

交接后的 1–3 项已完成，方案 A 已被用户否决，暂未实施任何工具裁剪：

- `pairChecks` 逐对记录：`changed` 保存该对实际修改记录的理由、`commitId` 和 `evidenceStatus`；`uncertain` 保存 `uncertainPairs` 中对应 `targetId` 的原因（跨批次保留）；`no_change` 固定写“本次未提交修改，未逐对确认。”，不再复制最后一批的 `reason`/`commitIds`/`basis`。
- 单人物报告：只展示当前人物的关系对；`synchronizePairs` 保留其他人物历史；完成判断和待处理检查按当前人物范围，历史中的未完成行不再阻塞单人运行。
- 取证策略：关系提示词增加“无未知、无方向存疑、无矛盾默认保持”和“多疑点批量 `query_relation_work` + `targetIds`”；明确 `unclear=false` 不等于绝对正确。
- 口径核对：282 条是贾赦修复前全库人物对（260 条属于其他人物且 `outcome=null`），22 条是贾赦本人关系对（2/9/11），14 条是 `tests/relation-quality.test.ts` fixture 中贾珩的关系对总数；三者不是同一数据集。
- 检查：typecheck、525 项单元测试、lint（仅 6 条既有 warning）、build、governance、OpenSpec 27 项通过；未调用真实模型、未改正式书库、未提交 Git。

### 保守方案 A' 评估（未实施）

只隐藏地点、事件节点、事件线相关的 6 个查询工具：`query_locations`、`get_location_detail`、`query_nodes`、`get_node_detail`、`query_event_lines`、`get_event_line_detail`。继续保留全部人物查询、候选组处理、`merge_assets`、资料编辑和关系操作。

按当前 `tool-contracts.json`：关系工作项 26 个工具、35,169 字节 / 约 10,035 Token；A' 后 20 个工具、30,562 字节 / 约 8,648 Token，节省 1,387 Token（-13.8%）。关系提示词没有引用这 6 个工具，涉及重复人物、候选组和合并的跨步骤能力全部保留。代价是关系步骤不能再读取地点、事件节点、事件线详情；需要修改这些资产时应在对应步骤处理或标记待核对，编辑工具本身仍保留。

实施 A' 前需要补的验证：

- 工具暴露测试：关系工作项包含 `query_characters`、`query_character_catalog`、`save_candidate_group`、`query_candidate_groups`、`resolve_candidate_group`、`merge_assets`、`edit_character`、`edit_location`、`set/delete_character_relation`；不包含上述 6 个查询工具。
- 固定数据工作流测试：在 `tests/organization.test.ts` 的 mock 模型运行中断言关系工作项的工具集合；同时断言目录/候选/资料工作项仍收到这 6 个工具，确认只影响关系步骤。
- 不合并工具，不做动态工具加载重构，不实施 B/C。
