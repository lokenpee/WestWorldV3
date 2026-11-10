## ADDED Requirements

### Requirement: AGENT-ORGANIZATION-STEP-01 运行中暂停边界

系统 SHALL 在 Agent 当前回合的安全边界响应暂停，不要求等待整个人物或整个工作项完成；暂停后不得发起新的模型请求或工具调用。

#### Scenario: API 之间暂停

- **WHEN** 某人物已经完成第 5 次 API，但还需要继续调用第 6 次时收到暂停请求
- **THEN** 当前回复和工具结果保存后停止，不发起第 6 次 API；继续时从当前人物同一上下文恢复。

#### Scenario: 新工具调用前暂停

- **WHEN** 暂停请求到达时当前 ASSISTANT 已返回但工具尚未开始执行
- **THEN** 未开始的工具被拦截，不执行新的业务写入；当前已开始的工具允许完成或按事务回滚。

#### Scenario: 继续

- **WHEN** 从 paused 状态继续
- **THEN** 使用原 sessionId/contextId/unitId 和剩余消息继续，不重建队列、不重复已确认提交。

### Requirement: AGENT-ORGANIZATION-STEP-02 取消的写前屏障

系统 SHALL 在取消后阻止旧请求继续执行工具和写库，同时保留取消前已经提交的修改。

#### Scenario: 晚到模型响应

- **WHEN** 取消时模型请求已经发出，随后返回工具调用
- **THEN** `beforeToolCall` 检查运行状态/取消信号并拒绝工具执行，不产生新写入。

#### Scenario: 写事务竞争

- **WHEN** 取消发生在写事务提交前
- **THEN** 写事务检查取消状态并拒绝/回滚；取消前已经提交的事务保留。

#### Scenario: 取消后不可恢复

- **WHEN** 旧运行状态为 cancelled
- **THEN** 下一次开始必须创建新 runId 和新队列，不能恢复旧消息、游标或 remainingWorkIds。
