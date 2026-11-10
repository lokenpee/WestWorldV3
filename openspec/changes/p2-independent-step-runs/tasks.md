# 实施任务

关联 [REQ-022](../../需求池.md)、[提案](proposal.md)、[设计](design.md)、[验收](acceptance.md)及差异规格。代码实施和自动检查已完成；完整刷新/旧浏览器用例和真实暂停验收待补。

## 1. 状态与调度基础

- [x] 1.1 在 `src/features/world/types.ts` 增加 `OrganizationState.runStep` 和 `pauseRequested`；旧运行无 `runStep` 时按原完整三步历史处理。
- [x] 1.2 在 `service.ts` 增加四个入口：`startOrganizationStep(bookId, step)`、`pauseOrganization(bookId)`、`continueOrganization(bookId)`、`cancelOrganization(bookId)`；旧的 `startOrganization` 可保留兼容，但新界面不再使用。
- [x] 1.3 `startOrganizationStep` 永远创建新 runId，按当前数据库构建该步骤队列；不读取旧 `remainingWorkIds`、游标、activeWork 或 Agent 消息。
- [x] 1.4 初始化步骤状态：第一步 scan/resolve；第二步只构建 profileItems；第三步只构建 relationItems/pairChecks；不混入其他步骤工作项。
- [x] 1.5 `nextUnit`/`runCharacterOrganization` 按 `runStep` 在目标步骤完成后设置 done，不自动进入下一步；第三步不调用 `finalizeStatistics`。
- [x] 1.6 `compileProgress` 只指向当前活动/暂停运行；完成/取消后不提供旧队列恢复入口。

## 2. 暂停

- [x] 2.1 `pauseOrganization` 置 `pauseRequested` 并把运行状态保存为 `paused`，不 abort 当前事务，不释放 lease。
- [x] 2.2 runtime 的 `finishTurn` 在暂停请求后返回结束，停止发起下一次 API。
- [x] 2.3 `beforeToolCall` 在暂停后拦截尚未开始的工具；当前已开始的工具允许完成；不产生新的写库。
- [x] 2.4 `runCharacterOrganization` 在安全边界返回暂停，不把当前工作项登记为 error；保留 activeWork、剩余队列、上下文和消息。
- [x] 2.5 `continueOrganization` 只接受 `paused` 的同一步骤运行，恢复原 runId、session/context、剩余队列，不重建队列。
- [x] 2.6 暂停期间其他步骤按钮禁用；取消按钮可用。

## 3. 彻底取消

- [x] 3.1 `cancelOrganization` 先在事务中标记 `cancelled` 和取消时间/原因，再 abort 执行器。
- [x] 3.2 `beforeToolCall` 检查运行状态/取消信号，取消后不执行新工具。
- [x] 3.3 `commitCommand` 在写事务内再次检查运行状态、lease 和取消信号；取消后拒绝新写，已提交写入保留。
- [x] 3.4 取消后释放 lease，旧 `remainingWorkIds`、游标、session 不再用于下一次开始。
- [x] 3.5 取消后再次点击任一步骤创建新 runId，重新读取当前人物/关系并重建完整队列。
- [x] 3.6 旧运行的 API 请求、连续消息链、修改记录和历史保留，并标记已取消。

## 4. 按钮与刷新恢复

- [x] 4.1 `WorldPanel` 改为三个步骤按钮 + “取消整理”；步骤按钮按 running/paused/idle 显示暂停/继续/开始。
- [x] 4.2 任一步 running/paused 时其他两步禁用；取消只对活动/暂停任务可用。
- [x] 4.3 完成、取消、失败后三个按钮恢复开始；暂停只能继续或取消，不能直接开始其他步骤。
- [x] 4.4 页面刷新后从 `pipelineRuns` 和 lease 恢复状态；数据库 running 但无活动执行器且 lease 失效时显示“已中断，可继续”，不假装运行中。
- [x] 4.5 保持 P2 整理详情三步骤历史、连续 Agent 消息链、原始 API 请求和单人物记录不变。

## 5. 出场统计分离

- [x] 5.1 移除第三步自动调用 `finalizeStatistics` 的路径，但不删除统计代码/表。
- [x] 5.2 增加独立 `updateStatistics` 服务入口和必要的界面入口；检查报告、进度、备份对统计的依赖。
- [x] 5.3 统计失败不回滚关系修改，不影响 P2 历史；旧统计值兼容。

## 6. 检查与交付

- [x] 6.1 固定响应测试：第一步完成不进入第二步；第二步独立；第三步独立且不自动统计。
- [x] 6.2 暂停测试：第 N 次 API 后请求暂停，后续请求/工具不执行；继续同一人物且不重复已确认提交。
- [x] 6.3 取消测试：旧队列失效、新开始新 runId、全量重建；晚到响应不能写库；已提交修改保留。
- [ ] 6.4 状态测试：按钮禁用、完成/取消后恢复已由浏览器/服务测试覆盖；刷新恢复和 running/stale 场景待补。
- [ ] 6.5 历史测试：取消运行和旧运行历史的浏览器用例待补。
- [x] 6.6 运行 `npm run typecheck`、`npm run lint`、`npm run test`、`npm run build`、`npm run governance:check`、OpenSpec 严格校验及世界/叙事相关浏览器测试。
- [x] 6.7 更新技术文档、验收记录和 REQ-022 状态；用户自测通过后同步规格并归档。

## 依赖与边界

- 1.x → 2.x/3.x/5.x → 4.x → 6.x。
- 不新增历史表，不改变 Prompt、工具业务语义和资产版本校验。
- 暂停是保留运行；取消是终止并废弃队列，两者不能共用 resume 路径。
- 第三步只做关系整理；统计是独立收尾能力。

当前进展：已实现 `runStep` 单步队列、三步独立启动、`finishTurn`/`beforeToolCall` 暂停边界、取消写前检查、暂停继续和取消后新建 runId；单步测试通过。`npm run typecheck`、`npm run test`（491 通过 / 4 跳过）、`npm run build`、治理和 OpenSpec 严格校验通过。旧的完整三步浏览器用例仍以待迁移的 `AI整理` 入口为前提，尚未全部改写。
