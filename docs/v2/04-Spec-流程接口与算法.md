# 详细规格：流程、接口与算法

职责和有效来源见[统一入口](00-阅读入口与术语.md)。实现及验收状态见[覆盖索引](12-验收执行与覆盖矩阵.md)。


## 1. 接口边界与返回约定

当前调用入口按各功能 service（领域服务）和[模块表](02-架构与技术规格.md#ar-03-模块与依赖方向)定位。精确工具参数由11和工具结构文件维护，界面输入由09说明；领域服务统一处理校验、事务、失败与恢复。

## ALG-01 解码、正则和分章

1. 自动解码使用UTF-8 fatal TextDecoder，成功去开头BOM；异常后GBK TextDecoder。手选UTF8不使用fatal。不得添加编码检测模型。
2. 正则输入先trim，空时报“分章正则不能为空，可以点击恢复默认。”；匹配`^/([\s\S]*)/([a-z]*)$`时拆正文/flags，否则整个输入为正文；补齐g/m，原flags保留。语法异常包装“分章正则无效：…”。
3. 默认正则必须使用[黄金结果](resources/golden-results.json)的regex原值；匹配中文数字、阿拉伯数字及空格标题。使用前lastIndex=0；无g时报错；任意匹配长度0报错避免循环。
4. 捕获组1存在用其内容，否则用完整匹配；trim后为空则忽略。真实标题起点=`match.index+fullMatch.indexOf(captured)`；找不到偏移取0。
5. 有标题时，非空前缀保存为序文chapterIndex=0；纯空白前缀并入首章。正文切片不trim，拼接必须还原规范化输入。标题章仍按匹配顺序1..N编号，不取原标题数字。
6. 无标题时按固定4000 UTF-16 code units逐段切为“第 n 段”，无重叠；空文本结果[]。
7. 长章超过10000按固定长度切块，编号`index.part`、名称`原标题（第 part 块）`；不按句子修正，不设重叠；所有输出order统一从0重排。
8. charCount=text.length，为JavaScript字符串长度。非BMP字符按两个UTF-16单位计；不可替换成Unicode code point或中文分词数。

分章预览在原生 Web Worker（独立工作线程）执行，10秒未完成时终止并提示调整正则或文件；切页卸载时终止预览。新文件和正则变化使旧预览失效。

## ALG-02 P1逐章提交、即时刷新与恢复

行为与场景见[逐章提取](../../openspec/specs/extraction/spec.md)。技术实现见[模块表](02-架构与技术规格.md#ar-03-模块与依赖方向)，事务和参数分别见[数据流](10-字段级数据流与状态转移.md)与[操作契约](09-操作与自动触发契约.md)。

## ALG-03 阶段门槛、窗口与独立恢复

行为与场景见[事件线串联与复核](../../openspec/specs/story-organization/spec.md)。技术实现见[模块表](02-架构与技术规格.md#ar-03-模块与依赖方向)，事务和参数分别见[数据流](10-字段级数据流与状态转移.md)与[操作契约](09-操作与自动触发契约.md)。

## ALG-04 名称归一化、聚组与融合

### 名称标准化

按顺序：合并空白为一个空格并trim；依次去末尾卷章版本后缀：数字+卷章回部篇节、卷+数字、v/ver及数字、新版/旧版/重做版/重制版/修订版/临时版/备份/资产/重复/改及对应括号形式；若清空退回原名trim。比较名再toLowerCase并去指定中英文标点空白。精确正则集见[规则参数](resources/algorithm-parameters.json)，不得泛化为去除全部Unicode标点。

### 两轮本地聚组

分组与确认规则见[世界资产整理](../../openspec/specs/world-organization/spec.md)。名称标准化和相似度用于相应候选计算。

### 本地融合

文本按中英文分号和换行拆、trim、去空去重，按首次出现顺序用中文分号连接。融合优先把keep放第一项。名称与已有别名全集去掉保留主名；sourceChapters合并按numeric localeCompare排序。人物关系按target/relation_type/direction(缺省空串)联合键去重，相同关系标签融合。

profile.age/gender保留目标现值，缺值补充；冲突记录“字段 冲突：旧 / 新（第 章 章），保留最早值，待复核”。ageText按文本融合。组内manual层级优先于keep和其他自动层级；自动合并更新updatedAt。地点description融合，来源和冲突并集。

### P2 AI精简判同、详细整编及报告

见[世界资产整理](../../openspec/specs/world-organization/spec.md)。

## ALG-05 主名出场与层级

1. scope=(processedIds或所有正文标识)去点后按原章去重。name=trim().toLowerCase；不使用别名和sourceChapters计数。
2. 重名实体无法唯一归属则不放匹配表达式；其余名称按长度降序、locale顺序排序，转义后以`|`组成gu正则。正文小写，matchAll是非重叠匹配；长名优先。
3. 每次命中mentions+1、原章加入Set；chapters为覆盖Set大小，scopeChapters为scope大小。
4. higher为章节数更大或同章节提及更大者数，same为两项都相同者数；percentile=`(higher+(same-1)/2)/max(1,实体数-1)`。
5. 多个人全部同频→NPC；否则<0.1主要、<0.3重要、<0.8 NPC、其余路人。只有一个人物时不是flat，按公式可为主要人物。
6. roleWeightSource=manual不覆盖，仍更新frequency；非manual写frequency与对应层级。AI调整主名后须再次计算，地点同样记录频次但不加人物层级。

## ALG-06 串联、补点与批提交

行为与场景见[事件线串联与复核](../../openspec/specs/story-organization/spec.md)。技术实现见[模块表](02-架构与技术规格.md#ar-03-模块与依赖方向)，事务和参数分别见[数据流](10-字段级数据流与状态转移.md)与[操作契约](09-操作与自动触发契约.md)。

## ALG-07 人工更新、合并与删除

行为与场景见[资产维护](../../openspec/specs/asset-management/spec.md)。技术实现见[模块表](02-架构与技术规格.md#ar-03-模块与依赖方向)，事务和参数分别见[数据流](10-字段级数据流与状态转移.md)与[操作契约](09-操作与自动触发契约.md)。

## ALG-08 当前实体及人物引用读取

行为与场景见[资产维护](../../openspec/specs/asset-management/spec.md)。技术实现见[模块表](02-架构与技术规格.md#ar-03-模块与依赖方向)，事务和参数分别见[数据流](10-字段级数据流与状态转移.md)与[操作契约](09-操作与自动触发契约.md)。

## ALG-09 图布局

行为与场景见[事件网络](../../openspec/specs/event-network/spec.md)。技术实现见[模块表](02-架构与技术规格.md#ar-03-模块与依赖方向)，事务和参数分别见[数据流](10-字段级数据流与状态转移.md)与[操作契约](09-操作与自动触发契约.md)。

## ALG-10 导出、恢复和删除

行为见[备份与书籍删除](../../openspec/specs/book-backup/spec.md)，序列化与预检入口见[备份编解码](../../src/features/backup/codec.ts)，生命周期与跨库恢复见[备份服务](../../src/features/backup/service.ts)。

## ALG-11 进度与事件投影

所有task事件携带bookId/stage/runId，按三元组更新目标runtime条目，不重置其他条目。start初始化本次计数和费用，progress更新对应任务，done根据该阶段失败/降级/剩余工作及依赖有效性决定终态；cancel只abort目标控制器。每任务最近2000条日志，费用累计本次模型和摘要调用。

P1单位为章/块（界面另显示原章数）；P2显示机械/AI判同/整编/报告四步和对象统计；P3分别显示窗口覆盖和全书队列覆盖，不把不同单位相加。成功、失败、跳过和总数分别展示，进度100%不等于成功。

刷新丢实时日志/控制器但保留pipelineRuns、进度、报告、会话和检查点。旧running在owner失效后显示可恢复paused；不后台自动续跑。不按“最新updatedAt的一条”覆盖整个工作台，始终同时读取P1/P2/P3各自状态。

## ALG-12 共用Pi模型入口与写命令生命周期

P1/整编/压缩走direct→pi-ai，P2判同/P3走pi-agent-core Agent→同一pi-ai。应用包装仅提供配置、校验、持久化、预算与错误策略，不另写Agent推理循环。两模式同一领域命令使用相同结构/引用/原文/事实覆盖/revision校验，模式不降低校验要求。

Agent查询→commit_*写工具execute→校验→业务记录和T20命令凭据同事务→返回commitId/alreadyApplied→Pi toolResult→可继续查询；末轮submit_result只报告已应用commitIds和remainingWorkIds。循环结束后编排器只汇总/核覆盖，不把最终回复增量再写一遍。

operationKey由Agent对同一逻辑命令复用，代码用(runId,operationKey)和payload指纹去重；同键不同内容拒绝。写服务开始事务前核signal，取消后不发新写；事务已提交后取消/断线/最终回复错不得回滚。报告保留所有已应用凭据，缺反馈可从账本恢复。

只读查询最多14种，受控写工具2种，结果收集器另计。写执行顺序交Pi sequential工具调度，租约/幂等/revision由应用事务服务保障，二者职责不能相互替代。

### ALG-12.1 运行与子任务身份

本节说明任务身份和持久化约定。runId代表一次用户发起的阶段运行；taskId为应用在发请求前分配并持久化的UUID，代表一份固定分配清单。重连、模型网络重试、校验修正保持同runId/taskId；用户点击“重新检查”创建新runId；partial后的剩余项形成新taskId，但P3始终保持同一逻辑sessionId。

每次请求前在T20.tasks追加TaskRecord，ordinal取nextTaskOrdinal后加1，冻结callId、phase、workItemIds、输入快照及其指纹、Prompt hash。输入必须通过05的具体调用Schema；Schema相符但callId不匹配同样拒绝。任务输入中的bookId/runId/taskId只能来自绑定上下文，不能读模型参数。相同run内每个工作项同时最多分配给一个running任务。

| 状态 | 触发与下一状态 | 持久结果/恢复 |
|---|---|---|
| pending | 取得资源与必要会话租约→running | 恢复原task不改分配清单；attempt只在实际发Provider请求前递增 |
| running | 合法final summary且剩余为空→completed | 保存逐项判断和有效覆盖；只是task完成 |
| running | 合法partial或预算耗尽→partial | 已提交确认保留；未核查项恢复pending，按新task继续 |
| running | 不可重试模型/存储错误→failed；用户取消→cancelled | 记录lastError，run暂停/失败/取消，不删除确认 |
| 任一已分配状态 | 输入事实或相关依赖变化→stale | 已提交结果不回滚；受影响项重入队，新task重查 |
| 刷新遗留running | owner失效后先恢复命令意图，再恢复原task为pending | 不自动后台续跑；用户“继续”才请求模型 |

P2只不保存长对话，并非不保存任务：恢复时使用冻结输入、有效未处理ID、已应用确认和新读集重建一次临时Agent。P3恢复原消息投影，再追加应用恢复消息；不得重复追加已存在的原始assistant/toolResult来伪造成功。

### ALG-12.2 写入前意图与提交后确认

1. **校验和定位。** 校验工具参数、绑定bookId/profile/phase/taskId和signal；同run查operationKey。已applied且taskId、payloadFingerprint相同，直接返回原CommitAck（alreadyApplied=true）；同键不同task或payload返回IDEMPOTENCY_CONFLICT。此检查先于成员存在性检查，避免已合并成员导致重放失败。
2. **保存意图。** 对新命令，在短事务中追加CommandIntent(state=prepared)：保存原payload、taskId、toolCallId、payloadFingerprint、实际读集和时间。只要尚未业务提交，就不能向模型说成功。保存意图失败则停止，不调用业务写服务。模型结构非法时不建prepared意图，仅返回INVALID_ARGS。
3. **业务事务。** 在同一事务重新核租约owner、prepared意图、实际读写集revision/引用/引文等；应用全部payload；追加appliedCommands（含taskId）；意图置applied并写commitId；任务appliedCommitIds追加同一确认；必要的P3记忆/代码提交条目与业务一并提交。任何一项失败，业务与确认全部回滚。
4. **失败归档。** 事务失败后可另用短事务将prepared意图置rejected并保存error；这次归档也失败时保留prepared，恢复重新核实。结构/领域错误修改payload必须用新operationKey；不能修改原意图的payload或指纹。只有网络中断后重试同一内容才复用原键。
5. **返回。** 事务成功后返回CommitAck并由Pi形成toolResult。取消发生在提交之后仍返回/恢复原确认；取消仅阻止新的命令。Agent最终总结不重复调用领域服务。

同一task可以多次写，但单个operationKey的所有groups/ops必须原子。P3的T17代码确认和最终summary元数据属于应用持久化；不把“最终收集器无业务写副作用”误解为运行结束不更新任务/覆盖状态。

### ALG-12.3 每个崩溃位置的恢复

| 中断位置 | 可见状态 | 继续规则 |
|---|---|---|
| 模型响应前 | task已保存，无意图 | 原task重新请求；新计费尝试计入usage，不猜旧响应 |
| 原始assistant已存但意图未存 | P3有原消息，P2可能仅task | 原消息不证明执行；代码核账本；P2重建任务重新判断 |
| 意图prepared、业务未提交 | 有完整payload和expectedReadSet，无确认 | 取得新owner后先重新校验当前读集。仍相符且用户要求继续则执行一次；已变则rejected/CONFLICT，任务重查，不盲重放 |
| 业务事务提交但toolResult丢失 | 意图applied、账本有K、业务已变 | 返回K；不得二次写。P3投影补显式中断占位后展示真实应用确认；P2恢复消息列K |
| finalizer接受但任务完成事务未提交 | 有确认，无持久completed | 重新核分配/依赖和总结；不根据一次assistant回复推断全阶段完成 |
| 运行在另一标签仍持有效租约 | 原owner活跃 | 拒绝接管；无BroadcastChannel时等待到期；不能因用户点击继续抢占 |

prepared恢复失败不无限自动重试：租约/版本冲突转明确待重查；磁盘不可写停止并展示错误。跨浏览器导入按03清除在途意图执行权，禁止把备份当作自动续写授权。

### ALG-12.4 覆盖项身份、派发与排序

T20.coverageItems是完成证明的权威清单。workItemId=`phase + ':' + scopeKey + ':' + kind + ':' + id`，各自由标识用encodeURIComponent编码后拼接；scopeKey：P1为substep，P2为`fullBook`，P3窗口为`start-end`零基半开范围，全局为队列名。kind用于避免人物/地点/事件线ID相同造成碰撞。

| 阶段 | 建项及稳定顺序 | 单task分配上限 |
|---|---|---|
| P1 | 每章两个子步骤，按Chapter.order再world/narrative | 一个子步骤；成功receipt满足后checked |
| P2 mechanical | 当前人物再地点，类型内按ID码点顺序 | 代码单组提交；无模型 |
| P2 ai_identity | 当前人物再地点，类型内ID码点；最多3项排队，每项独立核实 | 1个分配项，可跨资产批量查证；每次查询仍≤100 |
| P2 optimize | 判同后重枚举；候选按类型/ID排序；非候选记录no_change与触发判断 | 人物≤3且服从tokens预算；地点1 |
| P3 window_link | 按窗口起点顺序，再章节order、节点order、ID码点；切块按原章进入窗口 | 20个节点项 |
| P3 global_review | 队列依次orphans、event_lines、review_notes；队内ID码点顺序 | 节点、线和事项每批最多20项 |

0项阶段不发无意义模型请求，代码写零覆盖完成记录。读取工具可超出分配项查证，但未分配新对象不能借一次总结直接标checked；新建节点/线必须加入后续适用队列。P2本轮核实结束后，成功项进入按需整编，失败和未完成项保留待办；其他阶段在前一阶段当前项有效结束后切换。

TaskRecord记录需要模型参与的子任务，包含P1/direct整编与Agent任务。候选生成、同来源幂等核验及非候选跳过由代码处理，不伪造Agent调用：coverage.taskId=null，该阶段仅写覆盖/报告，不融合不同来源实体；已确认组由人工或AI命令事务处理。direct通过输出Schema/领域校验后，调用方把业务修改和该task对应覆盖/状态同事务保存，reviewedItems由代码根据真实变化生成，不要求direct额外调用Agent finalizer。命令意图/operationKey账本用于本规范两种受控Agent写工具；P1成功幂等仍以T18子步骤凭证为准，整编幂等以事实/优化指纹和revision为准。

### ALG-12.5 版本、事实指纹与查询依赖

指纹为03定义的规范JSON SHA-256。当前行revision变化先触发复核；若如下事实投影及关联依赖均相同，只更新coveredRevision，不重复请求模型：

| 对象 | 事实投影 |
|---|---|
| 人物/地点 | 所有持久业务字段，排除bookId/revision/updatedAt/frequency/optimizedFactIds/optimizationFingerprint；保留姓名、别名、事实底稿、保护/人工来源及roleWeight |
| 节点 | 所有持久字段，排除bookId/revision/eventLineIds；人物ID读取投影不加入；原文关联另记chapterTexts依赖 |
| 事件线 | id/title/nodeIds/cause/process/result/lineStatus；成员节点事实逐个作为依赖；派生chapters/timeRange不重复哈希 |
| 笔记 | key/kind/status/statement/nodeIds/lineIds/evidence；依据实体/原文另记；摘要时间和笔记revision不充当内容 |
| 原文 | chapterIndex和完整text；原文指纹不能只用长度 |
| 生命周期 | kind/originId/currentId/state/revision，包含墓碑与解析变化 |

RecordDependency必须记录实际请求ID、resolvedId、revision和事实hash；输入提示中的摘要也计入读集，不能只记显式工具调用。QueryDependency记录准确工具参数及**该查询实际选中行/顺序/事实投影**的hash；空结果同样记录。查询依赖重算沿用相同参数和分页规则，不把所有书全局hash作为替代。查询返回截断事实不代表已读完整事实。

写事务校验使用实际revision；已完成覆盖有效性采用事实投影+依赖。任务自己的成功写入允许把本task已读、已处理对象的基准更新为提交后版本；未读取的新对象、新外部证据仍入待办。其他task覆盖只在其明确依赖发生变化时stale，不全局清空。单个workItem在同run被事实变化置stale累计3次时将run设paused/validity=stale，说明“资料持续变化，剩余N项”，等待用户继续；继续保留run和有效覆盖，重置该项本轮冲突计数。

### ALG-12.6 总结、删除/合并和全阶段完成

AgentTaskSummarySchema新增必填reviewedItems：每项`{workItemId,outcome,reason}`；outcome为changed/no_change/needs_review。reviewedItems ID唯一、remainingWorkIds唯一且互斥，两集合并必须等于本task.workItemIds。commitIds必须精确列出本task所有持久成功确认，不能漏报或引用同run其他task；changed必须有本task命令写集命中该工作项或其当前解析目标。no_change/needs_review也必须有实际读取依据；needs_review为“已检查但需人工核实”，可以算覆盖，不代表事实已确定。

WorkRef的ID/revision/hash用于任务定位。P2人物、地点通过本任务查询读取；P3的分配目录经版本核验后可以支持保持现状的结论，相关候选提示通过详情查证。新建或修改事件线前读取相关节点及已有事件线详情，解决原事项前读取该事项详情；未核实项保留待办。

finalizer只校验/收集总结；结束钩子由Coordinator在短事务重核依赖后保存TaskRecord.reviewedItems和coverageItems。没有合法最终总结时，已写业务仍有效，分配项不能凭commitId自动全部checked；下次从原确认和当前事实继续检查。completed summary要求remaining为空，partial要求仍有剩余；预算耗尽的代码partial可以没有模型summary。

删除项标skipped/outcome=deleted并写原因；合并旧ID标skipped/redirected，解析目标若已存在对应清单不重复建项，未存在则新建pending目标。新建/新改项在终态前再次枚举加入，覆盖统计是派生值。最终同事务核有效清单、依赖和状态：无pending/assigned/stale、无未处理prepared意图、相关task已结束才可completed。P2/P3并行只比较自身清单和实际读取的跨域依赖；合理孤点和needs_review可保留。无法检查完时明确partial/paused/degraded，禁止用“最后一页/模型说完成/孤点为0”替代覆盖证明。

## 2026-10-23 · 字段与工具契约对接

> 当前缺陷策略已由用户改为“规划时修复”。以下ALG-FIX和07优先于任何历史“忠实保留BUG”的描述；计划指纹必须包含bugfixPolicyRevision=2026-10-24.fix-first，旧策略覆盖不能当成新策略已检查。

## ALG-FIX 已知缺陷的修复行为

固定触发与回归方法见[缺陷验收](07-验收与兼容缺陷.md)。行为以相应能力规格为准。
