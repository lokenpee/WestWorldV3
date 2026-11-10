## ADDED Requirements

### Requirement: AGENT-ORGANIZATION-HISTORY-01 P2 对象索引与请求查询

系统 SHALL 继续使用现有 `storySessionEntries.request_trace` 保存 P2 请求，并按运行、步骤和人物提供分页查询；不得为整理详情复制原始请求或提示词。

#### Scenario: 对象索引

- **WHEN** P2 整理详情进入某一步
- **THEN** 从现有运行状态生成该步骤全部对象索引，不读取请求正文；对象索引不受 50 条请求页限制。

#### Scenario: 对象请求

- **WHEN** 用户点击一个对象
- **THEN** 只读取该对象的请求页和快照；资料对象使用 `profile:<id>`，关系对象使用 `relations:<id>`，目录/候选使用对应工作项。

#### Scenario: 加载更早

- **WHEN** 用户加载当前对象的更早请求
- **THEN** 使用 `(startedAt, requestId)` 稳定游标追加，不使用 offset；新请求按 requestId 去重，当前页和其他对象不被重写或删除。

#### Scenario: 请求明细与快照

- **WHEN** 展示一条请求
- **THEN** SYSTEM、业务提示词和工具 Schema 从原有快照引用读取；快照缺失时显示缺失原因，不用当前配置冒充历史请求。

### Requirement: AGENT-ORGANIZATION-HISTORY-02 单人物运行复用 P2 上下文

系统 SHALL 让单人物资料和关系运行复用现有 P2 的提示词、工具过滤、工作项上下文和 `TraceSession`，不新建另一套 Agent 或请求格式。

#### Scenario: 资料运行

- **WHEN** 创建单人物资料运行
- **THEN** 使用 profiles 工作项提示词和工具集，`unitId` 为 `profile:<人物编号>`，请求写入原运行和会话；运行内临时 candidate 请求仍按该运行归入第二步；完成后不进入关系步骤。

#### Scenario: 关系运行

- **WHEN** 创建单人物关系运行
- **THEN** 使用 relations 工作项提示词和工具集，`unitId` 为 `relations:<人物编号>`；关系记录带人物编号和人物对；运行内临时 candidate 请求仍归入第三步；完成后不进入 finalize 或全书统计。

#### Scenario: 历史隔离

- **WHEN** 同一人物再次运行，或切换到其他人物
- **THEN** 新运行使用新的 `runId`；旧运行请求保留；不同人物不共用旧消息上下文。
