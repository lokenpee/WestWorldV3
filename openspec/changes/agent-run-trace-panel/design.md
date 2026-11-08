# 设计：运行详情与模型请求回放

## 总体结构

```text
Pi Agent 运行
  ├─ Agent.subscribe()      ── 文本/思考/工具事件 ─┐
  ├─ 最终 streamFunction    ── 最终有效模型输入 ──┤
  └─ CallSession attempt    ── 用量、缓存、失败 ──┘
                                                   ↓
                                        内存 TraceStore（按 Agent/request）
                                                   ↓ 入队，不阻塞事件
                                        异步日志 writer（批量落盘）
                                                   ↓
                                   storySessionEntries(request_trace)
                                                   ↓
                                        前端“运行详情”抽屉
                                                   ↓
                                          随书备份与恢复
```

复用现有 `requestLedger` 记录物理请求用量；新增过程记录只解决“模型看到什么、做了什么、返回什么”，不另造费用账本。

## 分层标识

| 层级 | 标识 | 用途 |
|---|---|---|
| 业务运行 | `runId`、`bookId`、workflow/phase | 一次人物整理或叙事整理轮次；跨任务、暂停、刷新和恢复保持不变，沿用 REQ-019 含义 |
| 执行实例 | `executionId` | 每次 `runtime.run` / Agent 实例 / 恢复执行生成；一个 `runId` 可包含多个 `executionId` |
| 会话 | `sessionId` | 判断是否沿用原会话、是否新开窗口 |
| 工作上下文 | `contextId`、`workId`、`characterId` | P2 的 identity/profiles/relations 与当前人物；P3 的窗口/复核 |
| 请求 | `requestId`、`executionId`、序号 | 一次逻辑模型调用，不把重试拆成多个逻辑请求 |
| 工具 | `toolCallId` | 关联参数、结果、错误；并行/重试时保持唯一 |

## 数据存储

### 复用表

- `storySessionEntries`：扩展 `request_trace` 记录，一条对应**一次最终模型调用**；网络重试不新建 request。
- `pipelineRuns.requestLedger`：保留物理 attempt 用量；每条带 requestId 和 attemptId，用于把费用挂到正确请求。
- `storySessionEntries` 现有 message/commit 条目：只有内容未变化、可作为不可变原件时才能按 entryId 引用；不能引用就保存完整内容。
- 系统/业务提示词、工具 Schema 采用不可变快照条目（`prompt_snapshot`、`tool_snapshot`），请求只引用当时版本。

### 观测数据隔离

`request_trace`、`prompt_snapshot`、`tool_snapshot` 是观测数据，不参与任何模型上下文或业务推进：

- `context.ts` 在 `sessionPath` 之前按类型排除这三类条目，再进入 `projectSession`、`entryMessages`、压缩切点、工作记忆和恢复消息；不能依赖 `entryMessages` 返回空数组的偶然行为。
- 人物整理按 `contextId/unitId` 加载消息、P3 会话投影、compaction 候选、resume context 和 resume 输入都走同一个排除函数。
- 观测条目不推进会话 leaf、不成为消息父节点、不写入工作记忆/readSet/task input/进度；writer 使用独立追加路径，禁止复用会修改会话 leaf 的普通消息追加。
- 固定响应测试分别开启和关闭 trace，模型实际收到的 messages、业务工具调用次数和资产结果必须一致。

### 请求、attempt 与压缩

| 概念 | 标识 | 规则 |
|---|---|---|
| 逻辑模型调用 | `requestId` | 每次进入最终 `streamFunction` 生成一个；一次模型响应及其工具执行属于同一 request |
| 网络重试 | `attemptId` | 同一 request 下的物理尝试；不重新生成 requestId，不改 purpose |
| 压缩/修正模型调用 | 新的 `requestId` + `parentRequestId` | 独立记录输入、输出、usage、失败；不混入人物请求 |
| 业务运行 | `runId` | 一次人物整理或叙事整理轮次；跨任务、暂停、刷新和恢复不变 |
| 执行实例 | `executionId` | 每次 `runtime.run` 生成；一个 `runId` 下可有多次执行和恢复；`agent_end` 只结束该执行实例，不逐个结束 request |

purpose 只取 `work`、`compaction`、`repair`；不再用 `retry` 表示网络重试。

### request_trace 字段

| 字段 | 说明 |
|---|---|
| `traceId`、`requestId`、`parentRequestId`、`requestOrdinal` | 记录 ID、逻辑请求、所属压缩/修正、序号 |
| `runId`、`executionId`、`taskId`、`sessionId`、`contextId`、`workId`、`characterId` | 业务运行、执行实例、任务与会话归属；P3 可只有 task/session |
| `purpose` | `work` / `compaction` / `repair` |
| `model` | provider/model 快照 |
| `status` | `running` / `succeeded` / `failed` / `cancelled` / `interrupted` |
| `startedAt`、`modelFinishedAt`、`finishedAt` | 模型流开始/结束、工具及请求收尾 |
| `input` | Pi 最终有效输入；字段见下 |
| `providerPayloadRef` | 可选的原生请求载荷引用；只供高级排错 |
| `thinking`、`text` | 模型返回的推理/正文；无推理时 null |
| `toolCalls` | toolCallId、解析后的参数、开始/结束、结果预览、完整结果引用、错误 |
| `usage` | 供应商报告 token、缓存 token、费用和 unknown 标记 |
| `attemptIds` | 本 request 下的物理 attempt |
| `error` | 错误码、具体原因、恢复动作 |
| `complete` | 输入/工具内容是否完整保存；false 时 UI 不得声称完整回放 |
| `final` | 最终保存版本 |

### 最终输入快照

记录点必须在**模型网关最终 `streamFunction` 入口**，即 `prepareRequest`、`transformContext`、`convertToLlm/normalizeContext` 之后；不能只记录 prepareRequest 的结果。需要看具体提供商原生 JSON 时，另用可选 `onPayload`，与 Pi 有效输入分开显示。

```ts
{
  systemPromptSnapshotId: "snap-...",
  businessPromptSnapshotId: "snap-...",
  toolSchemaSnapshotId: "tools-...",
  messageFormat: "pi-agent-message/v1",
  messages: [
    // 保持 Pi AgentMessage 原始结构，不转成统一字符串
    { role: "assistant", content: [
        { type: "text", text: "处理贾政……" },
        { type: "toolCall", id: "call-1", name: "submit_profile_review", arguments: { characterId: "贾政", done: true } }
      ], timestamp: 1760000000000 },
    { role: "toolResult", toolCallId: "call-1", toolName: "submit_profile_review",
      content: [{ type: "text", text: "已提交" }], isError: false, timestamp: 1760000000001 }
  ],
  messageHashes: ["sha256:...", "sha256:..."],
  messageRefs?: [{ index: 0, entryId: "entry-...", contentHash: "sha256:..." }],
  estimatedContextTokens: 17765,
  providerInputTokens: 16830,
  providerCacheReadTokens: 0,
  completeness: "complete" | "partial" | "reference-only",
  missingRefs?: ["snap-...", "entry-..."],
  incompleteReason?: string
}
```

- 必须保存 Pi 最终输入的**原始结构化消息**，包括工具调用编号、名称、结构化参数，以及工具结果的 `toolCallId`、`toolName` 和内容块；UI 预览由原始数据生成，不能反过来用预览文本还原模型输入。
- 已存在于会话且逐字未变的原始消息：保存 entryId 和 contentHash，可展开读取原文；引用读取时重新校验 contentHash，引用丢失或哈希不一致时标记回放不完整，不能用当前条目替代。
- 临时、被 transform 裁剪/替换、没有单独持久副本的消息：保存**完整原始结构**，按哈希去重；不能用字符串化内容或预览冒充完整输入。
- 系统/业务提示词保存不可变快照；请求引用 snapshotId，不随以后提示词修改变化。
- 工具参数 Schema 保存**当时完整 Schema 和版本哈希**，不能回放时读取当前工具定义。
- 只有确实无法保存（例如超过存储上限）时才标记 `completeness=partial`，记录原因和缺失引用，UI 明确“不能完整回放”。
- `estimatedContextTokens` 是本地估算；`providerInputTokens`、缓存和费用来自供应商 usage；未知值保留 null，不以估算冒充实际。

### 写入顺序与引用一致性

- writer 每批按 `prompt_snapshot` / `tool_snapshot` → `request_trace` 顺序写入；同一请求相关记录尽量在同一事务内提交。
- 快照或引用条目未持久化时，`request_trace` 写入 `missingRefs` 并置 `complete=false`，不能悄悄省略后仍显示完整。
- 请求引用的消息 entryId 在落盘和读取时校验存在性与哈希；缺失时显示“引用缺失”，不得用当前会话内容回填。
- 备份前 flush writer 队列并暂停新日志写入，等待在途批次完成后，在同一读事务中导出；导出水印之后的运行片段不写入本次备份，并提示“导出时仍有运行”。
- 恢复时逐项校验 snapshotId、entryId 和工具结果引用；缺失只标不完整，不使用当前提示词、工具定义或会话内容替代。

## 运行接入

### 请求采集与生命周期

1. 在最终 `streamFunction` 入口生成 requestId，记录业务 runId、本次 executionId、model、Pi 原始结构化 messages、system/business 提示词快照、工具 Schema 快照和估算 token。
2. 物理 attempt 由网关记录；网络重试使用同一 requestId，不同 attemptId。
3. 模型流结束即确定该 request 的模型状态（成功、截断、错误、取消）；工具执行作为该 request 的子项继续更新。
4. `turn_end` 表示一次模型响应及其工具执行完成；`agent_end` 只结束本次 Agent 执行实例，不负责逐个 request 的结束记录。
5. done=true 直接结束循环时，仍以工具实际写库和进度为完成依据；日志不完整不影响人物完成状态。
6. 压缩/修正由 compaction.ts 产生新的 requestId，并记录 parentRequestId、前后 token、摘要条目、失败类型和 usage。

### 实时事件绑定

- 每个 Agent 实例维护自己的活动 request 绑定（`Map<agentId, {requestId, runId, executionId}>`）；不使用全局 currentRequestId，避免 P2/P3 并行或多轮时串线。
- message_update/text/thinking/toolcall delta 只更新对应 Agent 的活动 request 内存状态。
- toolcall_delta 只做实时预览；最终工具参数以 `toolcall_end` 或 `tool_execution_start` 的已解析参数为准。
- tool_execution_start/update/end 按 toolCallId 更新同一 request 的工具项。
- 日志事件只入内存队列；独立写入器异步落盘，不阻塞 Pi 事件回调。

### 日志写入隔离

- `subscribe` 回调只做入队、状态合并和轻量批量通知，不等待 IndexedDB。
- 独立 writer 按顺序批量写 request_trace；捕获并记录写失败、重试或标记未保存，不把异常抛回 Agent。
- 业务完成状态始终来自原进度和资产事务；日志缺失不能把已完成人物判回未完成，也不能触发重新提交。
- UI 显示“日志保存失败/未保存”，业务继续；恢复后只补日志，不重放业务。

### 刷新与中断

- 浏览器刷新会终止原 JS 执行；页面重开后检查运行租约、其他标签页是否持有执行权、持久化进度和 trace 最后状态。
- 其他标签页持有租约时显示“运行中（其他窗口）”；租约失效且没有执行者时显示“运行已中断，已保存部分可查，可继续”，不能一直显示“运行中”。
- 进行中未落库的片段显示“未保存”；已持久化的请求和业务修改可读。

### 不变量

- `done=true`、工具提交成功、资产写库和换人行为完全不变；不额外请求模型总结。
- 观测条目绝不进入模型上下文、压缩、工作记忆或待办推进；开启/关闭 trace 的业务行为一致。
- 不因为日志截断、日志失败、存储容量不足或回放能力不足而改变业务结果；业务写入始终优先于日志。
- 实时片段不逐字符写库；内存批量刷新，消息/工具/请求结束由 writer 持久化。

## 前端

### 入口

- P2 世界整理面板新增“运行详情”，P3 叙事整理面板新增同一入口。
- 抽屉式覆盖层，不占满人物编辑页；关闭不停止 Agent。
- 顶部显示书、业务 run、executionId、sessionId 与标题、当前 contextId/workId/人物、当前请求序号和状态。
- 右上角可在 P2/P3 运行间切换（同书面板内）；跨书不混。

### 三个视图

1. **实时过程**
   - 分组：运行 → 会话 → 工作上下文/人物 → 请求。
   - 请求头：第 N 次请求、模型、用途、耗时、状态、token 摘要、是否压缩。
   - 折叠块：思考、正文、每个工具调用（名称、参数、结果、错误）、系统/业务提示词。
   - 长内容默认折叠，展开后按需读取全文；工具错误红色标记；运行中显示“模型正在生成/等待工具”。
   - 供应商不返回 reasoning 时，思考区显示“本次模型未返回推理内容”。

2. **本次输入**
   - 选中请求后显示 system prompt、business prompt、结构化消息列表（角色、工具调用、参数、工具结果内容块、来源条目）、预装人物资料/章节证据摘要、工具清单和估算/实际 token；预览由原始结构生成，不用预览文本反向还原输入。
   - 大块内容折叠；可跳转到对应会话条目查看原文；引用缺失或哈希不一致时明确标记“回放不完整”。
   - 明确标注是否发生压缩、分段或历史选段，防止把当前输入误认为完整历史。

3. **修改结果**
   - 从 `report.assetEdits`、关系编辑和 commitIds 读取，不依赖模型总结。
   - 按人物/资产分组，显示修改前后、理由、basis 来源、commitId、是否 no_change/uncertain。
   - 与请求的关联：通过 workId/characterId 和 commitIds 展示“本次处理最终写入了什么”；无法直接对应时明确显示“该修改来自本人物其他批次”。

### 刷新与实时

- 打开面板时先从 IndexedDB 读取已保存 request_trace，再订阅内存实时事件。
- 进行中的请求显示内存片段；刷新后重新打开时，先检查持久化进度、租约和其他标签页是否仍持有执行权，再显示“运行中（其他窗口）”“已中断，可继续”或“未保存片段不显示”，不能默认写成“请求仍在运行”。
- 取消/失败保留已保存过程；不自动重放。

## 脱敏、容量与备份

### 脱敏

- 不保存 API Key、Authorization、Cookie、请求头、凭据存储路径。
- 需脱敏的模型错误和工具错误按现有 `redact` 规则处理。
- 观测日志本身不能成为泄密渠道；导出/备份前再次过滤已知凭据字段。

### 容量与业务优先

- 观测日志有独立预算：默认不超过浏览器估算配额的 15%，并始终为业务数据保留至少 20% 可用空间。writer 在运行开始和每批大内容写入前读取 `navigator.storage.estimate()`，同时维护当前书观测日志的近似字节数；比例按实际浏览器实测校准。
- 软水位（观测预算用尽或可用空间低于 20%）：停止保存完整临时消息、完整工具 Schema 和超大工具结果，改为保存预览、哈希和引用并标 `completeness=partial`；请求元数据、模型正文和错误继续保存，Agent 和人物资产写入继续。
- 硬水位（可用空间低于 10%，或配额估算不可用且预算已超）：停止新增观测日志，只在内存保留当前片段；面板显示“日志未保存/空间不足”，不阻断业务。
- 业务写入优先：writer 在业务事务前让路，不预占也不挤占业务配额；容量保护只为业务留出空间，不自动删除已有日志，不限制 Agent 请求次数。
- 日志按 run/request 分页读取，列表虚拟化；不在一次打开时把整本书的 trace 全部载入内存。当前实现先读取最近 50 条并支持 offset 分页，列表虚拟化作为后续性能优化保留。
- 正常水位下完整内容必须可回放；因容量降级时明确标 partial 和原因。达到预算时提示导出或清理旧日志；删除书时随书删除日志。

### 备份与兼容

- 新日志包含 `prompt_snapshot`、`tool_snapshot`、requestId/parentRequestId 和 provider 输入用量。旧版应用的格式10解码器不认识这些新类型和字段，必须升级备份格式为 **11**；读取继续支持 4–10。
- 格式11保存过程日志、快照、请求输入引用和工具完整结果引用；导出前 flush writer 队列、暂停新日志并在同一读事务中取一致快照，运行中未落库片段不进入本次备份；恢复时重写 bookId、排除凭据和租约，不重放请求。
- 恢复逐项校验 snapshotId、entryId 和工具结果引用；缺失或哈希不符只标不完整，不使用当前数据替代。
- 旧格式 4–10 恢复后，运行详情显示“历史明细不完整”；不得读取当前工具 Schema 冒充旧请求输入。
- 实施前必须用旧格式样本和旧应用解码器核对“新格式被明确拒绝、旧格式仍可读”，不能假设格式10兼容。

## 错误与恢复

| 情况 | 处理 |
|---|---|
| 实时 UI 更新失败 | 不影响 Agent；只影响面板，下一次事件继续 |
| 日志 writer 写失败 | 业务继续；记录标“未保存”，writer 重试或标记失败；不抛回 Pi 事件、不阻塞运行 |
| 日志 writer 队列过载 | 丢弃最旧的**未落库 UI 片段**并显示容量告警；完整请求在结束后仍尝试落库；不限制业务请求 |
| 日志接近浏览器配额 | 按软/硬水位降级：先停止完整快照和超大结果，再停止新增日志；业务和人物资产写入继续 |
| 日志占用影响业务写入 | 日志 writer 让路并停止新增；已有日志不自动删除；业务事务优先，面板提示空间不足 |
| 快照或引用写入失败 | request_trace 记 `missingRefs`、`complete=false`；不显示完整回放 |
| 模型输入无法完整保存 | 标记 `completeness=partial` 和原因；不得声称完整回放 |
| 工具结果超大 | 保存完整内容或按存储上限标记 partial；不能只留预览却不告知 |
| 工具参数流未完成 | toolcall_delta 仅预览；最终参数取 toolcall_end/tool_execution_start 的解析结果 |
| 请求失败/取消/截断 | 独立结束该 request，保存已收到片段、错误和 usage；不标完成 |
| 刷新/浏览器关闭 | 检查租约、持久化进度和其他标签页执行权；显示“运行中（其他窗口）/已中断，可继续/未保存”，不默认显示运行中 |
| 备份/恢复 | 导出前 flush 并暂停日志，取一致快照；格式11保存过程记录和快照；恢复校验引用，缺失只标不完整 |
| 已完成人物但日志缺失 | 业务完成状态不变，不重新提交；只补日志或标记不可回放 |

## 字段变化

| 位置 | 新增/修改 | 类型、默认与校验 | 写入/读取 |
|---|---|---|---|
| `storySessionEntries` type=request_trace | 新增 requestId、parentRequestId、requestOrdinal、runId、executionId、taskId、workId、characterId、contextId、model、status、startedAt、modelFinishedAt、finishedAt、input、providerPayloadRef、thinking、text、toolCalls、usage、attemptIds、error、complete、missingRefs、final | 可选字段兼容旧记录；requestId/状态/时间在生成时写入；input 保存 Pi 原始结构化消息和完整性状态；长内容有截断标记和原因 | runtime 写入，运行详情读取 |
| `storySessionEntries` type=prompt_snapshot | 新增 snapshotId、promptKind、content、contentHash、createdAt | content 非空；同 run+kind+hash 去重；一旦写入不可修改；仅观测，不参与上下文 | runtime 写，request_trace 引用 |
| `storySessionEntries` type=tool_snapshot | 新增 snapshotId、toolNames、schema、schemaHash、createdAt | schema 为当时完整工具定义；不可修改；仅观测，不参与上下文 | runtime 写，request_trace 引用 |
| `pipelineRuns.requestLedger` | 新增 requestId、attemptId | 字符串；同一 request 的物理重试共享 requestId、各自 attemptId；旧记录缺省 | gateway/runtime 写，用量视图读 |
| `WorldRun` 类型 | requestLedger 条目增加 requestId/attemptId；trace 记录作为会话条目，不新增运行字段 | 可选，旧数据兼容 | UI/备份 |

不新增业务表或数据库版本，日志仍写入现有 `storySessionEntries`。备份格式因新增条目类型和字段升级为 11，读取继续支持 4–10；详见“脱敏、容量与备份”。

## 数据流转

```text
Pi 完成 prepareRequest/transformContext/convertToLlm
  → 进入最终 streamFunction：生成 requestId（带业务 runId 和本次 executionId）
  → 记录最终有效输入：Pi 原始结构化消息、提示词快照、工具 Schema 快照
  → CallSession 每次物理请求生成 attemptId，网络重试沿用同一 requestId
  → Pi agent.subscribe 接收 delta/tool 事件，按 Agent 绑定到活动 request
  → TraceStore 内存更新，批量通知 UI；事件回调不等待数据库
  → writer 检查观测预算和浏览器剩余空间，按“快照→请求”顺序入队
  → writer 批量写入 request_trace；写失败或空间不足标未保存/partial，不回滚业务
  → 模型流结束确定模型状态；工具执行结束后 request 收尾
  → requestLedger 的每个 attempt 带 requestId/attemptId/executionId 记录用量
  → 压缩/修正产生新 requestId 和 parentRequestId，单独记录
  → 运行详情读取 trace + ledger + assetEdits；引用缺失显示不完整
  → 导出前 flush 并暂停日志，取一致快照；随书保存（备份格式 11）
```

示例：P2 处理贾政时进入最终 `streamFunction`，生成请求 R1 并保存最终输入快照；模型返回 `submit_profile_review`，工具结果和 commitId K1 写入 R1；assetEdits 保存字段前后值。UI 用 R1 关联输入、usage 和 K1；刷新后从 request_trace 恢复，而不是重新调用模型。若 writer 写库失败，贾政的业务完成状态仍以工具提交和资产写库为准，面板只标记“日志未保存”。

## 触发逻辑

| 触发 | 前置 | 顺序、状态和反馈 | 失败/重复 |
|---|---|---|---|
| 打开运行详情 | 当前书有运行或历史 trace | 先读已保存 trace，再检查租约和其他标签页执行权，显示运行中/其他窗口运行/已中断/已结束 | 无日志显示历史明细不完整；读取失败不启动新任务 |
| 模型请求开始 | 任务已获得执行权，进入最终 `streamFunction` | 生成 requestId（业务 runId + 本次 executionId），保存最终有效输入、提示词和工具 Schema 快照，标记 running | 输入保存失败只标记日志缺失，继续模型调用 |
| 文本/思考/工具 delta | 请求 running | 仅更新内存，批量刷新；不写 IndexedDB | 前端组件关闭时丢弃 UI 订阅，业务继续 |
| 工具开始/结束 | 有 toolCallId | 记录最终参数、结果预览、结果引用、错误 | 结果超限保存全文或标记 partial；不能静默截断 |
| 模型流结束 | 收到 stream 完成/错误/取消 | 确定模型状态和 usage；工具作为同 request 子项继续 | 失败/截断独立结束，不标成功 |
| 请求收尾 | 模型回复及工具执行完成（`turn_end`） | 持久化 request_trace，更新 UI | `agent_end` 只结束执行实例，不逐个结束 request；写失败标记未保存，不改变 done/提交 |
| writer 容量检查 | 有日志待写 | 读取观测预算和剩余空间；软水位降级、硬水位停止新增日志 | 业务写入优先；容量不足只影响回放，不阻断提交 |
| writer 落盘失败 | 队列有未保存记录 | 重试或标记“未保存”；不阻塞 Pi 回调和业务 | 已完成人物不因日志失败回退或重新提交 |
| 关闭面板/刷新 | 运行中 | 关闭不停止；刷新读持久记录并检查其他标签页，进行中片段提示未保存 | 显示运行中/其他窗口/已中断，不默认运行中；不重放、不重复提交 |
| 备份/恢复 | 书或副本 | 先 flush 并暂停日志，同一读事务取一致快照；格式11保存日志、快照和引用 | 恢复校验引用；缺失只标不完整；旧格式缺日志明确提示 |

## 数据流示例

P2 处理贾政：进入最终 `streamFunction` 时创建 requestId R1（业务 runId 不变，本次 executionId E1），保存 Pi 原始结构化输入和预装资料；模型返回 `submit_profile_review(done=true)`。UI 实时显示“会话 S1 · 执行 E1 · profiles · 贾政 · 第 1 次请求”、思考（如有）、工具参数、修改前后和 commitId K1；请求收尾把 R1 写入 request_trace，requestLedger 的 attempt 带 R1、attemptId、E1 和 token。刷新后从 request_trace 恢复并检查其他标签页；修改结果从 assetEdits 读取，而不是从模型正文推断。

## 任务与验收

实施任务见 [tasks](tasks.md)，验收场景见 [acceptance](acceptance.md)。所有字段/事件先固定响应测试，再用真实 P2 单人/小批核对面板内容；不改变 v3 业务行为。
