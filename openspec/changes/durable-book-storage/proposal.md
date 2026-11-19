# 书库持久保存与浏览器数据丢失恢复

## Why
REQ-023 / BUG-45：关闭浏览器后书架及Key疑似丢失，目前没有浏览器之外的自动持久副本。用户要求正常保存不依赖反复手工导出。

## What Changes
采用本机SQLite主存储、Windows用户凭据保护和自动恢复副本，保留网页操作；项目与数据分别位于E:/WestWorldV3、E:/WestWorldV3-data。旧数据通过用户启动的迁移入口复制并验证。

## Capabilities
### New Capabilities
无新增产品流程类别，复用书库和配置入口。
### Modified Capabilities
book-backup：LOCAL-STORE-01、LOCAL-MIGRATE-01、LOCAL-BACKUP-01；model-access：LOCAL-KEY-01。

## Impact
| 需求 | 当前与目标 | 文档条款 | 模块与原因 | 实施与验收 |
|---|---|---|---|---|
| REQ-023 | 浏览器主存储改为本机磁盘 | 数据存储、架构AR-04/05、上述差异规格 | storage、导入/备份、模型配置、P1/P2/P3、Agent仓储；保证事务语义 | 任务1至3，重启、清站点、迁移、并发及回滚 |

## 确认依据
2026-11-13用户在了解本机SQLite、事务适配、数据库升级和分页方案后要求“git push保存版本号，登记之前改动后，开始进行”，随后明确项目和数据均放E盘。后台Agent运行没有纳入本次范围。

## 讨论结论
本机磁盘主存储、沿用浏览器界面及启动脚本，保存成功以磁盘事务为准；凭据加密落盘；旧库复制验证后切换，保留来源；自动轮换恢复副本。实现选择与恢复细节见设计，不改变整理业务要求。

## 接手说明
[设计](design.md)说明字段、数据流、触发、事务与迁移；[任务](tasks.md)、[验收](acceptance.md)、[差异规格](specs/book-backup/spec.md)及[凭据规格](specs/model-access/spec.md)为实施入口。现行[数据契约](../../../docs/v2/03-Spec-数据与存储.md)、[架构](../../../docs/v2/02-架构与技术规格.md)和[备份规格](../../specs/book-backup/spec.md)保持字段及恢复含义。本机接口、网页和全部业务调用方已接入，迁移及恢复入口已实现；检查结果与用户验收状态见验收记录。

此前讨论、故障排查和目录迁移记录见[历史依据](evidence/discussion-2026-11-13.md)。当前实施状态见任务与验收。
