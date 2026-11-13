# REQ-024 实施任务

已确认方案与模块范围见[提案](proposal.md)，验收场景见[差异规格](specs/extraction/spec.md)。

## 1. 实施与检查
- [x] 1.1 重写两份 P1 提示词、同步相关工具字段说明；核对四部分结构与有效业务规则。
- [x] 1.2 精简 extraction/service.ts 章节消息，更新 AI-02 契约和两个请求示例；同步脚本自动更新 P1 业务正文、章节消息及工具规格。
- [x] 1.3 固定响应验证两条 P1 初始请求与失败修正、保存凭证；更新已有提示词回归断言，执行类型、相关非 live、资源同步、治理和 OpenSpec 检查。结果见下方记录。

## 2. 用户验收
- [ ] 2.1 用户用章节副本核对两条实际调用与提取质量，确认后同步规格并归档。

## 开发检查记录

2026-11-13：
- `npm run test:unit -- tests/extraction.test.ts tests/extraction-controls.test.ts tests/extraction-performance.test.ts tests/models.test.ts --maxWorkers=2`：4文件101项通过。新增两类 P1 失败修正测试，核对初始纯净章节、独立工具错误与修正消息、四部分正文、共同文学说明及保存来源。
- `npm run typecheck`、`npm run build`通过；`npm run lint`无错误，5项既有警告。构建保留现有包体和依赖提示。
- `npm run prompts:sync -- --dry-run`预览后执行同步，再次预览0项变化。两个请求示例的正文、章节消息与工具规格逐项一致。
- `npm run governance:check`、`npm run openspec -- validate simplify-p1-extraction-prompts --strict`、`git diff --check`通过。
- 逐项移除description后比对schemas.json与原版，结构完全一致；没有新增字段校验和数据迁移。
- 使用固定响应与隔离测试库，未调用真实模型。真实提取质量由任务2.1验收。
