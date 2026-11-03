# 逐库逐表数据与生命周期

职责和有效来源见[统一入口](00-阅读入口与术语.md)。实现及验收状态见[覆盖索引](12-验收执行与覆盖矩阵.md)。

## 1. 当前数据只有一层

数据生效行为见[资产维护](../../openspec/specs/asset-management/spec.md)。设置库3表、单书15表；库和索引由[共享存储](../../src/lib/storage/workspace.ts)定义，字段结构由[存储结构](resources/v2.2/storage.schema.json)维护。下文解释业务含义，精确类型以指定结构文件为准。

## 2. 逐表清单与索引

| 编号 | 库/表 | 主键与索引 | 权威数据/写入者 |
|---|---|---|---|
| T01 | 全局 credentials | providerId | 明文凭据，设置修改；不备份到单书 |
| T02 | 全局 appSettings | key | 两模式共用llm.config/Provider适配描述；目录句柄；P1固定单章在途 |
| T03 | 全局 books | id, createdAt | 书名/来源/导入时间，无草稿/已入库状态 |
| T04 | 单书 chapters | chapterIndex, order | 章节元数据，导入生成 |
| T05 | 单书 chapterTexts | chapterIndex | 原章/切块正文，导入生成 |
| T08 | 单书 nodes | id, chapterIndex, order | 当前事件节点，P1/P3/人工直接操作 |
| T09 | 单书 eventLines | id, lineStatus | 当前事件线，P3/人工直接操作 |
| T10 | 单书 characters | id, chapterIndex, name | 当前人物实体，P1/P2/人工直接操作 |
| T11 | 单书 locations | id, chapterIndex, name | 当前地点实体，P1/P2/人工直接操作 |
| T12 | 单书 compileProgress | stage | 三个阶段各一条最新进度，不控制资产生效 |
| T13 | 单书 storyEditorMemory | id=sessionId | 本书持续Agent工作摘要 |
| T14 | 单书 storyEditorNotes | id, [sessionId+key], sessionId, kind, status | 有依据的判断/待查事项，P3提交 |
| T15 | 单书 storyEditorCheckpoints | id, sessionId, stage, phase | P3窗口/全书复核覆盖及恢复 |
| T16 | 单书 storySessions | id, status | 一个活动故事会话及只读旧会话 |
| T17 | 单书 storySessionEntries | id, [sessionId+ordinal], sessionId, parentId | 原始追加消息、compaction、commit、omit |
| T18 | 单书 extractionReceipts | key, chapterIndex, substep | 成功子步骤凭证，P1幂等 |
| T19 | 单书 assetLifecycle | key, kind, originId, currentId, state | 当前ID来源、并入映射及删除墓碑 |
| T20 | 单书 pipelineRuns | id, recordType, stage, status, startedAt, &lockKey | 三阶段/手动合并运行、报告及资源租约 |

无额外数据库层保存另一份待生效人物地点。全部目标字段在本文件第8节逐表展开；第9节规定入口赋值和关联。历史字典仅用于追溯，不能替代当前字段定义。完整机器结构见[data-contract.json](resources/v2.2/data-contract.json)。

## 3. 当前实体的逐字段约定

### 3.1 公共元数据

本表是跨实体字段汇总，不表示每个实体携带全部字段；各表是否存在/必填以第8节为准。节点不新增updatedAt，人物/地点才携带sourceChapters。

| 字段 | 类型/来源 | 约束与消费者 |
|---|---|---|
| id / bookId | string，代码生成 | 当前ID稳定；P1为C章-P/L/N编号，人工为U-UUID，线按L编号；不发布重编号 |
| revision | integer>=1；旧行迁移为1 | 每次修改递增；提交带expectedRevision，变化/不存在返回CONFLICT |
| createdBy | P1/P3/manual（旧P2来源只保留历史） | 记录来源，不表示处于待发布状态 |
| chapterIndex/chapterName | string可省略于手工人物/地点 | P1必填；人物地点保留初次来源信息，合并不会据此重新编号 |
| sourceChapters | string[]，缺省[] | 人物地点来源原章/块并集；合并按章节序排序 |
| updatedAt | ISO string，写入时更新 | 辅助展示；并发依据revision，事实变化不只比时间 |

### 3.2 T10 characters

| 业务字段 | 类型/可编辑性 | 赋值、合并与读取 |
|---|---|---|
| name / aliases | 非空string / string[] | P1写提取名，用户可改；合并保留指定主名、其他称呼归别名 |
| identity / appearance / personality / background | 可选string | 提取/人工资料；机械融合累加和精确去重，AI整编替换展示但保留事实底稿 |
| profile.age / profile.gender / profile.ageText | 可选number/string/string | ageText点路径编辑不覆盖其他字段；冲突保留目标值并报告 |
| speechStyleSample | 可选string | 提取DTO speech_style_sample在首次直接写入时改键，无发布转换步骤 |
| relations | 关系数组，原有target/relation_type/direction/relation_label | 随人物机械融合；target保留称呼，当前UI仍只读 |
| roleWeight / roleWeightSource | 主要人物/重要配角/NPC/路人；frequency/manual | 用户设置优先，自动频次按最终主名统计 |
| confidence / frequency | 原有数值/频次结构 | P1模型值；手工新增confidence默认0.5，不当作已验证 |
| mergeNotes | string[]可省略 | 冲突与待核实说明，不阻止当前实体可用 |
| mergeFacts | `{id,field,text,chapters}[]`可省略 | identity/appearance/personality/background的可追溯底稿 |
| optimizedFactIds / optimizationFingerprint | string[] / string可省略 | 完整事实覆盖与幂等缓存；对应人工字段变化后清缓存 |
| nameSource / manualKeep | extracted/automatic/manual；boolean缺省false | 人工名/保留目标优先；多个人工目标冲突不自动合并 |
| manualSourceNote | 可选string | 手工无章来源时必填，不冒充原文引文 |

### 3.3 T11 locations

name、aliases、来源、revision、createdBy、confidence、frequency、mergeNotes、nameSource、manualKeep、manualSourceNote与人物相同；详细业务字段为description。地点mergeFacts的field固定description，整编验证全部事实ID覆盖后替换展示描述，底稿保留。整体/内部区域不因名称包含自动合并。

### 3.4 T08 nodes与T09 eventLines

节点继续存name、summary、process、actors、targets、time_text/time_hint、timeCoord/timePrecision（若有）、world_delta、new_facts、started_actions、quote、chapterIndex/Name、order、eventLineIds、confidence等原有事实字段。P1/P3或人工写入当前节点；人工/补点选择本书章节；参考引文可留空，匹配时记录位置，不匹配时保存定位提示。order和eventLineIds由代码维护。

线继续存title、nodeIds、cause、process、result、lineStatus、chapters、timeRange（若有）等；P3/人工直接修改。成员非空、存在、多线可共享节点；修改成员时同步节点反向引用，删空线并留墓碑。

节点actorIds（行动人物编号）和targetCharacterIds（对象人物编号）保存稳定人物关联；actors与targets保存当前显示名称。人物删除会移除对应编号与名称，改名更新名称，合并替换为保留人物编号与主名并去重。以上修改与人物变更同事务提交。事件线characterIds（人物集合）按当前节点关联派生。同名时由明确编号选择身份。

人工编辑以“涉及人物”统一展示两类关联的并集。保存保留已有归类，新选择的人物写入行动人物，移除人物同步清理其两类关联。待关联称呼作为名称保留，选择其他人物时仍保留；补充人物资料后沿用唯一称呼自动关联规则。已有对象中的人物进入统一选择，其余对象保留并在详细经过中呈现。底层字段继续供存储、人物联动和查询工具读取。

人工保存参数使用participantIds（涉及人物编号）和unlinkedParticipants（暂存人物称呼）；这两个参数在事务中转换为两类名称与编号，节点表沿用原有结构。已有两类字段仍可由提取与查询流程读写。

## 4. 提取凭证、来源和报告

### 4.1 T18 extractionReceipts

字段key/bookId/chapterIndex/substep/inputFingerprint/originIds/committedAt/runId均必填；substep=worldAssets或narrativeAssets；key=`章:子步骤`。仅成功提交写凭证，可有空originIds；legacy=true仅保守迁移可证实的旧成功步骤。

每个P1成功事务同时写当前实体、live来源、凭证、进度与run覆盖。已有凭证跳过该子步骤，用户修改/并入/删除不删凭证。原文/提取策略变化不自动覆盖人工成果，本轮不增加破坏性强制重提按钮。

### 4.2 T19 assetLifecycle

必填key/bookId/kind/originId/state/revision/updatedAt；kind为character/location/node/eventLine，state为live/merged/deleted。key=`kind:originId`；live/merged有currentId，deleted不提供currentId。

新记录live→自身；合并保留目标并将全部历史来源指向目标（展开redirect链、同书同类、禁止循环）。删除目标使相关来源deleted，不还原被并入行。不为普通内容编辑保留另一份待发布数据。

### 4.3 T20 pipelineRuns

| 分支 | 必填 | 可选/生命周期 |
|---|---|---|
| recordType=run | id、bookId、stage=P1/P2/P3/manual_merge、status、startedAt、planVersion | phase、scope、finishedAt、coverage、input/outputFingerprint、cost/usage、report、aiMode、modelSnapshot、appliedCommands；当前提交结果立即有效，无publish分支 |
| recordType=lease | id=`lease:resource`、bookId、lockKey、owner、runId、expiresAt | resource=extraction/world/narrative；事务获取/续租/释放，导出排除 |

报告含前后数量、机械/AI/手工合并组、成员ID/旧名、保留ID/主名、别名/来源、整编前后tokens、失败/冲突/跳过、externalChanges和费用。报告记录已经生效的修改，不是等待审核生效的合并申请；取消/失败仍保存已提交结果和报告。无合并也有零变更报告。

## 5. 进度、会话与事务

T12保留P1/P2/P3各自进度，增加runId/phase/unit/scope=fullBook/planVersion='2.2'/validity/coverage/dependencyFingerprint。status包含idle/running/paused/cancelling/cancelled/failed/degraded/completed。validity=current/stale仅标识整理结果是否需复核，绝不决定资产能否使用。

T13–T17字段沿用工作摘要、事项、检查点、会话、原始条目形状；新写固定stage=P3，phase为window_link/global_review。每书持续同一active sessionId，窗口/重试/重查不新开；旧归档只读保留。实际世界依赖为kind/id/resolvedId/revision，queryDependencies记录工具参数和返回集合指纹；不纳入全世界指纹阻断无关并行。

### 5.1 会话与运行实例

bookId（书籍编号）确定资料归属，sessionId（逻辑会话编号）确定消息链，runId（运行编号）确定一次执行及其请求预算。重建 Pi 运行实例时读取原会话编号、消息链和有效摘要；继续已保存会话使用原逻辑编号。切换窗口只改变展示对象，结果写入仍使用启动时绑定的三个编号。

完整原始消息、工具调用与结果、摘要记录和提交确认随所属书保存。消息追加与会话末端、序号在同一事务更新；业务写入与提交确认按领域事务提交。恢复投影读取这些记录，按AI-08处理消息配对和摘要边界。相同提交凭据重放返回原确认。

### 5.2 游玩会话持久化

每本书保存自己的游玩历史、工具结果和压缩摘要，整理与游玩按各自职责加载上下文。T13–T17定义整理会话；游玩接口及待开发存储要求见[游玩设计](../../openspec/changes/play-session-foundation/design.md)。

验收核对切书后原书晚到的回复、刷新重建、工具提交后反馈丢失，以及压缩前后完整历史。导出与恢复须保留会话归属、消息顺序、摘要边界和提交确认；恢复为新书后按新书编号隔离。

P1实体+凭证+生命周期+进度+run覆盖同事务；P2/手工每组目标实体+删除成员+来源映射+报告同事务；P3节点/线/记忆/事项/检查点/覆盖/代码确认同批事务。模型请求不进入数据库长事务。普通人工修改在同一短事务先核对应域锁（锁定拒绝且零写），再比较revision，提交即生效。P2/P3运行中的同域人工修改不再是合法状态；P3跨域世界依赖仍需重核。

阶段结束重新枚举所属域当前ID/revision，人工新改数据未覆盖则补待办；无法收敛可paused/stale，资产仍可用。同run已核查的输出更新相应覆盖版本，不让摘要/派生变化把自身全部窗口反复失效。

## 6. 迁移与备份

### 6.1 v4→v5

本节描述旧格式备份的转换要求；旧数据库原地升级列入[后续能力](../../openspec/changes/review-remaining-baseline/proposal.md)，当前打开旧库时保留原库并提示升级。

原characters/locations曾是发布副本，原characterSnapshots/locationSnapshots才是用户最新编辑数据。迁移优先以旧可编辑表作为当前实体来源：该表存在且为空也按空处理，不能从旧固定副本复活用户删除的数据；仅旧可编辑表确实不存在时才回退固定实体。

保留源条目ID及全部资料/来源/底稿，speech_style_sample映射speechStyleSample，revision缺省1；建立live映射；完成验证后删除旧两张表。旧发布编号先按来源映射转换为当前人物编号；不能对应者按姓名和身份重新绑定。已有稳定人物关联保留，事件线人物集合由节点生成。不得机械地把旧两层数据相加生成重复人物地点。

新增T18/T19/T20，旧P1成功/partial仅在能证明成功时迁成功凭证；无法证明的步骤显示待处理；重提时分配本章同类型未使用序号，检查当前记录/来源/墓碑，保留所有既有资料，不覆盖人工资产、不复活旧ID；潜在重复再由用户或P2合并。旧P2/P3样本、进度和checkpoint保留历史但新计划stale，仍不影响资产可用。已有active故事会话继续使用，旧原始消息不伪造。

### 6.2 v5备份

formatVersion=5。data/characters.json、data/locations.json包含全部当前资料和来源/底稿；不再导出characterSnapshots/locationSnapshots。其余为书元数据、章节、节点、线、进度、会话记忆及新增extractionReceipts/assetLifecycle/pipelineRuns，原文仍chapters/*.txt。manifest列文件并保存SHA-256，设置Key/配置和lease排除；running运行导出为paused，报告保留。

导入总是新bookId，重写所有归属，清owner/lease；v4按上述优先规则迁移，不要求先发布。v5检查receipt唯一、redirect同类无环且目标有效或deleted、会话链和必要字段；原始输入数据不因P2/P3未完成而拒绝恢复。全书一致快照仍可在处理期间导出。书架与单书库跨库非原子边界保留说明。

## 7. Pi运行时、应用持久化与写命令凭据

Pi AgentState管理当前进程消息、可执行工具、pending calls、循环/流事件；长期业务数据仍在本文件的单书表中。应用加载T16/T17规范消息投影和T13–T15工作记忆构造Pi Agent上下文，通过Pi事件持久消息，不能假定SDK自行保存数据库。P2临时Agent不复用P3故事记忆，P3同书持续sessionId约定不变。

T02的llm.config原有地址、模型名和归并窗口继续保留；可选providerId/api或等价适配器标识经共用配置解析器归一为Pi Model，不引入另一份Agent专用配置。默认兼容现有deepseek设置；能力/窗口/价格未知时标明来源或估算，不能偷偷复制不相关模型元数据。凭据仍T01按Provider引用读取，run中不保存明文Key。

T20 run可记录aiMode=direct/agent及本次modelSnapshot（providerId/api/baseUrl/modelId/modelRole/contextWindow/capabilities/credentialRef元数据）。appliedCommands为`{taskId,operationKey,payloadFingerprint,commitId,committedAt,resultSummary}[]`，中断恢复沿用原runId，显式新一轮重查新runId；同run内operationKey唯一，与当前实体/记忆/覆盖/报告同事务追加；同键同payload返回原确认，不重复应用，同键不同payload拒绝。

commit_story_changes实际提交节点/线、工作记忆与检查点，允许空资产操作仅写memory_update；commit_asset_changes实际提交P2世界合并和报告。它们都是Pi AgentTool.execute调用的应用命令服务，不是仅收集意图的submit_result。final submit_result只提交AgentTaskSummarySchema摘要，不重演业务写入。

DB提交成功但工具反馈/最终模型回复未保存时，凭据仍可恢复；重试同operationKey返回alreadyApplied=true。新增字段进入v5单书备份，活Pi Agent对象/控制器/SDK进程状态不序列化为“长期记忆”；恢复依赖应用存档重新建运行对象。

## 8. 完整逐表字段字典（2026-10-23校订）

本节把18张目标表的字段放入正文。结构全集为[storage.schema.json](resources/v2.2/storage.schema.json)，与[data-contract.json](resources/v2.2/data-contract.json)的schemas一致。字段释义、来源和事务规则共同构成契约，JSON存在不代表应用已实现。

**存在性约定：** “可省略”不是“可null”；数据库目标行不存undefined，JSON序列化省略它。模型可选null在入库前转成省略；必填null拒绝。嵌套必填只在父对象存在时要求。空数组表示已知无条目，省略表示未提供/未计算；不得一律填空串或0。除表中明确default外，JSON Schema不负责补值，入口赋值见第9节。

**校验约定：** Schema只检查形状。Dexie索引不检查完整业务Schema、枚举或外键；应用命令服务必须执行结构、作用域、引用、引文、版本及租约校验。人工编辑按人工字段约束执行，不强加模型事实覆盖，但不能绕过引用/并发校验。历史弱校验记录与目标新写分开；导入不能静默猜补未知原文。

**时间和单位：** ISO时间由应用UTC序列化，界面再本地化；Unix数值时间为毫秒。正文字符数/offset按JavaScript UTF-16 code unit计数，字节限额按UTF-8 JSON计数。数据库索引首项为主键，`&`为唯一索引；所有关联均由应用维护，无SQL外键/自动级联。

以下字段保留原契约无上下界的number定义时，表示Schema未额外限制，不能宣称数据库已强制整数/范围。具体创建算法仍须生成合法业务值。

### T01 · credentials

库：`westworld_settings` v2。索引：`providerId`。

每Provider一行；设置保存/清除，模型凭据适配器读取；不随删书删除，不导出。

| 字段路径 | 类型/枚举 | 必填、null、默认 | 结构限制 | 含义、来源与更新 |
|---|---|---|---|---|
| providerId | string | 必填；非null；无Schema默认 | — | Pi Provider标识，关联全局credentials.providerId |
| credential | object | 必填；非null；无Schema默认 | — | 当前可用API Key凭据；OAuth仅为SDK可携带类型，应用无登录流程 |
| credential.type | "api_key" | 必填；非null；无Schema默认 | — | 判别字段；只允许该联合分支对应字段 |
| credential.key | string | 必填；非null；无Schema默认 | — | 稳定业务键；各表构造方式见下文 |

[本表完整结构示例](resources/v2.2/table-examples/credentials.json)（固定人工数据；example指纹不作为实际恢复凭证）。

```json
{"providerId":"deepseek","credential":{"type":"api_key","key":"test-only-not-a-real-key"}}
```

### T02 · appSettings

库：`westworld_settings` v2。索引：`key`。

每设置键一行；设置/目录选择写入，配置解析器和导出读取；不导出。

| 字段路径 | 类型/枚举 | 必填、null、默认 | 结构限制 | 含义、来源与更新 |
|---|---|---|---|---|
| [key=llm.config]::key | "llm.config" | 必填；非null；无Schema默认 | — | 稳定业务键；各表构造方式见下文 |
| [key=llm.config]::value | object | 必填；非null；无Schema默认 | — | 按key区分的设置值；不能混用分支 |
| [key=llm.config]::value.baseUrl | string | 必填；非null；无Schema默认 | — | 模型API基址；空读回DeepSeek默认地址 |
| [key=llm.config]::value.extractionModel | string | 必填；非null；无Schema默认 | — | P1/direct提取模型ID；默认deepseek-flash |
| [key=llm.config]::value.aggregationModel | string | 必填；非null；无Schema默认 | — | P2/P3归并模型ID；默认deepseek-v4-pro |
| [key=llm.config]::value.aggregationContextWindow | integer | 可省略；非null；无Schema默认 | minimum=8192 | 用户覆盖归并模型窗口tokens；可省略，UI要求整数≥8192 |
| [key=llm.config]::value.providerId | string | 可省略；非null；无Schema默认 | — | Pi Provider标识，关联全局credentials.providerId |
| [key=llm.config]::value.api | string | 可省略；非null；无Schema默认 | — | Pi协议适配器标识，缺省走当前兼容协议 |
| [key=llm.config]::updatedAt | string | 必填；非null；无Schema默认 | — | 应用提交时的ISO 8601时间；不替代revision并发检查 |
| [key=compile.concurrency]::key | "compile.concurrency" | 必填；非null；无Schema默认 | — | 稳定业务键；各表构造方式见下文 |
| [key=compile.concurrency]::value | integer | 必填；非null；无Schema默认 | minimum=1；maximum=16 | 按key区分的设置值；不能混用分支 |
| [key=compile.concurrency]::updatedAt | string | 必填；非null；无Schema默认 | — | 应用提交时的ISO 8601时间；不替代revision并发检查 |
| [key=assets.exportDirectory]::key | "assets.exportDirectory" | 必填；非null；无Schema默认 | — | 稳定业务键；各表构造方式见下文 |
| [key=assets.exportDirectory]::value | object | 必填；非null；无Schema默认 | — | 按key区分的设置值；不能混用分支 |
| [key=assets.exportDirectory]::updatedAt | string | 必填；非null；无Schema默认 | — | 应用提交时的ISO 8601时间；不替代revision并发检查 |

[本表完整结构示例](resources/v2.2/table-examples/appSettings.json)（固定人工数据；example指纹不作为实际恢复凭证）。

```json
{"key":"llm.config","value":{"baseUrl":"https://api.deepseek.com","extractionModel":"deepseek-flash","aggregationModel":"deepseek-v4-pro"},"updatedAt":"2000-01-01T00:00:00.000Z"}
```

### T03 · books

库：`westworld_settings` v2。索引：`id, createdAt`。

每次导入一本书；导入创建，书架读取，删书删除；单书备份book.json。

| 字段路径 | 类型/枚举 | 必填、null、默认 | 结构限制 | 含义、来源与更新 |
|---|---|---|---|---|
| id | string | 必填；非null；无Schema默认 | — | 记录主键；生成后稳定，更新不重新编号 |
| title | string | 必填；非null；无Schema默认 | — | 书名或会话/事件线标题；按所属表输入来源生成 |
| author | string | 可省略；非null；无Schema默认 | — | 作者。原文没写就留空。 |
| sourceFileName | string | 可省略；非null；无Schema默认 | — | 导入时的原始文件名。 |
| createdAt | string | 必填；非null；无Schema默认 | — | 应用创建时的ISO 8601时间，后续不改 |

[本表完整结构示例](resources/v2.2/table-examples/books.json)（固定人工数据；example指纹不作为实际恢复凭证）。

```json
{"id":"bk_acceptance","title":"逆推验证样本","createdAt":"2026-10-21T00:00:00.000Z","sourceFileName":"逆推验证样本.txt"}
```

### T04 · chapters

库：`westworld_canon_{bookId}` 目标v5。索引：`chapterIndex, order`。

每章/切块一行；导入创建，P1/原文工具/章节轴读取；正文在T05；删书删除。

| 字段路径 | 类型/枚举 | 必填、null、默认 | 结构限制 | 含义、来源与更新 |
|---|---|---|---|---|
| bookId | string | 必填；非null；无Schema默认 | — | 所属书；必须等于数据库命名中的bookId；导入重写 |
| chapterIndex | string | 必填；非null；无Schema默认 | — | 本书章节/切块标识，关联chapters.chapterIndex |
| chapterName | string | 必填；非null；无Schema默认 | — | 章节名，导入预处理后的结果。 |
| charCount | number | 必填；非null；无Schema默认 | — | 本章字数。 |
| order | number | 必填；非null；无Schema默认 | — | 在书中的顺序，从 0 开始。 |

[本表完整结构示例](resources/v2.2/table-examples/chapters.json)（固定人工数据；example指纹不作为实际恢复凭证）。

```json
{"bookId":"bk_acceptance","chapterIndex":"1","chapterName":"第一章 码头会面","charCount":28,"order":0}
```

### T05 · chapterTexts

库：`westworld_canon_{bookId}` 目标v5。索引：`chapterIndex`。

每章/切块正文一行；导入创建，P1/引文校验/原文工具读取；备份chapters/*.txt；删书删除。

| 字段路径 | 类型/枚举 | 必填、null、默认 | 结构限制 | 含义、来源与更新 |
|---|---|---|---|---|
| bookId | string | 必填；非null；无Schema默认 | — | 所属书；必须等于数据库命名中的bookId；导入重写 |
| chapterIndex | string | 必填；非null；无Schema默认 | — | 本书章节/切块标识，关联chapters.chapterIndex |
| text | string | 必填；非null；无Schema默认 | — | 本章正文。 |

[本表完整结构示例](resources/v2.2/table-examples/chapterTexts.json)（固定人工数据；example指纹不作为实际恢复凭证）。

```json
{"bookId":"bk_acceptance","chapterIndex":"1","text":"第一章 码头会面\n沈青在码头见到顾衡。顾衡将信交给沈青。"}
```

### T08 · nodes

库：`westworld_canon_{bookId}` 目标v5。索引：`id, chapterIndex, order`。

每事件一行；P1/P3/人工写，图和详情读取；删除同步线成员、空线及墓碑；删书删除。

| 字段路径 | 类型/枚举 | 必填、null、默认 | 结构限制 | 含义、来源与更新 |
|---|---|---|---|---|
| name | string | 必填；非null；无Schema默认 | — | 事件名称，客观描述，**不得是结论**。例：贾琏的资金来源异常 |
| summary | string | 必填；非null；无Schema默认 | — | 压缩摘要/代码提交说明/运行摘要；不是额外业务写指令 |
| process | string | 可省略；非null；无Schema默认 | — | 这个完整事件的详细经过：交代起因、连续行动、对话要点和结果；相关小动作合在这里，不拆成独立节点，不逐句复述。 |
| actorIds | string[] | 可省略；非null | — | 稳定行动人物编号，删除、改名和合并时由代码同步维护关联。 |
| targetCharacterIds | string[] | 可省略；非null | — | 涉及对象中的人物编号。 |
| quoteStatus | matched / unmatched / empty | 可省略；非null | — | 参考引文定位状态；未匹配或为空不阻断保存。 |
| actors | string[] | 必填；非null；无Schema默认 | — | 行动人物当前名称，与稳定人物编号同步更新。 |
| targets | string[] | 可省略；非null；无Schema默认 | — | 对象 / 承受者。例：["王熙凤"] |
| world_delta | string[] | 可省略；非null；无Schema默认 | — | 世界状态因此改变了什么。例：["贾琏手头多出大笔银子"] |
| new_facts | string[] | 可省略；非null；无Schema默认 | — | 新出现的信息。例：["贾琏近期有大笔来路不明的钱"] |
| started_actions | string[] | 可省略；非null；无Schema默认 | — | 谁开始了什么行动（尚未完成）。例：["贾琏开始变卖田产"] |
| time_text | string | 可省略；非null；无Schema默认 | — | 原文里的**明确**时间表述。可空。例：洪武十四年三月六日 / 亥时三刻 |
| time_hint | string | 可省略；非null；无Schema默认 | — | 原文里的**相对**时间表述。可空。例：次日 / 过了半月 |
| quote | string | 可省略；非null；默认空串 | — | 参考引文，用于回查；未匹配时仍可保存。 |
| offset | number | 可省略；非null；无Schema默认 | — | 该片段在**本章正文**中的字符起点（从 0 开始）。拿不准就留空。 |
| confidence | number | 必填；非null；无Schema默认 | minimum=0；maximum=1 | 抽取置信度，0 到 1 之间的小数。不确定时给低分，不要编造。 |
| id | string | 必填；非null；无Schema默认 | — | 记录主键；生成后稳定，更新不重新编号 |
| bookId | string | 必填；非null；无Schema默认 | — | 所属书；必须等于数据库命名中的bookId；导入重写 |
| chapterIndex | string | 必填；非null；无Schema默认 | — | 本书章节/切块标识，关联chapters.chapterIndex |
| chapterName | string | 必填；非null；无Schema默认 | — | 章节名。 |
| order | number | 必填；非null；无Schema默认 | — | 本章内的顺序，从 0 开始。用于按出现顺序展示与排序（比按 id 排序可靠）。 |
| createdBy | P1 / P3 / manual / P2 | 必填；非null；无Schema默认 | — | 创建来源；P2仅旧节点/线兼容，更新不覆盖创建来源 |
| eventLineIds | string[] | 可省略；非null；无Schema默认 | — | 代码维护的反向线ID；与线nodeIds同事务同步 |
| timeCoord | string | 可省略；非null；无Schema默认 | — | 虚构时间坐标。由 P2 推断，P1 阶段为空。例："003-02-15 08:00" |
| timePrecision | "explicit" 或 "inferred_hour" 或 "inferred_day" 或 "order_only" | 可省略；非null；无Schema默认 | — | 时间精度。explicit = 原文直接写的；inferred_hour = 推断到小时；inferred_day = 只能推到天；order_only = 只能定先后。 |
| canonicalId | string | 可省略；非null；无Schema默认 | — | 兼容节点去重指向；不是人物重定向；若携带必须是同书现存节点 |
| revision | integer | 必填；非null；无Schema默认 | minimum=1 | 乐观并发版本；实体/事项起始1，工作摘要起始0；每次有效修改递增 |

[本表完整结构示例](resources/v2.2/table-examples/nodes.json)（固定人工数据；example指纹不作为实际恢复凭证）。

```json
{"id":"C1-N001","bookId":"bk_acceptance","chapterIndex":"1","chapterName":"第一章 码头会面","order":0,"name":"码头会面","summary":"沈青在码头见到顾衡。","process":"沈青在码头见到顾衡。","quote":"沈青在码头见到顾衡。","actors":["沈青","顾衡"],"confidence":1,"createdBy":"P1","eventLineIds":["L01"],"revision":1}
```

### T09 · eventLines

库：`westworld_canon_{bookId}` 目标v5。索引：`id, lineStatus`。

每事件线一行；P3/人工写，图读取；成员与T08.eventLineIds同事务维护；删空线写墓碑。

| 字段路径 | 类型/枚举 | 必填、null、默认 | 结构限制 | 含义、来源与更新 |
|---|---|---|---|---|
| id | string | 必填；非null；无Schema默认 | — | 记录主键；生成后稳定，更新不重新编号 |
| bookId | string | 必填；非null；无Schema默认 | — | 所属书；必须等于数据库命名中的bookId；导入重写 |
| title | string | 必填；非null；无Schema默认 | — | 书名或会话/事件线标题；按所属表输入来源生成 |
| nodeIds | string[] | 必填；非null；无Schema默认 | — | 同书节点ID集合；事件线非空，事项可空；代码核引用并排序去重 |
| chapters | string[] | 必填；非null；无Schema默认 | — | 涉及章节（代码生成） |
| timeRange | string[] | 可省略；非null；无Schema默认 | — | 虚构时间区间 [最早, 最晚]（代码生成） |
| cause | string | 必填；非null；无Schema默认 | — | 起因 |
| process | string | 必填；非null；无Schema默认 | — | 经过 |
| result | string | 必填；非null；无Schema默认 | — | 结果 |
| lineStatus | "open" 或 "closed" | 必填；非null；无Schema默认 | — | 这条线在逻辑上是否已经讲完。已结束的线之后若发现新节点，允许重新打开。 |
| updatedAt | string | 必填；非null；无Schema默认 | — | 应用提交时的ISO 8601时间；不替代revision并发检查 |
| revision | integer | 必填；非null；无Schema默认 | minimum=1 | 乐观并发版本；实体/事项起始1，工作摘要起始0；每次有效修改递增 |
| createdBy | P3 / manual / P2 | 必填；非null；无Schema默认 | — | 创建来源；P2仅旧节点/线兼容，更新不覆盖创建来源 |

[本表完整结构示例](resources/v2.2/table-examples/eventLines.json)（固定人工数据；example指纹不作为实际恢复凭证）。

```json
{"id":"L01","bookId":"bk_acceptance","title":"书信交付","nodeIds":["C1-N001"],"chapters":["1"],"cause":"双方会面","process":"顾衡交信，沈青离开","result":"书信交付完成","lineStatus":"closed","updatedAt":"2026-10-21T00:00:00.000Z","revision":1,"createdBy":"P3"}
```

### T10 · characters

库：`westworld_canon_{bookId}` 目标v5。索引：`id, chapterIndex, name`。

每当前人物一行；P1/人工创建，P2/人工更新合并；合并删除成员并写T19；图按称呼派生人物引用。

| 字段路径 | 类型/枚举 | 必填、null、默认 | 结构限制 | 含义、来源与更新 |
|---|---|---|---|---|
| name | string | 必填；非null；无Schema默认 | minLength=1 | 本章主要使用的称呼。可能是别名，例：琏二爷。 |
| aliases_mentioned | string[] | 可省略；非null；无Schema默认 | — | P1原始提取称呼；保留来源，读取查询时与aliases合并 |
| identity | string | 可省略；非null；无Schema默认 | — | 身份 / 职务 / 归属。例：荣国府长孙。原文没写就留空。 |
| profile | object | 可省略；非null；无Schema默认 | — | 固定story_editor；P2临时Agent不写故事会话 |
| profile.age | number | 可省略；非null；无Schema默认 | — | 原文明确写出的精确年龄。范围、约数或未知年龄不填此字段，不取平均值、不猜测。 |
| profile.ageText | string | 可省略；非null；无Schema默认 | — | 原文的年龄描述，逐字保留，如“十四五岁”“年过三旬”；不知道则省略或填 null。 |
| profile.gender | string | 可省略；非null；无Schema默认 | — | 原文写明的性别，不知道则省略或填 null。 |
| appearance | string | 可省略；非null；无Schema默认 | — | 外貌。**仅当原文写到**，不要推断。 |
| personality | string | 可省略；非null；无Schema默认 | — | 性格。**必须能从原文找到依据**，不要凭印象概括。多条用「；」分隔。 |
| background | string | 可省略；非null；无Schema默认 | — | 背景 / 来历。仅当原文写到。 |
| relations | object[] | 可省略；非null；无Schema默认 | — | 本章观察到的关系。 |
| relations[].target | string | 必填；非null；无Schema默认 | — | 关系指向的人。用本章原文的称呼，还没归并。 |
| relations[].relation_type | string | 必填；非null；无Schema默认 | — | 关系的英文类型标记，小写下划线风格。例：spouse / parent_child / mentor / friendship |
| relations[].relation_label | string | 可省略；非null；无Schema默认 | — | 关系的中文说法，用原文里的词。例：夫妻 / 父子 / 知己。原文没写就留空。 |
| relations[].direction | "bidirectional" 或 "directed" | 可省略；非null；无Schema默认 | — | 关系方向。bidirectional = 对称（如夫妻、朋友）；directed = 有向（如父子、师徒）。 |
| confidence | number | 必填；非null；无Schema默认 | minimum=0；maximum=1 | 抽取置信度，0 到 1 之间的小数。不确定时给低分，不要编造。 |
| frequency | object | 可省略；非null；无Schema默认 | — | 按最终主名在原文计数的派生频次；手工主名或合并后重算 |
| frequency.chapters | integer | 必填；非null；无Schema默认 | — | 至少出现一次最终主名的原章数；切块合为原章 |
| frequency.mentions | integer | 必填；非null；无Schema默认 | — | 最终主名累计命中次数；同名未合并无法唯一归属时不分配命中 |
| frequency.scopeChapters | integer | 必填；非null；无Schema默认 | — | 参与频次计算的原章总数 |
| frequency.percentile | number | 必填；非null；无Schema默认 | — | (higher+(same-1)/2)/max(1,实体数-1)；按chapters再mentions排名，higher为更高数量，same含自身；越小越重要 |
| sourceChapters | string[] | 可省略；非null；无Schema默认 | — | 实体来源章/块标识并集；按章节顺序去重；合并保留全部来源 |
| mergeNotes | string[] | 可省略；非null；无Schema默认 | — | 融合冲突/待核说明；不代表未生效状态 |
| mergeFacts | object[] | 可省略；非null；无Schema默认 | — | 按字段保存的原始事实底稿；整编仅替换展示，不删除底稿 |
| mergeFacts[].id | string | 必填；非null；无Schema默认 | — | 实体内稳定事实ID；用于完整覆盖校验 |
| mergeFacts[].field | string | 必填；非null；无Schema默认 | — | 人物为identity/appearance/personality/background；地点固定description |
| mergeFacts[].text | string | 必填；非null；无Schema默认 | — | 该条事实文本；不可用整编后的概括覆盖 |
| mergeFacts[].chapters | string[] | 必填；非null；无Schema默认 | — | 该事实依据章标识；字段名是chapters，不是sourceChapters |
| optimizedFactIds | string[] | 可省略；非null；无Schema默认 | — | 最近整编已覆盖事实ID集合；相关人工编辑后清除 |
| optimizationFingerprint | string | 可省略；非null；无Schema默认 | — | 策略版本、称呼、事实、冲突的缓存指纹；相等才可跳过整编 |
| roleWeightSource | "frequency" 或 "manual" | 可省略；非null；无Schema默认 | — | manual表示人工层级优先；frequency表示可自动更新 |
| id | string | 必填；非null；无Schema默认 | — | 记录主键；生成后稳定，更新不重新编号 |
| bookId | string | 必填；非null；无Schema默认 | — | 所属书；必须等于数据库命名中的bookId；导入重写 |
| chapterIndex | string | 可省略；非null；无Schema默认 | — | 本书章节/切块标识，关联chapters.chapterIndex |
| chapterName | string | 可省略；非null；无Schema默认 | — | 导入预处理后的章节名。 |
| aliases | string[] | 可省略；非null；无Schema默认 | — | 当前累计别名；合并成员主名和别名，去重并排除当前主名 |
| roleWeight | "主要人物" 或 "重要配角" 或 "NPC" 或 "路人" | 可省略；非null；无Schema默认 | — | 出场频次分位数计算的默认层级，可由用户手动覆盖。 |
| updatedAt | string | 可省略；非null；无Schema默认 | — | 应用提交时的ISO 8601时间；不替代revision并发检查 |
| revision | integer | 必填；非null；无Schema默认 | minimum=1 | 乐观并发版本；实体/事项起始1，工作摘要起始0；每次有效修改递增 |
| createdBy | P1 / manual | 必填；非null；无Schema默认 | — | 创建来源；P2仅旧节点/线兼容，更新不覆盖创建来源 |
| nameSource | extracted / automatic / manual | 可省略；非null；无Schema默认 | — | extracted提取名、automatic整理名、manual人工名；人工优先 |
| manualKeep | boolean | 可省略；非null；false | — | 显式保护合并目标；缺省false；多个受保护目标时拒绝自动合并 |
| manualSourceNote | string | 可省略；非null；无Schema默认 | — | 人工无章节来源人物/地点的说明；该情况下非空必填 |
| speechStyleSample | string | 可省略；非null；无Schema默认 | — | 原文语言风格例句；从提取DTO speech_style_sample改键 |

[本表完整结构示例](resources/v2.2/table-examples/characters.json)（固定人工数据；example指纹不作为实际恢复凭证）。

```json
{"id":"C1-P001","bookId":"bk_acceptance","chapterIndex":"1","chapterName":"第一章 码头会面","name":"沈青","confidence":1,"identity":"人工验证样本人物","roleWeight":"NPC","aliases":[],"revision":1,"createdBy":"P1","nameSource":"extracted","manualKeep":false,"sourceChapters":["1"]}
```

### T11 · locations

库：`westworld_canon_{bookId}` 目标v5。索引：`id, chapterIndex, name`。

每当前地点一行；P1/人工创建，P2/人工更新合并；整体和内部区域不能因包含关系自动合并。

| 字段路径 | 类型/枚举 | 必填、null、默认 | 结构限制 | 含义、来源与更新 |
|---|---|---|---|---|
| name | string | 必填；非null；无Schema默认 | minLength=1 | 地点名称，用原文的叫法。例：荣国府 / 县一中。 |
| description | string | 可省略；非null；无Schema默认 | — | 一句话描述。原文没写就留空。 |
| confidence | number | 必填；非null；无Schema默认 | minimum=0；maximum=1 | 抽取置信度，0 到 1 之间的小数。不确定时给低分，不要编造。 |
| frequency | object | 可省略；非null；无Schema默认 | — | 按最终主名在原文计数的派生频次；手工主名或合并后重算 |
| frequency.chapters | integer | 必填；非null；无Schema默认 | — | 至少出现一次最终主名的原章数；切块合为原章 |
| frequency.mentions | integer | 必填；非null；无Schema默认 | — | 最终主名累计命中次数；同名未合并无法唯一归属时不分配命中 |
| frequency.scopeChapters | integer | 必填；非null；无Schema默认 | — | 参与频次计算的原章总数 |
| frequency.percentile | number | 必填；非null；无Schema默认 | — | (higher+(same-1)/2)/max(1,实体数-1)；按chapters再mentions排名，higher为更高数量，same含自身；越小越重要 |
| sourceChapters | string[] | 可省略；非null；无Schema默认 | — | 实体来源章/块标识并集；按章节顺序去重；合并保留全部来源 |
| mergeNotes | string[] | 可省略；非null；无Schema默认 | — | 融合冲突/待核说明；不代表未生效状态 |
| aliases | string[] | 可省略；非null；无Schema默认 | — | 当前累计别名；合并成员主名和别名，去重并排除当前主名 |
| id | string | 必填；非null；无Schema默认 | — | 记录主键；生成后稳定，更新不重新编号 |
| bookId | string | 必填；非null；无Schema默认 | — | 所属书；必须等于数据库命名中的bookId；导入重写 |
| chapterIndex | string | 可省略；非null；无Schema默认 | — | 本书章节/切块标识，关联chapters.chapterIndex |
| chapterName | string | 可省略；非null；无Schema默认 | — | 章节名。 |
| updatedAt | string | 可省略；非null；无Schema默认 | — | 应用提交时的ISO 8601时间；不替代revision并发检查 |
| revision | integer | 必填；非null；无Schema默认 | minimum=1 | 乐观并发版本；实体/事项起始1，工作摘要起始0；每次有效修改递增 |
| createdBy | P1 / manual | 必填；非null；无Schema默认 | — | 创建来源；P2仅旧节点/线兼容，更新不覆盖创建来源 |
| nameSource | extracted / automatic / manual | 可省略；非null；无Schema默认 | — | extracted提取名、automatic整理名、manual人工名；人工优先 |
| manualKeep | boolean | 可省略；非null；false | — | 显式保护合并目标；缺省false；多个受保护目标时拒绝自动合并 |
| manualSourceNote | string | 可省略；非null；无Schema默认 | — | 人工无章节来源人物/地点的说明；该情况下非空必填 |
| mergeFacts | object[] | 可省略；非null；无Schema默认 | — | 按字段保存的原始事实底稿；整编仅替换展示，不删除底稿 |
| mergeFacts[].id | string | 必填；非null；无Schema默认 | — | 实体内稳定事实ID；用于完整覆盖校验 |
| mergeFacts[].field | "description" | 必填；非null；无Schema默认 | — | 人物为identity/appearance/personality/background；地点固定description |
| mergeFacts[].text | string | 必填；非null；无Schema默认 | — | 该条事实文本；不可用整编后的概括覆盖 |
| mergeFacts[].chapters | string[] | 必填；非null；无Schema默认 | — | 该事实依据章标识；字段名是chapters，不是sourceChapters |
| optimizedFactIds | string[] | 可省略；非null；无Schema默认 | — | 最近整编已覆盖事实ID集合；相关人工编辑后清除 |
| optimizationFingerprint | string | 可省略；非null；无Schema默认 | — | 策略版本、称呼、事实、冲突的缓存指纹；相等才可跳过整编 |

[本表完整结构示例](resources/v2.2/table-examples/locations.json)（固定人工数据；example指纹不作为实际恢复凭证）。

```json
{"id":"C1-L001","bookId":"bk_acceptance","chapterIndex":"1","chapterName":"第一章 码头会面","name":"码头","confidence":1,"description":"人工验证样本地点","aliases":[],"revision":1,"createdBy":"P1","nameSource":"extracted","manualKeep":false,"sourceChapters":["1"]}
```

### T12 · compileProgress

库：`westworld_canon_{bookId}` 目标v5。索引：`stage`。

每P1/P2/P3各一行；编排器逐步提交，UI读进度；T18才是P1成功凭证；不作为资产生效开关。

| 字段路径 | 类型/枚举 | 必填、null、默认 | 结构限制 | 含义、来源与更新 |
|---|---|---|---|---|
| bookId | string | 必填；非null；无Schema默认 | — | 所属书；必须等于数据库命名中的bookId；导入重写 |
| stage | "P1" 或 "P2" 或 "P3" | 必填；非null；无Schema默认 | — | 阶段；新记忆/检查点固定P3，P2只允许旧历史；进度为P1/P2/P3 |
| status | idle / running / paused / cancelling / cancelled / failed / degraded / completed | 必填；非null；无Schema默认 | — | 本表状态枚举；不得把事项status与validity混为一谈 |
| totalChapters | number | 必填；非null；无Schema默认 | — | 本书持久章/块数；窗口原章数另按窗口规则计算 |
| completedChapters | string[] | 必填；非null；无Schema默认 | — | P1两个子步骤都有成功凭证的章/块标识 |
| failedChapters | string[] | 必填；非null；无Schema默认 | — | 重试后仍失败的章/块标识 |
| lastWindowIndex | number | 可省略；非null；无Schema默认 | — | 旧P2窗口位置；目标P3以检查点和coverage为准 |
| planKey | string | 可省略；非null；无Schema默认 | — | 计划版本/窗口/策略签名；不匹配则相关覆盖过期 |
| editorSessionId | string | 可省略；非null；无Schema默认 | — | T16故事会话引用；P2目标运行不设置 |
| testScope | string[] | 可省略；非null；无Schema默认 | — | 旧样本测试范围；保留历史，不解锁目标正式流程 |
| partialChapters | object | 可省略；非null；无Schema默认 | — | 动态键为章节标识，值为尚缺成功凭证的子步骤数组 |
| partialChapters.{动态键} | "worldAssets" 或 "narrativeAssets"[] | 父对象存在时；非null | — | 动态键为章节标识，值为尚缺成功凭证的子步骤数组 |
| updatedAt | string | 必填；非null；无Schema默认 | — | 应用提交时的ISO 8601时间；不替代revision并发检查 |
| scope | "fullBook" | 可省略；非null；无Schema默认 | — | 全书正式运行固定fullBook |
| planVersion | "2.2" | 可省略；非null；无Schema默认 | — | 目标计划版本2.2 |
| runId | string | 可省略；非null；无Schema默认 | — | 关联T20 run行；恢复同一运行保持不变 |
| phase | string | 可省略；非null；无Schema默认 | — | P2=mechanical/ai_identity/optimize/report；P3=window_link/global_review；旧link/review仅历史 |
| unit | chapter / step / window / item | 可省略；非null；无Schema默认 | — | 当前进度计量单位；chapter/step/window/item |
| validity | current / stale | 可省略；非null；无Schema默认 | — | current当前有效，stale依据已变；不控制资产使用 |
| dependencyFingerprint | string | 可省略；非null；无Schema默认 | — | 当前进度所依赖输入的确定性指纹 |
| coverage | object | 可省略；非null；无Schema默认 | — | 当前运行覆盖清单；阶段结束重新枚举，不能仅由模型自报完成 |
| coverage.total | integer | 必填；非null；无Schema默认 | minimum=0 | 当前计划项总数 |
| coverage.checked | integer | 必填；非null；无Schema默认 | minimum=0 | 依据仍有效的已核查项数 |
| coverage.pendingIds | string[] | 必填；非null；无Schema默认 | — | 尚未核查的稳定工作项ID；清空前不能completed |
| coverage.cursor | string | 可省略；非null；无Schema默认 | — | 当前阶段的续扫位置；无下一页时省略 |

[本表完整结构示例](resources/v2.2/table-examples/compileProgress.json)（固定人工数据；example指纹不作为实际恢复凭证）。

```json
{"bookId":"bk_acceptance","stage":"P1","status":"completed","totalChapters":1,"completedChapters":["1"],"failedChapters":[],"updatedAt":"2000-01-01T00:00:00.000Z","scope":"fullBook","planVersion":"2.2","runId":"run_example","phase":"narrativeAssets","unit":"chapter","validity":"current","coverage":{"total":2,"checked":2,"pendingIds":[]},"dependencyFingerprint":"example-not-a-valid-runtime-fingerprint"}
```

### T13 · storyEditorMemory

库：`westworld_canon_{bookId}` 目标v5。索引：`id, sessionId`。

每会话最新摘要；P3提交覆盖摘要并递增revision；工具读取；压缩文本不代替本表。

| 字段路径 | 类型/枚举 | 必填、null、默认 | 结构限制 | 含义、来源与更新 |
|---|---|---|---|---|
| id | string | 必填；非null；无Schema默认 | — | 记录主键；生成后稳定，更新不重新编号 |
| bookId | string | 必填；非null；无Schema默认 | — | 所属书；必须等于数据库命名中的bookId；导入重写 |
| sessionId | string | 可省略；非null；无Schema默认 | — | 同书T16逻辑会话ID；新数据必须写；空串/省略只兼容旧历史 |
| revision | integer | 必填；非null；无Schema默认 | minimum=0 | 乐观并发版本；实体/事项起始1，工作摘要起始0；每次有效修改递增 |
| workingSummary | string | 必填；非null；无Schema默认 | maxLength=2000 | P3长期工作摘要；模型提供，经长度和业务校验后替换，不当作原文事实 |
| dataFingerprint | string | 必填；非null；无Schema默认 | — | 摘要依据指纹；空记忆返回空串；按实际相关依赖检查变化 |
| updatedAt | string | 必填；非null；无Schema默认 | — | 应用提交时的ISO 8601时间；不替代revision并发检查 |

[本表完整结构示例](resources/v2.2/table-examples/storyEditorMemory.json)（固定人工数据；example指纹不作为实际恢复凭证）。

```json
{"id":"session_example","bookId":"bk_acceptance","sessionId":"session_example","revision":1,"workingSummary":"已核对第一章。","dataFingerprint":"example-fingerprint","updatedAt":"2000-01-01T00:00:00.000Z"}
```

### T14 · storyEditorNotes

库：`westworld_canon_{bookId}` 目标v5。索引：`id, &[sessionId+key], sessionId, kind, status, updatedAt`。

每会话主题一行；P3按稳定key创建/更新，工具/UI读取；已解决仍保留；新旧会话隔离。

| 字段路径 | 类型/枚举 | 必填、null、默认 | 结构限制 | 含义、来源与更新 |
|---|---|---|---|---|
| key | string | 必填；非null；无Schema默认 | minLength=1；maxLength=120 | 稳定业务键；各表构造方式见下文 |
| kind | "decision" 或 "review" | 必填；非null；无Schema默认 | — | 按表区分事项类型、会话类型或资产类型；取值以本行枚举为准 |
| status | "active" 或 "resolved" | 必填；非null；无Schema默认 | — | 本表状态枚举；不得把事项status与validity混为一谈 |
| statement | string | 必填；非null；无Schema默认 | minLength=1；maxLength=1000 | 事项判断或复核结论；同一key更新，不保存长篇推理 |
| nodeIds | string[] | 必填；非null；无Schema默认 | maxItems=20 | 同书节点ID集合；事件线非空，事项可空；代码核引用并排序去重 |
| lineIds | string[] | 必填；非null；无Schema默认 | maxItems=20 | 同书事件线ID；工作事项可为空 |
| evidence | object[] | 必填；非null；无Schema默认 | maxItems=5 | 逐字引文依据；无节点/线引用时至少一条有效依据 |
| evidence[].chapterIndex | string | 必填；非null；无Schema默认 | — | 本书章节/切块标识，关联chapters.chapterIndex |
| evidence[].quote | string | 必填；非null；无Schema默认 | minLength=1；maxLength=1000 | 该章节中连续存在的逐字原句，不要改写、拼接或增加标点。 |
| id | string | 必填；非null；无Schema默认 | — | 记录主键；生成后稳定，更新不重新编号 |
| bookId | string | 必填；非null；无Schema默认 | — | 所属书；必须等于数据库命名中的bookId；导入重写 |
| revision | integer | 必填；非null；无Schema默认 | minimum=1 | 本次工作摘要修订号=提交前memory.revision+1；新/更新事项都赋本批修订号，不是各笔记独立加1 |
| sessionId | string | 可省略；非null；无Schema默认 | — | 同书T16逻辑会话ID；新数据必须写；空串/省略只兼容旧历史 |
| stage | P3 / P2 | 必填；非null；无Schema默认 | — | 阶段；新记忆/检查点固定P3，P2只允许旧历史；进度为P1/P2/P3 |
| basisFingerprint | string | 必填；非null；无Schema默认 | — | 事项所引用节点/线/原文与实际世界依赖的指纹 |
| createdAt | string | 必填；非null；无Schema默认 | — | 应用创建时的ISO 8601时间，后续不改 |
| updatedAt | string | 必填；非null；无Schema默认 | — | 应用提交时的ISO 8601时间；不替代revision并发检查 |
| worldDependencies | object[] | 可省略；非null；无Schema默认 | — | 实际读过的人物/地点版本，不扫描未读全世界 |
| worldDependencies[].kind | character / location | 必填；非null；无Schema默认 | — | 按表区分事项类型、会话类型或资产类型；取值以本行枚举为准 |
| worldDependencies[].id | string | 必填；非null；无Schema默认 | — | 记录主键；生成后稳定，更新不重新编号 |
| worldDependencies[].resolvedId | string | 必填；非null；无Schema默认 | — | 当时解析出的最终当前ID |
| worldDependencies[].revision | integer | 必填；非null；无Schema默认 | minimum=1 | 乐观并发版本；实体/事项起始1，工作摘要起始0；每次有效修改递增 |
| queryDependencies | object[] | 可省略；非null；无Schema默认 | — | 实际工具查询参数及结果集合指纹；包含空结果 |
| queryDependencies[].tool | string | 必填；非null；无Schema默认 | — | 只读工具名 |
| queryDependencies[].args | object | 必填；非null；无Schema默认 | — | 经过该工具参数Schema校验的完整参数；不含bookId或凭据 |
| queryDependencies[].resultFingerprint | string | 必填；非null；无Schema默认 | — | 返回集合/顺序/所依赖版本的指纹；空结果也记录 |
| window | object | 可省略；非null；无Schema默认 | — | P3原章零基半开窗口；全书复核可省略 |
| window.start | integer | 必填；非null；无Schema默认 | minimum=0 | 原章零基包含起点 |
| window.end | integer | 必填；非null；无Schema默认 | minimum=0 | 原章零基排他终点 |
| phase | window_link / global_review / link / review | 可省略；非null；无Schema默认 | — | P2=mechanical/ai_identity/optimize/report；P3=window_link/global_review；旧link/review仅历史 |

[本表完整结构示例](resources/v2.2/table-examples/storyEditorNotes.json)（固定人工数据；example指纹不作为实际恢复凭证）。

```json
{"id":"SN000001","bookId":"bk_acceptance","sessionId":"session_example","revision":1,"stage":"P3","key":"会面","kind":"decision","status":"active","statement":"会面属于书信交付线。","nodeIds":["C1-N001"],"lineIds":["L01"],"evidence":[],"basisFingerprint":"example-fingerprint","createdAt":"2000-01-01T00:00:00.000Z","updatedAt":"2000-01-01T00:00:00.000Z","phase":"window_link","window":{"start":0,"end":1},"worldDependencies":[],"queryDependencies":[]}
```

### T15 · storyEditorCheckpoints

库：`westworld_canon_{bookId}` 目标v5。索引：`id, sessionId, stage, phase, status, updatedAt`。

每会话阶段范围一个恢复点；P3代码写，恢复核验实际依赖；过期记录不能当完成。

| 字段路径 | 类型/枚举 | 必填、null、默认 | 结构限制 | 含义、来源与更新 |
|---|---|---|---|---|
| id | string | 必填；非null；无Schema默认 | — | 记录主键；生成后稳定，更新不重新编号 |
| bookId | string | 必填；非null；无Schema默认 | — | 所属书；必须等于数据库命名中的bookId；导入重写 |
| stage | P3 / P2 | 必填；非null；无Schema默认 | — | 阶段；新记忆/检查点固定P3，P2只允许旧历史；进度为P1/P2/P3 |
| sessionId | string | 可省略；非null；无Schema默认 | — | 同书T16逻辑会话ID；新数据必须写；空串/省略只兼容旧历史 |
| phase | window_link / global_review / link / review | 必填；非null；无Schema默认 | — | P2=mechanical/ai_identity/optimize/report；P3=window_link/global_review；旧link/review仅历史 |
| scopeIds | string[] | 必填；非null；无Schema默认 | — | 本检查批覆盖的节点/线/工作项标识，不代表全书都已检查 |
| sourceFingerprint | string | 必填；非null；无Schema默认 | — | 检查点输入/输出有效依据指纹；不是全世界资产全量指纹 |
| status | "completed" 或 "failed" 或 "cancelled" | 必填；非null；无Schema默认 | — | 本表状态枚举；不得把事项status与validity混为一谈 |
| memberships | object | 必填；非null；无Schema默认 | — | 动态键为节点ID，值为该点所属线ID数组；用于恢复检查 |
| memberships.{动态键} | string[] | 父对象存在时；非null | — | 动态键为节点ID，值为该点所属线ID数组；用于恢复检查 |
| updatedAt | string | 必填；非null；无Schema默认 | — | 应用提交时的ISO 8601时间；不替代revision并发检查 |
| worldDependencies | object[] | 可省略；非null；无Schema默认 | — | 实际读过的人物/地点版本，不扫描未读全世界 |
| worldDependencies[].kind | character / location | 必填；非null；无Schema默认 | — | 按表区分事项类型、会话类型或资产类型；取值以本行枚举为准 |
| worldDependencies[].id | string | 必填；非null；无Schema默认 | — | 记录主键；生成后稳定，更新不重新编号 |
| worldDependencies[].resolvedId | string | 必填；非null；无Schema默认 | — | 当时解析出的最终当前ID |
| worldDependencies[].revision | integer | 必填；非null；无Schema默认 | minimum=1 | 乐观并发版本；实体/事项起始1，工作摘要起始0；每次有效修改递增 |
| queryDependencies | object[] | 可省略；非null；无Schema默认 | — | 实际工具查询参数及结果集合指纹；包含空结果 |
| queryDependencies[].tool | string | 必填；非null；无Schema默认 | — | 只读工具名 |
| queryDependencies[].args | object | 必填；非null；无Schema默认 | — | 经过该工具参数Schema校验的完整参数；不含bookId或凭据 |
| queryDependencies[].resultFingerprint | string | 必填；非null；无Schema默认 | — | 返回集合/顺序/所依赖版本的指纹；空结果也记录 |
| window | object | 可省略；非null；无Schema默认 | — | P3原章零基半开窗口；全书复核可省略 |
| window.start | integer | 必填；非null；无Schema默认 | minimum=0 | 原章零基包含起点 |
| window.end | integer | 必填；非null；无Schema默认 | minimum=0 | 原章零基排他终点 |

[本表完整结构示例](resources/v2.2/table-examples/storyEditorCheckpoints.json)（固定人工数据；example指纹不作为实际恢复凭证）。

```json
{"id":"example-checkpoint-hash","bookId":"bk_acceptance","sessionId":"session_example","stage":"P3","phase":"window_link","scopeIds":["C1-N001"],"sourceFingerprint":"example-fingerprint","status":"completed","memberships":{"C1-N001":["L01"]},"updatedAt":"2000-01-01T00:00:00.000Z","window":{"start":0,"end":1},"worldDependencies":[],"queryDependencies":[]}
```

### T16 · storySessions

库：`westworld_canon_{bookId}` 目标v5。索引：`id, status, createdAt, parentSessionId`。

每逻辑故事会话一行；应用创建，原书继续/重查复用active；旧archived只读；追加消息时更新叶子和序号。

| 字段路径 | 类型/枚举 | 必填、null、默认 | 结构限制 | 含义、来源与更新 |
|---|---|---|---|---|
| id | string | 必填；非null；无Schema默认 | — | 记录主键；生成后稳定，更新不重新编号 |
| bookId | string | 必填；非null；无Schema默认 | — | 所属书；必须等于数据库命名中的bookId；导入重写 |
| profile | "story_editor" | 必填；非null；无Schema默认 | — | 固定story_editor；P2临时Agent不写故事会话 |
| kind | "initial" 或 "review" | 必填；非null；无Schema默认 | — | 按表区分事项类型、会话类型或资产类型；取值以本行枚举为准 |
| title | string | 必填；非null；无Schema默认 | — | 书名或会话/事件线标题；按所属表输入来源生成 |
| status | "active" 或 "archived" | 必填；非null；无Schema默认 | — | 本表状态枚举；不得把事项status与validity混为一谈 |
| parentSessionId | string | 可省略；非null；无Schema默认 | — | 旧复核会话的父会话；目标继续/重查不新增会话 |
| leafId | string | 可省略；非null；无Schema默认 | — | 当前追加链末尾T17.id；空会话省略 |
| nextOrdinal | integer | 必填；非null；无Schema默认 | minimum=0 | 下一条消息的序号；初始0，与追加条目同事务加1 |
| createdAt | string | 必填；非null；无Schema默认 | — | 应用创建时的ISO 8601时间，后续不改 |
| updatedAt | string | 必填；非null；无Schema默认 | — | 应用提交时的ISO 8601时间；不替代revision并发检查 |
| leaseOwner | string | 可省略；非null；无Schema默认 | — | 持有会话的运行实例令牌；接管时更换，不是用户ID |
| leaseUntil | number | 可省略；非null；无Schema默认 | — | 会话租约到期Unix毫秒；导出清除 |

[本表完整结构示例](resources/v2.2/table-examples/storySessions.json)（固定人工数据；example指纹不作为实际恢复凭证）。

```json
{"id":"session_example","bookId":"bk_acceptance","profile":"story_editor","kind":"initial","title":"初次故事编辑","status":"active","leafId":"entry_example","nextOrdinal":1,"createdAt":"2000-01-01T00:00:00.000Z","updatedAt":"2000-01-01T00:00:00.000Z"}
```

### T17 · storySessionEntries

库：`westworld_canon_{bookId}` 目标v5。索引：`id, &[sessionId+ordinal], sessionId, parentId, type`。

每原始消息/压缩/省略标记/代码提交一行；只追加，Pi事件落库；按ordinal读取，压缩不删除原始记录。

| 字段路径 | 类型/枚举 | 必填、null、默认 | 结构限制 | 含义、来源与更新 |
|---|---|---|---|---|
| [type=message]::id | string | 必填；非null；无Schema默认 | — | 记录主键；生成后稳定，更新不重新编号 |
| [type=message]::sessionId | string | 必填；非null；无Schema默认 | — | 同书T16逻辑会话ID；新数据必须写；空串/省略只兼容旧历史 |
| [type=message]::bookId | string | 必填；非null；无Schema默认 | — | 所属书；必须等于数据库命名中的bookId；导入重写 |
| [type=message]::ordinal | integer | 必填；非null；无Schema默认 | minimum=0 | 会话内从0递增序号；复合唯一索引避免重复 |
| [type=message]::parentId | string 或 null | 必填；可null；无Schema默认 | — | 上一条条目ID；首条为null |
| [type=message]::createdAt | string | 必填；非null；无Schema默认 | — | 应用创建时的ISO 8601时间，后续不改 |
| [type=message]::type | "message" | 必填；非null；无Schema默认 | — | 判别字段；只允许该联合分支对应字段 |
| [type=message]::message | object | 必填；非null；无Schema默认 | — | 原始Pi消息对象；保持工具调用ID、用量、推理与协议扩展字段 |
| [type=message]::message.role | "system" 或 "user" 或 "assistant" 或 "toolResult" | 必填；非null；无Schema默认 | — | Pi消息角色system/user/assistant/toolResult |
| [type=message]::message.content | string 或 JSON值[] | 可省略；非null；无Schema默认 | — | Pi原始文本或内容块数组；不丢工具/推理字段 |
| [type=message]::message.timestamp | number | 可省略；非null；无Schema默认 | — | Pi时间戳Unix毫秒 |
| [type=compaction]::id | string | 必填；非null；无Schema默认 | — | 记录主键；生成后稳定，更新不重新编号 |
| [type=compaction]::sessionId | string | 必填；非null；无Schema默认 | — | 同书T16逻辑会话ID；新数据必须写；空串/省略只兼容旧历史 |
| [type=compaction]::bookId | string | 必填；非null；无Schema默认 | — | 所属书；必须等于数据库命名中的bookId；导入重写 |
| [type=compaction]::ordinal | integer | 必填；非null；无Schema默认 | minimum=0 | 会话内从0递增序号；复合唯一索引避免重复 |
| [type=compaction]::parentId | string 或 null | 必填；可null；无Schema默认 | — | 上一条条目ID；首条为null |
| [type=compaction]::createdAt | string | 必填；非null；无Schema默认 | — | 应用创建时的ISO 8601时间，后续不改 |
| [type=compaction]::type | "compaction" | 必填；非null；无Schema默认 | — | 判别字段；只允许该联合分支对应字段 |
| [type=compaction]::summary | string | 必填；非null；无Schema默认 | minLength=1；maxLength=64000 | 压缩摘要/代码提交说明/运行摘要；不是额外业务写指令 |
| [type=compaction]::firstKeptEntryId | string | 必填；非null；无Schema默认 | — | 压缩后保留的第一条原始条目ID |
| [type=compaction]::tokensBefore | number | 必填；非null；无Schema默认 | — | 压缩前上下文估算tokens |
| [type=compaction]::tokensAfter | number | 必填；非null；无Schema默认 | — | 压缩后上下文估算tokens |
| [type=compaction]::systemMessage | object | 可省略；非null；无Schema默认 | — | 压缩时有效Pi系统消息快照，包含工具声明变化 |
| [type=compaction]::systemMessage.role | "system" 或 "user" 或 "assistant" 或 "toolResult" | 必填；非null；无Schema默认 | — | Pi消息角色system/user/assistant/toolResult |
| [type=compaction]::systemMessage.content | string 或 JSON值[] | 可省略；非null；无Schema默认 | — | Pi原始文本或内容块数组；不丢工具/推理字段 |
| [type=compaction]::systemMessage.timestamp | number | 可省略；非null；无Schema默认 | — | Pi时间戳Unix毫秒 |
| [type=compaction]::usage | object | 可省略；非null；无Schema默认 | — | Pi响应累计用量；精确定义见Usage |
| [type=compaction]::usage.input | number | 必填；非null；无Schema默认 | — | 输入tokens |
| [type=compaction]::usage.output | number | 必填；非null；无Schema默认 | — | 输出tokens |
| [type=compaction]::usage.totalTokens | number | 必填；非null；无Schema默认 | — | Pi报告总tokens；不自行忽略缓存重算 |
| [type=compaction]::usage.cost | number | 必填；非null；无Schema默认 | — | Pi费用；累计所有实际响应，未知单价不能伪称真实账单 |
| [type=omit]::id | string | 必填；非null；无Schema默认 | — | 记录主键；生成后稳定，更新不重新编号 |
| [type=omit]::sessionId | string | 必填；非null；无Schema默认 | — | 同书T16逻辑会话ID；新数据必须写；空串/省略只兼容旧历史 |
| [type=omit]::bookId | string | 必填；非null；无Schema默认 | — | 所属书；必须等于数据库命名中的bookId；导入重写 |
| [type=omit]::ordinal | integer | 必填；非null；无Schema默认 | minimum=0 | 会话内从0递增序号；复合唯一索引避免重复 |
| [type=omit]::parentId | string 或 null | 必填；可null；无Schema默认 | — | 上一条条目ID；首条为null |
| [type=omit]::createdAt | string | 必填；非null；无Schema默认 | — | 应用创建时的ISO 8601时间，后续不改 |
| [type=omit]::type | "omit" | 必填；非null；无Schema默认 | — | 判别字段；只允许该联合分支对应字段 |
| [type=omit]::omittedEntryIds | string[] | 必填；非null；无Schema默认 | — | 仅在投影中省略的原始条目ID，原表不删除 |
| [type=omit]::reason | string | 必填；非null；无Schema默认 | — | 省略/合并/操作原因，保留可核对说明 |
| [type=commit]::id | string | 必填；非null；无Schema默认 | — | 记录主键；生成后稳定，更新不重新编号 |
| [type=commit]::sessionId | string | 必填；非null；无Schema默认 | — | 同书T16逻辑会话ID；新数据必须写；空串/省略只兼容旧历史 |
| [type=commit]::bookId | string | 必填；非null；无Schema默认 | — | 所属书；必须等于数据库命名中的bookId；导入重写 |
| [type=commit]::ordinal | integer | 必填；非null；无Schema默认 | minimum=0 | 会话内从0递增序号；复合唯一索引避免重复 |
| [type=commit]::parentId | string 或 null | 必填；可null；无Schema默认 | — | 上一条条目ID；首条为null |
| [type=commit]::createdAt | string | 必填；非null；无Schema默认 | — | 应用创建时的ISO 8601时间，后续不改 |
| [type=commit]::type | "commit" | 必填；非null；无Schema默认 | — | 判别字段；只允许该联合分支对应字段 |
| [type=commit]::summary | string | 必填；非null；无Schema默认 | maxLength=2000 | 压缩摘要/代码提交说明/运行摘要；不是额外业务写指令 |

[本表完整结构示例](resources/v2.2/table-examples/storySessionEntries.json)（固定人工数据；example指纹不作为实际恢复凭证）。

```json
{"id":"entry_example","bookId":"bk_acceptance","sessionId":"session_example","ordinal":0,"parentId":null,"createdAt":"2000-01-01T00:00:00.000Z","type":"message","message":{"role":"user","content":"核对第一章。","timestamp":946684800000}}
```

### T18 · extractionReceipts

库：`westworld_canon_{bookId}` 目标v5。索引：`key, chapterIndex, substep`。

每章每成功子步骤一行；P1实体事务写，恢复读取；人工改删/合并不删除成功凭证。

| 字段路径 | 类型/枚举 | 必填、null、默认 | 结构限制 | 含义、来源与更新 |
|---|---|---|---|---|
| key | string | 必填；非null；无Schema默认 | — | 稳定业务键；各表构造方式见下文 |
| bookId | string | 必填；非null；无Schema默认 | — | 所属书；必须等于数据库命名中的bookId；导入重写 |
| chapterIndex | string | 必填；非null；无Schema默认 | — | 本书章节/切块标识，关联chapters.chapterIndex |
| substep | worldAssets / narrativeAssets | 必填；非null；无Schema默认 | — | P1世界或叙事子步骤 |
| inputFingerprint | string | 必填；非null；无Schema默认 | — | 输入原文/策略/配置依据指纹；输入改变不自动覆盖人工资料 |
| originIds | string[] | 必填；非null；无Schema默认 | — | 本次成功子步骤生成的原始ID；提取为空也写空数组成功凭证 |
| committedAt | string | 必填；非null；无Schema默认 | — | 事务成功时ISO时间 |
| runId | string | 必填；非null；无Schema默认 | — | 关联T20 run行；恢复同一运行保持不变 |
| legacy | boolean | 可省略；非null；无Schema默认 | — | 仅可证明的旧成功步骤迁移时true；新提交省略或false |

[本表完整结构示例](resources/v2.2/table-examples/extractionReceipts.json)（固定人工数据；example指纹不作为实际恢复凭证）。

```json
{"key":"1:worldAssets","bookId":"bk_acceptance","chapterIndex":"1","substep":"worldAssets","inputFingerprint":"example-not-a-valid-runtime-fingerprint","originIds":["C1-P001","C1-L001"],"committedAt":"2026-10-23T00:00:00.000Z","runId":"run_example"}
```

### T19 · assetLifecycle

库：`westworld_canon_{bookId}` 目标v5。索引：`key, kind, originId, currentId, state`。

每原始ID一行；创建/合并/删除事务更新；恢复/引用解析读；墓碑保留，禁止ID复用复活。

| 字段路径 | 类型/枚举 | 必填、null、默认 | 结构限制 | 含义、来源与更新 |
|---|---|---|---|---|
| key | string | 必填；非null；无Schema默认 | — | 稳定业务键；各表构造方式见下文 |
| bookId | string | 必填；非null；无Schema默认 | — | 所属书；必须等于数据库命名中的bookId；导入重写 |
| kind | character / location / node / eventLine | 必填；非null；无Schema默认 | — | 按表区分事项类型、会话类型或资产类型；取值以本行枚举为准 |
| originId | string | 必填；非null；无Schema默认 | — | 历史来源ID，永不因合并更改 |
| currentId | string | 可省略；非null；无Schema默认 | — | live时为自身，merged时为最终目标；deleted时禁止存在 |
| state | live / merged / deleted | 必填；非null；无Schema默认 | — | live活跃来源、merged已并入、deleted删除墓碑 |
| revision | integer | 必填；非null；无Schema默认 | minimum=1 | 乐观并发版本；实体/事项起始1，工作摘要起始0；每次有效修改递增 |
| updatedAt | string | 必填；非null；无Schema默认 | — | 应用提交时的ISO 8601时间；不替代revision并发检查 |
| sourceChapterIndex | string | 可省略；非null；无Schema默认 | — | 初始来源章节，可省略于手工来源 |

[本表完整结构示例](resources/v2.2/table-examples/assetLifecycle.json)（固定人工数据；example指纹不作为实际恢复凭证）。

```json
{"key":"character:C1-P001","bookId":"bk_acceptance","kind":"character","originId":"C1-P001","currentId":"C1-P001","state":"live","revision":1,"updatedAt":"2026-10-23T00:00:00.000Z"}
```

### T20 · pipelineRuns

库：`westworld_canon_{bookId}` 目标v5。索引：`id, recordType, stage, status, startedAt, &lockKey`。

run为每次运行/手动合并一行；lease为资源互斥行；编排器和命令服务写；运行报告/幂等恢复读取；租约不备份。

| 字段路径 | 类型/枚举 | 必填、null、默认 | 结构限制 | 含义、来源与更新 |
|---|---|---|---|---|
| [recordType=run]::recordType | "run" | 必填；非null；无Schema默认 | — | run运行记录或lease资源租约 |
| [recordType=run]::id | string | 必填；非null；无Schema默认 | — | 记录主键；生成后稳定，更新不重新编号 |
| [recordType=run]::bookId | string | 必填；非null；无Schema默认 | — | 所属书；必须等于数据库命名中的bookId；导入重写 |
| [recordType=run]::stage | P1 / P2 / P3 / manual_merge | 必填；非null；无Schema默认 | — | 阶段；新记忆/检查点固定P3，P2只允许旧历史；进度为P1/P2/P3 |
| [recordType=run]::status | running / completed / degraded / failed / cancelled / paused | 必填；非null；无Schema默认 | — | 本表状态枚举；不得把事项status与validity混为一谈 |
| [recordType=run]::startedAt | string | 必填；非null；无Schema默认 | — | 运行开始ISO时间 |
| [recordType=run]::finishedAt | string | 可省略；非null；无Schema默认 | — | 终态时间；运行中省略 |
| [recordType=run]::planVersion | "2.2" | 必填；非null；无Schema默认 | — | 目标计划版本2.2 |
| [recordType=run]::phase | string | 可省略；非null；无Schema默认 | — | P2=mechanical/ai_identity/optimize/report；P3=window_link/global_review；旧link/review仅历史 |
| [recordType=run]::scope | "fullBook" | 可省略；非null；无Schema默认 | — | 全书正式运行固定fullBook |
| [recordType=run]::inputFingerprint | string | 可省略；非null；无Schema默认 | — | 输入原文/策略/配置依据指纹；输入改变不自动覆盖人工资料 |
| [recordType=run]::outputFingerprint | string | 可省略；非null；无Schema默认 | — | 本次已应用结果指纹 |
| [recordType=run]::coverage | object | 可省略；非null；无Schema默认 | — | 当前运行覆盖清单；阶段结束重新枚举，不能仅由模型自报完成 |
| [recordType=run]::coverage.total | integer | 必填；非null；无Schema默认 | minimum=0 | 当前计划项总数 |
| [recordType=run]::coverage.checked | integer | 必填；非null；无Schema默认 | minimum=0 | 依据仍有效的已核查项数 |
| [recordType=run]::coverage.pendingIds | string[] | 必填；非null；无Schema默认 | — | 尚未核查的稳定工作项ID；清空前不能completed |
| [recordType=run]::coverage.cursor | string | 可省略；非null；无Schema默认 | — | 当前阶段的续扫位置；无下一页时省略 |
| [recordType=run]::cost | number | 可省略；非null；无Schema默认 | minimum=0 | Pi费用；累计所有实际响应，未知单价不能伪称真实账单 |
| [recordType=run]::usage | object | 可省略；非null；无Schema默认 | — | Pi响应累计用量；精确定义见Usage |
| [recordType=run]::usage.input | number | 必填；非null；无Schema默认 | — | 输入tokens |
| [recordType=run]::usage.output | number | 必填；非null；无Schema默认 | — | 输出tokens |
| [recordType=run]::usage.totalTokens | number | 必填；非null；无Schema默认 | — | Pi报告总tokens；不自行忽略缓存重算 |
| [recordType=run]::usage.cost | number | 必填；非null；无Schema默认 | — | Pi费用；累计所有实际响应，未知单价不能伪称真实账单 |
| [recordType=run]::report | object | 可省略；非null；无Schema默认 | — | 世界合并报告；描述已生效修改，取消也保留 |
| [recordType=run]::report.beforeCounts | object | 必填；非null；无Schema默认 | — | 本次运行开始的世界资产数量 |
| [recordType=run]::report.beforeCounts.characters | integer | 必填；非null；无Schema默认 | minimum=0 | 人物条数 |
| [recordType=run]::report.beforeCounts.locations | integer | 必填；非null；无Schema默认 | minimum=0 | 地点条数 |
| [recordType=run]::report.afterCounts | object | 必填；非null；无Schema默认 | — | 结束/当前最新世界资产数量 |
| [recordType=run]::report.afterCounts.characters | integer | 必填；非null；无Schema默认 | minimum=0 | 人物条数 |
| [recordType=run]::report.afterCounts.locations | integer | 必填；非null；无Schema默认 | minimum=0 | 地点条数 |
| [recordType=run]::report.groups | object[] | 必填；非null；无Schema默认 | — | 已成功应用的合并组，不包含失败申请 |
| [recordType=run]::report.groups[].method | manual / mechanical / ai_identity | 必填；非null；无Schema默认 | — | manual人工、mechanical机械、ai_identity模型判同 |
| [recordType=run]::report.groups[].kind | character / location | 必填；非null；无Schema默认 | — | 按表区分事项类型、会话类型或资产类型；取值以本行枚举为准 |
| [recordType=run]::report.groups[].memberIds | string[] | 必填；非null；无Schema默认 | — | 组内原成员ID列表 |
| [recordType=run]::report.groups[].memberNames | string[] | 必填；非null；无Schema默认 | — | 与memberIds逐项对齐的合并前主名 |
| [recordType=run]::report.groups[].keepId | string | 必填；非null；无Schema默认 | — | 保留的原成员ID |
| [recordType=run]::report.groups[].canonicalName | string | 必填；非null；无Schema默认 | — | 本次确定的主名 |
| [recordType=run]::report.groups[].aliases | string[] | 必填；非null；无Schema默认 | — | 当前累计别名；合并成员主名和别名，去重并排除当前主名 |
| [recordType=run]::report.groups[].sourceChapters | string[] | 必填；非null；无Schema默认 | — | 实体来源章/块标识并集；按章节顺序去重；合并保留全部来源 |
| [recordType=run]::report.groups[].conflicts | string[] | 必填；非null；无Schema默认 | — | 本组资料冲突说明 |
| [recordType=run]::report.groups[].beforeTokens | integer | 必填；非null；无Schema默认 | minimum=0 | 合并/整编前详细字段估算tokens |
| [recordType=run]::report.groups[].afterTokens | integer | 必填；非null；无Schema默认 | minimum=0 | 合并/整编后详细字段估算tokens |
| [recordType=run]::report.optimizedIds | string[] | 必填；非null；无Schema默认 | — | 本次成功整编的当前实体ID |
| [recordType=run]::report.skipped | string[] | 必填；非null；无Schema默认 | — | 跳过的项ID或带原因的工作项标识 |
| [recordType=run]::report.failed | string[] | 必填；非null；无Schema默认 | — | 失败项标识 |
| [recordType=run]::report.conflicted | string[] | 必填；非null；无Schema默认 | — | 并发或人工保护冲突项标识 |
| [recordType=run]::report.status | running / completed / degraded / failed / cancelled / paused | 必填；非null；无Schema默认 | — | 本表状态枚举；不得把事项status与validity混为一谈 |
| [recordType=run]::report.cost | number | 必填；非null；无Schema默认 | minimum=0 | Pi费用；累计所有实际响应，未知单价不能伪称真实账单 |
| [recordType=run]::report.usage | object | 必填；非null；无Schema默认 | — | Pi响应累计用量；精确定义见Usage |
| [recordType=run]::report.usage.input | number | 必填；非null；无Schema默认 | — | 输入tokens |
| [recordType=run]::report.usage.output | number | 必填；非null；无Schema默认 | — | 输出tokens |
| [recordType=run]::report.usage.totalTokens | number | 必填；非null；无Schema默认 | — | Pi报告总tokens；不自行忽略缓存重算 |
| [recordType=run]::report.usage.cost | number | 必填；非null；无Schema默认 | — | Pi费用；累计所有实际响应，未知单价不能伪称真实账单 |
| [recordType=run]::report.externalChanges | string[] | 必填；非null；无Schema默认 | — | 运行期间人工/其他阶段造成的外部变更说明，不算作本轮自动减少量 |
| [recordType=run]::appliedCommands | object[] | 可省略；非null；无Schema默认 | — | 同run操作幂等账本；与业务变更原子追加 |
| [recordType=run]::appliedCommands[].operationKey | string | 必填；非null；无Schema默认 | minLength=1 | 当前run内唯一命令键；同键同payload重放，同键异payload拒绝 |
| [recordType=run]::appliedCommands[].payloadFingerprint | string | 必填；非null；无Schema默认 | minLength=1 | 完整命令payload规范JSON的SHA-256 |
| [recordType=run]::appliedCommands[].commitId | string | 必填；非null；无Schema默认 | minLength=1 | 代码分配UUID提交确认ID；模型不得指定 |
| [recordType=run]::appliedCommands[].committedAt | string | 必填；非null；无Schema默认 | minLength=1 | 事务成功时ISO时间 |
| [recordType=run]::appliedCommands[].resultSummary | string | 必填；非null；无Schema默认 | minLength=1 | 代码生成的原成功确认摘要；幂等重试原样返回 |
| [recordType=run]::aiMode | direct / agent | 可省略；非null；无Schema默认 | — | 本次AI调用模式；纯手动合并省略 |
| [recordType=run]::modelSnapshot | object | 可省略；非null；无Schema默认 | — | 解析后的Pi模型元数据；无明文Key |
| [recordType=run]::modelSnapshot.providerId | string | 必填；非null；无Schema默认 | — | Pi Provider标识，关联全局credentials.providerId |
| [recordType=run]::modelSnapshot.api | string | 必填；非null；无Schema默认 | — | Pi协议适配器标识，缺省走当前兼容协议 |
| [recordType=run]::modelSnapshot.baseUrl | string | 必填；非null；无Schema默认 | — | 模型API基址；空读回DeepSeek默认地址 |
| [recordType=run]::modelSnapshot.modelId | string | 必填；非null；无Schema默认 | — | 模型ID |
| [recordType=run]::modelSnapshot.modelRole | extraction / aggregation | 必填；非null；无Schema默认 | — | 模型用途extraction或aggregation |
| [recordType=run]::modelSnapshot.contextWindow | integer | 必填；非null；无Schema默认 | minimum=0 | 有效上下文tokens |
| [recordType=run]::modelSnapshot.capabilities | object | 必填；非null；无Schema默认 | — | 已适配的模型工具与结构化能力元数据 |
| [recordType=run]::modelSnapshot.capabilities.tools | boolean | 必填；非null；无Schema默认 | — | 是否支持工具调用 |
| [recordType=run]::modelSnapshot.capabilities.structuredOutput | boolean | 必填；非null；无Schema默认 | — | 是否支持本项目要求的结构化返回 |
| [recordType=run]::modelSnapshot.credentialRef | string | 必填；非null；无Schema默认 | — | T01 providerId引用；不是Key |
| [recordType=lease]::recordType | "lease" | 必填；非null；无Schema默认 | — | run运行记录或lease资源租约 |
| [recordType=lease]::id | string | 必填；非null；无Schema默认 | — | 记录主键；生成后稳定，更新不重新编号 |
| [recordType=lease]::bookId | string | 必填；非null；无Schema默认 | — | 所属书；必须等于数据库命名中的bookId；导入重写 |
| [recordType=lease]::lockKey | extraction / world / narrative | 必填；非null；无Schema默认 | — | extraction/world/narrative资源键；唯一索引只约束lease，run不得携带 |
| [recordType=lease]::owner | string | 必填；非null；无Schema默认 | — | 当前页面/执行实例随机UUID；续租/释放必须匹配 |
| [recordType=lease]::runId | string | 必填；非null；无Schema默认 | — | 关联T20 run行；恢复同一运行保持不变 |
| [recordType=lease]::expiresAt | integer | 必填；非null；无Schema默认 | minimum=0 | 租约到期Unix毫秒；取得/续租为当前时刻+300000 |

[本表完整结构示例](resources/v2.2/table-examples/pipelineRuns.json)（固定人工数据；example指纹不作为实际恢复凭证）。

```json
{"recordType":"run","id":"run_example","bookId":"bk_acceptance","stage":"P1","status":"completed","startedAt":"2026-10-23T00:00:00.000Z","finishedAt":"2026-10-23T00:00:00.000Z","planVersion":"2.2","appliedCommands":[],"usage":{"input":0,"output":0,"totalTokens":0,"cost":0},"cost":0}
```

## 9. 入口赋值、关联与迁移补充

| 表/字段 | 创建/更新入口与确定规则 |
|---|---|
| T01/T02 | API Key trim后按providerId覆盖；llm.config只保存一份，两模式共用。baseUrl缺省https://api.deepseek.com，提取模型deepseek-flash，归并模型deepseek-v4-pro。providerId/api是目标扩展，可省略时使用deepseek/openai-completions。compile.concurrency旧值可保留，但2.2调度固定单章在途，不读取旧并发值决定P1并发。 |
| T03–T05 | 导入分配新bookId；书名默认文件名；createdAt当前ISO时间；chapterIndex来自分章/切块，order从0连续；charCount=text.length；元信息和正文同章关联。书架与单书库跨库非原子，导入失败清理按04。 |
| T08/T10/T11 | P1成功后由代码分配章内ID并写bookId和章节信息，revision=1，createdBy=P1。人物/地点nameSource=extracted、manualKeep=false、sourceChapters=[chapterIndex]、aliases来自提取别名；手工新增ID=U-UUID，createdBy/manual名来源均manual，无原文章信息则manualSourceNote必填。confidence手工默认0.5。 |
| T08 | P1节点eventLineIds=[]；createdBy=P3用于有引文补点，manual用于人工节点；order代码生成。补点DTO无confidence时沿用补点服务默认0.6（模型未给置信度，不冒称模型评分）。actorIds与targetCharacterIds保存稳定人物编号，应用负责绑定和关联更新。参考引文未匹配时保留节点并记录定位提示。timeCoord/timePrecision/canonicalId为可携带兼容字段，不能推断存在独立时间推理/节点去重工具。 |
| T09 | P3/人工创建分配稳定L编号，revision=1，updatedAt当前ISO时间；nodeIds非空且有效、排序去重；chapters由成员章去重生成；成员时间存在时生成timeRange；无时间则省略。line_status DTO改为lineStatus；characterIds只读派生。 |
| T10/T11融合 | 同组目标保留id/bookId/创建来源；资料精确去重并融合，sourceChapters取并集；mergeFacts保留事实与chapters；目标revision递增，删除成员并更新T19/报告同事务。人工改事实字段后清optimizedFactIds和optimizationFingerprint。 |
| T12 | 新正式运行必须写scope=fullBook、planVersion=2.2、runId、phase、unit、validity=current及coverage；completedChapters/failedChapters初始[]，partialChapters={}。P1 phase使用worldAssets/narrativeAssets；只有两张成功凭证齐全才入completedChapters。旧lastWindowIndex/testScope不能升级为目标已完成。 |
| T13 | 无持久摘要时工具返回虚拟空记录：id=sessionId、bookId、sessionId、revision=0、workingSummary/dataFingerprint/updatedAt均空串，不为一次读自动建表行。首次有效memory_update写revision=1，后续加1。 |
| T14 | 新笔记id取该书所有SN编号最大值+1，格式SN加至少6位数字；sessionId必填，stage=P3。相同(sessionId,key)更新原行且createdAt不变；新/更新笔记revision均取本次memory.revision（提交前摘要revision+1），不按笔记旧版本各自加1。status=resolved要求旧事项存在，kind不能直接改变；必须有有效nodeIds/lineIds/evidence至少一种依据。validity读时计算，不持久存储。 |
| T15 | 检查点键由会话、stage、phase、scopeIds构成确定性键；恢复对sourceFingerprint、worldDependencies、queryDependencies复验。window_link保存window={start,end}，global_review可省略window。stage=P2/phase=link或review仅旧历史，不计目标覆盖。 |
| T16/T17 | 新故事会话UUID，profile=story_editor、kind=initial、status=active、nextOrdinal=0；leafId省略。一次追加原子写entry、递增nextOrdinal并更新leafId/updatedAt。entry.id UUID，首parentId=null；租约字段只用于进程协调，备份清除。 |
| T18 | key=chapterIndex+':'+substep；originIds可空；committedAt当前ISO时间；与该子步骤实体、T19、T12、T20覆盖同事务。inputFingerprint变化不删除旧成功凭证或自动覆盖数据。 |
| T19 | key=kind+':'+originId。创建live/currentId=originId/revision=1；合并将所有来源扁平指向最终保留ID并增版本；删除改deleted并移除currentId。墓碑和旧ID不可被新P1重用。 |
| T20 run | id UUID；status=running，startedAt当前ISO，planVersion=2.2；appliedCommands初始[]、cost=0、usage各计数0。每个成功命令账本与业务同事务；finishedAt在终态写。手动合并stage=manual_merge，可省略aiMode/modelSnapshot；无lockKey。 |
| T20 lease | id='lease:'+lockKey；owner随机运行实例令牌；expiresAt=当前Unix毫秒+300000。获取/续租/释放在短事务比较owner；同资源活持有者不能被抢占；非当前owner不得释放。 |
| T20 report | beforeCounts为开始计数，afterCounts为最新/最终计数；列表初始[]、cost与usage初始0；memberNames与memberIds逐项对齐。无变更也写零变更报告；不得将外部人工增删算为自动合并效果。 |

**准确命名：** 人物关系字段是`relation_label`；事实来源字段是`mergeFacts[].chapters`。节点使用`world_delta/new_facts/started_actions/time_text/time_hint`；事件线使用`lineStatus`，输入工具的`status`只是过滤参数。禁止自行改写成worldStateChanges/newFacts/initiatedActions/timeText或把lineStatus建成status。

**恢复与删除：** T01/T02不随书删。删书删除该书全部15表和T03书架项；跨库不能保证单事务，失败须暴露残留。人工删资产按04清引用并写T19墓碑，不删除提取成功凭证。T13–T17历史不因压缩或重查清空。18表中只有T01/T02排除单书备份，T03映射book.json，T05映射chapters/*.txt，T20只导出run分支；所有导入归属重写为新bookId。

**旧数据迁移差异：** 旧可编辑表存在但空必须迁为空，不从发布副本补回；旧人物speech_style_sample→speechStyleSample，已有mergeFacts[].chapters不改名。人物/地点revision缺失补1；nameSource无证据证明人工时用extracted并保留现有name；不得凭字段非空推断manualKeep。旧节点来源P2保留兼容；来源缺失不能伪造历史，迁移报告登记按旧P1节点默认的兼容处理。新增运行才能使用完整2.2阶段字段，旧摘要/事项/检查点保留而标失效。

**指纹明确化（目标补充）**：新增2.2写命令payloadFingerprint采用递归对象键按Unicode码点排序、数组保持契约顺序、UTF-8 JSON无空白后SHA-256小写hex；省略与null不同，字符串不trim后再哈希。同run同operationKey相同payload原样返回确认，改变任一业务值返回IDEMPOTENCY_CONFLICT。输入/查询依赖指纹必须覆盖实际输入、ID/revision/redirect及查询结果集合；不能只用updatedAt，也不能让不相关世界资产变化使全书P3失效。旧指纹不转用为2.2有效证明。

**协议扩展边界：** T17.message与systemMessage按锁定Pi 1.0.2消息协议保留原始扩展键；不是任意模型JSON都能成为持久业务对象。T02目录句柄由浏览器structured clone存储，JSON Schema的object只能描述槽位，不能验证浏览器原生句柄；导出不含该值。QueryDependency.args按对应工具参数Schema校验，不能把开放object视为绕过工具白名单的入口。

## 10. 任务、命令意图与覆盖账本（2026-10-24）

> 缺陷修复补充：T02新增动态键book.lifecycle:{operationId}，详见本文件第11节；模型费用状态和引用歧义是新增明确字段。表数量不变。

本节说明任务字段与生命周期，T20仍是一张表，不增加数据库/表数量。完整结构见[execution.schema.json](resources/v2.2/execution.schema.json)，已同步合入storage.schema及data-contract。旧2026-10-23表样例仅说明旧字段；新运行必须contractRevision=2026-10-24并初始化tasks/commandIntents/coverageItems=[]、nextTaskOrdinal=0、reconciliationPass=0、noProgressTasks=0。已有目标试验数据缺这些字段时只能保留历史/暂停重查，不能推断覆盖完成。

### TaskRecord 字段

| 字段 | 类型/枚举 | 存在性 | 含义/约束 |
|---|---|---|---|
| taskId | string | 必填 | ；minLength=1 |
| ordinal | integer | 必填 | ；minimum=0 |
| callId | string | 必填 | ；minLength=1 |
| phase | string | 必填 | ；minLength=1 |
| status | pending/running/partial/completed/failed/cancelled/stale | 必填 | 按下述状态与来源规则 |
| workItemIds | string[] | 必填 | ；uniqueItems=True |
| input | object 或 object 或 object 或 object 或 object 或 object 或 object 或 object | 必填 | 按下述状态与来源规则 |
| inputFingerprint | string | 必填 | ；minLength=1 |
| promptHash | string | 必填 | ；minLength=1 |
| attempt | integer | 必填 | ；minimum=0 |
| repairCount | integer | 必填 | ；minimum=0；maximum=1 |
| stepsUsed | integer | 必填 | ；minimum=0 |
| appliedCommitIds | string[] | 必填 | ；uniqueItems=True |
| reviewedItems | object[] | 必填 | 按下述状态与来源规则 |
| readSet | object | 必填 | 按下述状态与来源规则 |
| createdAt | string | 必填 | 按下述状态与来源规则 |
| updatedAt | string | 必填 | 按下述状态与来源规则 |
| lastError | object | 可省略 | 按下述状态与来源规则 |

### CommandIntent 字段

| 字段 | 类型/枚举 | 存在性 | 含义/约束 |
|---|---|---|---|
| operationKey | string | 必填 | ；minLength=1 |
| taskId | string | 必填 | ；minLength=1 |
| toolCallId | string | 必填 | ；minLength=1 |
| state | prepared/applied/rejected/abandoned | 必填 | 按下述状态与来源规则 |
| payloadFingerprint | string | 必填 | ；minLength=1 |
| expectedReadSet | object | 必填 | 按下述状态与来源规则 |
| createdAt | string | 必填 | 按下述状态与来源规则 |
| updatedAt | string | 必填 | 按下述状态与来源规则 |
| commitId | string | 可省略 | ；minLength=1 |
| error | object | 可省略 | 按下述状态与来源规则 |
| toolName | commit_asset_changes | 必填 | 按下述状态与来源规则 |
| payload | object | 必填 | 按下述状态与来源规则 |
| operationKey | string | 必填 | ；minLength=1 |
| taskId | string | 必填 | ；minLength=1 |
| toolCallId | string | 必填 | ；minLength=1 |
| state | prepared/applied/rejected/abandoned | 必填 | 按下述状态与来源规则 |
| payloadFingerprint | string | 必填 | ；minLength=1 |
| expectedReadSet | object | 必填 | 按下述状态与来源规则 |
| createdAt | string | 必填 | 按下述状态与来源规则 |
| updatedAt | string | 必填 | 按下述状态与来源规则 |
| commitId | string | 可省略 | ；minLength=1 |
| error | object | 可省略 | 按下述状态与来源规则 |
| toolName | commit_story_changes | 必填 | 按下述状态与来源规则 |
| payload | object | 必填 | 事件线串联结果。 |

### CoverageItem 字段

| 字段 | 类型/枚举 | 存在性 | 含义/约束 |
|---|---|---|---|
| workItemId | string | 必填 | ；minLength=1 |
| phase | string | 必填 | ；minLength=1 |
| kind | character/location/node/eventLine/note/chapter | 必填 | 按下述状态与来源规则 |
| id | string | 必填 | ；minLength=1 |
| status | pending/assigned/checked/stale/skipped | 必填 | 按下述状态与来源规则 |
| inputRevision | integer | 必填 | ；minimum=0 |
| inputFingerprint | string | 必填 | 按下述状态与来源规则 |
| coveredRevision | integer | 必填 | ；minimum=0 |
| coveredFingerprint | string | 必填 | 按下述状态与来源规则 |
| dependencies | object | 必填 | 按下述状态与来源规则 |
| taskId | string 或 null | 必填 | 按下述状态与来源规则 |
| outcome | changed/no_change/needs_review/deleted/redirected 或 null | 必填 | 按下述状态与来源规则 |
| reason | string | 必填 | 按下述状态与来源规则 |
| invalidations | integer | 必填 | ；minimum=0 |
| updatedAt | string | 必填 | 按下述状态与来源规则 |

### RecordDependency 字段

| 字段 | 类型/枚举 | 存在性 | 含义/约束 |
|---|---|---|---|
| table | characters/locations/nodes/eventLines/storyEditorMemory/storyEditorNotes/chapterTexts/assetLifecycle | 必填 | 按下述状态与来源规则 |
| id | string | 必填 | ；minLength=1 |
| resolvedId | string 或 null | 必填 | 按下述状态与来源规则 |
| revision | integer | 必填 | ；minimum=0 |
| factFingerprint | string | 必填 | ；minLength=1 |

### QueryDependencyV2 字段

| 字段 | 类型/枚举 | 存在性 | 含义/约束 |
|---|---|---|---|
| tool | string | 必填 | ；minLength=1 |
| args | object | 必填 | 严格按该tool的参数Schema二次校验 |
| resultFingerprint | string | 必填 | ；minLength=1 |

### ReadSet 字段

| 字段 | 类型/枚举 | 存在性 | 含义/约束 |
|---|---|---|---|
| records | object[] | 必填 | 按下述状态与来源规则 |
| queries | object[] | 必填 | 按下述状态与来源规则 |

### ReviewItem 字段

| 字段 | 类型/枚举 | 存在性 | 含义/约束 |
|---|---|---|---|
| workItemId | string | 必填 | ；minLength=1 |
| outcome | changed/no_change/needs_review | 必填 | 按下述状态与来源规则 |
| reason | string | 必填 | ；minLength=1；maxLength=1000 |

字段来源及迁移：TaskRecord.input由本章Prompt输入Schema校验后冻结，callId选择具体输入分支；TaskRecord.readSet由输入摘要/读工具实际读取形成，模型不得传入。CommandIntent.payload是已通过参数结构校验的原始命令，按toolName分别执行IdentityGroups或Link Schema；prepared阶段不含commitId，applied必须有对应账本commitId，rejected必须有error；后两项条件由服务校验。CoverageItem由调度器创建和更新，模型只提供ReviewItem判断。

appliedCommands每项新增必填taskId，必须指向同run的tasks项。operationKey在run内唯一，taskId不同即使payload相同也拒绝复用原键。命令意图、确认、任务状态、覆盖清单进入v5备份；租约/活动Agent对象不导出。导入新bookId须重写所有任务input中的bookId并重新计算inputFingerprint，保留旧run/task/operationKey作为导入库内的历史身份，禁止自动继续prepared意图；它们变abandoned，活动task变partial、run变paused，用户继续时重查后创建新task。

覆盖统计仍存coverage={total,checked,pendingIds,cursor?}作为可重建缓存；权威是coverageItems。total只计当前phase清单，checked仅计有效checked项；skipped单独从清单计数，不伪装checked；pendingIds为pending/assigned/stale项。phase切换后UI统计重置到新phase，但旧phase清单保留。覆盖/恢复/事务细则见04 ALG-12。

## 11. 修复所需的生命周期日志与只读字段

T02的key允许book.lifecycle:{operationId}，value为BookLifecycleJournal；不增加表。该记录由应用创建，模型不可读写。

| 字段 | 类型/必填 | 来源与更新 |
|---|---|---|
| operationId | 非空string，必填 | 应用UUID，与key后缀一致 |
| action | import/delete，必填 | 创建时固定 |
| bookId | 非空string，必填 | 本次新建或明确要删除的书；之后不变 |
| state | preparing/ready/deleting/cleanup_pending，必填 | import准备/待发布或删除/清理状态，按04 ALG-FIX转移 |
| createdAt / updatedAt | ISO string，必填 | 创建/每次状态更新时写 |
| book | Book，可省略 | import进入ready必须保存待发布Book，book.id=bookId；delete省略 |
| error | string，可省略 | 失败诊断；不包含凭据 |
| owner | 非空string，必填 | 当前操作实例令牌；恢复接管在全局事务比较后更换 |
| leaseUntil | 非负整数毫秒，必填 | 当前租约到期时刻；活动时续租，其他标签不得抢占活操作 |

新生命周期日志必须先持久成功再创建/删除书库，发布Book与清日志在同一全局事务。旧库没有日志不主动删除；启动恢复只能操作已登记的bookId。日志与目录句柄、Key都不进单书备份。

ModelSnapshot新增pricingStatus（known/estimated/unknown）和pricingCurrency；应用Usage新增costStatus同枚举。旧记录缺状态按unknown读取；known/estimated必须由解析器提供币种。numeric cost仍可保存SDK累计值，但unknown不得据此显示免费/真实账单；混合统计单列已知部分。

characterReferences为人物关联的读取说明；节点actorIds与targetCharacterIds保存人物编号，事件线characterIds从节点关联派生。字段字典中的当前实体仍只有18种表定义。
