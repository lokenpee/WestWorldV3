# 修改记录

## 2026-11-08 · BUG-33 整理详情改为窗口与回合

### 为什么改

用户实际运行时，“运行详情”把每次模型 API 调用当成一个独立条目，并重复展示“本次输入”，看起来像每轮都重新新建 Agent 会话。实际运行是同一个 Agent 窗口内的连续回合：system prompt 和之前消息按 API 无状态规则随请求重放，但窗口、会话和工具历史是连续的。旧界面还会把最新请求的工具渲染到旧请求下，空结果可能导致整个面板崩溃。

### 改了什么

- 重新按“窗口 → 上下文 → 回合”展示：
  - P2：人物窗口可切换；同一人物的资料/关系上下文在窗口内切换；目录、候选作为独立工作窗口。
  - P3：一个持续会话窗口，按回合顺序展示。
- system prompt、业务提示词和工具定义移到窗口顶部，只展示一次。
- 每次模型调用显示为“回合”，展示本轮新增的用户/程序消息、助手回复、工具调用和工具结果；完整累计上下文放进回合详情。
- 每个回合只读取自己的 `toolCalls`，不再复用最新请求的工具。
- 空值/未返回结果显示“等待返回/未记录”，不再调用 `undefined.length` 导致崩溃。
- 展开内容改为全文，不再沿用 1,200 字预览截断。
- 删除受控 `open={status==='running'}`，避免实时更新强制开关；新增“回到最新”。
- 外部 P2 三个入口合并成一个“整理详情”；内部为运行过程、修改结果、用量；报告从内部打开。
- 修改结果只展示实际写库的 `assetEdits`，提交工具参数单独放在“提交记录”。

### 文件

- `src/features/agents/AgentRunPanel.tsx`：窗口/回合展示、空值安全、全文、P2/P3 分窗、修改结果、用量。
- `src/features/agents/AgentRunPanel.css`：窗口标签、回合、消息和滚动布局。
- `src/features/world/WorldPanel.tsx`：单一“整理详情”入口，传入人物名称、运行列表、报告。
- `src/features/story/StoryPanel.tsx`：P3 单一入口，传入逐请求账本。
- `src/features/story/service.ts`：返回 `requestLedger`、运行状态和开始时间供用量标签使用。
- `tests/run-panel.test.ts`：每请求工具、空结果、长内容回归。
- `tests/browser/world.spec.ts`、`tests/browser/story.spec.ts`：单一入口、P2 人物窗口、P3 单会话、修改结果和用量。

### 检查

`npm run typecheck`、`npm run lint`、`npm run test`（470 通过/3 跳过）、开发与生产世界/叙事浏览器测试、`npm run build`、`npm run governance:check`、OpenSpec 严格校验均通过。

### 未完成

滚动位置保持的专项浏览器测试仍列为部分通过；用户自测通过后再决定归档。未提交 Git。
