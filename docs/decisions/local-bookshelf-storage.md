---
status: accepted
date: 2026-10-24
decision-makers: 用户（批准阶段1及既定纯浏览器存储方案），Codex（落地边界）
---

# 用 Dexie 分库保存书架，并隔离开发验收资料

## 背景与决定

阶段 1 需要持久书架、按书隔离、刷新恢复与跨标签刷新。沿用 2.2 规格的 IndexedDB/Dexie 方案，在现有 React/npm 工程增加 Dexie 4.4.6；不增加后端、云同步或另一份权威资产状态。

- 正常库为 `westworld_settings` v2（3 表），书库为 `westworld_canon_{bookId}` v5（15 表）；只在查询该书资料时打开书库，空书架不创建书库、不预置内容。
- `src/lib/storage/workspace.ts` 负责库 Schema 与查询；`BookRepository` 供页面查询。书架选择和当前标签仅存 App 内存；刷新回资产并选最新书，切标签保留当前选书。
- `src/hooks/useLiveResult.ts` 管理 Dexie liveQuery 订阅和取消订阅；新查询不复用上一本书的结果，错误显示到用户明确重试。
- 阶段 1 不承担旧库迁移：尝试升级旧书库时中止升级事务并给出提示，原内容保留；阶段 15 实现真实迁移。
- `src/dev/Stage1Acceptance.tsx` 只在开发构建及明确的 `?acceptance=stage1` 入口加载，固定使用 `westworld_acceptance_stage1_*` 库。工具仅装载/清空固定两本样本，不能枚举清理用户库；生产构建移除模块及样本。
- 页面沿用现有普通 CSS，使用规格约定的中性色、240px 书架和小于768px堆叠布局；本阶段无需新增 CSS 框架或全局状态库。

## 替代方案与后果

原生 IndexedDB 可以减少依赖，但跨标签查询与后续事务都需要另写封装；Dexie 与既定规格一致。所有书放单库更容易做跨书事务，但改变了按书隔离契约，故不采用。单纯内存样本无法验证重开与跨标签，故验收也使用独立 IndexedDB。

每书独立数据库意味着以后导入/删除必须处理跨库非原子操作；本阶段没有借样本装载逻辑冒充正式导入。页面不复制数据库资产数组作为第二权威源。

## 验证

- [x] `tests/workspace.test.ts` 验证空库、排序、持久化、书籍隔离、跨连接更新、15表与旧升级回滚。
- [x] `tests/browser/workspace.spec.ts` 验证真实浏览器三入口、StrictMode无重复、跨标签更新、错误重试、窄屏与独立样本库。
- [x] 生产验收入口隔离：`workspace.production.spec.ts` 已通过，执行结果登记阶段1验收单。
- [x] 正式导入、资产写命令及备份恢复分别由业务与浏览器测试覆盖；旧库原地迁移遵循迁移规格。

体积以本次构建实际结果为准，登记在阶段1验收单；若后续迁移改变数据库命名或版本，先更新本记录与目标契约。
