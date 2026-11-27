# REQ-040 编号文档核对

范围及核对依据见[提案](proposal.md)。

## 开发检查

- [x] 1.1 核对 00–12、文档归属清单、正式页面入口、按书存储和活动变更。改前 OpenSpec 严格校验 39 项通过。治理检查已报告 26 项，其中 21 项是既有活动变更未在需求池登记，4 项引用缺失的旧计划，1 项是旧验收锚点。
- [x] 1.2 [00–12 文档入口](../../../docs/v2/00-阅读入口与术语.md)按现行功能说明操作、接口、存储与验证方法。08 号文档给出[资产与任务的追溯路径](../../../docs/v2/08-追溯与验证记录.md)。
- [x] 1.3 核对 13 份文档的 542 处本地引用，其中 35 处带 Markdown 锚点、23 处带 JSON 字段指针。另核对 3 处资源指回正文的锚点。OpenSpec 严格校验 41 项通过，规格入口与契约检查 21 项通过。全仓治理仍报告其他材料的链接和需求登记问题。

### 本轮专项测试

2026-11-26 在仓库根目录运行以下测试，使用隔离书库和固定模型响应。

| 命令 | 实际结果 |
|---|---|
| `npm run test:unit -- tests/stage0-contracts.test.ts` | 规格入口与历史契约回归 21 项通过。 |
| `npm run test:unit -- tests/extraction-controls.test.ts tests/organization.test.ts tests/event-candidates.test.ts tests/event-workflow.test.ts tests/narrative-v4.test.ts tests/backup.test.ts` | 6 个文件，115 项通过、1 项失败。失败集中在旧事件字段的导出样例。 |
| `npm run test:unit -- tests/backup.test.ts -t "副本保留事件进展"` | 单独复测仍在导出时报错，未进入副本恢复。 |

[失败样例](../../../tests/backup.test.ts)在现行书库直接插入只有旧字段 `coreClue` 的事件 E1，缺少现行必填的线索数组 `clues`。导出时报告 `storyEvents[0] 数据结构不符：must have required properties clues`。从旧格式备份包导入另走版本迁移，本用例未经过该入口。[备份预检和版本分支](../../../src/features/backup/codec.ts) · [旧事件字段迁移](../../../src/features/assets/narrativeMigration.ts)

## 用户审阅

- [ ] 2.1 从 00 的能力表找到当前 P3 入口，核对逐节点串联、两步复核和故事线暂停位置。由 02、03 核对正式存储与备份，再由 12 定位相应用例。待用户审阅文档。
