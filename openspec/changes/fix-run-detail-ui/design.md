# 整理详情简化设计

2026-11-12实施覆盖：[用户确认的图稿与历史保留设计](user-layout.md)。P2界面及人物链路保留规则按此设计；下文保留此前实际发送采集与工具声明精简的技术背景。

## 需求与确认

REQ-020 / BUG-33，2026-11-11用户再次指出详情同时展示请求、工具快照和对话事件，让人误以为重复发送。用户明确保留顶部人物/时间/统计及底部实际修改，中间只需看到发送给API的消息、工具定义、模型回复和工具调用。同时要求精简模型使用工具的复杂度；关联REQ-019。

本次属于中型优化。按用户明确目标实施，保留已有工作区改动，测试使用固定响应，不调用真实模型或修改正式书库。

## 界面与实施方法

每个API请求只保留一张卡片：编号、时间和状态 → 发送内容（按SYSTEM、USER、ASSISTANT、TOOL区分）→ 模型回复（正文、可展开推理、工具调用参数）→ 对应工具执行结果。工具结果明确是本地执行结果，不混为API回复正文。工具定义只显示一份，默认折叠；长消息可展开全文。删除第二套对话事件、拼接原始JSON、重复请求标题、执行/会话UUID及空的解释块。首个请求展开，其余可逐次展开；用户展开状态不随流式更新重置。

人物索引首次读取立即执行；后续日志更新仍合并刷新，避免刚打开时连续日志将首次读取反复推迟。顶部统计及底部assetEdits保持。P2人物/步骤选择、P3持续会话入口保持。无API记录的旧运行显示简短缺失提示，不根据事件伪造实际请求。

## 字段变化

- 在模型网关的实际fetch发送位置增加只读观测回调，获取即将发送的JSON消息和工具定义，不采集HTTP鉴权头，不改变请求。
- trace的input.messages保存发送体里的消息投影；messageFormat标识provider-request/v1。系统提示在不同协议的system/instructions/messages中统一映射为SYSTEM展示。工具声明保存在既有tool_snapshot，由input.toolSchemaSnapshotId引用，消息不再另存SDK toolsAdded工具定义。旧pi-agent-message/v1记录继续可读，界面标为历史上下文记录。
- 可选input.requestParameters保留请求中模型/采样等非消息字段，input.transportAttemptIds记录此次逻辑请求对应的HTTP尝试；失败/缺失仍明确显示。沿用现有开放input结构，无数据库升级及备份格式变化。
- 模型可见的submit_profile_review与submit_relation_review参数隐藏自动生成的operationKey；关系提交隐藏顶层默认basis，只保留changes[].basis。内部契约和执行兼容已有operationKey及顶层basis，不削弱证据或提交校验。

## 数据流转

SDK生成请求 → 网关读取即将发送的body → trace提取messages/input、system/instructions及tools → 保存同一requestId下的输入和单份工具快照 → ApiRequest按消息角色展示；模型流式返回继续写text/thinking/toolCalls；工具执行结果按toolCallId对应到调用下方。

例如API #1返回query_relation_work参数，程序执行得到结果R；API #2输入含R。页面把#1下的R标为工具执行结果，把#2输入中的R标为TOOL消息；这表示实际反馈链路，不另生成一套对话事件重复回放。输入历史原样保留，折叠只影响阅读。

## 触发、恢复与检查

打开整理详情按requestId渲染；实时更新只更新同一请求，手动折叠保持。重试属于原逻辑请求，记录实际尝试次数；观测失败不阻断调用。存储不足沿用摘要降级，不能把缺失内容显示成完整。

固定测试核对真实fetch请求与trace发送消息/工具一致、工具定义无outputSchema/重复toolsAdded、两种提交模型Schema精简且空提交/证据删除/旧调用兼容。组件检查只有一条API流、无重复原始JSON、正文与工具结果无重复包装；开发和生产浏览器检查人物切换、长内容、折叠稳定及窄屏，保存截图检查观感。

## 接手说明

涉及AgentRunPanel、ExecutionChainView、P2OrganizationPanel及CSS、trace、models/gateway/types、agents/tools和相关测试。任务见[tasks.md](tasks.md)，业务规格见[差异规格](specs/agent-session/spec.md)，既有技术契约见[工具与回放](../../../docs/v2/11-AI工具返回与回放契约.md)。完成后记录实际检查、工具Schema大小和用户自测步骤，用户未验收前不归档，不提交Git。
