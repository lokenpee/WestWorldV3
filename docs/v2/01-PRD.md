# 产品定位与能力导航

面向单用户的本地小说资产工作台：导入小说，提取人物、地点和事件，维护当前资产，整理世界资料、串联事件线，并通过备份迁移成果。游玩会话通过独立变更接入。

## 产品与数据范围

当前应用运行在用户浏览器，资料按书保存在本地数据库，模型调用使用用户配置的服务。资产、游玩入口和设置三个入口可见。账号、多人权限、云同步及业务服务器在出现明确需求时另行设计。

## 用户旅程

导入与预览 → 逐章提取并即时查看 → 人工维护 → 按需独立运行世界整理与事件线串联 → 全书复核 → 查看事件网络或导出备份。详细门槛和恢复按对应能力规格。

## 需求导航

### FR-01 书架与切换

有效条款见[书架与小说导入](../../openspec/specs/book-import/spec.md)。

### FR-02 TXT导入与预览

有效条款见[书架与小说导入](../../openspec/specs/book-import/spec.md)。

### FR-03 模型、凭据与探测

有效条款见[模型配置与调用](../../openspec/specs/model-access/spec.md)。

### FR-04 逐章提取与即时可编辑

有效条款见[逐章提取](../../openspec/specs/extraction/spec.md)。

### FR-05 全书前置与独立恢复

有效条款见[逐章提取](../../openspec/specs/extraction/spec.md)。

### FR-07 世界资产整理P2

有效条款见[世界资产整理](../../openspec/specs/world-organization/spec.md)。

### FR-08 事件组织P3

有效条款见[事件线串联与复核](../../openspec/specs/story-organization/spec.md)。

### FR-09 人工编辑与批量合并

有效条款见[资产维护](../../openspec/specs/asset-management/spec.md)。

### FR-10 直接持久化与即时生效

有效条款见[资产维护](../../openspec/specs/asset-management/spec.md)。

### FR-11 事件网络

有效条款见[事件网络](../../openspec/specs/event-network/spec.md)。

### FR-12 编辑记忆与会话

有效条款见[智能体会话与工具](../../openspec/specs/agent-session/spec.md)。

### FR-13 备份、恢复与删除

有效条款见[备份与书籍删除](../../openspec/specs/book-backup/spec.md)。

### FR-14 按书独立的游玩会话

目标行为及接口见[游玩接入变更](../../openspec/changes/play-session-foundation/proposal.md)。

### FR-15 统一Pi AI运行与可持久化Agent

有效条款见[模型配置与调用](../../openspec/specs/model-access/spec.md)。

## FR-CLARIFY 可恢复、可判断完成的处理要求（2026-10-24）

见[并行执行与恢复](../../openspec/specs/task-recovery/spec.md)、[智能体会话与工具](../../openspec/specs/agent-session/spec.md)及各能力的覆盖与恢复场景。
