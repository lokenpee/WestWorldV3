# 修复“整理详情”交互与数据串线

2026-11-12用户图稿与逐项确认覆盖此前P2布局建议，本轮实施以[用户图稿方案](user-layout.md)为准，包含主面板当前人物用量、已完成人物去重选择、折叠实际链路、合并历史及完成后替换旧链路。历史保留语义按大型需求实施，确认内容、字段/数据流/触发、影响表与验收均见该方案，任务6追踪。

2026-11-11用户再次要求去掉冗余与误导性日志展示，保留统计及实际修改，中间只展示API发送内容、模型回复及对应工具调用；同时精简模型可见工具参数。本轮具体范围、字段与验收见[简化设计](design.md)，任务4追踪，沿用BUG-33与REQ-020并关联REQ-019。

## 缺陷

BUG-33，中型缺陷。用户实际运行 P2/P3 时，“运行详情”出现以下问题：

1. 实时过程每一行都显示最新请求的工具，旧请求下面出现新请求的工具；工具区域随新请求闪烁、上下跳动。
2. 打开“本次输入”后滚动不到底部；展开内容仍被 1,200 字截断。
3. “修改结果”可能直接崩溃；提交工具参数和真实资产修改混在一起。
4. 外部同时保留“查看整理报告”“请求与用量”“运行详情”三个入口，功能重复。
5. P2 请求没有按人物/工作上下文分窗，所有人物按时间混成长列表；P3 反而应保持单会话序列。
6. 实时更新会改变正在阅读的折叠状态和滚动位置。

## 根因

- [AgentRunPanel.tsx](../../../src/features/agents/AgentRunPanel.tsx) 在循环 `merged.requests.map(row => ...)` 内使用外层 `toolCalls`，而 `toolCalls` 来自 `current?.toolCalls`；`current` 默认是最新请求，导致所有旧请求显示新工具。
- `preview(value)` 对 `undefined` 调用 `JSON.stringify` 后直接读 `.length`，工具结果尚未返回时抛异常，整个 panel 崩溃。
- 所有“展开全文”仍调用 `preview`，超过 1,200 字符仍被截断；工具定义只渲染名称。
- 请求列表使用受控 `open={row.status === 'running'}`；每次状态变化强制开关 `<details>`，用户阅读位置被重置。
- 页面没有按 `characterId/unitId` 分组；三个入口分别打开报告、用量和详情。

## 目标行为

- 外部只保留一个“整理详情”入口，内部是一条连续 API 会话流：顶部统计 API 次数、工具次数、耗时、Token、费用和模型；每次 API 请求显示 SYSTEM、USER、ASSISTANT、TOOL CALL及本地TOOL RESULT；底部显示实际写库的 `assetEdits`（字段、修改前、修改后、理由、确认号）。
- P2 先切换人物/工作窗口，人物窗口内再切换资料/关系上下文；P3 按持续会话展示。每个 API 请求使用自己的 `row.toolCalls`。
- 展开区显示完整内容；只有确实未保存或被降级时显示“未保存/不完整”，不再静默截断。
- 实时更新只更新对应请求；用户手动展开/收起和滚动位置保持；提供“回到最新”。
- P2 人物窗口标题优先显示姓名，不额外展示执行与会话UUID；目录/候选阶段作为单独窗口。P3 不套用逐人物窗口。
- 旧运行可从同一入口切换；不新增聊天输入、不改变 Agent 业务语义。

## 影响

| 需求 | 当前 → 目标 | 规格 | 模块 | 验收 |
|---|---|---|---|---|
| BUG-33 / REQ-020 | 工具串线、闪烁 → 每请求独立、稳定展开 | agent-session | AgentRunPanel | T01–T03 |
| BUG-33 / REQ-020 | 预览崩溃/截断 → 安全空值和全文 | agent-session | AgentRunPanel | T04–T05 |
| BUG-33 / REQ-020 | 三入口重复 → 一个整理详情、单条会话流 | world-organization、story-organization | WorldPanel、StoryPanel、AgentRunPanel | T06 |
| BUG-33 / REQ-020 | P2 混合长列表 → 人物窗口；P3 单会话 | world-organization、story-organization | AgentRunPanel | T07–T08 |
| BUG-33 / REQ-020 | 提交参数混入修改结果 → 实际写库记录 | world-organization | AgentRunPanel | T09 |
| BUG-33 / REQ-020 | API记录加重复事件流、拼接JSON → 单张API卡片，输入来自实际发送体 | agent-session AGENT-TRACE-05、技术契约11第10节 | gateway、trace、请求展示组件与CSS | 任务4.1、4.2、4.4 |
| REQ-019 / REQ-020 | 自动操作键及批次/逐条依据并列 → 模型只填业务参数、逐条关系依据 | agent-session AGENT-TRACE-05、技术契约11第10节 | tools、资料/关系提示词 | 任务4.3、4.4 |

## 确认依据

2026-11-08 用户明确要求修复上述问题：合并三个入口；P2 按人物窗口、P3 单会话；每请求独立工具；展开全文；修改结果只展示实际写库记录；实时更新不打断阅读。按该范围实施，不改 Agent 业务逻辑。

2026-11-11用户明确要求保留统计和实际修改，只看API发送/返回和工具调用，去掉重复冗余展示，并优化工具复杂度。本轮据此完成[简化设计](design.md)，精简模型声明并兼容旧调用；固定响应检查，不调用真实模型、不修改正式书库。

## 接手说明

2026-11-13 BUG-42再次反馈的结束流程修复已获用户明确授权：“改，然后检查其他环节有没有这种情况”。本次中型局部修复范围为共用Agent运行层及P2三步、P3串联/复核的调用方。普通文字回复后继续当前未完成任务，完成仍依据工具回执；主动暂停、取消和工具失败不能被旧总结校验覆盖。不增加输出格式或字数校验。字段与存储无变化，沿用任务状态、完成回执及会话消息，旧数据与备份兼容。实施方法、数据流及验收见设计末节与任务8。

读本提案、[任务](tasks.md)、[验收](acceptance.md)、[修改记录](implementation-record.md)及差异规格后实施。技术入口为 `src/features/agents/AgentRunPanel.tsx`、`src/features/world/WorldPanel.tsx`、`src/features/story/StoryPanel.tsx`；数据仍来自 `request_trace`、`prompt_snapshot`、`tool_snapshot`、`WorldRun.requestLedger` 和 `report.assetEdits`。

## 2026-11-13：统一单行执行状态（BUG-42）
用户确认P2三步、P3串联和复核均使用一行原位更新的状态，显示API次数、等待计时、返回后的真实工具动作及暂停/错误；运行中有动态光晕，停止后不再动画。用户授权开发者选择事件文案，不追加多段日志。按中型局部修改实施，关联REQ-020、REQ-019、REQ-025。
实施与验收见[设计补充](design.md#单行执行状态)及任务7。证据见[备份诊断](../continuous-character-organization/evidence/identity-paused-2026-11-13.md)。影响agents共用状态展示、world/P2Progress、story/StoryPanel及其服务读取；模型工具和业务写权限不变。
