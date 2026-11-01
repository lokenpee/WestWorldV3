# WestWorld V2 · 详细规格：流程、接口与算法

> **阶段0修订（2026-10-24）：** P2持有world域锁时禁止同书人物/地点人工写入，P3持有narrative域锁时禁止节点/事件线人工写入；UI与命令事务均校验，拒绝返回`ASSET_DOMAIN_LOCKED`。取消须等在途提交停止并释放锁才恢复编辑。P1人工编辑、跨书编辑、只读和备份不受此域锁限制。P2/P3仍可并行，保留跨域实际读依赖校验。direct首次/网络重发/至多一次修正合计最多3次实际请求；P2身份核实按[世界资产整理决策](../decisions/world-organization.md)收尾；P3预算见[叙事整理的排队与恢复](../decisions/story-organization.md)。详见[阶段0决策](../decisions/stage-edit-lock-and-request-budget.md)及当前机器契约。历史证据不代表新规则已在业务应用执行。

| 文档控制项 | 内容 |
|---|---|
| 文档编号 | WW-LOGIC |
| 文档版本 | 2.2 |
| 产品 / 应用包版本 | WestWorld V2 / 1.0.0 |
| 复现基线 | WWV2-WORKTREE-20261021；实际工作区快照，含未提交文件 |
| 文档状态 | 2.2 目标规格待评审；本次只改文档，未宣称应用已实现 |
| 编写 / 维护 | Codex 编写；后续维护责任人待指定 |
| 产品决策 / 审核 | 用户；本文尚未标记为已审核通过 |
| 创建 / 更新 | 2026-10-21 / 2026-10-24（Asia/Shanghai） |
| 共同术语 / 文档导航 | [统一入口](00-阅读入口与术语.md) |
| 缺陷策略 | 已知缺陷优先修复，禁止复现旧错误；07修复条款优先 |

### 修订记录

| 版本 | 日期 | 变更 | 影响 |
|---|---|---|---|
| 2.0 | 2026-10-21 | 建立正式重建规格、机器契约、交互与兼容验收 | 确立2.0规格基线与忠实复现范围；不修改应用 |
| 2.1 | 2026-10-21 | 补17张实际表、60组UI动作、14字段流、完整工具返回及独立验收 | 保留应用与兼容行为 |
| 2.2 | 2026-10-21 | 全书P1先行；P2世界资产整理与P3事件组织解耦；补实时编辑、批量合并和同书持续会话 | 目标设计变更；旧实现证据不作新验收结论 |
| 2.2 | 2026-10-22 | 用户澄清：提取直接存实体，后续直接CRUD/合并；删除草稿/入库双层 | 单书15表，无发布按钮或重编号 |
| 2.2 | 2026-10-22 | AI统一Pi：direct/agent共用模型层、校验与错误；Agent受控工具读写，应用持久化长期记忆 | 目标规格澄清；未改应用代码 |
| 2.2 | 2026-10-23 | 补18表完整字段与样例、16业务工具契约、Pi迁移/coding取舍与禁用能力 | 明确当前实现与目标补充；专项验收待应用执行 |
| 2.2 | 2026-10-24 | 明确任务身份、命令意图、逐项覆盖、完整Prompt组装和隔离探测；补接口与验收夹具 | 目标需求补全；应用及独立重建仍待执行 |
| 2.2 | 2026-10-24 | 用户明确要求规划时修复已知缺陷，撤销错误行为兼容义务 | 修复后结果作为重建验收；旧失败只作历史证据 |

> **版本边界：** 本文为2.2目标规格。2.1源码取证、旧机器契约、截图和51项历史验收只证明旧实现；新流程的权威机器补充见[2.2契约](resources/v2.2/pipeline-contract.json)，变更对照见[13](13-流程变更与冲突对照.md)。未涉及的字段与算法沿用旧定义；不得把旧资源的流程、锁、会话和按钮规则用于覆盖2.2。

## 1. 接口边界与返回约定

本应用没有独立业务REST API。以下为重建所需的内部能力契约，允许更换文件组织但输入、结果、副作用与入口行为必须等价。TypeScript类型、可选参数及默认值详见随包[完整内部契约](resources/internal-contracts.md)；不得将此附件误解为业务算法实现。

| 能力 | 输入 | 结果 | 副作用 / 错误 |
|---|---|---|---|
| decodeBytes/decodeWith | ArrayBuffer；手选编码可选 | text/encoding/ok 或text | 无保存；自动UTF8 fatal后GBK |
| parseChapterRegex | string | RegExp | 空/无效报错；自动gm |
| splitChapters | text、regex?、maxChunkChars=10000、fallbackWindowChars=4000 | ChapterDraft[] | 无保存；零宽匹配报错 |
| importBook | id/title/text/sourceFileName?/split? | book、chapterCount、章摘要 | 建书、保存章节/文本、P1 idle；空章结果报错 |
| extractChapter | bookId/chapterIndex/chapterName/text；call?/signal?/onlyStages? | 三类资产、usages、failures | 调模型，不直接保存 |
| runP1 | bookId、chapterConcurrency=1（固定）、signal/deps/bus | status/total/completed/failed/cost/failures | 部分成功保存、更新P1进度 |
| runAll（兼容入口） | bookId、恢复/signal/deps | p1及本次费用，不产生merge/link结果 | 2.2停用自动连跑；兼容入口仅启动全书P1 |
| runTestStage | bookId、p1/p2-merge/p2-link/p3 | status、cost | 2.2仅允许隔离诊断副本，不写正式进度 |
| runMerge | bookId、stage=P2、scope=fullBook、runId/signal | status/人物地点前后数/cost/degraded | 合并事务；冲突抛错；取消不交在途组，保留已提交组及报告 |
| runLink | bookId、stage=P3、windowSize=100/overlap=20、phase/sessionId/runId | status/节点线数/批数/失败/补点/跳过/cost | 校验和批事务；取消保留先前批次 |
| 四类update | bookId/id/patch | void | 校验必要字段和expectedRevision；不存在行返回NOT_FOUND，不得静默成功 |
| 人物地点merge | bookId/kind/keepId/selectedIds/canonicalName/expectedRevisions | report | 保留keep，融合并删除其余；keep不存在抛错 |
| 四类delete | bookId/id | void | 节点/线清理引用，来源墓碑及相关覆盖有效性同事务更新 |
| exportBook | bookId | fileName/bytes/manifest | 单书读取；不存在书报错 |
| inspectBackup | Uint8Array | ok/errors/manifest?/stats? | 损坏/畸形JSON统一返回ok=false/errors，不产生未处理拒绝 |
| importBackup | Uint8Array | bookId/chapterCount | 新书恢复；无覆盖；完整恢复后发布书架，日志支持跨库恢复 |
| deleteAssetBook | bookId | void | 三个资源排他租约；删除本书库和书架 |
| tryOneChapter | bookId、chapterIndex? | 原文片段/三类结果/failures/cost/duration | 默认首章；不保存提取资产 |

未变函数沿用已有异步/抛错边界；变更函数按2.2新增的凭证、revision和报告边界执行；模型返回失败对象不等于所有外围代码永不抛异常。入口的catch/finally和友好错误呈现按UI Spec保留。

## ALG-01 解码、正则和分章

1. 自动解码使用UTF-8 fatal TextDecoder，成功去开头BOM；异常后GBK TextDecoder。手选UTF8不使用fatal。不得添加编码检测模型。
2. 正则输入先trim，空时报“分章正则不能为空，可以点击恢复默认。”；匹配`^/([\s\S]*)/([a-z]*)$`时拆正文/flags，否则整个输入为正文；补齐g/m，原flags保留。语法异常包装“分章正则无效：…”。
3. 默认正则必须使用[黄金结果](resources/golden-results.json)的regex原值；匹配中文数字、阿拉伯数字及空格标题。使用前lastIndex=0；无g时报错；任意匹配长度0报错避免循环。
4. 捕获组1存在用其内容，否则用完整匹配；trim后为空则忽略。真实标题起点=`match.index+fullMatch.indexOf(captured)`；找不到偏移取0。
5. 有标题时，非空前缀保存为序文chapterIndex=0；纯空白前缀并入首章。正文切片不trim，拼接必须还原规范化输入。标题章仍按匹配顺序1..N编号，不取原标题数字。
6. 无标题时按固定4000 UTF-16 code units逐段切为“第 n 段”，无重叠；空文本结果[]。
7. 长章超过10000按固定长度切块，编号`index.part`、名称`原标题（第 part 块）`；不按句子修正，不设重叠；所有输出order统一从0重排。
8. charCount=text.length，为JavaScript字符串长度。非BMP字符按两个UTF-16单位计；不可替换成Unicode code point或中文分词数。

## ALG-02 P1逐章提交、即时刷新与恢复

按Chapter.order排序，单章在途。对每章依次尝试worldAssets、narrativeAssets，互不携带前一响应；世界失败仍尝试叙事，取消则停止后续调用。成功请求使用原提取Schema；同章人物/地点仅去除规范完整DTO相同项，不按名称丢弃不同资料，跨章不去重，ID由代码分配，节点order从0、createdBy=P1。

每个子步骤事务执行：核当前runId/owner及取消状态→查`extractionReceipts[chapterIndex:substep]`→无成功凭证时创建资产和live生命周期记录→写success凭证（含inputFingerprint和originIds）→更新P1 completed/failed/partial→提交。已有成功凭证直接跳过，不用bulkPut覆盖现有资产。若旧迁移中已有当前行但无成功凭证，重新提取分配本章同类型尚未使用的序号（检查当前行、来源映射和墓碑），保留既有资料，不覆盖/复活旧ID；重复候选之后由用户或P2整理。资产提交、凭证与进度必须同事务，消除旧版“资产已存而进度未存”的恢复缝隙。

凭证与当前行数量无关：用户修改、删除或并入条目不删除凭证；assetLifecycle保存merged/deleted状态或最终目标。重试不得重建这些originIds。每个成功事务完成后使响应式查询失效，最迟该章结束前可在表中看到成功内容；刷新不依赖日历、100章窗口或P2。

每个子步骤遵循05的3次实际请求总预算，章节外不再叠加重试。某子步骤失败只记录失败及缺口，保留成功部分；继续补缺，不强制重提成功部分。缺原文记录失败。全书所有章块两凭证齐备才completed；否则按running/failed/cancelled/paused记录。取消后在途响应丢弃，既有提交保留。手工新增行用U-UUID空间，不与模型C章-P/L/N编号碰撞。

P1结束仅解锁P2/P3，不启动它们。单章试跑不写这些表或凭证。

继续提取沿用原运行编号，子步骤执行记录保存请求次数、完成或失败状态与错误原因，用量累计到同一运行。开始前逐条核对成功凭证与来源记录：有效当前条目、并入后的保留目标、删除记录都保留成功认定；来源缺失或映射形成环时停止并提示检查资料。

浏览器排他执行权按设置库与书籍区分，持有期间覆盖整个提取任务；数据库事务同时校验运行编号、持有者和到期时间。打开页面只恢复进度展示；刷新中断后，执行权到期且没有浏览器执行者时，将原任务标为暂停并开放“继续提取”。运行中的其他标签页保留执行权。恢复和晚到回复均重新核对持有者，取消等待在途调用结束后释放执行权。

## ALG-03 阶段门槛、窗口与独立恢复

### 正式调度

startP1/startP2/startP3均接受bookId及独立signal/runId；P2/P3的服务前置再次核全书P1成功凭证覆盖全部章块。P2不检查P3，P3不检查P2。已有P1完成时“继续P1”跳过成功子步骤；旧runAll只能作为启动P1的兼容适配，不再自动连跑。

P2子阶段为mechanical、ai_identity、optimize、report；P3子阶段为window_link、global_review。各阶段独立进度、租约、报告与取消，某阶段失败不得覆写另一阶段状态。停用正式库前100章四按钮测试和testScope放行。诊断样本必须隔离，不能产生正式完成记录。

### P3窗口

按Chapter.order排序，以chapterIndex点前部分聚成原章，全部切块跟随原章。窗口size=100、overlap=20、stride=80，使用原章顺序零基半开区间`[0,100)`、`[80,180)`、`[160,260)`；末窗到末章停止，空书不得启动。240章的窗口为第1–100、81–180、161–240章，不能另开第241章空窗口。

窗口按顺序执行，复用同sessionId；400节点等只读/调用容量是窗口内分页，不改变窗口定义。窗口覆盖清单记录全部节点ID和分页游标；未扫描完成的页不能标整个窗口完成。重叠节点先查已有成员，优先append/update同线，重复完全相同成员create幂等跳过。

### 恢复和复核

P3窗口全部完成后才创建全书复核工作清单：全部孤点、全部事件线、未解决/过期事项。清单按稳定ID分页，记录每项已检查的事实指纹与结论；新补节点/新线加入队列，已删项记跳过原因。全书复核按需跨线、跨窗查证并回原文；30线一批只是分页上限，不能只看首30/50条就声称全书看完。

任务计划键含version=2.2、scope=fullBook、原章窗口、策略阈值和phase。检查点仅在对应输入/输出依赖和覆盖游标仍有效时跳过；重查在原会话追加任务并废弃相关旧检查点，不归档会话。取消/失败保留已提交批和游标；单批达到步数/预算上限则拆更小子任务继续，未完成项不能被计作已覆盖。

完成表示全范围检查结束且无失败批、未处理工作项或过期依赖；允许明确保留孤点和有依据的待复核事项。世界变化命中已读依赖时入复核队列；持续变化导致无法收敛时paused并列出剩余项，不能假报完成。

## ALG-04 名称归一化、聚组与融合

### 名称标准化

按顺序：合并空白为一个空格并trim；依次去末尾卷章版本后缀：数字+卷章回部篇节、卷+数字、v/ver及数字、新版/旧版/重做版/重制版/修订版/临时版/备份/资产/重复/改及对应括号形式；若清空退回原名trim。比较名再toLowerCase并去指定中英文标点空白。精确正则集见[规则参数](resources/algorithm-parameters.json)，不得泛化为去除全部Unicode标点。

### 两轮本地聚组

代码整理独立运行两轮聚组，展示候选并允许选择组内实际成员；用户选择成员后可直接确认，名称不同时在候选栏选择主名；可按需打开预览调整保留编号与主名，通过版本校验再融合。AI整理可独立启动，通过Pi查询资料与原文后提交合并，再按需整编。两个入口分别保存报告。

每条初始一组。第一轮按名称相等/包含建立候选；连通分量只服务检索，不授权删除不同originId的实体。人物地点都不能仅凭同名/包含自动融合。

第二轮将组内主名/别名归一化、去重排序，比较集合相似度：名称相似度=`1-LevenshteinDistance/max(lenA,lenB)`，相同为1、空一方为0；建立最大权重一对一配对，权重=`round(similarity*max(lenA,lenB))`，短侧补空。集合分数=`2*最佳权重和/两组全部名称字符总量`；严格`>0.9`加入相似候选，恰好0.9不因本条件入候选；候选不直接落融合结果，须人工确认或有效AI证据。

以下目标选择与字段融合仅适用于人工已确认或AI证据通过的组；候选本身不执行。确认组仅有一条manualKeep=true时优先保留该条；多个manualKeep目标或人工主名冲突不自动合并并报告待选择。无人工目标时保留ID numeric localeCompare最早；不使用旧pickMainByQuality方案。指定范围选择记录依据chapterIndex或sourceChapters与范围相交；范围外原记录保留。

### 本地融合

文本按中英文分号和换行拆、trim、去空去重，按首次出现顺序用中文分号连接。融合优先把keep放第一项。名称与已有别名全集去掉保留主名；sourceChapters合并按numeric localeCompare排序。人物关系按target/relation_type/direction(缺省空串)联合键去重，相同关系标签融合。

profile.age/gender保留目标现值，缺值补充；冲突记录“字段 冲突：旧 / 新（第 章 章），保留最早值，待复核”。ageText按文本融合。组内manual层级优先于keep和其他自动层级；自动合并更新updatedAt。地点description融合，来源和冲突并集。

### P2 AI精简判同、详细整编及报告

机械阶段先生成候选及报告，不因名称信号删除不同来源实体。AI判同通过`query_characters`/`query_locations`分页读取精简行：id/name/aliases、身份摘要或地点类型提示（最多160字符）、sourceChapters、revision、estimatedDetailTokens、duplicateScore，不包含完整性格、背景、外貌、process或description。Token与重复度由本地计算，仅返回指标。AI可自主选候选，通过按ID详情工具/read_original核实；不默认读取所有详细档案。

人物、地点按稳定编号建立持久待办清单，每次安排最多3个待办，逐个资产执行。模型可跨批检索同名和别名对象，合并仍核对完整成员及原文依据。每批保存已核实范围、资料指纹和实际读依赖，部分完成只确认已核实项；单项按[世界资产整理决策](../decisions/world-organization.md)提前收尾，未完成项保留待办，让后续资产继续。P2单项失败或未完成时继续后续资产；本轮全部尝试后，由用户继续剩余项。取消、失败或刷新后沿用本次运行及有效覆盖，变化资料重新核对。全量查询使用after_id稳定游标而非边删除边递增offset，按ID码点字典序读；新插入在游标之前的记录由末次清单校验补入待办。同时允许按名称检索其他页；所有分页都覆盖后才完成判同。Agent调用commit_asset_changes以资产ID分组（同名不同ID可区分），`keepId/memberIds/canonicalName/reason/confidence/evidence`限定本次已查询的同类当前ID，至少两条；主名选已有称呼，人工自定主名及人工保留目标优先。跨页组须把成员查询纳入本次读集，不能凭未读取名称提交。写工具execute中的共用命令服务再次核记录revision并调用与手工相同的机械融合；AI判同自身不压缩长文本。

整编候选在机械与AI判同后重新计算。新增明确触发：详细字段估算>1200 tokens，或同字段非完全相同片段的3-gram字符Jaccard重复度>=0.85（每片段去空白、至少20字符）；保留原有冲突、1800字符/8事实以及高频重要人物触发。完全相同片段已在机械融合去重，不重复提交整编。人物和地点都进入候选；指标仅控制读取/整编，不用于实体判同。

人物事实底稿仅identity/appearance/personality/background。已有mergeFacts则沿用，不把整编展示文案反复当新事实；无底稿才按字段拆文本产生事实。事实ID为FNV样式32位：初值2166136261，对`${field}\0${text}`每个Unicode字符的codePoint进行xor与Math.imul(...,16777619)，无符号转hex加F；哈希冲突加_1等后缀。相同field/text合并来源，最终按id排序。

optimizationFingerprint包含策略版本及JSON对象{names:归一化排序称呼,facts:[id,field,text]列表,notes:mergeNotes或[]}。相同策略/事实指纹跳过；否则满足新增Token/近重复指标或任一旧触发（mergeNotes、>1800字符、字段≥8事实、重要人物的原章/事实频次）即整编，均不满足才跳过。

输入仅未优化事实（若为空则全部事实），按本人物短号F1/F2重新编号，带previous四字段。单批最多3人，输入预算为`min(6000,floor(capacity*0.45))`；capacity=window-reserve-Prompt估算-Schema估算-1024。单条超capacity不发请求并降级；发送前再核对动态Schema和输入总预算。temperature0；maxTokens=min(16384,reserve,model.maxTokens或16384)。

提交校验固定人物键、完整不重复事实短号、主名和别名来自原有称呼、有事实字段不得变空；成功只更新四文本字段、主名/别名/冲突和缓存，不用它重新判层级。失败保留本地底稿并degraded。地点满足同样的过长/重复/冲突触发时按需读取description事实，建立同人物类似的mergeFacts底稿和事实ID，验证完整覆盖后替换展示描述；保留底稿与来源，不把旧重复长描述重新追加到展示文本。maxTokens8192、temperature0。

每组提交前bulkGet并比较revision和生命周期目标；变化/删除则拒绝该组，记录冲突并可重新查询重试，不覆盖人工结果。机械单组事务写keep、删除被并入当前行、写redirect/来源映射和该组报告；Agent写命令若含多个组，则这些组与同一命令凭据同事务全成或全败，不能先部分写再记账。取消只停止未提交组；已提交结果不可因后续AI失败回滚。

P2结束统计各类型开始数、机械后/判同后/整编后数量；合并组数与减少条数分开计数。每组记录阶段、成员ID/名称、保留ID/主名、别名、来源、冲突和整编前后token估算；报告聚合skipped/failed/conflicted、费用/用量、状态completed/degraded/failed/cancelled。无合并也生成零变更报告。报告与阶段终态持久化，UI自动弹出且可重开。

阶段结束前须重新枚举当前所属资产域的ID/revision，与本次覆盖清单比对；在取得阶段锁前或暂停解锁期间发生的人工新增、删改、并入导致遗漏时加入待办后继续，不能仅沿初始清单宣称完成。多次变化无法在本轮完成则paused/stale并列明剩余项。报告的前后数是开始/结束两次快照，同时记录externalChanges，不能把用户手工变化计作P2自动减少条数。

## ALG-05 主名出场与层级

1. scope=(processedIds或所有正文标识)去点后按原章去重。name=trim().toLowerCase；不使用别名和sourceChapters计数。
2. 重名实体无法唯一归属则不放匹配表达式；其余名称按长度降序、locale顺序排序，转义后以`|`组成gu正则。正文小写，matchAll是非重叠匹配；长名优先。
3. 每次命中mentions+1、原章加入Set；chapters为覆盖Set大小，scopeChapters为scope大小。
4. higher为章节数更大或同章节提及更大者数，same为两项都相同者数；percentile=`(higher+(same-1)/2)/max(1,实体数-1)`。
5. 多个人全部同频→NPC；否则<0.1主要、<0.3重要、<0.8 NPC、其余路人。只有一个人物时不是flat，按公式可为主要人物。
6. roleWeightSource=manual不覆盖，仍更新frequency；非manual写frequency与对应层级。AI调整主名后须再次计算，地点同样记录频次但不加人物层级。

## ALG-06 串联、补点与批提交

只在P3执行。先按ALG-03窗口扫描，再全书复核；同书持续会话贯穿全部子任务和恢复。输入提供阶段、分配目录、相关旧资料摘要、有限事件线提示和工作记忆，细节通过工具获取。批次按数量与估算内容量共同限制，相关候选可继续检索和分页。

window_link通过commit_story_changes的payload提交操作；每个操作须有confidence和evidenceNodeIds/reason，默认阈值>=0.85；代码校验数值与引用，低于阈值不写线，只记复核事项。模型置信度不是语义准确率保证。global_review同样仅在证据充分时写入，疑点保留说明；不得要求孤点数归零，也不得凭“逻辑应有”编造新事件。

commit_story_changes的execute调用共用服务，提交前验证：补点结构、临时ID本批唯一且不与节点冲突、章节存在且可读取，参考引文按matched/unmatched/empty记录而不阻断提交；每个操作node_ids非空且存在（含合法临时ID）；append/update的线存在；merge保留和被并入线存在且不自并；memory结构引用有效。

补点如同章同name同quote已存在则临时ID映射旧ID；否则编号，offset=source.indexOf(quote)，order初放章末、confidence0.6、createdBy=P3。若同章所有成员quote均可定位，按source.indexOf再旧order重排order。

线操作语义：create遇完全相同成员集合的已有线跳过；append合并旧有效成员和新增；update用提交成员替换；merge合并keep、merge_line_ids及新成员后删除其余线。成员去重按章节比较器、章内order排序。标题仅create采用提交title，其余保留旧title；cause/process/result/status使用本次提交。

派生chapters去重按章节比较器，timeRange取已有timeCoord字符串最小最大；无坐标时不生成。线characterIds若重算仅取当前读取的actorIds，不根据P2结果同步写新实体映射；查询时统一派生。提交服务清理本次受影响的空线，重算受影响节点eventLineIds，准备记忆与检查点；在事务内验证本批实际叙事读写集、查询集合依赖、记忆revision、本批读取的世界记录revision及active session/租约；随后只写本命令涉及的节点/线/记忆/notes/checkpoint及commit条目。禁止沿用旧实现“比较全部线并clear整表再bulkPut”的提交方式，否则无关人工修改也会阻断本批。冲突抛错，无部分事务提交。成功事务须更新本次检查对象的覆盖版本；逐项覆盖结构已在03第10节和本文件ALG-12.4–6定义，不能仅凭一个checked计数代替。

恢复若非recheck且checkpoint completed、输入指纹和节点成员快照仍一致，则跳过。单批失败记录failed checkpoint、保留前批结果；取消记录cancelled。全书复核按孤点/线/事项工作队列分页，线分页最多30条，可跨组merge；已被合并的线解析映射或记跳过，新生成项加入覆盖队列。即使没有任何节点，也在未取消时执行清理persist。

## ALG-07 人工更新、合并与删除

人工新增和修改均校验：人物/地点name非空，节点name/summary/chapterIndex有效，参考引文按定位状态记录，线title与至少一个有效nodeId；其他字段按既有结构允许缺省。CSV按中英文逗号拆并trim去空。每次提交带expectedRevision，不存在或变化返回CONFLICT，新增人工行使用U-UUID并标createdBy=manual。人物profile.ageText用Dexie点路径更新，不覆盖age/gender。

人物四文本变化且已有mergeFacts：删除被修改字段的旧事实，按新字段构造事实重新合入，移除对应optimizedFactIds并清优化指纹；其他更新加updatedAt。直接层级操作写manual。地点改描述时同步重建description底稿并清整编缓存、加updatedAt。节点或线修改涉及章序、成员、actor称呼时重算相关章/成员反向引用；实体ID引用在读取时派生，不把用户改称呼直接写成实体ID。所有修改递增revision。

手动合并只接受同类至少两项、全部存在的selectedIds，keepId必须在其中；预览绑定所有revision。默认保留用户选中目标；不同名称要求明确确认canonicalName，可选所选主名/别名或输入新非空名，其他称呼归别名。复用本地融合，不调用AI/不做语义压缩；写人工主名优先标记和manualKeep=true。事务写目标、删除其他当前行、更新assetLifecycle为merged→keepId（展开旧redirect链、禁止循环），写手工报告。任何选中行变化都返回CONFLICT，不静默忽略缺项。

单条删除写deleted墓碑；并入目标后被删除时，指向它的来源一并视为deleted，不复活被并入行。凭证仍为成功；重跑P1不恢复已删来源。人物/地点操作直接修改当前实体；人物删除、改名、合并同步维护节点人物编号与显示名称。原文章节和参考引文保留。无自动拆分/撤销；可从合并前备份恢复为新书。删节点在节点/线事务内重算每条线成员、章节、时间、人物，删空线，重建所有节点的反向归属；删线移除节点eventLineIds中的该ID。

## ALG-08 当前实体及人物引用读取

P1人物/地点直接写characters/locations，字段沿用提取资料、来源和合并底稿；speech_style_sample在存储边界映射为speechStyleSample。当前实体ID创建后稳定，不生成P001/L001第二套编号。所有人工操作及P2都直接写同表，不存在publishCanon入口。

节点以actorIds与targetCharacterIds保存人物关联，actors/targets保存当前名称。初始名称唯一时绑定编号，同名时选择身份；删除人物移除对应编号和名称；合并按来源编号替换为保留编号与主名并去重。人物变更、节点关联及修订号同事务更新。事件线人物集合由当前成员节点的两类人物编号并集生成。

人工表单将两类人物合并为“涉及人物”，保留已有归类并将新增选择写入行动人物。用户移除人物时清理两类关联；待关联称呼单独保留，已有非人物对象保留原始值并在详细经过中补充一次。搜索与选择使用人物编号，姓名仅用于显示与匹配。

精确重复称呼和模糊多候选必须显示匹配依据与歧义，不能默认为已经消歧。关联维护更新节点显示名称，原文章节和参考引文保留。事件线成员及节点eventLineIds仍由叙事操作事务保持一致。

阶段结果过期只表示需要重新整理，不影响当前实体可查询、可编辑、可导出；没有数据发布门槛或冻结状态。

## ALG-09 图布局

章节比较器按点分段转Number，有限数不同则相减；非数字比较字符串；缺段一方更早。节点按chapter、order、id排序，重复id用Map保留最后记录。

节点框200×106；水平STEP260；颜色循环`#65963c,#d78242,#8e65ae,#3995a8,#bd526c,#b09632`。线成员去重过滤不存在节点；孤点y100；有孤点则第一泳道290，否则120；每条线泳道y=firstLane+index*180，共享节点y取所属泳道平均。

章节集合包括传入所有章和已有节点章，空章也保留刻度。cursor40；每章previous=cursor-14；成员按顺序x=previous+14并与占用带冲突取max；垂直占用带按floor(y/50)到floor((y+106)/50)覆盖，各带写x+260。章width=max(260,previous+260-cursor)，cursor累加。总width=cursor+40，height=firstLane+线数*180+150。

每条线依图中成员先后仅连相邻点，边id=`lineId:source->target`，source/target handle=`out:lineId`/`in:lineId`。不得按共享人物或章节重叠增边。精确坐标和边可比对golden-results。

## ALG-10 导出、恢复和删除

数据格式与校验见DATA-05。目录保存先queryPermission，再必要时requestPermission，仍非granted则失败。createWritable后write Blob并await close才成功；失败尝试abort再抛错。下载Blob URL插入临时a并click移除，书架路径延迟1000ms revoke；设置路径同样至少延迟1000ms revoke，修复过早回收差异。

整书删除在三个资源排他租约中关闭缓存数据库实例、删除数据库、删除全局books记录。无回收站，不清除本地导出和设置。下载文件名和目录权限不由“建议项目目录”字符串自动授权。

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

本节为2026-10-24补全的目标规则。runId代表一次用户发起的阶段运行；taskId为应用在发请求前分配并持久化的UUID，代表一份固定分配清单。重连、模型网络重试、校验修正保持同runId/taskId；用户点击“重新检查”创建新runId；partial后的剩余项形成新taskId，但P3始终保持同一逻辑sessionId。

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

### 文本保全、文件入口和P1提交

导入先去一个开头BOM、将CRLF/CR统一为LF，除此之外不删除正文字符。有非空首标题前缀时建立序文chapterIndex=0、chapterName=序文；纯空白前缀并入第一标题章。标题章仍为1..N；序文超长可切0.1/0.2。序文参与P1及原章窗口，按order处理。任意切章/切块后的text按order无分隔拼接，必须精确等于规范化输入；无法满足则阻止导入，不静默丢内容。只有全空白文件拒绝；没有标题仍按固定窗口切片。

选择和拖放共用服务：恰好一个文件，文件名按不区分大小写的.txt后缀判断，MIME只作提示；reject多文件/错误后缀/解码后全空白。加载开始清除当前可导入预览并递增loadToken；异步read/decode/split完成或失败只在token仍为最新时更新界面。busy时两个入口均禁用；仍从底层并发触发时token守卫有效。旧预览不能在新文件失败后继续导入。

P1世界提交须校验trim(name)非空、必填值类型/范围；完整DTO规范JSON相同才去重，同名不同资料保留为独立ID。P1叙事参考引文可为空；精确匹配时由代码设置offset并记matched，无法定位时记unmatched，空引文记empty。未匹配不触发修正或使提取失败，其他结构错误按统一预算处理。参考引文定位状态单独显示，完整章节可供回查。

### 名称候选与有证据的融合

机械阶段保留原归一化和相似度**计算**，移除以名称信号直接融合不同originId的动作。相等、包含、严格>0.9分别形成候选边，不增加“同一实体已确认”含义；连通分量也不允许传递性自动删除。单纯候选阶段前后人物/地点数量不变。已确认的同origin命令重放由receipt/账本跳过，不再次融合。

人工明确选择成员、keepId和主名并通过revision校验后，可直接使用原机械字段融合算法。AI commit_asset_changes每组新增必填confidence∈[0.9,1]、evidence 1–10项；每项为{chapterIndex,quote,memberIds}。证据memberIds必须为本组非空子集，所有证据成员并集必须覆盖整组；quote为1–1000字符且逐字存在于指定本书章。每个被引用成员至少有一个已知主名/别名出现在对应引文中；成员资料/原文均须进入实际读集。没有证据、编造引文、漏成员、低置信或仅说“名称包含”都返回INVALID_ARGS，整命令无写入。

模型必须论证同一身份，不能用相似外貌、同姓、地点包含或同名替代；既有人工保护/主名冲突守卫继续适用。引用/阈值是硬校验，文学语义判断仍可能不确定：不确定就保留分开，报告待核实，不强行凑合并数量。手工确认不需要伪造AI confidence/evidence，其路径仍有显式预览与revision校验。

### 备份验证与可恢复跨库生命周期

inspectBackup必须捕获ZIP/manifest/JSON解析、文件缺失、hash错误、Schema及引用/循环错误，返回{ok:false,errors:[{code,path,message}]}；不得仅统计行数便返回ok，也不得让畸形统计JSON产生未处理Promise拒绝。预检失败不创建任何书架项或书库。v4输入先按确定迁移规则转成目标对象，再执行目标校验；不猜补缺失原文。

物理上全局库与单书库仍不能同事务，但用户可见生命周期必须可恢复：

1. 导入分配新bookId/operationId，在T02写key=book.lifecycle:{operationId}，value.action=import、state=preparing。该日志成功后才创建目标书库；整书目标数据同单书事务写入，未完成不写books。
2. 单书事务成功后，日志置ready并保存待发布Book元数据。最后在全局同一事务put books并删除该日志。只有这一步成功才提示导入成功/选择新书。
3. 出错时记录cleanup_pending；删除新库成功后删除日志。浏览器关闭可能留下preparing/ready日志，启动只枚举这些自有日志：ready且书库通过完整性复验则完成发布；preparing/cleanup_pending清理未发布库。不因库名猜测删除其他书。清理失败保留日志并显示可重试，不显示一个可用但缺数据的书。
4. 删书取得三域排他租约后，在全局事务写action=delete/state=deleting并移除books可用入口，再关闭/删除单书库，成功后移除日志。失败保留日志提示“删除待完成”，重启继续幂等删除；不恢复为正常可用书。

T02日志只作本机恢复协调，不随单书备份导出。日志中的book仅import/ready需要，必须与bookId一致；delete不得借日志改写另一书。启动恢复是非模型本地处理，不自动调用付费模型。

日志必须保存owner与leaseUntil；创建/接管时租约为当前毫秒+300000，活动操作每30000ms续租。AUTO-17只在租约过期且原owner不活跃时尝试接管，使用全局事务比较原owner/leaseUntil后写新owner，只有胜者恢复。无法探测活跃状态时至少等待租约到期；不可清理另一标签正在导入的preparing库。每次状态变更和发布前重核owner，失去租约的旧操作不得报成功；删除被其他连接阻塞时保持日志并提示等待，不移除日志假称删除完成。

### 引用、取消、金额与显示

人物名称用于初始编号绑定；同名时选择对应身份。已绑定编号保持稳定，删除或合并时按编号同步更新节点名称，不能仅按同名字符串批量修改其他人物的关联。事件线人物集合从当前节点关联派生。

任何退避Promise必须监听AbortSignal，取消在下一事件循环reject/返回cancelled并清理定时器/监听器；取消后禁止再请求、prepare新意图或提交未开始事务。已完成事务确认和费用保留。非法数字（NaN/Infinity/空串转换结果）不能被round/clamp后写入；有界整数配置先验证再应用范围。

模型元数据的pricingStatus、应用Usage.costStatus为known/estimated/unknown；缺省按unknown读取。known/estimated同时声明pricingCurrency；unknown不输出货币总额，界面显示“费用未知”，混合用量显示“已知部分+未知部分”，不能拿SDK缺价格时的0冒称免费。estimated明确显示估算，禁止擅自换成人民币符号。

小于768px的工作台采用上下排列/分区滚动，主操作不能被固定侧栏挤到不可达；375px与1440px均验收保存/取消/阶段操作。即时编辑成功使用服务返回的新revision记录，失败恢复控件；dirty表单遇外部变更保留输入并提示重新载入/重新提交。下载URL两入口均在click后至少1000ms回收；浏览器下载仅提示已触发，真实目录写入await close后才显示已保存。

本文件算法所操作的持久字段必须使用03第8–9节准确命名。世界精简查询的estimatedDetailTokens及duplicateScore计算见11第6.2节；写工具的执行/提交/重放见11第6.3–6.5节；不能把Agent最终submit_result再次作为业务增量应用。
