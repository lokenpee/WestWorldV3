## ADDED Requirements

### Requirement: AGENT-TRACE-01 请求归属与实际输入
系统 SHALL 为每次实际模型请求保存业务 `runId`、本次 `executionId`、会话、工作上下文、人物、requestId 和最终发送的上下文；同一逻辑请求的网络重试共享 requestId，不重复新建逻辑请求。最终上下文以进入模型网关最终 `streamFunction` 的内容为准，提示词和工具 Schema 保存为不可变快照。

#### Scenario: 同一人物多次请求
- **WHEN** 一个工作项在一次或多次模型请求中查询工具并提交结果
- **THEN** 每次请求都能看到自己的 requestId、executionId、会话、上下文、消息和工具清单，不把第一次任务提示词当作后续请求的实际输入。

#### Scenario: 会话切换
- **WHEN** P2 换人物或 P3 进入新窗口
- **THEN** 新请求显示新的 contextId/workId；沿用原会话时 sessionId 不变，新开窗口时显示新 sessionId，不能混用其他书的日志。

#### Scenario: 暂停与恢复
- **WHEN** 同一轮人物整理暂停、刷新或恢复执行
- **THEN** 业务 runId 保持不变，新的 runtime.run 使用新的 executionId；面板能区分同一轮整理下的多次执行。

#### Scenario: 上下文转换与快照
- **WHEN** prepareRequest、transformContext 或 convertToLlm 修改了上下文
- **THEN** 记录的是最终 streamFunction 收到的输入；运行后修改提示词或工具定义，旧请求仍显示当时的不可变快照，不读取当前定义冒充历史。

### Requirement: AGENT-TRACE-02 实时事件与持久化
系统 SHALL 订阅 Pi 的文本、思考、工具调用、工具结果和结束事件，按 Agent 实例绑定活动 request，实时提供给运行详情；片段只在内存累积，由独立异步 writer 在消息/工具/请求结束时持久化，日志失败不得阻断业务。`agent_end` 只结束运行，不作为逐个请求的结束依据。

#### Scenario: 实时生成与工具
- **WHEN** 模型输出正文、思考并调用多个工具
- **THEN** 面板按 toolCallId 显示参数、结果和错误，长内容默认折叠；toolcall_delta 只作预览，最终参数取解析结果；供应商未返回思考时明确说明，不伪造推理。

#### Scenario: 日志失败
- **WHEN** 运行日志写入失败、writer 队列过载或内容超限
- **THEN** Agent 继续执行并保留已提交资产；面板显示保存失败或截断，不把日志失败当作业务完成或失败，已完成人物不回退或重新提交。

#### Scenario: 刷新与关闭
- **WHEN** 请求运行中关闭面板或刷新页面
- **THEN** Agent 不被停止；刷新后检查租约、持久化进度和其他标签页执行权，显示“运行中（其他窗口）/已中断，可继续/未保存”，不默认运行中，不跨书显示，不重放请求。

### Requirement: AGENT-TRACE-03 观测数据隔离与存储保护
系统 SHALL 将 `request_trace`、`prompt_snapshot`、`tool_snapshot` 视为仅观测数据，不参与模型上下文、压缩、工作记忆、待办或业务推进；并 SHALL 在浏览器存储空间不足时优先保护业务数据。

#### Scenario: 开启与关闭 trace
- **WHEN** 同一任务分别关闭和开启 trace 运行
- **THEN** 两次运行发送给模型的 messages、业务工具调用次数和资产结果一致；观测条目不进入上下文、压缩、工作记忆或 resume 消息，也不推进会话 leaf。

#### Scenario: 浏览器存储水位
- **WHEN** 观测日志接近独立预算或浏览器剩余空间低于安全水位
- **THEN** 先停止保存完整快照和超大工具结果并标记 partial，再停止新增日志；Agent 和人物资产继续提交，业务写入优先于日志，已有日志不自动删除。

#### Scenario: 日志失败
- **WHEN** writer 写失败、队列过载或日志引用缺失
- **THEN** 业务完成状态不受影响；面板显示未保存或不完整，不把日志失败当作业务完成或失败，已完成人物不回退或重新提交。
