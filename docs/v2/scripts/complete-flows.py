from pathlib import Path
import importlib.util,json,copy
OUT=Path(__file__).resolve().parent.parent
s=importlib.util.spec_from_file_location('m',Path(__file__).with_name('complete-spec.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
flows=[]
def add(id,title,trigger,steps,example):flows.append(dict(id=id,title=title,trigger=trigger,steps=[dict(zip(['input','read','transform','write','commit','failure','consumer'],r))for r in steps],example=example))
add('DF-01','小说预览与保存','OP-06/09/10',[
('File首文件','浏览器bytes','解码UTF8/GBK，按regex切章/10000切块','局部preview.{decode,chapters,regex,bytes}','仅内存，无DB事务','错regex/解码显示错误，旧preview保留','预览200行与导入守卫'),
('preview有效、用户确认','preview.decode.text与regex','uuid生成书ID、filename去最后扩展名作为title','T03.{id,title,sourceFileName,createdAt}','先await设置库单行put','后续失败没有跨库回滚','书架新卡片'),
('ChapterDraft[]','每章index/name/text/order/charCount','元数据与正文拆表，共享bookId/chapterIndex','T04全记录；T05.{bookId,chapterIndex,text}','本书两表同事务bulkPut','事务失败两表不部分写；T03可能已存在','窗口、P1、章数'),
('保存章节成功','drafts.length','构造stage=P1/status=idle/完成失败[]','T12.P1','独立put，不与建书/章节合为同事务','这里失败仍可能已有书/章节','入库按钮禁用、可阶段处理'),
('仅导入或完整模式','新bookId','仅导入reset任务；完整模式beginRun后不await runAll','ui.bookId；showImport=false；assetTab人物','仅内存状态；完整后续另走DF-02','任务catch写failed日志，书不删除','资产工作台')],{'portable':['P02','P03','P05'],'before':{'books':[],'chapters':[]},'input':{'id':m.book,'title':'测试书','text':'第一章 会面\n甲见乙。'},'after':{'books.count':1,'chapters':[{'chapterIndex':'1','order':0,'charCount':11}],'chapterTexts.0.text':'第一章 会面\n甲见乙。','P1.status':'idle'},'note':'charCount应取具体字符串UTF16长度；可执行用例直接核正文/章数，完整精确记录由import结果。'})
add('DF-02','完整编排与取消恢复','OP-10/27/29',[
('bookId/配置/signal','T04按order、T12各阶段、T16 active','建100/20窗口、planKey，判断恢复点，ensure会话','T12.P2 running；必要T16建/归档','分别事务；同JS同书锁包围整个编排','锁占用拒绝；不删除已有资产','窗口调度'),
('当前窗口未完成章','T05.text、T12.P1完成/partial','世界/叙事独立调用，分配ID；成功部分可用','T06/T07/T08成功数组bulkPut','三个资产表同事务，随后独立写T12.P1','失败缺子步骤进入partial；signal取消则不提交在途','进度、列表，恢复只补失败'),
('P1本窗处理结束','T06/T07与来源/正文','DF-05归并；DF-03串联','相应草稿与T13–17；T12.P2完成/失败窗','各阶段各批提交，非整窗全原子','degraded/失败窗不推进连续checkpoint，但可处理后窗','可继续而不丢先前结果'),
('所有窗口处理后','全书当前草稿','全局合并与runLink(review=true)','T12.P3；T06–09/T13–17','本阶段分批保存，最后T12.P3状态','P1/P2/P3任失败则P3failed；取消不自动入库','P3completed仅为当前范围门槛'),
('取消/刷新/继续','T12与T15已有检查点','abort或重读恢复方案；刷新不后台跑','已提交不撤销；后续T12cancelled/paused显示','无总回滚；继续才运行','sleep可延迟取消；旧runtime不代表后台存活','CompilePanel、继续按钮')],{'portable':['P06','P07','P24'],'note':'P06明确失败世界/叙事恢复请求次数和前后表；窗口P24明确第100章切块与181原章；完整真实模型全书效果另列验证范围。'})
add('DF-03','独立阶段与事件串联提交','OP-28与AUTO-12/13',[
('step/sample','T04、T12.P1','sample前100原章；非P1只核样本P1全完成','删除T12.P3；p1另删T12.P2','前置成功后删除旧完成标记','P1未齐先报错，不擅加P2先后守卫','入库放行撤销'),
('P2/P3故事检查','T08当前范围、T09全书、T06/T07、T13–17','按400节点给ID/摘要，工具按需查询；核Schema/原文/引用','工作内存nodeMap/lineMap，尚不生效','只有工具submit成功仍不等于DB提交','失败记录T15 failed/cancelled，保前一批','准备提交'),
('有效新节点/操作/记忆','T05引文与当前T08/T09/T13版本/资产signature','临时ID→正式ID；成员排序；重算chapters/characterIds/eventLineIds；准备指纹','T08/T09/T13/T14/T15及T17 commit，T16末端','同批多表事务，事务内再核旧读值/版本/会话','冲突抛错，全批回滚；不能覆盖人工修改','列表/图/记忆useLiveQuery'),
('阶段完成','本次失败和旧assets失败','stage样本模式保存testScope；p3检查所有已提取，不补未提取','T12.P2/P3状态/完成失败；runtime事件','进度独立事务','样本通过不表示全书通过；失败不放行','测试草稿提示、入库测试草稿')],{'portable':['P17','P18','P19','P20'],'before':{'eventLines':[],'storyEditorMemory':[]},'input':{'event_line_ops':[{'op':'create','title':'会面线','node_ids':['C1-N001'],'cause':'会面','process':'见面','result':'','line_status':'open'}],'memory_update':{'workingSummary':'已核对会面','notes':[]}},'after':{'line':'L01','nodeIds':['C1-N001'],'node.eventLineIds':['L01'],'memory.revision':1,'memory.workingSummary':'已核对会面','checkpoint.status':'completed'},'failureAfter':{'lineCount':0,'memoryCount':0,'checkpoint.status':'failed'}})
add('DF-04','单章试跑不保存资产','OP-32/33',[
('bookId','T04首order章、T05完整正文','使用P1两次请求同完整章输入','仅局部result，含三类资产与失败','不调用saveP1Result或putProgress','请求异常显示error；子步骤失败仍在result','左右对照与人工判断'),
('结果显示','sourceText、usages','sourceText.slice(0,2000)，cost求和，durationMs','局部视图与文案','无业务保存','关闭不发abort，结果随卸载丢','重跑按钮与费用说明')],{'input':'任一已导入书首章','after':'T06/T07/T08/T12数量和值均不因试跑而改变','portable':[],'verification':'静态路径，UI仅采集弹窗未真实调用模型；无虚构运行通过'})
add('DF-05','草稿合并、频次与缓存','OP-27/28，ALG-04/05',[
('当前stage范围','T06/T07选中与sourceChapters；T05全文；T12.P1范围','人物主名相等/包含、地点仅相等、别名集合>0.9；保最早ID，先本地融合','仅workingCharacters/locations局部','提交前不替换旧表','未定义全局安全自动锁','AI补充分组/频次'),
('本地组','精简名称别名/identity、description前160','180条取批/160步；AI只能合本批>=2主名；再融合','局部主名/aliases/sourceChapters/四文本/relations/conflicts','无单独工具直接写库','AI失败degraded，保本地底稿','主名出场扫描'),
('最终主名','T05处理范围、T06聚合资料','扫描主名非别名；原章去重/提及次数；分位→roleWeight，manual优先','局部frequency/roleWeight/source','非单独持久写','未知/重复主名不重复归属','按需人物整编'),
('需整编人物/多描述地点','mergeFacts与缓存、Prompt/schema预算','短事实ID；固定人物键；覆盖/名称/非空校验；地点描述保底合入','局部四文本/mergeNotes/optimizedFactIds/fingerprint','AI通过不等于提交；末尾重算主名频次','超预算/校验错保底，degraded使阶段不通过','提交'),
('整轮未取消','原参与快照bulkGet','JSON比对未变→删除参与旧ID→写保留融合记录','T06/T07参与集合','两表同事务；范围外不删除','取消整轮不提交；冲突拒绝覆盖','人物/地点列表、入库、记忆依据失效')],{'portable':['P10','P25','P26'],'input':[{'id':'C1-P001','name':'甲','identity':'书生'},{'id':'C2-P001','name':'甲乙','identity':'来客'}],'after':{'keptId':'C1-P001','aliases':['甲乙'],'identity':'书生；来客','sourceChapters':['1','2']},'note':'包含聚组无单字守卫是兼容行为；手动指定keepId与自动规则分开。'})
add('DF-06','人工编辑与副本/指纹','OP-15–20',[
('表单局部values','UI字段→fromEditable','CSV中英文逗号分割trim去空；字符串只用trim判空，非空保原文本','patch字段，尚未写库','无统一必填Schema','空必填可undefined，不补新校验','核心update'),
('人物patch','T06当前行/mergeFacts/cache','ageText点路径；四文本变则替换该字段事实、移除退休优化ID、清fingerprint','T06 patch/updatedAt；层级另写manual','人物事务；地点单行更新；Node/Line普通update','未统一catch UI；无行通常no-op；不撤P3','useLiveQuery列表'),
('DB提交','本书查询订阅','重读新行，不自动setSelected新对象','列表视图；旧详情仍持旧asset','无新事务','层级/线状态控件回显旧值BUG-16','关闭重开后新详情'),
('后续继续/入库','已变T06–09资料','记忆读取重算validity；入库才重建实体/人物引用','本次编辑不自动写T10/T11/T08.actorIds/T09.characterIds','副本非持续同步','P3completed不自动失效，待处理不归零仍可能入库','下轮检查/用户手动发布')],{'portable':['P08','P09'],'input':{'id':'C1-P001','patch':{'identity':'修改身份','profile.ageText':'约二十岁'}},'after':{'characterSnapshots.C1-P001.identity':'修改身份','characterSnapshots.C1-P001.profile.ageText':'约二十岁','characters.count':0},'UIVerification':'ui-role-change.txt：列表主要人物，详情仍NPC；关闭重开必须读取已保存值'})
add('DF-07','手动并入与快照删除','OP-21/23',[
('keepId+mergeIds','同表目标/其他有效记录','去掉keepId自身，保指定目标ID；资料/称呼/关系融合','T06或T07目标put、其余delete','同表事务','keep不存在报错；无回收/拆分','列表数量变化、详情关闭'),
('直接删快照','当前id','仅按id delete','T06或T07一行','单表删除','不改T10/T11和节点文本称呼；无二次确认','下次入库重新计算实体')],{'portable':['P10'],'before':{'人物草稿':['C1-P001沈青','C1-P002顾衡','C1-P003阿宁']},'input':{'keepId':'C1-P001','mergeIds':['C1-P002']},'after':{'人数':2,'保留ID':'C1-P001','aliases包含':'顾衡'}})
add('DF-08','节点/线删除传播','OP-24/25',[
('删nodeId','T08全部、T09全部','删节点→线成员过滤不存在ID→删空线；重算chapters/timeRange/characterIds','T08删除+所有节点eventLineIds；T09成员和派生/空线','节点/线事务','事务错误全批回滚，无单独恢复UI','列表、图、散落数'),
('删lineId','T08.eventLineIds','删线→逐节点过滤该lineId','T09删除；T08归属字段','节点/线事务','保留节点本体，不删人物地点','节点可变散落点')],{'portable':['P13','P14'],'before':{'L01.nodeIds':['C1-N001','C1-N002']},'input':'删除C1-N001，然后删除C1-N002','afterFirst':{'L01.nodeIds':['C1-N002']},'afterSecond':{'nodes':[],'eventLines':[]}})
add('DF-09','入库与引用重编','OP-30',[
('入库点击','UI最近progress、T06/T07/T08/T09','UI P3completed放行；底层不再核；按来源ID parseFloat章号+numeric ID排序','局部entities/名称索引','读取在写事务外','与running/人工编辑无统一服务锁','生成实体'),
('人物快照→实体','name/aliases_mentioned/aliases/profile/relations等','P001起；speech_style_sample→speechStyleSample；roleWeight默认NPC；relations默认[]','T10局部全数组；T11地点L001起','未提交','精确称呼先登记优先，模糊才唯一；重名BUG保留','节点映射'),
('节点→人物引用','actors+targets逐称呼、精确/模糊索引','唯一匹配ID有序去重；不改原称呼；未命中Set收集','每节点actorIds；线按成员汇总characterIds','局部准备，不回写草稿','未映射只告警，不阻断入库','最终事务'),
('准备完成','实体数组和派生patch','clear T10/T11，bulkPut实体，update每节点/线引用','T10/T11/T08.actorIds/T09.characterIds','四表单事务','失败回滚该四表；已有草稿保留','资产包徽标、数量提示、备份')],{'portable':['P11','P12'],'before':{'characters':[],'locations':[],'node.actors':['沈青','顾衡']},'after':{'characters.ids':['P001','P002','P003'],'locations.ids':['L001','L002'],'node.actorIds':['P001','P002'],'L01.characterIds':['P001','P002']},'repeat':'第二次相同草稿仍3人物2地点；不新建资产包版本'})
add('DF-10','备份与恢复','OP-49/50/51/53/54/55',[
('导出','T03 book；单书T04–T17全表','单书只读事务快照→JSON/章节TXT→每文件SHA256→manifest→ZIP','独立wwv2文件；不写单书','单书读事务；文件后写','排除T01/T02和lease；内存日志不导出','目录/下载提示'),
('选择ZIP','文件bytes','格式/manifest/过新版本/checksum→统计','局部inspect结果','无业务写入','缺统计JSON可拒绝Promise无友好兜底','用户确认'),
('确认恢复','各data文件与章节文件','记忆/会话额外校验；新bookId；title后缀；bookId重写；清lease','先T03新记录；后目标库T04–T17','目标书多表事务，非跨库原子','目标写失败可留书架；不回滚已有原书','选中新书，页面仍设置'),
('恢复完成','新库数据','useLiveQuery加载，P3可能来自备份','UI当前书','无自动编译/发布','人工complete标记非真实模型证据','可编辑/入库/再导出')],{'portable':['P21','P22'],'before':{'原书':m.book},'after':{'newBookId':'不同于原书','newTitle':'逆推验证样本（导入）','原书仍存在':True,'restored.nodes':2,'restored.characterSnapshots':3},'preview':'固定实体0可以与草稿3同时成立'})
add('DF-11','整书删除边界','OP-57',[
('弹窗确认','目标bookId、同JS锁','锁检查→close缓存db→Dexie.delete资产库','本书T04–T17所有表实例删除','整库删除','已有任务占锁则拒绝；不是全标签锁','删除书架'),
('资产库删除成功','T03对应书','books.delete(id)','T03删除','设置库独立操作','失败不是跨库回滚；不清T01/T02或导出文件','切其他书/空导入')],{'portable':['P23'],'before':{'bookExists':True,'credentialExists':True},'after':{'bookExists':False,'credentialExists':True},'UI':'只看确认弹窗，未实际删除用户数据'})
add('DF-12','全局配置与凭据','OP-41/42/43/47',[
('模型保存','局部配置、T02旧llm.config','trim文本，窗口空undefined/整数≥8192，merge旧值','T02.llm.config.value/updatedAt','单行put','错窗口不写；无自动网络探测','后续调用配置'),
('Key保存/清除','局部Key/T01 provider','trim→CredentialStore.modify；UI清除调用CredentialStore.delete','T01凭据','credentials读改写事务','UI显示掩码，不将明文回填','模型请求/配置状态'),
('并发保存/目录选择','number/浏览器handle','round+clamp1–16；或保存真实目录句柄','T02对应key/value/updatedAt','单行put','不新增NaN校验；目录仍需权限','新任务池/目录导出')],{'input':{'key':'compile.concurrency','value':99},'after':{'key':'compile.concurrency','value':16},'note':'该具体边界由源函数算式确定；独立用例主要覆盖Key保留，配置UI本轮只默认值运行观察'})
add('DF-13','模型探测和工具返回','OP-44–46',[
('探测点击','T01 Key、T02已保存URL/model','GET/models或文本POST或归并工具Agent，三种协议不同','无小说资产写入；仅局部status/catalog','网络副作用，不是数据库事务','认证/空目录/工具无提交分别报错','成功耗时/错误行'),
('Agent正常查询/修正','toolSchema、DB查询、scripted SSE','只读查询→toolResult→submit校验→最多一次修正','无session时不存T17；runLink调用方提交走DF-03','提交收集器只接data，非直接写库','两次无效停止；末轮只能提交','结果回调用方')],{'portable':['P15','P16','P30','P31','P32'],'replays':['resources/replays/agent-query-submit.json','resources/replays/agent-submit-repair.json','resources/replays/agent-submit-failure.json'],'note':'回放为真实SDK/原边界拦截HTTP生成，非真实模型服务输出'})
add('DF-14','只读视图、记忆和游玩内存','AUTO-03/12/13/14、OP-59',[
('持久消息追加','T16当前header和owner','消息JSON校验，ordinal=nextOrdinal，parentId=leafId','T17追加；T16.leafId/nextOrdinal/updatedAt/leaseUntil','两表同事务','租约冲突拒绝；消息保存不等于事件事务成功','会话历史/模型上下文'),
('压缩请求','T17原始链、有效usage、模型窗口','投影→预算→切点→分块摘要→核after预算','成功追加compaction，不删除原始消息','最终append事务；失败不改投影边界','失败或取消原历史仍在','后续模型读摘要+近期消息'),
('记忆列表读取','T06–09、T05引文、T13–15','计算dataChanged/current或stale/pending，按会话过滤','只读视图；不写note.status','无业务写入','无自动全书重查，需要用户继续','记忆页面、下一批Prompt'),
('游玩发送','当前bookId、trim(input)','追加player和固定占位narrator','仅组件lines，input清空','无数据库/网络','切页卸载丢消息；不推进世界','消息区滚底')],{'portable':['P27','P28','P29'],'compaction':{'before':'3条长user消息','successAfter':'原message仍3、compaction新增1','failureAfter':'仍仅3条，无compaction'},'play':'UI运行确认占位且切页清空；不是可玩世界'})

transitions=[
('编译P1','idle/paused/failed/cancelled','runP1','存在章节/获得入口锁','T12.running','running','进度/日志开始','加载/读正文异常传播'),
('编译P1','running','章两子步骤全成功','signal未取消','三资产表保存；completed加入、failed移除、partial删除','running或completed','章完成与数量','资产和进度不是一个事务'),
('编译P1','running','子步骤失败','有可保存成功部分','保存成功部分；failed加入，partial缺口','failed或paused','失败章日志','继续只补缺口'),
('编译','running','用户取消','signal检查到','不交当前在途；已有批保留，记录cancelled','cancelled','恢复说明','退避可能延迟'),
('显示进度','DB running/runtime idle','刷新挂载','旧任务进程已不存在','不写DB','显示paused','继续按钮','须用户继续，不后台续跑'),
('P2窗口','running','一窗归并串联结束','无degraded/失败','保存窗索引完成；此前无空洞才推进lastWindowIndex','running/阶段完成','窗口成功计数','失败窗保数据不推进checkpoint'),
('P3','running','两项结束','上下游均无失败','T12.status completed','completed','入库UI可用','任上游失败仍failed'),
('P3样本','running','样本检查完成','当前已提取范围','T12.completed+testScope','completed（样本）','入库测试草稿','不代表全书完成'),
('人工草稿','任意','普通保存','行存在，UI仅saving守卫','patch字段，P3不自动删','仍草稿','已保存、列表变','可写空必填；缺少全局兜底'),
('入库实体','空或已有','publishCanon','UI P3门槛；服务无再核','清表重建实体与引用','当前实体替换','数量徽标','无历史版本/永久稳定ID'),
('笔记','无','新active主题','有效引用/原文','新增T14，revision>=1','active','判断/待复核','无依据拒绝'),
('笔记','active/resolved','同主题更新/解决','同kind；resolved须原主题存在','覆盖同会话key条目与basisFingerprint','active/resolved','相应状态','不能凭空解决主题'),
('笔记视图','current','依据变化后读取','指纹不等','无T14.status写入','stale视图','依据变化警告','直到继续重查，不后台自动修复'),
('会话','无active','ensure','无活竞争','新session active/nextOrdinal0','active','当前会话','旧记录可迁移但不造聊天'),
('会话','active','新全书复核','旧owner不活/无竞争','旧archived，新review指parent','旧归档+新active','历史可回查','活竞争拒绝'),
('会话租约','未持有','acquire','同owner存活探测允许','leaseUUID、到期+300000','持有','仅任务内部','不保护全部编辑'),
('会话租约','持有','append/release','owner相同','append续租；release清lease','持有/释放','消息可查看','错owner拒绝'),
('上下文','未压缩','预算超限','可切分且有效摘要','追加compaction，不删旧','摘要投影','token前后日志','失败不追加compaction'),
('备份预览','无','选择合法包','常规检查通过','仅局部preview','待确认','统计与确认按钮','非法包错误/畸形结构可抛错'),
('备份恢复','待确认','确认','inspect.ok','先建书后单书事务','新书可用','已导入n章','跨库可留下孤立书架'),
]
def make():
 body='''## 1. 字段级流转总览

数据库/表编号见[17表字典](03-Spec-数据与存储.md)。每步分别列出输入、源字段、转换、目标、提交、失败残留与消费者；箭头不是事务承诺。模型/服务返回先存在局部变量，只有相应事务成功才成为持久事实。

| 流程 | 入口 | 验收/示例 |
|---|---|---|
'''
 for f in flows:body+=f"| {f['id']} {f['title']} | {f['trigger']} | "+','.join(f['example'].get('portable',[]))+' |\n'
 for f in flows:
  body+=f"\n## {f['id']} · {f['title']}\n\n触发：{f['trigger']}。\n\n| 步骤/输入 | 读取对象与字段 | 转换/守卫 | 写入/临时结果 | 提交边界 | 失败/取消结果 | 消费者/反馈 |\n|---|---|---|---|---|---|---|\n"
  for i,row in enumerate(f['steps'],1):body+='| '+str(i)+'. '+' | '.join(str(row[k]).replace('|','或')for k in ['input','read','transform','write','commit','failure','consumer'])+' |\n'
  body+='\n具体输入与前后记录：\n\n```json\n'+json.dumps(f['example'],ensure_ascii=False,indent=2)+'\n```\n'
 body+='\n## 2. 状态转移与显示/持久差异\n\n| 对象 | 当前状态 | 事件 | 守卫 | 字段写入/处理 | 下一状态 | UI反馈 | 失败/恢复 |\n|---|---|---|---|---|---|---|---|\n'
 for row in transitions:body+='| '+' | '.join(row)+' |\n'
 body+='\n## 3. 原始字段到目标字段的映射\n\n| 来源 | 目标 | 赋值/生成 | 不自动同步的内容 |\n|---|---|---|---|\n'
 maps=[('ChapterDraft.chapterIndex/name/order/charCount','T04同名字段（name→chapterName）','加入bookId，和正文同事务','原文件bytes不存'),('ChapterDraft.text','T05.text','同chapterIndex和bookId','首标题前文本不在drafts'),('world.characters[i].字段','T06同名字段','name去重后编号C{章}-P{序}，加bookId/章名','model不分配id'),('world.locations[i].字段','T07同名字段','同理-L编号','P1不生成aliases'),('narrative.nodes[i].字段','T08同名字段','-N编号/order=i/createdBy=P1','不自动填actorIds/timeCoord'),('new_nodes[].client_id','T08.id和op.node_ids','临时→正式ID映射；quote定位offset/confidence=.6','旧quote/actor文本不改为id'),('memory_update.workingSummary','T13.workingSummary','提交revision+1和全局dataFingerprint','不成为原著权威事实'),('memory_update.notes[]','T14','session+key upsert，元数据/指纹补齐','stale只读计算'),('event_line_ops.node_ids','T09.nodeIds→T08.eventLineIds','按op增并换、排序，反向归属全重算','不同op标题行为不同'),('T06.speech_style_sample','T10.speechStyleSample','入库改键、保内容','T06仍用旧字段名'),('T08.actors+targets','T08.actorIds→T09.characterIds','入库名称匹配ID并集','普通表单不即时重算'),('备份所有bookId','目标新库所有bookId','导入重写，书内ID不改','不恢复旧lease'),('NativeMessage','T17.message','JSON克隆/标准结构校验','非持久agent不写原始会话')]
 for row in maps:body+='| '+' | '.join(row)+' |\n'
 m.write('10-字段级数据流与状态转移.md','WW-FLOW','字段级数据流与状态转移',body)
 m.dump('resources/data-flows.json',flows);m.dump('resources/state-transitions.json',[dict(zip(['object','from','event','guard','write','to','feedback','failure'],r))for r in transitions])
 print(f'{len(flows)} data flows, {len(transitions)} state transitions')
if __name__=='__main__':make()
