# 目标缺口专项验收 · 2026-10-24

本目录包含6个固定恢复/覆盖用例，输入与预期均冻结在recovery-cases.json。执行入口不导入原应用；需要重建者提供真实服务适配器。未提供适配器时命令必须报错，不能使用文档自比对的假实现冒充通过。

```text
node resources/v2.2/acceptance/run.mjs --adapter /absolute/path/rebuilt-adapter.mjs
```

适配器导出四个异步函数：reset(seed)、dispatch({operation,input})、inspect({bookId,runId})、dispose()。reset创建隔离仓储、注入clockMs及按序消费uuidSequence；seed中未列的表为空。它只装载前置记录，不调用原实现算预期。dispose清理本用例资源，禁止操作真实用户库。

| dispatch.operation | 接入边界与返回 |
|---|---|
| prepareCommand | 校验绑定/参数/幂等后保存意图；{state:"prepared"}或工具错误对象 |
| executePrepared | 按绑定命令意图调用共享领域服务；CommitAck或工具错误对象；重复执行不得二次应用 |
| manualUpdate | 正式人工修改服务，核expectedRevision并更新字段；{ok:true}或错误 |
| reconcileCoverage | 正式覆盖有效性重核；{ok:true}；无模型调用 |
| finalizeTask | 使用正式最终总结校验/结束事务；{accepted:true}或{error,message} |

inspect输出{characters,run}；characters按ID码点排序，run是T20对应run记录，保留tasks/commandIntents/coverageItems数组已有顺序。runner检查output子集及snapshot点路径，如characters.length或run.tasks.0.status。未知返回字段可保留；禁止以expected值直接构造结果。

这6项覆盖命令重放、同键异payload、准备后冲突、选择性覆盖失效、总结漏项及冒用确认；不是全部30项流程/8项迁移验收。Prompt Context另有15份结构夹具；真实模型、浏览器竞争和空白项目重建仍需执行对应验证。

## 缺陷优先修复回归

新增bugfix-cases.json有6个固定回归场景；运行时使用`--cases /absolute/path/bugfix-cases.json`，仍须真实重建adapter。它们不是本轮已运行的应用测试。

adapter额外暴露dispatch操作：splitChapters返回{chapters,joinedText}，joinedText为真实章块无分隔拼接；planIdentityCandidates返回{candidatePairs:[{memberIds,...}],automaticMerges:[]}且不得写实体；validateP1Narrative返回正式业务校验的{valid,errors,quoteStatuses}；resolveCharacterRefs返回{actorIds,characterReferences}；retryWithAbort注入假时钟和首次限流响应，输出实际请求次数/取消状态/相对elapsedMs，不能在adapter中直接拷贝预期。prepareCommand复用原接口，新增confidence/evidence必须实际校验。

其余BUG-01–20完整触发/预期在07及bugfix-contract.json，含跨库日志恢复、375px可达性和异步文件选择；这些需要对应存储/UI环境验证。旧错误断言不能当成功预期复用。

## 阶段0：按域锁定后的用例调整

GAP-REC-03增加pauseAndRelease与resumeRun：前者调用正式暂停服务，等在途工作停止、释放本owner租约后返回{ok:true}；后者通过正式资源服务取得原run租约并恢复running，同一prepared意图的旧依据仍须executePrepared实际校验。不得直接改seed状态冒充执行。GAP-REC-04初始为paused且没有world租约，人工编辑合法。manualUpdate必须实际检查域锁，锁定返回ASSET_DOMAIN_LOCKED且零写。新增stage0-cases.json为声明式目标验收，不是本轮已运行的应用测试。
