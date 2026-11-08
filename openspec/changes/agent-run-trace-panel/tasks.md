# 实施任务

关联 [REQ-020](../../需求池.md)、[提案](proposal.md)、[设计](design.md)、五份差异规格和[验收](acceptance.md)。需求范围已确认，实施方案已获批准并完成；代码、自动检查和真实模型验收已通过，用户自测待进行。

## 1. 契约与存储

- [x] 1.1 扩展 `request_trace` 条目：requestId、parentRequestId、requestOrdinal、runId、executionId、task/work/context/character、sessionId、用途、模型、状态、开始/模型结束/请求结束时间、输入、providerPayloadRef、思考、正文、工具数组、usage、attemptIds、错误、complete、missingRefs 和 final；同步 `storage.schema.json`，旧记录缺字段兼容。证据：`docs/v2/resources/v2.2/storage.schema.json`、`tests/trace.test.ts`、`tests/organization.test.ts`。
- [x] 1.2 扩展 `requestLedger`：每条物理 attempt 带 requestId、attemptId、executionId；明确 provider 输入、缓存读写、输出、费用和 unknown 的语义。证据：`src/features/agents/ledger.ts`、`tests/models.test.ts`、`tests/organization.test.ts`。
- [x] 1.3 新增不可变 `prompt_snapshot` 和 `tool_snapshot` 条目：保存当时完整提示词、工具定义、内容哈希和创建时间；请求只引用 snapshotId，不能回放时读取当前提示词或工具定义。证据：`src/features/agents/trace.ts`、`tests/trace.test.ts`。
- [x] 1.4 输入保存规则：保存 Pi 最终输入的原始结构化消息（含 toolCall 参数和 toolResult 内容块），不字符串化；逐字未变的会话消息保存 entryId+contentHash；临时消息保存完整结构并按哈希去重；引用读取校验哈希。证据：`src/features/agents/trace.ts`、`tests/trace.test.ts`。
- [x] 1.5 内存 TraceStore 按 Agent 实例绑定活动 request，按书/run/execution/session/context 建索引；定义订阅/取消、批量刷新、分页读取和容量告警；不把整本书 trace 一次载入。证据：`src/features/agents/trace.ts`、`tests/trace.test.ts`。
- [x] 1.6 备份格式升级为 11，保存 request_trace、快照、输入引用和工具完整结果引用；读取继续支持 4–10。证据：`src/features/backup/codec.ts`、`tests/organization.test.ts`、`tests/backup.test.ts`。
- [x] 1.7 观测数据隔离：`context.ts` 在 `sessionPath` 前按类型排除 `request_trace`/`prompt_snapshot`/`tool_snapshot`；人物整理按 context/unit 加载、P3 投影、压缩候选、工作记忆和 resume 消息共用同一排除函数；观测条目不推进 leaf。证据：`src/features/agents/context.ts`、`src/features/agents/repository.ts`、`tests/trace.test.ts`。
- [x] 1.8 容量预算：观测日志独立预算（默认配额 15%，保留至少 20% 可用空间）；writer 用 `navigator.storage.estimate()` 和观测字节计数执行软/硬水位；业务写入优先，不自动删除已有日志。证据：`src/features/agents/trace.ts`、`tests/trace.test.ts`。
- [x] 1.9 引用一致性：writer 按“快照→请求”顺序提交；快照/消息引用缺失时写 `missingRefs`、`complete=false`；读取和恢复逐项校验 snapshotId/entryId/哈希，缺失不用当前数据替代。证据：`src/features/agents/trace.ts`、`src/features/backup/codec.ts`、`tests/trace.test.ts`。
- [x] 1.10 请求记录保存 `runId` 为 REQ-019 业务运行号，`executionId` 为本次 runtime.run/恢复执行号；一个 runId 可关联多个 executionId。证据：`src/features/agents/runtime.ts`、`tests/trace.test.ts`、`tests/organization.test.ts`。

## 2. Runtime 与模型网关

- [x] 2.1 在最终 `streamFunction` 入口生成 requestId 和 executionId，记录 prepareRequest/transformContext/convertToLlm 之后的最终有效输入（Pi 原始结构化消息）；需要原生请求 JSON 时用可选 `onPayload` 单独保存。证据：`src/features/models/gateway.ts`、`tests/models.test.ts`。
- [x] 2.2 CallSession 每次物理请求生成 attemptId，网络重试沿用同一 requestId；requestLedger 的 attempt 与 request_trace、executionId 正确关联。证据：`src/features/models/gateway.ts`、`src/features/agents/ledger.ts`、`tests/models.test.ts`。
- [x] 2.3 请求生命周期：模型流结束确定模型状态和 usage；工具执行作为同一 request 子项；`turn_end` 收尾响应及工具，`agent_end` 只结束执行实例，不逐个结束 request。证据：`src/features/agents/trace.ts`、`tests/organization.test.ts`。
- [x] 2.4 Pi 事件按 Agent 实例绑定：text/thinking/toolcall delta 只更新对应 request；toolcall_delta 只做预览，最终参数取 toolcall_end 或 tool_execution_start 的解析结果；tool 事件按 toolCallId 关联。证据：`src/features/agents/trace.ts`、`src/features/agents/runtime.ts`。
- [x] 2.5 独立日志 writer：Pi 订阅回调只入队和轻量通知，异步批量写 IndexedDB；写失败重试或标“未保存”，不抛回 Agent、不阻塞回调、不回滚 done/工具提交/资产写入；业务事务前让路，容量水位按 1.8 执行。证据：`src/features/agents/trace.ts`、`tests/trace.test.ts`。
- [x] 2.6 压缩/修正调用生成新的 requestId 和 parentRequestId，记录前后 token、摘要条目、失败类型和 usage；P2 正常换人不产生额外总结请求。证据：`src/features/agents/compaction.ts`、`src/features/models/gateway.ts`。
- [x] 2.7 刷新/中断：页面重开后检查租约、持久化进度和其他标签页执行权，显示“运行中（其他窗口）/已中断，可继续”；未落库片段提示未保存，不重放请求。证据：`src/features/agents/trace.ts`、`src/features/agents/AgentRunPanel.tsx`。
- [x] 2.8 runtime 保持 v3 业务语义：done=true 直接结束循环，完成状态来自工具写库和进度；日志缺失不把已完成人物判回未完成，也不触发重新提交。证据：`tests/organization.test.ts`、`tests/agents.test.ts`。

## 3. 前端运行详情

- [x] 3.1 新增共享 AgentRunPanel 抽屉：顶部业务 run、executionId、sessionId/标题、contextId/workId/人物、请求序号和状态；三个视图标签；关闭不停止运行。证据：`src/features/agents/AgentRunPanel.tsx`、`tests/browser/world.spec.ts`、`tests/browser/story.spec.ts`。
- [x] 3.2 实时过程：按运行→会话→工作上下文/人物→请求分组；思考、正文、工具参数/结果/错误默认折叠，长内容展开；无 thinking 显示“未返回推理内容”。证据：`src/features/agents/AgentRunPanel.tsx`、`tests/browser/world.spec.ts`。
- [x] 3.3 本次输入：最终 system/business prompt 快照、Pi 原始结构化消息、预装资料/证据、工具定义快照、估算/实际 token 和压缩标记；按 entryId 读取时校验哈希；引用缺失明确标记不完整。证据：`src/features/agents/AgentRunPanel.tsx`、`tests/browser/world.spec.ts`。
- [x] 3.4 修改结果：从 assetEdits/关系编辑/commitIds 读取前后值、理由、basis；不以模型总结作为完成依据；无法对应时说明来自本人物其他批次。证据：`src/features/agents/AgentRunPanel.tsx`、`src/features/world/WorldPanel.tsx`。
- [x] 3.5 WorldPanel 和 StoryPanel 各增加“运行详情”入口；P2/P3 运行隔离，切书不串数据；不新增聊天输入、不改变现有按钮和报告。证据：`src/features/world/WorldPanel.tsx`、`src/features/story/StoryPanel.tsx`、两个浏览器测试。
- [x] 3.6 刷新/进行中状态：先读已落库记录，检查租约和其他标签页执行权，再订阅实时事件；显示运行中/其他窗口/已中断，不默认运行中；取消/失败保留已保存过程。证据：`src/features/agents/trace.ts`、`src/features/agents/AgentRunPanel.tsx`。
- [ ] 3.7 完整列表虚拟化尚未实现；当前只读取最近 50 条请求并支持 offset/limit。证据：`src/features/agents/trace.ts`（分页），`AgentRunPanel.tsx`（最近请求）。

## 4. 备份、验证与交付

- [x] 4.1 备份/恢复：导出前 flush writer 并暂停日志，同一读事务取一致快照；格式11保存日志、快照和引用；恢复副本重写 bookId，排除凭据和租约，不重放请求；恢复校验 snapshotId/entryId/哈希，缺失只标不完整。证据：`src/features/backup/service.ts`、`src/features/backup/codec.ts`、`tests/organization.test.ts`。
- [x] 4.2 固定响应测试：事件序列、最终输入快照、结构化消息回放、工具参数/结果、失败/取消、压缩/修正、writer 失败、观测数据隔离、存储水位、刷新恢复、跨书隔离、per-delta 不写库、备份兼容。证据：`tests/trace.test.ts`、`tests/models.test.ts`、`tests/organization.test.ts`。
- [x] 4.3 浏览器开发/生产：P2/P3 入口、折叠/展开、思考无数据、工具错误、修改结果、刷新后持久化、关闭不中断、容量提示。证据：`tests/browser/world.spec.ts`、`tests/browser/story.spec.ts`（开发与生产项目均通过）。
- [x] 4.4 已运行 `npm run typecheck`、`npm run lint`、`npx vitest run`、`npm run build`、`npm run governance:check`、OpenSpec 严格校验；结果见验收实际记录。
- [x] 4.5 用户授权后用真实 P2 单人/小批和 P3 运行核对：会话、最终输入、工具参数/结果、资产修改和面板可回放性。证据：DeepSeek Flash 单人、8 人与 P3 两章窗口均通过（`evidence/req020-live-*.json`）；用户自测和归档仍未开始。

## 依赖与检查入口

- 1.x → 2.x → 3.x → 4.x。
- 日志复用 `storySessionEntries` 和 `requestLedger`，不新增业务表；不改变 done=true、工具提交和资产写入。
- 观测类型必须在 `context.ts` 投影入口硬排除，不能依赖 `entryMessages` 返回空数组；开启/关闭 trace 业务行为一致。
- 日志有独立浏览器存储预算，业务写入优先；空间不足只降低或停止日志，不影响资产提交。
- 输入保存 Pi 原始结构化消息；快照、请求和备份引用必须校验，缺失只标不完整。
- 所有采集和面板逻辑以“观测不改变业务”为前提；日志失败只影响回放，不影响运行结果。
- 固定响应样本使用现有 P2/P3 测试夹具；真实模型验证另行授权。
