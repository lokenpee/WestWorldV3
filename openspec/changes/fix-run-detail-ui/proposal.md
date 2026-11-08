# 修复“整理详情”交互与数据串线

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

- 外部只保留一个“整理详情”入口，内部是一条连续 API 会话流：顶部统计 API 次数、工具次数、耗时、Token、费用和模型；每次 API 请求显示 SYSTEM、USER、ASSISTANT、TOOL CALL、TOOL EXECUTION、TOOL RESULT；底部显示实际写库的 `assetEdits`（字段、修改前、修改后、理由、确认号）。
- P2 先切换人物/工作窗口，人物窗口内再切换资料/关系上下文；P3 按持续会话展示。每个 API 请求使用自己的 `row.toolCalls`。
- 展开区显示完整内容；只有确实未保存或被降级时显示“未保存/不完整”，不再静默截断。
- 实时更新只更新对应请求；用户手动展开/收起和滚动位置保持；提供“回到最新”。
- P2 人物窗口标题优先显示姓名，内部编号放在展开信息；目录/候选阶段作为单独窗口。P3 不套用逐人物窗口。
- 旧运行可从同一入口切换；不新增聊天输入、不改变 Agent 业务语义。

## 影响

| 需求 | 当前 → 目标 | 规格 | 模块 | 验收 |
|---|---|---|---|---|
| BUG-33 / REQ-020 | 工具串线、闪烁 → 每请求独立、稳定展开 | agent-session | AgentRunPanel | T01–T03 |
| BUG-33 / REQ-020 | 预览崩溃/截断 → 安全空值和全文 | agent-session | AgentRunPanel | T04–T05 |
| BUG-33 / REQ-020 | 三入口重复 → 一个整理详情、单条会话流 | world-organization、story-organization | WorldPanel、StoryPanel、AgentRunPanel | T06 |
| BUG-33 / REQ-020 | P2 混合长列表 → 人物窗口；P3 单会话 | world-organization、story-organization | AgentRunPanel | T07–T08 |
| BUG-33 / REQ-020 | 提交参数混入修改结果 → 实际写库记录 | world-organization | AgentRunPanel | T09 |

## 确认依据

2026-11-08 用户明确要求修复上述问题：合并三个入口；P2 按人物窗口、P3 单会话；每请求独立工具；展开全文；修改结果只展示实际写库记录；实时更新不打断阅读。按该范围实施，不改 Agent 业务逻辑。

## 接手说明

读本提案、[任务](tasks.md)、[验收](acceptance.md)、[修改记录](implementation-record.md)及差异规格后实施。技术入口为 `src/features/agents/AgentRunPanel.tsx`、`src/features/world/WorldPanel.tsx`、`src/features/story/StoryPanel.tsx`；数据仍来自 `request_trace`、`prompt_snapshot`、`tool_snapshot`、`WorldRun.requestLedger` 和 `report.assetEdits`。
