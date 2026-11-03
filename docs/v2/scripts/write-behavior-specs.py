from pathlib import Path
import runpy,json
OUT=Path(__file__).resolve().parent.parent
write=runpy.run_path(str(Path(__file__).with_name('write-specifications.py')))['write']

write('04-Spec-流程接口与算法.md',r'''
## 1. 接口边界与返回约定

本应用没有独立业务REST API。以下为重建所需的内部能力契约，允许更换文件组织但输入、结果、副作用与入口行为必须等价。TypeScript类型、可选参数及默认值详见随包[完整内部契约](resources/internal-contracts.md)；不得将此附件误解为业务算法实现。

| 能力 | 输入 | 结果 | 副作用 / 错误 |
|---|---|---|---|
| decodeBytes/decodeWith | ArrayBuffer；手选编码可选 | text/encoding/ok 或text | 无保存；自动UTF8 fatal后GBK |
| parseChapterRegex | string | RegExp | 空/无效报错；自动gm |
| splitChapters | text、regex?、maxChunkChars=10000、fallbackWindowChars=4000 | ChapterDraft[] | 无保存；零宽匹配报错 |
| importBook | id/title/text/sourceFileName?/split? | book、chapterCount、章摘要 | 建书、保存章节/文本、P1 idle；空章结果报错 |
| extractChapter | bookId/chapterIndex/chapterName/text；call?/signal?/onlyStages? | 三类资产、usages、failures | 调模型，不直接保存 |
| runP1 | bookId、concurrency=3、范围/signal/deps/bus | status/total/completed/failed/cost/failures | 部分成功保存、更新P1进度 |
| runAll | bookId、配置/恢复/signal/deps | p1、merge、link、totalCost | 同书锁、窗口和P3编排 |
| runTestStage | bookId、p1/p2-merge/p2-link/p3 | status、cost | 同书锁、样本范围、撤旧P3 |
| runMerge | bookId、stage=P2/useAi=true、范围/quiet/signal | status/人物地点前后数/cost/degraded | 合并事务；冲突抛错；取消不写本轮 |
| runLink | bookId、stage=P3、batchSize=400、review=false/recheck=false/session | status/节点线数/批数/失败/补点/跳过/cost | 校验和批事务；取消保留先前批次 |
| publishCanon | bookId、bus? | characters/locations/mappedNodes/mappedLines/unmappedNames | 替换当前实体与引用；不自验P3 |
| 四类update | bookId/id/patch | void | 更新指定草稿；不存在行通常无变化 |
| 人物地点merge | bookId/keepId/mergeIds | void | 保留keep，融合并删除其余；keep不存在抛错 |
| 四类delete | bookId/id | void | 节点/线清理引用；快照只删自身 |
| exportBook | bookId | fileName/bytes/manifest | 单书读取；不存在书报错 |
| inspectBackup | Uint8Array | ok/errors/manifest?/stats? | 常规错误作为结果；畸形统计JSON可拒绝Promise |
| importBackup | Uint8Array | bookId/chapterCount | 新书恢复；无覆盖；跨库非原子 |
| deleteAssetBook | bookId | void | 同书锁；删除本书库和书架 |
| tryOneChapter | bookId、chapterIndex? | 原文片段/三类结果/failures/cost/duration | 默认首章；不保存提取资产 |

所有函数应按现有异步完成与抛错边界实现；模型返回失败对象不等于所有外围代码永不抛异常。入口的catch/finally和友好错误呈现按UI Spec保留。

## ALG-01 解码、正则和分章

1. 自动解码使用UTF-8 fatal TextDecoder，成功去开头BOM；异常后GBK TextDecoder。手选UTF8不使用fatal。不得添加编码检测模型。
2. 正则输入先trim，空时报“分章正则不能为空，可以点击恢复默认。”；匹配`^/([\s\S]*)/([a-z]*)$`时拆正文/flags，否则整个输入为正文；补齐g/m，原flags保留。语法异常包装“分章正则无效：…”。
3. 默认正则必须使用[黄金结果](resources/golden-results.json)的regex原值；匹配中文数字、阿拉伯数字及空格标题。使用前lastIndex=0；无g时报错；任意匹配长度0报错避免循环。
4. 捕获组1存在用其内容，否则用完整匹配；trim后为空则忽略。真实标题起点=`match.index+fullMatch.indexOf(captured)`；找不到偏移取0。
5. 有标题时，仅从首个标题起点切到下个标题/文本末尾；不创建序言章（BUG-01）。章节编号取匹配顺序i+1，不提取原标题数字。
6. 无标题时按固定4000 UTF-16 code units逐段切为“第 n 段”，无重叠；空文本结果[]。
7. 长章超过10000按固定长度切块，编号`index.part`、名称`原标题（第 part 块）`；不按句子修正，不设重叠；所有输出order统一从0重排。
8. charCount=text.length，为JavaScript字符串长度。非BMP字符按两个UTF-16单位计；不可替换成Unicode code point或中文分词数。

## ALG-02 P1、部分成功与并发

世界提取提交WorldAssetsExtractionSchema；叙事提交NarrativeAssetsExtractionSchema。使用同章输入但不串接前次响应。结果赋bookId、chapterIndex、chapterName；人物地点先按trim后名称非空去重保留第一项，字段原值不因此统一trim；节点按输出序号编号，order从0、createdBy=P1。

runP1读取全部章节与P1进度；todo为“不在completed内且在指定范围内”。completed/failed分别为Set。partialChapters存尚缺`worldAssets/narrativeAssets`；恢复传onlyStages，成功部分不重复请求。每章读取正文，缺失则记录失败；该缺失分支不执行正常子步骤提交。

任务池limit=`max(1,min(concurrency,items.length))`，共享cursor，每个worker开始前检查signal；worker抛错由Promise.all向外传播，不统一吞掉。每章请求结束且signal未取消时将成功数组bulkPut（不主动清整章旧记录），随后更新completed/failed/partial与进度，分别写入两个事务。崩溃发生在二者之间可重复跑该章；ID相同的bulkPut覆盖，不清理旧多余ID。

P1最终状态：signal取消→cancelled；`done.size+failed.size<全部章块数`→paused；否则failed非空→failed；否则completed。指定范围仅完成部分全书时可paused。P1事件task:done由runtime store按失败数量转状态，阶段入口可额外发paused修正。

## ALG-03 窗口、完整流程和阶段测试

### 完整流程

按Chapter.order排序，以chapterIndex点前部分聚组；size=100/overlap=20，步长80，末窗到末章立即停止。校验size为正整数、overlap非负整数且小于size。planKey为`JSON.stringify({version:4,windows,useAi})`，保持键顺序。

checkpoint初始为P1有失败时-1，否则P2.lastWindowIndex或-1。满足以下任一项重置-1：无P1、P1总数与实际不符、recheck、P2.planKey不符；useAi时P2.editorSessionId与当前active会话ID不符也重置。

若旧P3 completed、checkpoint覆盖最后窗、P1无失败且非recheck，可直接发送P3完成事件返回，不重新做工作。否则ensureStorySession(bookId,recheck)，写P2 running。逐窗：P1→合并→串联；useAi=false跳过串联。合并degraded、串联failedBatches或本窗提取failures任一存在即窗口失败；否则记完成，且只有此前没有失败窗时推进lastWindowIndex。

取消后写P2 cancelled并返回，不做P3。未取消则P3固定两项：全书合并assets；runLink review=true检查lines。useAi=false将lines-skipped记失败。P3有本阶段失败、P2失败或P1失败时failed，否则completed。估算费用累加所有本次调用；合并/串联对象数取最近结果，累计字段不能误解为唯一对象总和。

### 分阶段测试

sample为size100/overlap0的第一窗口。空sample报错；预取消返回cancelled/0。非p1若sample存在未完成P1项则报“请先完成 P1 前 100 章提取…”；不检查P2是否已经成功。

通过前置后删除P3记录；p1另外删除P2，执行样本P1，不自动后续。其他阶段使用当前会话，`planKey=JSON.stringify({mode:'temporary-stage-test',scope})`。P2 scope=sample；P3 scope为所有已完成P1的章节。进度totalChapters固定2；本次事件total是p3为2、其他为1。p2-link若旧P2 planKey同，保留旧assets完成/失败项，其余重建；这使串联成功不会清除之前合并失败。

p2-merge只合并；p2-link只串联且recheck=true；p3全局合并+review=true。保存testScope，不提取剩余章。caught错误写failed/cancelled再抛给入口。所有流程共享同书内存锁，finally释放。

## ALG-04 名称归一化、聚组与融合

### 名称标准化

按顺序：合并空白为一个空格并trim；依次去末尾卷章版本后缀：数字+卷章回部篇节、卷+数字、v/ver及数字、新版/旧版/重做版/重制版/修订版/临时版/备份/草稿/重复/改及对应括号形式；若清空退回原名trim。比较名再toLowerCase并去指定中英文标点空白。精确正则集见[规则参数](resources/algorithm-parameters.json)，不得泛化为去除全部Unicode标点。

### 两轮本地聚组

每条初始一组。第一轮人物只比归一化主名，相等或一方包含另一方就合并，**没有短名≥2守卫**；地点只相等。所有匹配对用连通分量归并，不使用依赖遍历结果的贪心相邻合并。

第二轮将组内主名/别名归一化、去重排序，比较集合相似度：名称相似度=`1-LevenshteinDistance/max(lenA,lenB)`，相同为1、空一方为0；建立最大权重一对一配对，权重=`round(similarity*max(lenA,lenB))`，短侧补空。集合分数=`2*最佳权重和/两组全部名称字符总量`；严格`>0.9`合并，恰好0.9不合并。第一轮组完成后再一次性计算第二轮关系。

自动保留条目为ID numeric localeCompare最早；不得用旧pickMainByQuality方案。指定范围选择记录依据chapterIndex或sourceChapters与范围相交；范围外原记录保留。

### 本地融合

文本按中英文分号和换行拆、trim、去空去重，按首次出现顺序用中文分号连接。融合优先把keep放第一项。名称与已有别名全集去掉保留主名；sourceChapters合并按numeric localeCompare排序。人物关系按target/relation_type/direction(缺省空串)联合键去重，相同关系标签融合。

profile.age/gender保留目标现值，缺值补充；冲突记录“字段 冲突：旧 / 新（第 章 章），保留最早值，待复核”。ageText按文本融合。组内manual层级优先于keep和其他自动层级；自动合并更新updatedAt。地点description融合，来源和冲突并集。

### AI补充及人物整编

别名识别输入为精简档案，批起点每次+160、实际取180条（20条重叠）。只允许当前批主名，组至少两不同主名，canonicalName属于names。按组命中的现有分组融合，不因模型canonicalName改变“保留哪个ID”规则。

人物事实底稿仅identity/appearance/personality/background。已有mergeFacts则沿用，不把整编展示文案反复当新事实；无底稿才按字段拆文本产生事实。事实ID为FNV样式32位：初值2166136261，对`${field}\0${text}`每个Unicode字符的codePoint进行xor与Math.imul(...,16777619)，无符号转hex加F；哈希冲突加_1等后缀。相同field/text合并来源，最终按id排序。

optimizationFingerprint为JSON对象{names:归一化排序称呼,facts:[id,field,text]列表,notes:mergeNotes或[]}。相同指纹跳过。触发按顺序：有mergeNotes；总事实字符>1800或任字段事实≥8；主要/重要且来源原章≥3、任字段事实≥3。其他跳过。

输入仅未优化事实（若为空则全部事实），按本人物短号F1/F2重新编号，带previous四字段。单批最多3人，输入预算为`min(6000,floor(capacity*0.45))`；capacity=window-reserve-Prompt估算-Schema估算-1024。单条超capacity不发请求并降级；发送前再核对动态Schema和输入总预算。temperature0；maxTokens=min(16384,reserve,model.maxTokens或16384)。

提交校验固定人物键、完整不重复事实短号、主名和别名来自原有称呼、有事实字段不得变空；成功只更新四文本字段、主名/别名/冲突和缓存，不用它重新判层级。失败保留本地底稿并degraded。地点group>1且不同非空description>1时AI融合，maxTokens8192、temperature0，返回描述仍与本地description合入，不能替代底稿。

提交前bulkGet参与记录，序列化比较原读值；变化或删除则拒绝覆盖。事务删除选中旧快照后写新结果；取消不提交整轮。

## ALG-05 主名出场与层级

1. scope=(processedIds或所有正文标识)去点后按原章去重。name=trim().toLowerCase；不使用别名和sourceChapters计数。
2. 重名实体无法唯一归属则不放匹配表达式；其余名称按长度降序、locale顺序排序，转义后以`|`组成gu正则。正文小写，matchAll是非重叠匹配；长名优先。
3. 每次命中mentions+1、原章加入Set；chapters为覆盖Set大小，scopeChapters为scope大小。
4. higher为章节数更大或同章节提及更大者数，same为两项都相同者数；percentile=`(higher+(same-1)/2)/max(1,实体数-1)`。
5. 多个人全部同频→NPC；否则<0.1主要、<0.3重要、<0.8 NPC、其余路人。只有一个人物时不是flat，按公式可为主要人物。
6. roleWeightSource=manual不覆盖，仍更新frequency；非manual写frequency与对应层级。AI调整主名后须再次计算，地点同样记录频次但不加人物层级。

## ALG-06 串联、补点与批提交

全库节点和线建立Map，限定范围仅决定当前输入batch，不限制只读工具查询全书。selected按仓储排序，每400个batch；常驻消息给范围、节点ID、前50条线摘要，详情通过工具读取。

提交先验证：补点结构、临时ID本批唯一且不与节点冲突、章节原文含非空逐字quote；每个操作node_ids非空且存在（含合法临时ID）；append/update的线存在；merge保留和被并入线存在且不自并；memory结构引用有效。

补点如同章同name同quote已存在则临时ID映射旧ID；否则编号，offset=source.indexOf(quote)，order初放章末、confidence0.6、createdBy当前P2/P3。若同章所有成员quote均可定位，按source.indexOf再旧order重排order。

线操作语义：create遇完全相同成员集合的已有线跳过；append合并旧有效成员和新增；update用提交成员替换；merge合并keep、merge_line_ids及新成员后删除其余线。成员去重按章节比较器、章内order排序。标题仅create采用提交title，其余保留旧title；cause/process/result/status使用本次提交。

派生chapters去重按章节比较器，timeRange取已有timeCoord字符串最小最大；无坐标时不生成。线characterIds汇总成员actorIds。persist清理空线，重新计算节点eventLineIds，准备记忆与检查点；在事务内验证旧节点、全部线、记忆revision、资产签名和active session；随后节点/线/记忆/notes/checkpoint及commit条目同批提交。冲突抛错，无部分事务提交。

恢复若非recheck且checkpoint completed、输入指纹和节点成员快照仍一致，则跳过。单批失败记录failed checkpoint、保留前批结果；取消记录cancelled。P3 review将当时所有lineId按30条一组复核，可跨组merge；已被合并不存在的线跳过。即使没有任何节点，也在未取消时执行清理persist。

## ALG-07 人工更新、合并与删除

普通表单对字符串trim仅用于判空：trim为空写undefined，否则保留原文本；CSV按中英文逗号拆后逐项trim去空，不去重。人物profile.ageText用Dexie点路径更新，不覆盖age/gender。

人物四文本变化且已有mergeFacts：删除被修改字段的旧事实，按新字段构造事实重新合入，移除对应optimizedFactIds并清优化指纹；其他更新加updatedAt。直接层级操作写manual。地点更新加updatedAt；节点和线一般update不加统一更新时间或重算全部派生。

手动人物/地点合并只保留keepId，忽略不存在的其他项，调用本地融合后删除mergeIds。无撤销。人物/地点草稿删除不碰固定实体或文本引用。删节点在节点/线事务内重算每条线成员、章节、时间、人物，删空线，重建所有节点的反向归属；删线移除节点eventLineIds中的该ID。

## ALG-08 入库

底层函数不检查P3或加编译锁。人物地点草稿排序：用ID中`^C([\d.]+)-`提取后parseFloat作chapterNo，失败Infinity；相等再ID numeric localeCompare。保留这个与章节比较器不同的规则，不能修正成另一排序。

每次重编P001/L001；人物复制主名、全集别名去主名、层级缺省NPC、relations缺省[]及已有基础文本，speech_style_sample改键speechStyleSample；地点复制描述/别名/置信度。名称索引遍历排序人物全部称呼，比较归一化后只登记首次key。精确命中直接返回；否则包含模糊匹配使用较短名长度≥2守卫，候选实体ID Set大小=1才返回。缓存按输入trim后的raw。

节点actors与targets一起匹配，保持首次出现ID顺序去重；未命中raw名称Set收集，包括非法空名若经该路径传入。线characterIds按节点成员顺序取actorIds并集。在四表事务中clear characters/locations、bulkPut新实体、逐节点和线更新人物引用；不修改草稿或原始称呼。没有发布版本；实体ID可能随草稿删除变化。

## ALG-09 图布局

章节比较器按点分段转Number，有限数不同则相减；非数字比较字符串；缺段一方更早。节点按chapter、order、id排序，重复id用Map保留最后记录。

节点框200×106；水平STEP260；颜色循环`#65963c,#d78242,#8e65ae,#3995a8,#bd526c,#b09632`。线成员去重过滤不存在节点；孤点y100；有孤点则第一泳道290，否则120；每条线泳道y=firstLane+index*180，共享节点y取所属泳道平均。

章节集合包括传入所有章和已有节点章，空章也保留刻度。cursor40；每章previous=cursor-14；成员按顺序x=previous+14并与占用带冲突取max；垂直占用带按floor(y/50)到floor((y+106)/50)覆盖，各带写x+260。章width=max(260,previous+260-cursor)，cursor累加。总width=cursor+40，height=firstLane+线数*180+150。

每条线依图中成员先后仅连相邻点，边id=`lineId:source->target`，source/target handle=`out:lineId`/`in:lineId`。不得按共享人物或章节重叠增边。精确坐标和边可比对golden-results。

## ALG-10 导出、恢复和删除

数据格式与校验见DATA-05。目录保存先queryPermission，再必要时requestPermission，仍非granted则失败。createWritable后write Blob并await close才成功；失败尝试abort再抛错。下载Blob URL插入临时a并click移除，书架路径延迟1000ms revoke；设置路径立即revoke，保留入口差异。

整书删除在同书锁中关闭缓存数据库实例、删除数据库、删除全局books记录。无回收站，不清除本地导出和设置。下载文件名和目录权限不由“建议项目目录”字符串自动授权。

## ALG-11 进度与事件投影

task:start写running/stage/total并将成功失败cost归零；task:progress写counts/cost；task:done按failed或pendingFailures决定failed/completed、更新本次counts但不重新计算cost；task:cancelled写cancelled；paused/resumed分别写paused/running。日志level/text附毫秒时间戳和递增序号，只保留最后2000条。

beginRun清日志、counts和cost，建立新AbortController；cancelRun仅调用abort，不强制先写cancelling。reset重置状态/counts/total/controller，不显式清logs或stage。runtime store不按bookId过滤事件。持久进度排序updatedAt倒序、并列stage字符串倒序取首；UI runtime idle才选持久记录，遗留running仅显示为paused，不写回数据库。
''')

write('05-Spec-AI与会话.md',r'''
## AI-01 模型协议、配置与探测

必须锁定pi-ai/pi-agent-core 1.0.2并按配置角色选模型，providerId固定deepseek。缓存键为baseUrl/extractionModel/aggregationModel拼接，窗口覆盖在resolveModel时应用。已知模型用目录元数据，未知名复制目录首项模板再替换id/name/provider/baseUrl。API Key从CredentialStore解析；无Key返回undefined，不能因为UI提示而假定无Key可用。

| 请求 | 协议与结果 |
|---|---|
| 拉取模型 | `${trimTrailingSlash(baseUrl)}/models` GET，Authorization Bearer；取data[].id字符串、去重排序；非2xx错误含状态和前200字符正文 |
| 提取模型快速测试 | `/chat/completions` POST，model、messages=[{role:user,content:'回复一个字：好'}]、max_tokens8、stream=false；2xx即ok，即使空内容；错误正文截300 |
| 归并工具探测 | runAgent，工具真实声明但execute固定PROBE_ONLY；Schema `{ok:true}`；maxSteps2、timeout30000、maxTokens512；不建持久会话 |
| P1及直接整编 | models.complete + 提交工具，见AI-03 |
| 查询式资产/故事检查 | models.streamSimple + Agent，见AI-04 |

探测读取保存配置与Key，不读取尚未保存的界面字段。真实服务端协议/随机内容属于外部条件；不得修改默认模型名以追随新服务目录。

## AI-02 有效Prompt与输入组装

Prompt必须从随包文件按原文加载。生成表段也按基线保留；更新模型策略属于后续变更。`03-merge-world-assets`为旧资源，不属于当前有效人物处理步骤；不得因名称相似把它接入替代现有分层/整编。

| 调用 | 随包Prompt | 常驻输入与输出 |
|---|---|---|
| P1世界资产 | [01](resources/prompts/extraction/01-extract-world-assets.md) | 章节消息；WorldAssetsExtractionSchema |
| P1叙事资产 | [02](resources/prompts/extraction/02-extract-narrative-assets.md) | 独立同章消息；NarrativeAssetsExtractionSchema |
| 事件串联/复核 | [04](resources/prompts/merge/04-link-event-lines.md) | 本批ID、范围、已有线摘要、工作记忆；LinkEventLinesResultSchema |
| 别名补充识别 | [05](resources/prompts/merge/05-detect-alias-groups.md) | 人物/地点类型与精简档案，动态名称枚举 |
| 地点融合 | [06](resources/prompts/merge/06-merge-locations.md) | JSON `{snapshots:group}`；MergedLocationSchema |
| 会话压缩 | [07](resources/prompts/session/07-compact-story-session.md) | 旧摘要与待压缩历史；SessionCompactionResultSchema |
| 人物整编 | [08](resources/prompts/merge/08-optimize-characters.md) | JSON `{stage,entities:items}`，固定人物键和事实枚举 |

P1用户消息必须为下列格式，换行保留；timestamp为当前毫秒：

```text
章节标识：{chapterIndex}
章节名：{chapterName}

--- 正文开始 ---
{完整章节text}
--- 正文结束 ---
```

串联用户消息包括阶段、首尾章、本批节点ID逗号列表、查询提示和最多前50条线摘要（`id | title | 章节… | status | 起因前100 | 结果前100`），再附“【本书故事编辑工作记忆：仅作参考，过期记录需核实】”与JSON报告。P3 review消息按当前30条线摘要要求查重、更新、补点和原文核对。精确动态消息模板见[模板参数资源](resources/ai-message-templates.json)，不能只把整本原文塞进一个新Prompt替代。

别名输入档案含keep.id/name、全部称呼去重、identity/description各前160字符。指令要求只合并本批至少两档案主名、不扩张工具查询所得名称、无确定变更groups=[]；地点强调整体与区域不同。temperature0。

## AI-03 直接提交与修正

有Schema无查询tools时注册唯一`submit_result`，parameters为当前Schema，`constrainedSampling:{type:'json_schema',strict:'prefer'}`。模型必须调用该工具；普通文本不当作结构化成功。

返回usage每次尝试均累计。stopReason为error/aborted时按AI-05处理；没有Schema时把text块换行拼接返回。否则找首个submit_result调用，递归normalize可选null，TypeBox验证，再执行validateData业务引用/原文等校验。

提交缺失、结构错或业务校验错共允许一次结果修正，与网络失败计数分离。修正必须带回完整assistant原始响应（包含推理字段）、每个toolCall的配对toolResult错误，以及“唯一一次修正机会”用户指令。其他工具不执行，反馈“本请求只接收 submit_result，其他工具未执行。”；第二次仍错返回validation失败，不继续五次结构重试。

直接请求总硬上限=`max(各服务错误maxAttempts)+1`。可选字段null仅在非必填且原属性不允许null时移除；递归数组、对象和union分支，不改原响应、不强制类型、不删除必填。

## AI-04 查询Agent与提交边界

| 职责 | 允许工具 | 会话 |
|---|---|---|
| asset_editor | query_nodes/get_node_detail/query_event_lines/get_event_line_detail/query_characters/get_character_detail/query_locations/read_original | 临时任务，不读取故事记忆 |
| story_editor | 上述8个 + get_editor_memory/query_editor_notes/get_editor_note_detail/list_editor_sessions/query_editor_session_history | 允许恢复指定故事会话 |

只注册kind=read且在职责白名单内的工具。submit_result为独立提交收集器，不写数据库；Schema和业务校验通过才记录data并终止，之后由流水线执行事务。

默认maxSteps6、timeout180000ms。系统消息前置本书会话、新复核父会话及“只有代码提交确认才表示写入成功”约束，再加职责指令、有效Prompt和步数/修正规则。初始配置变化需追加系统工具声明，不能伪造覆盖旧历史。

每轮turn_start计步。最后一轮或发生提交校验失败时，模型可见工具列表只保留submit_result；openai-completions载荷强制tool_choice该函数，DeepSeek同时thinking.disabled。beforeToolCall仍禁止已撤查询工具实际执行。达到上限但需一次提交修正可再有受限轮次；模型末轮仍要求已撤查询时只纠正一次，不执行查询。

每个只读工具先校验参数；业务返回含error时为工具错误。returns已声明时执行返回Schema校验，否则不能假定所有工具有返回Schema；序列化超过maxBytes返回TOO_LARGE。记录工具执行和错误，错误摘要去重复行、最多6行/1000字符，Received arguments最多600字符；原始工具反馈仍交模型。

持久session仅允许story_editor；取得租约、准备上下文，追加每个message_end原始标准PI消息，最后error/aborted可追加omit标记最后失败条目（原始仍保存）；finally退租并清超时。成功结果还需control.signal未取消。

无持久会话时使用JSON上下文长度/2估算，超过模型窗口80%中止；持久会话按AI-08精细预算和压缩。不能将两条预算规则合并成统一阈值。

## AI-05 错误分类、退避与用量

分类仅对stopReason='error'；其他如aborted归unknown。错误字符串小写，顺序：空→network；401/403/auth/invalid key→auth；429/rate limit/quota→rate_limit；5xx/internal/bad gateway/unavailable→server；context length/tokens→context_length；content policy/filter/safety/blocked→content_policy；network/fetch/timeout/econnreset等→network；其余unknown。

| 类型 | 服务失败最大尝试 | 退避 |
|---|---|---|
| network / server | 3 | base1000ms，指数与抖动 |
| rate_limit | 5 | 解析Retry-After整数秒优先，否则指数 |
| auth/content_policy/context_length/validation/unknown | 1 | 普通服务重试禁用；结构修正另计 |

delay=`round(base*2^attempt*(0.5+Math.random()))`，attempt从0。Retry-After仅按字符串正则提取整数，不增加HTTP日期支持。直接请求只对限流解析Retry-After，Agent外层对可重试结果尝试解析。等待sleep不实现signal中断，取消可能等到退避结束。

有session的Agent遇context_length可额外强制压缩恢复一次，再按服务策略；不能无限压缩。模型调用失败对象含ok=false、stopReason、errorKind/errorMessage、attempts、attemptsUsage。费用为每次返回usage.cost.input+output的总和，摘要费用也计入；不按UI货币符号自行换算。

## AI-06 查询工具完整行为

完整参数、必填、范围、描述和返回约束在[tool-contracts.json](resources/tool-contracts.json)。所有分页输出为`{data,totalCount,truncated,nextOffset}`；通常offset0/limit100，再受工具maxResults限制。单行>64512字节改为`{id,fields_omitted:['oversized_detail'],hint}`；累计返回逼近64512停止，外层65536字节再限制。参数limit Schema最大200，不等于每工具均能返回200。

| 工具 | 过滤/排序/输出与限额 |
|---|---|
| query_nodes | chapter_range闭区间、actor精确匹配actors或targets、event_line_id按真实线成员；章/order排序；summary前240；最多200 |
| get_node_detail | ids1–20，完整匹配节点；返回最多20 |
| query_event_lines | status/name_like子串/章节任一相交；character先查人物草稿扩充全部同组称呼，再用成员actors/targets匹配；cause/result前160；最多50 |
| get_event_line_detail | 参数ids最多20，实际最多10条 |
| query_characters | 主名和别名包含name_like；返回id/name/aliases/identity/sourceChapters；最多100 |
| get_character_detail | 完整人物但排除mergeFacts/optimizedFactIds/optimizationFingerprint；最多20 |
| query_locations | 主名别名包含过滤，完整地点；最多100 |
| read_original | 必填chapter_range恰两字符串；章节order；片段前缀`\n【章节 id：name】\n`，offset对拼接后整体；maxChars默认8000、实际至多20000（参数允许200000）；超字节每次缩80% |
| get_editor_memory | 当前或指定同书会话；摘要、dataChanged、pending/stale数、最多10条active笔记摘要、最近5个批次；statement前240、引用各前5，truncated提示 |
| query_editor_notes | kind/key/status/node_id/line_id，stale匹配validity而非status；最新更新在前；最多50 |
| get_editor_note_detail | 同会话指定ids完整笔记；最多20 |
| list_editor_sessions | 当前书创建时间倒序，摘要含parentSessionId和entryCount；最多50 |
| query_editor_session_history | 当前或指定会话；summary预览前800/最多50，full最多20；entry_id模式按JSON字符char_offset/maxChars（默认8000/最大20000）分段，越权/不存在返回NOT_FOUND |

取消参数查询返回ABORTED；参数错误INVALID_ARGS；超大TOO_LARGE；工具返回结构错误INTERNAL。这里只读“其他同书历史会话”不能扩张到其他书。

## AI-07 工作记忆、依据和检查点

工作记忆结构和字段见DATA。校验要求非空trim摘要和statement/key、批内key唯一、至少一个node/line/evidence依据，节点线引用有效；新增临时节点允许在本批先声明。evidence.quote必须在指定章逐字存在；错误时回查所有章给实际所在章提示。resolved不能用于此前不存在的事项，同主题kind不能变。

资产signature：人物与地点各按id排序，每行去bookId/updatedAt，其余顶层键按locale排序后JSON；assetFingerprint=SHA256(JSON.stringify(signature字符串))。全局数据指纹为SHA256(JSON.stringify({assets:assetFingerprint,nodes:按id排序节点事实,lines:按id排序线事实}))。节点事实包括原文/时间/内容/参与者等，排除派生actorIds和eventLineIds；线事实包括id/title/nodeIds/cause/process/result/status。

笔记依据指纹含assetFingerprint、引用节点/线事实与每条evidence及present布尔。与当前计算不等则validity=stale；不直接写坏原笔记状态。dataChanged比较保存的全局指纹；pendingCount只计kind review/status active，和staleCount独立。

checkpoint key按work+排序scopeIds哈希；sourceFingerprint还含相关章的原文与范围节点/线事实。恢复需checkpoint completed且指纹匹配；link还核对当前实际线成员与保存memberships相等。资料更新时间不作事实变化，人物地点实际资料和原文变化会失效。

prepareEditorCommit先校验增量，按会话+主题key更新或创建notes；memory.revision从预期+1；checkpoint completed与memberships随提交生成。在事务中再核预期revision/资产signature，最后写入并追加commit摘要前1800字符。失败/取消checkpoint不能替代之前已完成批次结果。

## AI-08 持久消息、投影与压缩

### 原始记录

会话仅一个active。ensure(newReview=false)续旧；newReview=true检查活租约，归档旧active后新建UUID review并指parent；初次标题“初次故事编辑”，复核标题“全书复核 n”。追加条目在session/entries事务中取nextOrdinal、parentId旧leaf，更新leaf与nextOrdinal；持租约写入须owner一致，无owner提交不得占用活租约。

NativeMessage保存标准PI形状，允许额外字段包含模型/用量/推理和toolCall；不是只存role/content文本。messages、toolResult、system toolsAdded/Removed的SDK具体结构使用锁定pi-ai标准类型。

### 投影

从leaf沿parent到根形成消息路径，发现循环/缺父抛错；反转为正序。最新compaction存在时，取其自身+其前firstKeptEntryId起的非system消息+其后条目；omit标记的id从投影移除。commit投影为user `[代码提交确认] ...`；compaction投影为保存systemMessage和user摘要提示；omit不投影。

若assistant发toolCall但原始历史缺结果，投影补一个isError toolResult，明确“会话中断，工具结果未保存；请重新查询。此标记不是实际工具结果。”，不得写入原始存档；无对应pending调用的孤立toolResult不投影。

### Token估算与阈值

文本按code point：CJK/Kana/Hangul范围1.5，其他非ASCII1，ASCII0.25，最后ceil；message=16+JSON（去usage）的估算。有效最近assistant usage存在且在最后compaction/omit之后时，用其totalTokens（或input/output/cache之和）加后续消息估算；错误/aborted和压缩前usage不能当当前大小。

默认reserve32768/keepRecent150000。实际reserve=min(配置或32768,max(128,floor(window/4)))；keep=min(配置或150000,max(64,floor((window-reserve)/3)))。启用且tokens>window-reserve触发压缩；强制恢复亦可触发。

### 压缩过程

从末尾累加消息预算选择user/assistant切点，不从toolResult切入；第一次无可用切点改keep64，再尝试在可容纳尾部的后续任务边界切；仍超窗可保留零旧条目，firstKeptEntryId指压缩条目自身。

前缀剔除system与compaction序列化为带“原始条目ID、角色”的JSON文本；沿用上次摘要。每块最大预算=max(256,floor(window*0.45)-Prompt估算)，逐块调用归并角色摘要，maxTokens=min(16384,max(128,floor(window/8)))、temperature0；每块usage计入。

空摘要、结构错、取消、after>=before或after>window-reserve均失败，不提交compaction，不删除原记录。成功追加含summary/firstKeptEntryId/tokensBefore/tokensAfter/systemMessage/usage的条目。后续仍需保持当前任务精确输入，若压缩投影已不含当前opts.messages则重新追加，不能仅用概括摘要代替本批ID与要求。
''')

if __name__=='__main__':print('Wrote detailed behavioral and AI specifications.')
