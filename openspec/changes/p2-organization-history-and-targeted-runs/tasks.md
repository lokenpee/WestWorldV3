# 实施任务

关联 [REQ-021](../../需求池.md)、[提案](proposal.md)、[设计](design.md)、[验收](acceptance.md)及差异规格。代码实施和自动检查已完成；用户自测和少数边界验证待进行。

## 1. 查询与数据兼容

- [x] 1.1 在 `src/features/world/types.ts` 增加 `OrganizationState.mode`、`targetCharacterId`、`CandidateGroup.originStep`、`CandidateDecision.originStep` 和 `WorldRun.scope`；旧数据按 `full` / `fullBook` 兼容，不迁移书库。
- [x] 1.2 在 `src/features/agents/trace.ts` 增加两个查询：`readOrganizationStepIndex` 从运行状态生成该步骤全部对象索引；`readOrganizationRequests` 按对象和稳定游标返回请求页、快照和是否还有更早记录；保留 `readBookTrace` 给 P3 和单运行兼容使用。
- [x] 1.3 实现归属判定：单人物运行按 `mode` 归入第二步或第三步；完整运行的 `directory` 归第一步，`candidate` 使用 `originStep`；`candidate:` 前缀不能单独决定第一步；未知工作项进入“其他”。
- [x] 1.4 在保存疑似组和候选结论时写入 `originStep`；旧数据缺失时按运行范围和运行当前工作集回退。
- [x] 1.5 旧运行没有 `request_trace` 时返回可恢复摘要：`scanPages`、`candidateDecisions`、`profileItems`、`relationItems`、`pairChecks` 和 `report.assetEdits`；标记“旧版本未保存 API 明细”，不生成假请求。
- [x] 1.6 检查备份导入导出仍包含 `storySessionEntries` 和 `pipelineRuns`，不新增备份格式，不删除旧记录。

## 2. P2 整理详情三步骤

- [x] 2.1 在 `AgentRunPanel.tsx` P2 模式增加固定三步骤导航；三个步骤始终显示，不读取当前 `organization.step` 决定是否显示。
- [x] 2.2 每步先加载对象索引：第一步显示目录页、来源为第一步的疑似组和合并结论；第二步、第三步显示全部人物/关系对象；同一人物多次运行显示多条记录，按运行时间倒序。对象索引不受请求分页影响。
- [x] 2.3 点击对象后再加载该对象最近 50 条请求；使用 `(startedAt, requestId)` 稳定游标加载更早记录，不使用 offset；切换对象保留各对象游标。
- [x] 2.4 保持 `ApiRequest`、`MessageBlock`、`Changes` 的现有渲染不变；不改 SYSTEM、USER、ASSISTANT、TOOL CALL、TOOL RESULT 的顺序、参数展开、Token、耗时、费用和修改前后。
- [x] 2.5 运行中订阅 trace hub：新请求追加到当前对象，按 `requestId` 去重；新请求不导致旧游标漂移。
- [x] 2.6 在 `WorldPanel.tsx` 中主进度只使用 `scope=fullBook` 的完整运行；`AgentRunPanel` 接收全部 P2 组织运行用于三步骤历史。
- [x] 2.7 无请求明细的旧运行显示摘要和“无 API 明细”，不隐藏步骤；其他步骤仍可切换。

## 3. 单人物整理运行

- [x] 3.1 在 `service.ts` 增加 `startCharacterOrganization(bookId, characterId, kind)`；校验人物、世界锁、未运行任务和版本条件，创建 `scope=character` 的新运行并返回运行编号。
- [x] 3.2 资料运行只构建目标人物的一个 `profile` 工作项；关系运行只构建目标人物的一个 `relations` 工作项和目标相关人物对，复用 `reviewContext`、`relationWork` 和现有 P2 runtime。
- [x] 3.3 在 `organization.ts` 中让单人物运行在目标工作项（含后续候选处理）完成后结束，不进入关系步骤、finalize 或全场统计。
- [x] 3.4 单人物运行不更新 `compileProgress`、完整运行的 `organizationSummary` 或完整三步统计；资产修改仍走现有版本校验、关系重检和并发保护。
- [x] 3.5 单人物运行使用现有 `TraceSession`、提示词、工具过滤和 `AgentRunPanel`，资料记录归入第二步，关系记录归入第三步；运行内临时 `candidate` 请求也归当前运行步骤，不能拆到第一步。
- [x] 3.6 同一人物每次点击创建新运行；失败、取消后保留已有请求和提交记录，再次点击不覆盖旧运行。

## 4. 人物编辑页入口

- [x] 4.1 在 `AssetEditor.tsx` 底部操作栏增加“AI 整理人物资料”“AI 整理人物关系”，只在已存在人物且未合并/删除时显示，与保存、取消编辑、删除条目并列。
- [x] 4.2 有未保存表单或关系修改、版本冲突、世界锁、完整 P2 或单人物整理运行时禁用两个按钮，并给出简短原因。
- [x] 4.3 在 `AssetsPanel.tsx` 和 `BookOverview.tsx` 传递启动回调；点击后启动对应运行并打开 P2 整理详情，定位到第二步或第三步的该次运行。
- [x] 4.4 按钮不直接依赖世界服务；资产模块只接收回调，保持模块边界。
- [x] 4.5 运行中可查看详情；按钮在运行结束后恢复；错误不覆盖人物编辑表单。

## 5. 检查与交付

- [x] 5.1 固定响应测试：第二步 138 个人物、超过 50 条请求时，对象索引一次显示全部人物；请求按对象分页，加载更早只追加该对象。
- [x] 5.2 固定响应测试：单人物资料运行中插入 `candidate` 核实/合并，全部请求仍归第二步该人物；完整运行第二、三步候选按 `originStep` 归属，不进入第一步。
- [x] 5.3 固定响应测试：运行中追加请求后，加载更早记录不重复、不遗漏；请求 ID 去重。
- [x] 5.4 固定响应测试：旧运行无请求明细时显示摘要和“无 API 明细”；不生成假 SYSTEM/USER/TOOL 记录。
- [x] 5.5 单人物测试：资料只完成目标人物；关系只完成目标人物关系；两次同人物运行保留两条记录；完整三步统计不变。
- [ ] 5.6 并发测试：完整运行或另一个单人物运行时拒绝启动；版本冲突按现有规则拒绝；失败/取消保留记录。已有服务校验和现有并发规则，缺少专项浏览器用例。
- [ ] 5.7 浏览器测试：编辑页按钮位置、对象索引、运行中查看已完成；对象请求分页、备份恢复后历史仍需补充浏览器用例。
- [x] 5.8 运行 `npm run typecheck`、`npm run lint`、`npm run test`、`npm run build`、`npm run governance:check`、OpenSpec 严格校验及世界/人物编辑相关开发/生产浏览器测试。
- [x] 5.9 更新技术文档、验收记录和 REQ-021 状态；用户自测通过后再同步规格并归档。

## 依赖与边界

- 1.x → 2.x；1.x → 3.x；3.x → 4.x；4.x → 5.x。
- 不新增历史表，不复制请求；只使用现有 `pipelineRuns` 和 `storySessionEntries`。
- 不改变 API 详情内部形式和完整三步运行的提示词、工具、统计口径。
- 单人物运行只增加运行记录，不覆盖完整运行；旧数据无法恢复的 API 明细必须明确说明。

当前进展：已实现步骤索引、对象请求稳定游标、单人物资料/关系运行、人物编辑页两个按钮和 P2 三步骤详情；`tests/organization-history.test.ts` 覆盖 138 人物索引、候选归属、稳定游标和旧数据回退，`tests/organization.test.ts` 覆盖单人物运行与完整统计隔离。`npm run typecheck`、`npm run test`（485 通过 / 3 跳过）、`npm run build`、`npm run governance:check`、OpenSpec 严格校验、世界 26 项及叙事/Agent 14 项开发/生产浏览器测试通过。
