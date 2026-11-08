## ADDED Requirements

### Requirement: MODEL-TRACE-01 请求输入与用量关联
系统 SHALL 在模型网关记录每个物理 attempt 的 requestId、attemptId、用途、模型、token、缓存、费用和状态，并与最终 `streamFunction` 的实际输入快照关联；用量继续以 requestLedger 为唯一账本。

#### Scenario: 重试与压缩
- **WHEN** 同一次逻辑请求发生网络重试，或单独触发压缩/修正
- **THEN** 重试 attempts 共享原 requestId、各自有 attemptId；压缩/修正有新的 requestId 和 parentRequestId、独立用途和输入；用量与输入不混入其他人物或会话。

#### Scenario: 未知用量
- **WHEN** 供应商未返回 usage 或价格快照缺失
- **THEN** 账本保留 known 字段和 unknown 标记，不把缺失 token/费用记为 0；估算输入和供应商实际输入分开显示，不互相冒充。

#### Scenario: 结构化输入回放
- **WHEN** 最终输入包含工具调用、结构化参数和工具结果内容块
- **THEN** 保存并回放 Pi 原始结构化消息，不把消息转成字符串；UI 预览由原始数据生成，toolCallId、工具名、参数结构和内容块不丢失。

#### Scenario: 引用一致性
- **WHEN** 请求引用的提示词快照、工具快照或会话条目缺失、哈希不一致
- **THEN** 请求标记 `missingRefs` 和 `complete=false`，面板显示回放不完整，不用当前提示词或工具定义替代。
