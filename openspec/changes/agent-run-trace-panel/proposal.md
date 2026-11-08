# Agent 运行详情与模型请求回放

## Why

REQ-020，大型需求。用户需要看见 P2/P3 Agent 每次实际调用模型时使用的会话、工作上下文、模型输入、思考、工具调用与结果，以及最终写库的资产变化。现有“请求与用量”只汇总 attempt 的 token 和费用，不能判断：

- 这次调用是否沿用了原会话，还是新开了窗口；
- 模型实际看到的是当前人物/窗口资料，还是错误地带了上一批历史；
- 模型调用了哪些工具、参数和返回值是否符合预期；
- 最终资产修改是什么、依据和确认号是否对得上。

用户明确要求类似 DeepSeek/Codex 的可折叠思考链和工具过程，而不是完整聊天界面。需求本身不变；下面“建议方案”作为实施参考。

## What Changes

1. **记录每个实际模型请求。** 以一次逻辑模型请求为 requestId，记录 runId、taskId、workId、contextId、characterId、sessionId、请求序号、模型、用途、开始/结束、状态和 usage。工具调用用 toolCallId 关联参数、结果和错误。
2. **记录实际模型输入。** 在模型网关最终 `streamFunction` 入口记录真正发送给模型的上下文，而不是只记录 `prepareRequest` 的中间结果或任务最初提示词：system prompt、业务提示词、消息角色/内容、工具定义，以及本轮是否使用压缩、分段或历史选段。提示词和工具 Schema 保存为不可变快照，请求只引用当时版本；逐字未变的消息引用会话条目，临时或被 transform 修改的消息保存完整内容，不能完整保存时明确标记。
3. **实时事件订阅。** 使用 Pi `agent.subscribe()` 接收 text/thinking/tool 事件，按 Agent 实例绑定活动 request，实时推送到前端；流式片段只在内存累积，由独立异步 writer 批量落盘，不阻塞 Pi 回调和业务。请求在模型流结束及工具执行完成时独立收尾，`agent_end` 只结束运行；压缩、修正产生新的 requestId，网络重试使用同一 requestId 和不同 attemptId。
4. **运行详情面板。** 在 P2 世界整理和 P3 叙事整理提供“运行详情”抽屉，含三个视图：
   - 实时过程：按会话/上下文/人物分组，逐请求展示思考、正文、工具调用、参数、结果、错误和连接状态，长内容默认折叠。
   - 本次输入：选中请求的实际 system/业务提示词、消息、预装资料、工具定义、估算/实际用量，支持展开和跳到来源条目。
   - 修改结果：按人物/资产展示实际 assetEdits 的前后值、理由、basis、commitId；完成状态以数据库实际写入为准，不依赖模型总结。
5. **归档与恢复。** 运行过程随书保存，刷新后读取已保存的部分；进行中的未落库片段显示“请求中，尚未保存”。备份格式升级为11并包含过程日志和快照，恢复副本保持独立；旧格式4–10仍可读取，缺日志时明确显示“历史明细不完整”。API Key、Authorization 和请求头不进入日志。
6. **观测数据隔离与浏览器容量保护。** payload 条目只用于回放，硬性排除在模型上下文、压缩、工作记忆和待办之外；日志有独立预算和安全水位，空间不足时先降低采集完整度、再停止新增日志，业务写入始终优先。
7. **保持现有业务边界。** 不改变 v3 的 `done=true` 后直接换人、不增加模型结束总结、不增加聊天输入、不引入固定请求/token 上限或阅读证明；不另造一套请求账本，用量继续复用 `requestLedger`。

## 影响

| 需求 | 当前 → 目标 | 规格及契约 | 模块 | 任务 | 验收 |
|---|---|---|---|---|---|
| REQ-020 | 只有汇总用量 → 逐请求过程与输入 | agent-session、model-access | runtime、gateway、trace 存储 | 1–3 | T01–T05、T10 |
| REQ-020 | 看不到思考与工具过程 → 实时可折叠 | agent-session | Agent 事件订阅、前端状态 | 2、3、5、6 | T02、T04、T08 |
| REQ-020 | 看不到本次实际输入 → 可展开输入回放 | agent-session、model-access | 最终 streamFunction、不可变快照 | 1、2、3 | T03、T07、T15、T16 |
| REQ-020 | P2/P3 无运行详情入口 → 面板 | world-organization、story-organization | WorldPanel、StoryPanel、共享组件 | 3 | T06、T11 |
| REQ-020 | 日志不随书保存 → 备份恢复 | book-backup | request_trace、codec、schema | 1、4 | T09、T12、T17 |
| REQ-020 | 观测日志可能污染上下文/耗尽存储 → 严格隔离与容量保护 | agent-session、model-access | context.ts、writer、storage estimate | 1、2、3、4 | T21、T22、T24 |

## 已建议的实施边界

- 第一版覆盖 P2 人物整理和 P3 叙事整理；P1 是直接模型调用，没有 Agent 工具过程，先保留现有请求用量，不纳入本面板。若用户要求 P1 也显示输入，可在同一 trace 模块扩展，但不在本次默认范围。
- 入口放在 P2、P3 各自面板的“运行详情”，不做全局独立日志中心；同一本书的 P2/P3 运行可从各自面板打开，按 run/session 选择。
- 日志随书持久保存，不做自动删除或固定保留条数；通过引用会话条目和“提示词快照”控制输入重复，长内容只在展开时读取。用户删除书时一并删除。
- 完整系统/业务提示词、当前人物预装资料、工具结果属于书内业务数据，可进入日志和备份；密钥、认证头和请求级凭证排除。

## 确认依据

2026-11-08 用户确认：

1. 第一版覆盖 P2 人物整理和 P3 叙事整理；P1 直接模型调用暂只保留现有用量。
2. 运行详情入口放在 P2/P3 各自面板，使用可关闭的抽屉。
3. 过程日志随书保存并进入备份；完整输入用提示词快照和消息引用展开，不自动删除旧日志。

以上为**需求范围确认**。实施方案已于 2026-11-08 获用户批准，代码、自动检查和 DeepSeek Flash 真实验收已完成；用户自测待执行。

## 审查修订

2026-11-08 用户审查指出以下问题，已写入设计、任务和验收：

| 级别 | 问题 | 修订 |
|---|---|---|
| P0 | `prepareRequest` 结果不等于最终模型输入 | 采集点改到最终 `streamFunction`，位于 prepareRequest/transformContext/convertToLlm 之后；原生 payload 另存 |
| P0 | `agent_end` 不等于单次请求结束 | request 在模型流及工具执行完成时独立收尾；`agent_end` 只结束运行 |
| P0 | 快照可能不完整 | 提示词和工具 Schema 保存不可变完整快照；临时消息保存全文；不能保存时标 `completeness=partial` |
| P0 | 日志写失败可能影响业务 | 独立异步 writer，订阅回调只入队；写失败标记未保存，不回滚 done/提交/资产 |
| P1 | request/attempt/压缩身份不清 | requestId 按逻辑调用，attemptId 按物理重试；压缩/修正新 requestId + parentRequestId |
| P1 | 事件可能串线 | 每个 Agent 实例绑定自己的活动 request；toolcall_delta 只预览，最终参数取解析结果 |
| P1 | 刷新后的状态不明确 | 检查租约和持久化状态，显示已中断/可继续；未落库片段标未保存 |
| P1 | 备份格式兼容未验证 | 升级为格式11，读取保留4–10；用旧样本和旧解码器核对 |
| P1 | token 语义不清 | 估算、供应商输入、缓存、输出、费用和 unknown 分开记录 |
| P2 | 日志容量无规则 | 分页、虚拟化、内存窗口、容量告警；不自动删除，不限制业务请求 |

### 二次审查修订（2026-11-08）

| 级别 | 问题 | 修订 |
|---|---|---|
| P0 | 观测日志可能被错误装入模型上下文 | 明确 `request_trace`/`prompt_snapshot`/`tool_snapshot` 仅观测；`context.ts` 在投影前按类型排除，人物整理按 context/unit 加载、压缩、工作记忆和 resume 共用排除函数；增加开启/关闭 trace 行为一致性测试 |
| P0 | 日志可能耗尽浏览器配额并影响业务写入 | 观测日志独立预算（默认配额15%）、保留至少20%可用空间；软水位降级、硬水位停止新增日志；业务写入优先，已有日志不自动删除 |
| P1 | 输入快照不是无损结构 | 保存 Pi 原始结构化消息，保留 toolCall 参数和 toolResult 内容块；预览由 UI 生成；引用读取校验哈希 |
| P1 | runId 与 REQ-019 冲突 | 保留业务 `runId` 跨任务/恢复不变，新增 `executionId` 标识每次 runtime.run/恢复执行 |
| P1 | 快照、日志、备份引用不一致 | writer 按“快照→请求”顺序；缺失写 `missingRefs`/`complete=false`；备份前 flush 并取一致快照；恢复逐项校验，不用当前数据替代 |
| P2 | 刷新文案矛盾 | 重新打开先检查租约、持久化进度和其他标签页执行权，再显示运行中/其他窗口/已中断/可继续 |

新增验收 T21–T24；T01、T08 补充 runId/executionId 和刷新状态。

## 接手说明

1. 读本提案、[设计](design.md)、[任务](tasks.md)、[验收](acceptance.md)及五份差异规格即可接手。
2. 当前规则见[智能体会话](../../specs/agent-session/spec.md)、[模型访问](../../specs/model-access/spec.md)、[世界整理](../../specs/world-organization/spec.md)、[叙事整理](../../specs/story-organization/spec.md)、[备份](../../specs/book-backup/spec.md)。
3. 技术入口：`src/features/agents/runtime.ts`、`models/gateway.ts`、`agents/trace.ts`、`agents/AgentRunPanel.tsx`、`agents/commands.ts`、`storySessionEntries`、`WorldPanel`、`StoryPanel`、`WorldUsageDialog`。
4. 当前实现已有 `requestLedger`、`request_trace`、`onEvent` 和 `done` 机制，需扩展而不是重写；不得改变已完成人物立即切换的 v3 行为。
5. 代码、自动检查和真实模型验收已完成（单人、8 人、P3 小窗口）；备份格式11、观测隔离、异步 writer、P2/P3 面板及 T21–T24 测试落地；用户自测和 Git 提交待执行。
