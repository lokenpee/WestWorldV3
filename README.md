# WestWorldV3

本地小说资产工作台。TXT（小说文本）导入后分章，逐章提取人物、地点、事件节点，再由 P2 整理人物与关系、P3 串联事件线；支持原文阅读、资产人工维护、批量合并、整书备份恢复和模型配置。

当前应用包版本见[项目清单](package.json)，改动与验证范围见[版本记录](CHANGELOG.md)。

## 给接手的 Agent：先看这里

| 先读 | 用途 |
|---|---|
| [仓库开发指令](AGENTS.md) | 需求分级、确认范围、文档归属、检查与归档规则。 |
| [阅读入口与统一术语](docs/v2/00-阅读入口与术语.md) | 当前能力、文档职责、统一术语和最短阅读路径。 |
| [需求池](openspec/需求池.md) / [缺陷池](openspec/缺陷池.md) | 正在讨论或修复的需求、故障、材料入口和下一步。 |
| [活动变更](openspec/changes/) | 当前实施中的 proposal / design / tasks / acceptance；`archive/` 为已归档变更。 |
| [架构与模块契约](docs/v2/02-架构与技术规格.md) | 模块边界、依赖方向、运行形态。 |
| [AI 与会话](docs/v2/05-Spec-AI与会话.md) | Pi Agent、工具、会话、租约、冲突与恢复。 |
| [文档与资源归属](docs/v2/文档与资源归属.json) | 每个规格、资源、运行时文件和消费者的唯一归属；改提示词/契约前先查这里。 |

最短路径：

1. 读 [AGENTS.md](AGENTS.md)，确认需求级别和授权范围。
2. 读 [00-阅读入口](docs/v2/00-阅读入口与术语.md)，找到对应能力规格和验收。
3. 先查[需求池](openspec/需求池.md)和[缺陷池](openspec/缺陷池.md)，避免重复或覆盖已有结论。
4. 涉及 P1/P2/P3 或 Agent 时，再读 [04 流程接口](docs/v2/04-Spec-流程接口与算法.md)、[05 AI 与会话](docs/v2/05-Spec-AI与会话.md)、[09 操作契约](docs/v2/09-操作与自动触发契约.md)。
5. 按本文末尾的命令自检，再写验收记录。

## 架构速览

```
React 页面 / 面板
  └─ src/features/*/*Panel.tsx、BookOverview.tsx
       └─ 领域服务（service.ts）
            ├─ 资产与关系事务（assets）
            ├─ P1 逐章提取（extraction，direct 模型调用）
            ├─ P2 世界整理（world + agents，Pi Agent）
            ├─ P3 叙事整理（story + agents，Pi Agent）
            ├─ 模型配置与网关（models）
            └─ 导入 / 备份 / 存储（import、backup、lib/storage）
                 └─ IndexedDB：设置库 + 每书库
```

关键边界：

- **P1 不使用 Agent**：`extraction/service.ts` 直接调用模型，按章、按子步骤写入成功凭证和进度。
- **P2/P3 使用 Pi Agent**：`agents/runtime.ts` 管理模型循环，`agents/repository.ts` 提供带版本和租约校验的事务，`agents/commands.ts` 执行写命令。
- **当前版本同书单任务**：同一本书的 P1/P2/P3 不跨阶段并行；P1 内部世界/叙事两条 lane 仍可并行；不同书籍互不影响。准入在 service/租约事务内检查，不只靠 UI。
- **写入保护**：业务提交比较实际 revision/fingerprint，校验 `pipelineRuns` 租约和 P3 会话所有权/有效期；续租时间不参与业务快照比较。
- **断点恢复**：P1 用成功凭证和 `compileProgress`；P2 用 `activeWork` + `appliedCommands`；P3 用窗口检查点、覆盖清单和持续会话。稳定 operationKey 防止回执丢失后重复写库。

### P1 / P2 / P3 运行链

| 阶段 | 入口 | 关键文件 |
|---|---|---|
| P1 逐章提取 | `ExtractionPanel` → `createExtractionService.start/startLane/reExtract` | [extraction/service.ts](src/features/extraction/service.ts)、[recovery.ts](src/features/extraction/recovery.ts)、[contracts.ts](src/features/extraction/contracts.ts) |
| P2 世界整理 | `WorldPanel` / `AssetEditor` → `world/service.ts` | [world/service.ts](src/features/world/service.ts)、[world/organization.ts](src/features/world/organization.ts)、[agents/organizationCommands.ts](src/features/agents/organizationCommands.ts)、[agents/organizationLease.ts](src/features/agents/organizationLease.ts) |
| P3 叙事整理 | `StoryPanel` → `story/service.ts` | [story/service.ts](src/features/story/service.ts)、[story/checkpoints.ts](src/features/story/checkpoints.ts)、[story/coverage.ts](src/features/story/coverage.ts) |
| Agent 运行时 | P2/P3 共用 | [agents/runtime.ts](src/features/agents/runtime.ts)、[agents/repository.ts](src/features/agents/repository.ts)、[agents/tools.ts](src/features/agents/tools.ts)、[agents/commands.ts](src/features/agents/commands.ts) |

## 关键文件导航

### 应用入口与界面

| 文件 | 用途 |
|---|---|
| [src/App.tsx](src/App.tsx) | 应用外壳、导航和页面切换。 |
| [books/BookOverview.tsx](src/features/books/BookOverview.tsx) | 书籍工作台：提取、世界整理、叙事整理和资产面板。 |
| [assets/AssetsPanel.tsx](src/features/assets/AssetsPanel.tsx) / [AssetEditor.tsx](src/features/assets/AssetEditor.tsx) | 四类资产列表、搜索、编辑、删除。 |
| [extraction/ExtractionPanel.tsx](src/features/extraction/ExtractionPanel.tsx) | P1 开始、暂停、继续、取消、重提和结果。 |
| [world/WorldPanel.tsx](src/features/world/WorldPanel.tsx) | P2 代码整理、机械合并、按步骤 AI 整理、报告。 |
| [story/StoryPanel.tsx](src/features/story/StoryPanel.tsx) | P3 窗口串联、全书复核、继续和用量。 |
| [models/ModelSettings.tsx](src/features/models/ModelSettings.tsx) | 服务商、模型、密钥、连接和 Agent 基础测试。 |
| [backup/BackupPanel.tsx](src/features/backup/BackupPanel.tsx) | 备份导出、预检、恢复为副本、整书删除。 |

### 资产与关系

| 文件 | 用途 |
|---|---|
| [assets/service.ts](src/features/assets/service.ts) | 资产 CRUD、合并、删除、锁定和快照读取。 |
| [assets/mergeCore.ts](src/features/assets/mergeCore.ts) | 人物/地点合并核心，事务内更新实体、来源映射和关联。 |
| [assets/relations.ts](src/features/assets/relations.ts) | 关系基础数据、有效人物对、视角切换、指纹。 |
| [assets/relationEdits.ts](src/features/assets/relationEdits.ts) | 人物对保存/删除、证据状态和编辑记录。 |
| [assets/relationLabels.ts](src/features/assets/relationLabels.ts) | 关系标签展示行。 |
| [assets/characterNames.ts](src/features/assets/characterNames.ts) | 人物匹配称呼和上下文称呼。 |
| [assets/derive.ts](src/features/assets/derive.ts) | 出场频次、事实底稿和层级派生。 |

### Agent 核心

| 文件 | 用途 |
|---|---|
| [agents/runtime.ts](src/features/agents/runtime.ts) | Pi Agent 运行、心跳、预算、恢复、事件和最终结果。 |
| [agents/repository.ts](src/features/agents/repository.ts) | Agent 读写快照、租约 fence、`LeaseGuard`、冲突重试。 |
| [agents/tools.ts](src/features/agents/tools.ts) | 工具注册、按工作项初始工具集、`get_tools`/`get_tools_detail` 动态激活、参数校验、读集记录、稳定 operationKey。 |

按工作项的初始工具集（其他允许工具通过 `get_tools` / `get_tools_detail` 按需开放）：

| 工作项 | 初始工具 |
|---|---|
| P2 目录页 | `query_character_catalog`、`save_candidate_group`、`record_organization_progress`、`submit_result` |
| P2 疑似组 | `get_character_detail`、`get_location_detail`、`read_original`、`merge_assets`、`resolve_candidate_group`、`submit_result` |
| P2 人物资料 | `query_character_profile`、`get_character_detail`、`read_original`、`edit_character`、`submit_profile_review` |
| P2 人物关系 | `submit_relation_review`、`query_relation_work`、`read_original`、`get_character_relation`、`get_legacy_relation_records` |
| P3 窗口/复核 | `get_node_detail`、`query_nodes`、`query_event_lines`、`get_event_line_detail`、`read_original`、`get_editor_memory`、`query_editor_notes`、`get_editor_note_detail`、`search_story_context`、`commit_story_changes`、`submit_result` |

`get_tools` 只列当前任务允许但尚未开放的工具；`get_tools_detail({name})` 返回完整参数并把它加入下一次请求。激活只在当前 Agent 任务内存中，不跨书、不跨阶段。
| [agents/commands.ts](src/features/agents/commands.ts) | 提交意图、`checkLease`、幂等、业务写事务。 |
| [agents/organizationCommands.ts](src/features/agents/organizationCommands.ts) | P2 目录/候选/资料/关系工具和人物对提交。 |
| [agents/organizationReview.ts](src/features/agents/organizationReview.ts) | P2 资料/关系复核上下文、pairChecks、失效处理。 |
| [agents/organizationData.ts](src/features/agents/organizationData.ts) | P2 当前人物资料和关系概览输入。 |
| [agents/organizationLease.ts](src/features/agents/organizationLease.ts) | P2 续租和带租约守卫的仓储包装。 |
| [agents/sessions.ts](src/features/agents/sessions.ts) | 会话解析、绑定和持久化。 |
| [agents/compaction.ts](src/features/agents/compaction.ts) | 会话压缩和摘要修复。 |
| [agents/context.ts](src/features/agents/context.ts) | 会话投影、消息修复、观测记录过滤。 |
| [agents/contracts.ts](src/features/agents/contracts.ts) | 工具契约、Schema、canonical/hash。 |
| [agents/queries.ts](src/features/agents/queries.ts) | 只读查询工具和读集指纹。 |
| [agents/trace.ts](src/features/agents/trace.ts) / [executionChain.ts](src/features/agents/executionChain.ts) | 请求追踪、执行链和详情面板数据。 |
| [world/leaseHeartbeat.ts](src/features/world/leaseHeartbeat.ts) | 周期心跳、失败分类、连续失败计数。 |

### 存储、导入与备份

| 文件 | 用途 |
|---|---|
| [src/lib/storage/workspace.ts](src/lib/storage/workspace.ts) | Dexie 设置库/书库、版本升级、表索引。 |
| [src/lib/storage/importService.ts](src/lib/storage/importService.ts) | 导入事务、书籍和章节落库。 |
| [features/import/parseInWorker.ts](src/features/import/parseInWorker.ts) | TXT 分章和编码处理 Worker。 |
| [features/backup/service.ts](src/features/backup/service.ts) | `.wwv2` 导出、预检、恢复为副本。 |
| [features/backup/codec.ts](src/features/backup/codec.ts) | 备份格式编解码。 |
| [features/backup/rebase.ts](src/features/backup/rebase.ts) | 恢复时重写书籍身份和引用。 |

## 提示词、契约与运行时资源

提示词正文统一在 [docs/v2/resources/v2.2/prompts/active/](docs/v2/resources/v2.2/prompts/active/)。文件角色和调用时机见其 [README](docs/v2/resources/v2.2/prompts/active/README.md)。

| 文件 | 使用场景 |
|---|---|
| [p1-world.md](docs/v2/resources/v2.2/prompts/active/p1-world.md) / [p1-narrative.md](docs/v2/resources/v2.2/prompts/active/p1-narrative.md) | P1 世界资产 / 叙事资产 direct 提取。 |
| [p2-identity.md](docs/v2/resources/v2.2/prompts/active/p2-identity.md) + `identity.txt` | P2 旧身份核实 / 候选 Agent。 |
| [p2-asset-review.md](docs/v2/resources/v2.2/prompts/active/p2-asset-review.md) | P2 全资产/关系核对。 |
| [p2-organization-directory.md](docs/v2/resources/v2.2/prompts/active/p2-organization-directory.md) | P2 目录页工作项，独立完整提示词。 |
| [p2-organization-candidate.md](docs/v2/resources/v2.2/prompts/active/p2-organization-candidate.md) | P2 疑似同人组工作项，独立完整提示词。 |
| [p2-organization-profiles.md](docs/v2/resources/v2.2/prompts/active/p2-organization-profiles.md) | P2 人物资料工作项，独立完整提示词。 |
| [p2-organization-relations.md](docs/v2/resources/v2.2/prompts/active/p2-organization-relations.md) | P2 人物关系工作项，独立完整提示词。 |
| [p3-story.md](docs/v2/resources/v2.2/prompts/active/p3-story.md) + `story.txt` | P3 窗口串联 / 全书复核。 |
| [runtime.ts](src/features/agents/runtime.ts) | 只组装业务 md 正文和 output-discipline；P2/P3 业务策略全部在各 prompt md 中，不再读取 agent-wrapper，也不把 bookId/runId/taskId/phase 写入 system。 |
| `compact.md`、`repair_*.txt`、`recovery.txt`、`final_only.txt` | 压缩、修复、恢复和末轮收束。 |
| `probe_*.txt`、`output-discipline.txt` | 隔离探针和所有 system 提示词尾部输出纪律。 |

修改提示词后：

```powershell
npm run prompts:sync -- --dry-run
npm run prompts:sync
```

`--full` 会继续执行类型检查、非 live 测试和 OpenSpec。同步脚本会更新运行时资源哈希和请求示例；不要手改 `request-examples/` 或 `docs/v2/文档与资源归属.json` 中的哈希。

其他运行时权威资源：

| 资源 | 用途 |
|---|---|
| [tool-contracts.json](docs/v2/resources/v2.2/tool-contracts.json) | Agent 工具参数和结果 Schema。 |
| [tool-results.schema.json](docs/v2/resources/v2.2/tool-results.schema.json) | 工具返回结构。 |
| [storage.schema.json](docs/v2/resources/v2.2/storage.schema.json) | 持久化表/字段结构。 |
| [ai-runtime-contract.json](docs/v2/resources/v2.2/ai-runtime-contract.json) | 请求预算、超时、压缩和工具轮次。 |
| [operation-catalog.json](docs/v2/resources/v2.2/operation-catalog.json) | 60 组界面/操作契约。 |
| [state-transitions.json](docs/v2/resources/v2.2/state-transitions.json) / [data-flows.json](docs/v2/resources/v2.2/data-flows.json) | 状态转移和数据流。 |
| [acceptance-cases.json](docs/v2/resources/v2.2/acceptance-cases.json) | 验收案例索引。 |
| [prompt-call-manifest.json](docs/v2/resources/v2.2/prompt-call-manifest.json) | 提示词调用身份和输入/输出 Schema。 |

## 数据与存储

- 设置库：`westworld_settings`，保存书架、模型配置和凭据。
- 每书库：`westworld_canon_<bookId>`，按书隔离原文、资产、进度、运行、会话和备份映射。
- 主要表组：
  - 原文：`chapters`、`chapterTexts`
  - 世界资产：`characters`、`locations`、`characterRelations`、`characterRelationEdits`
  - 叙事资产：`nodes`、`eventLines`
  - P1：`extractionReceipts`、`compileProgress`
  - 运行与租约：`pipelineRuns`（run、task、lease、commandIntents、appliedCommands、coverage）
  - P2/P3 会话：`storySessions`、`storySessionEntries`、`storyEditorMemory`、`storyEditorNotes`、`storyEditorCheckpoints`
  - 生命周期/旧数据：`assetLifecycle`、`legacyRelationRecords`
- 数据库结构以 [workspace.ts](src/lib/storage/workspace.ts) 和 [storage.schema.json](docs/v2/resources/v2.2/storage.schema.json) 为准；表含义见 [03-数据与存储](docs/v2/03-Spec-数据与存储.md)。
- 资料保存在当前浏览器 origin。改端口或主机名会打开另一个 IndexedDB；本地开发固定使用 `127.0.0.1:5173`。
- `.wwv2` 备份不包含设置库凭据；恢复为独立副本，不覆盖原书。正式书库和备份修改必须获得用户明确授权。

## 常用改动路径

| 要改什么 | 先看 | 修改后检查 |
|---|---|---|
| P1 提示词或提取字段 | `p1-*.md`、`extraction/contracts.ts`、`tool-contracts.json` | `prompts:sync`、`tests/extraction.test.ts`、验收 `docs/acceptance/extraction.md` |
| P2 提示词/工具/关系规则 | `p2-organization-*.md`、`organizationCommands.ts`、`organizationReview.ts` | `tests/organization.test.ts`、`tests/relation-quality.test.ts`、`tests/world.test.ts` |
| P3 提示词/窗口/复核 | `p3-story.md`、`story/service.ts`、`story/checkpoints.ts` | `tests/story.test.ts`、`tests/story-coverage.test.ts` |
| Agent 运行/租约/冲突 | `runtime.ts`、`repository.ts`、`commands.ts`、`organizationLease.ts` | `tests/concurrency.test.ts`、`tests/agents.test.ts`、`tests/lease-heartbeat.test.ts` |
| 数据库表/字段/迁移 | `workspace.ts`、`storage.schema.json`、`03-数据与存储.md` | `tests/workspace.test.ts`、`tests/backup.test.ts`、`tests/import-storage.test.ts` |
| 导入/分章 | `import/parseInWorker.ts`、`importService.ts` | `tests/import-text.test.ts`、`tests/import-storage.test.ts`、`tests/browser/import.spec.ts` |
| 备份格式/恢复 | `backup/service.ts`、`backup/codec.ts`、`backup/rebase.ts` | `tests/backup*.test.ts`、`tests/browser/backup*.spec.ts` |
| 工具参数/返回 | `tool-contracts.json`、`commands.ts`、`tools.ts`、`contracts.ts` | `tests/agents.test.ts`、`tests/stage0-contracts.test.ts`、`docs/v2/11-AI工具返回与回放契约.md` |
| 界面操作/按钮 | 对应 `*Panel.tsx`、`06-界面与交互规格.md`、`operation-catalog.json` | 单元测试 + `tests/browser/*.spec.ts` |

调试运行问题时优先看：

- `pipelineRuns`：run/task 状态、租约、意图、`appliedCommands`、覆盖、报告。
- `storySessionEntries`：请求、工具结果、压缩、执行链。
- `P2OrganizationPanel.tsx` / `P3ExecutionPanel.tsx` / `ExecutionChainView.tsx`：界面中的请求与执行链。
- [trace.ts](src/features/agents/trace.ts) / [executionChain.ts](src/features/agents/executionChain.ts)：运行详情数据。

## 启动

Windows 下双击 [启动本地服务](scripts/启动本地服务.bat)，服务就绪后自动打开工作台。重复双击会打开已有服务。使用完毕后，双击 [关闭本地服务](scripts/关闭本地服务.bat)。也可以为这两个文件创建桌面快捷方式。

入口固定为 `http://127.0.0.1:5173/`。继续使用原来的浏览器及用户配置，即可读取已保存资料。关闭服务前先结束页面中正在运行的提取或整理任务。

首次使用先安装 Node.js 并执行 `npm install`。命令行启动方式：

```powershell
npm install
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

## 使用入口

- 资产维护：设置提取模型后点击“开始提取”；提取中断后“继续提取”只补未成功步骤。详细步骤见[逐章提取验收](docs/acceptance/extraction.md)和[恢复验收](docs/acceptance/extraction-recovery.md)。
- 资产编辑：人物、地点、事件节点、事件线可搜索、筛选、新增、编辑、删除；节点支持“涉及人物”搜索和多选。见[资产维护验收](docs/acceptance/assets.md)。
- 批量合并：代码整理先合并完整同名；异名候选人工确认或加入队列；AI 整理通过 Pi 核对原文并提交有依据的合并。见[世界资产整理验收](docs/acceptance/world.md)。
- 事件线：P3 按每 100 原章、重叠 20 章串联，复用已有事件线和本书会话；取消保留已提交结果。见[事件线验收](docs/acceptance/story.md)。
- 备份：书卡“导出”下载 `.wwv2`；设置页预检后恢复为副本；删除前可先导出。见[备份验收](docs/acceptance/backup.md)。
- 模型：设置页保存服务商、协议、地址、模型和密钥，可测试 direct 与 Agent 基础回复。见[模型验收](docs/acceptance/models.md)和[智能体验收](docs/acceptance/agents.md)。

## 检查

`.env.local` 含真实模型密钥时，`npm test` 会执行 live 测试并产生费用；日常使用：

```powershell
npm run test:unit
```

完整检查：

```powershell
npm run test:unit
npm run typecheck
npm run lint
npm run build
npm run governance:check
npm run openspec -- validate --all --strict
```

提示词改动后先 `npm run prompts:sync -- --dry-run`，确认无误再 `npm run prompts:sync`。

浏览器测试使用 Windows 已安装的 Edge（浏览器）。其他系统安装 Chromium（浏览器）后设置 `PLAYWRIGHT_CHANNEL`（测试浏览器通道）为 `chromium`。

```powershell
npm run test:browser
```

单元测试覆盖文本、存储、恢复、资产业务和 Agent 固定响应；浏览器测试覆盖页面操作、跨标签并发、窄屏与生产构建。真实模型质量验收使用隔离副本，不修改正式书库。

## 当前边界

- 同一本书当前只允许一个 P1/P2/P3 后台任务；P1 内部世界/叙事两条 lane 仍并行，不同书籍可各自运行。
- P2 单人物遇到可恢复冲突会保留当前人物和 `activeWork` 并可继续；真实执行权丢失时旧执行者停止写入。
- 关系方向以当前人物为视角；缺少逐字证据的修改会标记 `unverified`，但业务结果仍可为 `changed`，不阻断完成。
- 已有正式书库数据不会因提示词修复自动重写；需要重新运行相关阶段或人工修正。
- 未经过正式书库的端到端真实模型验收时，不宣称对应数据质量已通过。

## 约定

开发规则见[仓库指令](AGENTS.md)，规格、术语和当前任务入口见[阅读入口](docs/v2/00-阅读入口与术语.md)，治理检查执行 `npm run governance:check`。

- 当前规格在 `openspec/specs/`，拟议变化在 `openspec/changes/`；不另建重复规范文档。
- 规格、技术正文和代码注释描述当前有效状态；历史过程放 Git、归档或证据记录。
- `src/` 是应用源码唯一位置；测试放 `tests/`，可重复脚本放 `scripts/`，临时文件放系统临时目录。
- 提交和推送需用户明确授权；提交说明注明版本和改动。
