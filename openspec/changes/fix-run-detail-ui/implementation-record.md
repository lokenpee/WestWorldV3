# 修改记录

## 2026-11-08 · BUG-33 整理详情改为 API 会话流

### 为什么改

用户实际运行时，“整理详情”把每次模型调用展示成独立条目和“本次输入”，看起来像一个窗口只发送 system prompt，无法按正常 Agent 会话阅读。用户要求直接按 API 实际发生顺序展示：SYSTEM → USER → ASSISTANT → TOOL CALL → TOOL RESULT → 下一次 API，最后附实际写库修改；不额外生成解释，不增加模型调用。

同时修复确认存在的代码问题：

- 实时过程每行使用最新请求的 `current.toolCalls`，导致旧请求显示新工具。
- `preview(undefined)` 读取 `.length` 会抛异常，可能让整个面板崩溃。
- “完整结果”仍走 1,200 字预览，展开也看不全。
- P2 请求按时间混列，没有人物窗口；外部同时有报告、用量、运行详情三个重复入口。
- 工具结果消息被误当成 assistant 文本写入 trace。

### 改了什么

- 整理详情改为一条连续 API 会话流：
  - 顶部统计：API 请求次数、工具调用次数、耗时、Token（输入/缓存/输出）、费用、模型。
  - 每次 API 请求显示完整输入消息：SYSTEM、USER、ASSISTANT、TOOL RESULT；业务提示词和工具定义作为展开项。
  - 当前模型返回单独显示 ASSISTANT 文本/推理/TOOL CALL。
  - 程序执行工具显示 TOOL EXECUTION 和 TOOL RESULT；工具结果不再标成助手回复。
  - 流式更新只更新当前 API 请求对应消息和工具。
- 底部显示“本次实际修改”：只使用真实写库的 `assetEdits`，包含字段、修改前、修改后、理由和 commitId。
- P2 先选人物/工作窗口，人物窗口内切资料/关系上下文；P3 保持一个持续会话。
- 删除“运行过程 / 修改结果 / 用量”三个大标签；外部只保留一个“整理详情”，报告从内部打开。
- 每个 API 请求只读取自己的 `toolCalls`；空结果显示“等待返回/未记录”；展开全文，无预览截断。
- 移除受控 `open={status==='running'}`，增加“回到最新”。
- 修复 `message_end` 把 toolResult 文本覆盖到 assistant 文本的问题；旧日志中与工具结果完全相同的 assistant 文本不再重复显示。
- 最终请求按消息文本去重人物任务 JSON，避免 string 与 content block 两种表示重复发送；真实单人复验只剩 1 份任务。
- 组织整理系统提示词改用 `budgetRule`：不再出现 `100000` 和“最后一次只能调用 submit_result”；明确目录/疑似组用 submit_result，人物资料/关系用 submit_profile_review/submit_relation_review 的 done=true 结束。

### 文件

- `src/features/agents/AgentRunPanel.tsx`：API 会话流、角色块、工具执行结果、统计、人物/上下文窗口、实际修改。
- `src/features/agents/AgentRunPanel.css`：角色颜色、API 卡片、统计栏和修改区样式。
- `src/features/agents/trace.ts`：只从 assistant 的 `message_end` 更新助手文本。
- `src/features/world/WorldPanel.tsx`：单一“整理详情”入口，传入人物名称和运行列表。
- `src/features/story/StoryPanel.tsx`：P3 单一入口。
- `src/features/story/service.ts`：返回逐请求账本和运行状态。
- `tests/run-panel.test.ts`：每请求独立工具、空结果、全文回归。
- `tests/browser/world.spec.ts`、`tests/browser/story.spec.ts`：API 会话流、P2 人物窗口、P3 单会话、实际修改。

### 检查

`npm run typecheck`、`npm run lint`、`npm run test`（472 通过/3 跳过）、开发与生产世界/叙事浏览器测试、`npm run build`、`npm run governance:check`、OpenSpec 严格校验通过。真实单人复验：最终请求 1 份任务 JSON，系统提示词不含旧预算/最后 submit_result 规则。

### 未完成

滚动位置保持的专项浏览器测试仍列为部分通过；旧版本 trace 的 assistant 文本只能按工具结果文本做去重保护。用户自测通过后再决定归档。未提交 Git。
