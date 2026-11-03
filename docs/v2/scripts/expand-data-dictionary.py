"""文档维护脚本：展开已有2.2实体和2.1未变表；不导入/修改应用。
新增明确化选择登记在13，输出为目标规格，不作为实现证据。
"""
from pathlib import Path
import sys
if '--legacy-snapshot' not in sys.argv:
    raise SystemExit('该生成器已由2026-10-24目标契约取代；如确需生成旧快照，显式使用--legacy-snapshot，并勿覆盖当前规格。')
from copy import deepcopy as cp
import json

ROOT = Path(__file__).resolve().parents[1]
R = ROOT / 'resources'
def read(path): return json.loads(path.read_text(encoding='utf-8'))
def save(path, value): path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
old = read(R/'schemas.json')
data = read(R/'v2.2/data-contract.json')
D = data['schemas']['$defs']
def obj(props, required=None): return dict(type='object', properties=props, required=list(props) if required is None else required, additionalProperties=False)
def s(desc=''): return dict(type='string', **({'description':desc} if desc else {}))
def n(desc=''): return dict(type='number', **({'description':desc} if desc else {}))
def i(desc=''): return dict(type='integer', minimum=0, **({'description':desc} if desc else {}))
def arr(item): return dict(type='array', items=item)
def en(*values): return dict(enum=list(values))
def ref(name): return {'$ref':'#/$defs/'+name}

# 保留旧字段的准确拼写；用完整对象补齐原来的 object 占位。
D['StoredCharacter']['description']='当前人物实体；P1/人工创建，P2/人工直接更新。'
D['StoredLocation']['description']='当前地点实体；P1/人工创建，P2/人工直接更新。'
for name in ['StoredCharacter','StoredLocation']:
    D[name]['properties']['createdBy']=en('P1','manual')
    D[name]['properties']['name']['minLength']=1
D['StoredEventLine']['properties']['createdBy']=en('P3','manual','P2')
D['StoredNode']['properties']['createdBy']=en('P1','P3','manual','P2')
D['LocationFact']=obj({'id':s('事实标识；同一实体内唯一'), 'field':{'const':'description'}, 'text':s('地点描述事实原文'), 'chapters':arr(s('依据章节标识'))})
D['StoredLocation']['properties']['mergeFacts']=arr(ref('LocationFact'))
D['Usage']=obj({'input':n('输入tokens；累计所有实际响应'), 'output':n('输出tokens'), 'totalTokens':n('沿用Pi返回totalTokens，不用input+output覆盖缓存计数'), 'cost':n('Pi输入与输出费用之和；不兑换货币')})
D['Coverage']=obj({'total':i('当前计划项总数'), 'checked':i('依据仍有效的已核查项数'), 'pendingIds':arr(s('尚未完成的工作项标识')), 'cursor':s('当前阶段的续扫位置；无下一页时省略')}, ['total','checked','pendingIds'])
D['WorldDependency']=obj({'kind':en('character','location'), 'id':s('查询时请求的ID'), 'resolvedId':s('当时解析出的最终当前ID'), 'revision':dict(type='integer',minimum=1)})
D['QueryDependency']=obj({'tool':s('只读工具名'), 'args':dict(type='object',description='经过该工具参数Schema校验的完整参数；不含bookId或凭据'), 'resultFingerprint':s('返回集合/顺序/所依赖版本的指纹；空结果也记录')})
D['ModelSnapshot']=obj({'providerId':s('Pi Provider标识'), 'api':s('Pi协议适配器标识'), 'baseUrl':s('请求基址；禁止内嵌密钥'), 'modelId':s('模型ID'), 'modelRole':en('extraction','aggregation'), 'contextWindow':i('有效上下文tokens'), 'capabilities':obj({'tools':dict(type='boolean'), 'structuredOutput':dict(type='boolean')}), 'credentialRef':s('T01 providerId引用；不是Key')})
for field, target in [('coverage','Coverage'),('usage','Usage'),('modelSnapshot','ModelSnapshot')]:
    D['PipelineRun']['properties'][field]=ref(target)
D['MergeReport']['properties']['usage']=ref('Usage')

for name in ['Book','Chapter','ChapterText','CompileProgress','StoryEditorMemory','StoryEditorNote','StoryEditorCheckpoint','StorySession','StorySessionEntry']:
    D[name]=cp(old[name+'Schema'])
p=D['CompileProgress']['properties']
p.update({'status':en('idle','running','paused','cancelling','cancelled','failed','degraded','completed'), 'scope':{'const':'fullBook'}, 'planVersion':{'const':'2.2'}, 'runId':s(), 'phase':s(), 'unit':en('chapter','step','window','item'), 'validity':en('current','stale'), 'dependencyFingerprint':s(), 'coverage':ref('Coverage')})
# 旧档可缺新增字段；新建2.2运行时服务必须赋值，另在正文注明。
for name in ['StoryEditorNote','StoryEditorCheckpoint']:
    props=D[name]['properties']
    props['worldDependencies']=arr(ref('WorldDependency'))
    props['queryDependencies']=arr(ref('QueryDependency'))
    props['window']=obj({'start':i('原章零基包含起点'), 'end':i('原章零基排他终点')})
    props['phase']=en('window_link','global_review','link','review')
    props['stage']=en('P3','P2')
D['CredentialRow']=obj({'providerId':s('全局凭据主键；当前默认deepseek'), 'credential':obj({'type':{'const':'api_key'}, 'key':s('trim后的API Key；明文，不进入单书备份')})})
D['LlmConfig']=obj({'baseUrl':s(), 'extractionModel':s(), 'aggregationModel':s(), 'aggregationContextWindow':dict(type='integer',minimum=8192), 'providerId':s(), 'api':s()},['baseUrl','extractionModel','aggregationModel'])
D['AppSettingRow']={'oneOf':[
    obj({'key':{'const':'llm.config'},'value':ref('LlmConfig'),'updatedAt':s()}),
    obj({'key':{'const':'compile.concurrency'},'value':dict(type='integer',minimum=1,maximum=16),'updatedAt':s()}),
    obj({'key':{'const':'assets.exportDirectory'},'value':dict(type='object',description='浏览器FileSystemDirectoryHandle，structured clone保存；不能当JSON对象或路径重建'), 'updatedAt':s()})
]}
tables=[
('T01','credentials','CredentialRow','providerId','每Provider一行；设置保存/清除，模型凭据适配器读取；不随删书删除，不导出。'),
('T02','appSettings','AppSettingRow','key','每设置键一行；设置/目录选择写入，配置解析器和导出读取；不导出。'),
('T03','books','Book','id, createdAt','每次导入一本书；导入创建，书架读取，删书删除；单书备份book.json。'),
('T04','chapters','Chapter','chapterIndex, order','每章/切块一行；导入创建，P1/原文工具/章节轴读取；正文在T05；删书删除。'),
('T05','chapterTexts','ChapterText','chapterIndex','每章/切块正文一行；导入创建，P1/引文校验/原文工具读取；备份chapters/*.txt；删书删除。'),
('T08','nodes','StoredNode','id, chapterIndex, order','每事件一行；P1/P3/人工写，图和详情读取；删除同步线成员、空线及墓碑；删书删除。'),
('T09','eventLines','StoredEventLine','id, lineStatus','每事件线一行；P3/人工写，图读取；成员与T08.eventLineIds同事务维护；删空线写墓碑。'),
('T10','characters','StoredCharacter','id, chapterIndex, name','每当前人物一行；P1/人工创建，P2/人工更新合并；合并删除成员并写T19；图按称呼派生人物引用。'),
('T11','locations','StoredLocation','id, chapterIndex, name','每当前地点一行；P1/人工创建，P2/人工更新合并；整体和内部区域不能因包含关系自动合并。'),
('T12','compileProgress','CompileProgress','stage','每P1/P2/P3各一行；编排器逐步提交，UI读进度；T18才是P1成功凭证；不作为资产生效开关。'),
('T13','storyEditorMemory','StoryEditorMemory','id, sessionId','每会话最新摘要；P3提交覆盖摘要并递增revision；工具读取；压缩文本不代替本表。'),
('T14','storyEditorNotes','StoryEditorNote','id, &[sessionId+key], sessionId, kind, status, updatedAt','每会话主题一行；P3按稳定key创建/更新，工具/UI读取；已解决仍保留；新旧会话隔离。'),
('T15','storyEditorCheckpoints','StoryEditorCheckpoint','id, sessionId, stage, phase, status, updatedAt','每会话阶段范围一个恢复点；P3代码写，恢复核验实际依赖；过期记录不能当完成。'),
('T16','storySessions','StorySession','id, status, createdAt, parentSessionId','每逻辑故事会话一行；应用创建，原书继续/重查复用active；旧archived只读；追加消息时更新叶子和序号。'),
('T17','storySessionEntries','StorySessionEntry','id, &[sessionId+ordinal], sessionId, parentId, type','每原始消息/压缩/省略标记/代码提交一行；只追加，Pi事件落库；按ordinal读取，压缩不删除原始记录。'),
('T18','extractionReceipts','ExtractionReceipt','key, chapterIndex, substep','每章每成功子步骤一行；P1实体事务写，恢复读取；人工改删/合并不删除成功凭证。'),
('T19','assetLifecycle','AssetLifecycle','key, kind, originId, currentId, state','每原始ID一行；创建/合并/删除事务更新；恢复/引用解析读；墓碑保留，禁止ID复用复活。'),
('T20','pipelineRuns','PipelineRecord','id, recordType, stage, status, startedAt, &lockKey','run为每次运行/手动合并一行；lease为资源互斥行；编排器和命令服务写；运行报告/幂等恢复读取；租约不备份。')]
data['completeTableSchemas']=[dict(id=a,name=b,schema='#/$defs/'+c,indexes=d) for a,b,c,d,_ in tables]
data['baseDictionary']='本文件schemas为18表结构全集；03为逐字段语义。历史schemas.json仅用于未变DTO。'
data['clarificationDate']='2026-10-23'
save(R/'v2.2/data-contract.json',data)
save(R/'v2.2/storage.schema.json',{'$schema':'https://json-schema.org/draft/2020-12/schema','$defs':D})

# 可读的逐表结构示例；固定时间/ID，不伪造运行或有效指纹结论。
samples={}
stamp='2026-10-23T00:00:00.000Z'; book='bk_acceptance'
for tid,name,definition,indexes,lifecycle in tables:
    legacy={'characters':'characterSnapshots','locations':'locationSnapshots'}.get(name,name)
    f=R/'table-examples'/(legacy+'.json')
    if f.exists(): samples[name]=[read(f)]
samples['characters'][0].update(revision=1,createdBy='P1',nameSource='extracted',manualKeep=False,sourceChapters=['1'])
samples['locations'][0].update(revision=1,createdBy='P1',nameSource='extracted',manualKeep=False,sourceChapters=['1'])
samples['nodes'][0].pop('actorIds',None)
samples['nodes'][0].update(revision=1,eventLineIds=['L01'])
samples['eventLines'][0].pop('characterIds',None)
samples['eventLines'][0].update(revision=1,createdBy='P3',nodeIds=['C1-N001'],chapters=['1'])
samples['compileProgress'][0].update(totalChapters=1,status='completed',completedChapters=['1'],scope='fullBook',planVersion='2.2',runId='run_example',phase='narrativeAssets',unit='chapter',validity='current',coverage={'total':2,'checked':2,'pendingIds':[]},dependencyFingerprint='example-not-a-valid-runtime-fingerprint')
for table in ['storyEditorNotes','storyEditorCheckpoints']:
    samples[table][0].update(stage='P3',phase='window_link',window={'start':0,'end':1},worldDependencies=[],queryDependencies=[])
samples['extractionReceipts']=[dict(key='1:'+step,bookId=book,chapterIndex='1',substep=step,inputFingerprint='example-not-a-valid-runtime-fingerprint',originIds=ids,committedAt=stamp,runId='run_example') for step,ids in [('worldAssets',['C1-P001','C1-L001']),('narrativeAssets',['C1-N001'])]]
samples['assetLifecycle']=[dict(key=kind+':'+ident,bookId=book,kind=kind,originId=ident,currentId=ident,state='live',revision=1,updatedAt=stamp) for kind,ident in [('character','C1-P001'),('location','C1-L001'),('node','C1-N001'),('eventLine','L01')]]
samples['pipelineRuns']=[dict(recordType='run',id='run_example',bookId=book,stage='P1',status='completed',startedAt=stamp,finishedAt=stamp,planVersion='2.2',appliedCommands=[],usage={'input':0,'output':0,'totalTokens':0,'cost':0},cost=0),dict(recordType='lease',id='lease:world',bookId=book,lockKey='world',owner='owner_example',runId='run_world_example',expiresAt=1792713900000)]
sample_dir=R/'v2.2/table-examples'
sample_dir.mkdir(exist_ok=True)
for name,value in samples.items(): save(sample_dir/(name+'.json'),value)

# 每个字段的语义优先使用精准覆盖，否则沿用已核对的Schema描述。
MEAN={
'coverage':'当前运行覆盖清单；阶段结束重新枚举，不能仅由模型自报完成','pendingIds':'尚未核查的稳定工作项ID；清空前不能completed','role':'Pi消息角色system/user/assistant/toolResult',
'chapterIndex':'本书章节/切块标识，关联chapters.chapterIndex','modelRole':'模型用途extraction或aggregation','capabilities':'已适配的模型工具与结构化能力元数据','tools':'是否支持工具调用','structuredOutput':'是否支持本项目要求的结构化返回',
'id':'记录主键；生成后稳定，更新不重新编号','bookId':'所属书；必须等于数据库命名中的bookId；导入重写',
'revision':'乐观并发版本；实体/事项起始1，工作摘要起始0；每次有效修改递增',
'createdBy':'创建来源；P2仅旧节点/线兼容，更新不覆盖创建来源',
'updatedAt':'应用提交时的ISO 8601时间；不替代revision并发检查','createdAt':'应用创建时的ISO 8601时间，后续不改',
'sourceChapters':'实体来源章/块标识并集；按章节顺序去重；合并保留全部来源',
'aliases':'当前累计别名；合并成员主名和别名，去重并排除当前主名',
'aliases_mentioned':'P1原始提取称呼；保留来源，读取查询时与aliases合并',
'profile':'可省略的基础资料对象；修改单个属性不得覆盖其余属性',
'speechStyleSample':'原文语言风格例句；从提取DTO speech_style_sample改键',
'frequency':'按最终主名在原文计数的派生频次；手工主名或合并后重算',
'frequency.chapters':'至少出现一次最终主名的原章数；切块合为原章',
'frequency.mentions':'最终主名累计命中次数；同名未合并无法唯一归属时不分配命中','frequency.scopeChapters':'参与频次计算的原章总数','frequency.percentile':'(higher+(same-1)/2)/max(1,实体数-1)；按chapters再mentions排名，higher为更高数量，same含自身；越小越重要',
'mergeNotes':'融合冲突/待核说明；不代表未生效状态','mergeFacts':'按字段保存的原始事实底稿；整编仅替换展示，不删除底稿',
'mergeFacts[].id':'实体内稳定事实ID；用于完整覆盖校验','mergeFacts[].field':'人物为identity/appearance/personality/background；地点固定description',
'mergeFacts[].text':'该条事实文本；不可用整编后的概括覆盖','mergeFacts[].chapters':'该事实依据章标识；字段名是chapters，不是sourceChapters',
'optimizedFactIds':'最近整编已覆盖事实ID集合；相关人工编辑后清除','optimizationFingerprint':'策略版本、称呼、事实、冲突的缓存指纹；相等才可跳过整编',
'roleWeightSource':'manual表示人工层级优先；frequency表示可自动更新','nameSource':'extracted提取名、automatic整理名、manual人工名；人工优先',
'manualKeep':'显式保护合并目标；缺省false；多个受保护目标时拒绝自动合并','manualSourceNote':'人工无章节来源人物/地点的说明；该情况下非空必填',
'eventLineIds':'代码维护的反向线ID；与线nodeIds同事务同步','canonicalId':'兼容节点去重指向；不是人物重定向；若携带必须是同书现存节点',
'stage':'阶段；新记忆/检查点固定P3，P2只允许旧历史；进度为P1/P2/P3',
'status':'本表状态枚举；不得把事项status与validity混为一谈','phase':'P2=mechanical/ai_identity/optimize/report；P3=window_link/global_review；旧link/review仅历史',
'totalChapters':'本书持久章/块数；窗口原章数另按窗口规则计算','completedChapters':'P1两个子步骤都有成功凭证的章/块标识',
'failedChapters':'重试后仍失败的章/块标识','lastWindowIndex':'旧P2窗口位置；目标P3以检查点和coverage为准','planKey':'计划版本/窗口/策略签名；不匹配则相关覆盖过期',
'editorSessionId':'T16故事会话引用；P2目标运行不设置','testScope':'旧样本测试范围；保留历史，不解锁目标正式流程',
'partialChapters':'动态键为章节标识，值为尚缺成功凭证的子步骤数组','runId':'关联T20 run行；恢复同一运行保持不变',
'scope':'全书正式运行固定fullBook','planVersion':'目标计划版本2.2','unit':'当前进度计量单位；chapter/step/window/item',
'validity':'current当前有效，stale依据已变；不控制资产使用','dependencyFingerprint':'当前进度所依赖输入的确定性指纹',
'sessionId':'同书T16逻辑会话ID；新数据必须写；空串/省略只兼容旧历史',
'workingSummary':'P3长期工作摘要；模型提供，经长度和业务校验后替换，不当作原文事实',
'dataFingerprint':'摘要依据指纹；空记忆返回空串；按实际相关依赖检查变化','basisFingerprint':'事项所引用节点/线/原文与实际世界依赖的指纹',
'sourceFingerprint':'检查点输入/输出有效依据指纹；不是全世界资产全量指纹',
'key':'稳定业务键；各表构造方式见下文','kind':'按表区分事项类型、会话类型或资产类型；取值以本行枚举为准',
'statement':'事项判断或复核结论；同一key更新，不保存长篇推理','evidence':'逐字引文依据；无节点/线引用时至少一条有效依据',
'nodeIds':'同书节点ID集合；事件线非空，事项可空；代码核引用并排序去重','lineIds':'同书事件线ID；工作事项可为空',
'scopeIds':'本检查批覆盖的节点/线/工作项标识，不代表全书都已检查','memberships':'动态键为节点ID，值为该点所属线ID数组；用于恢复检查',
'worldDependencies':'实际读过的人物/地点版本，不扫描未读全世界','queryDependencies':'实际工具查询参数及结果集合指纹；包含空结果',
'window':'P3原章零基半开窗口；全书复核可省略','profile':'固定story_editor；P2临时Agent不写故事会话',
'title':'书名或会话/事件线标题；按所属表输入来源生成','parentSessionId':'旧复核会话的父会话；目标继续/重查不新增会话',
'leafId':'当前追加链末尾T17.id；空会话省略','nextOrdinal':'下一条消息的序号；初始0，与追加条目同事务加1',
'leaseOwner':'持有会话的运行实例令牌；接管时更换，不是用户ID','leaseUntil':'会话租约到期Unix毫秒；导出清除',
'ordinal':'会话内从0递增序号；复合唯一索引避免重复','parentId':'上一条条目ID；首条为null',
'type':'判别字段；只允许该联合分支对应字段','message':'原始Pi消息对象；保持工具调用ID、用量、推理与协议扩展字段',
'summary':'压缩摘要/代码提交说明/运行摘要；不是额外业务写指令','firstKeptEntryId':'压缩后保留的第一条原始条目ID',
'tokensBefore':'压缩前上下文估算tokens','tokensAfter':'压缩后上下文估算tokens','systemMessage':'压缩时有效Pi系统消息快照，包含工具声明变化',
'usage':'Pi响应累计用量；精确定义见Usage','omittedEntryIds':'仅在投影中省略的原始条目ID，原表不删除','reason':'省略/合并/操作原因，保留可核对说明',
'substep':'P1世界或叙事子步骤','inputFingerprint':'输入原文/策略/配置依据指纹；输入改变不自动覆盖人工资料',
'originIds':'本次成功子步骤生成的原始ID；提取为空也写空数组成功凭证','committedAt':'事务成功时ISO时间',
'legacy':'仅可证明的旧成功步骤迁移时true；新提交省略或false',
'originId':'历史来源ID，永不因合并更改','currentId':'live时为自身，merged时为最终目标；deleted时禁止存在',
'state':'live活跃来源、merged已并入、deleted删除墓碑','sourceChapterIndex':'初始来源章节，可省略于手工来源',
'recordType':'run运行记录或lease资源租约','startedAt':'运行开始ISO时间','finishedAt':'终态时间；运行中省略',
'outputFingerprint':'本次已应用结果指纹','report':'世界合并报告；描述已生效修改，取消也保留','appliedCommands':'同run操作幂等账本；与业务变更原子追加',
'aiMode':'本次AI调用模式；纯手动合并省略','modelSnapshot':'解析后的Pi模型元数据；无明文Key',
'operationKey':'当前run内唯一命令键；同键同payload重放，同键异payload拒绝','payloadFingerprint':'完整命令payload规范JSON的SHA-256',
'commitId':'代码分配UUID提交确认ID；模型不得指定','resultSummary':'代码生成的原成功确认摘要；幂等重试原样返回',
'lockKey':'extraction/world/narrative资源键；唯一索引只约束lease，run不得携带',
'owner':'当前页面/执行实例随机UUID；续租/释放必须匹配','expiresAt':'租约到期Unix毫秒；取得/续租为当前时刻+300000',
'beforeCounts':'本次运行开始的世界资产数量','afterCounts':'结束/当前最新世界资产数量','groups':'已成功应用的合并组，不包含失败申请',
'method':'manual人工、mechanical机械、ai_identity模型判同','memberIds':'组内原成员ID列表','memberNames':'与memberIds逐项对齐的合并前主名',
'keepId':'保留的原成员ID','canonicalName':'本次确定的主名','conflicts':'本组资料冲突说明','beforeTokens':'合并/整编前详细字段估算tokens','afterTokens':'合并/整编后详细字段估算tokens',
'optimizedIds':'本次成功整编的当前实体ID','skipped':'跳过的项ID或带原因的工作项标识','failed':'失败项标识','conflicted':'并发或人工保护冲突项标识',
'externalChanges':'运行期间人工/其他阶段造成的外部变更说明，不算作本轮自动减少量',
'input':'输入tokens','output':'输出tokens','totalTokens':'Pi报告总tokens；不自行忽略缓存重算','cost':'Pi费用；累计所有实际响应，未知单价不能伪称真实账单',
'characters':'人物条数','locations':'地点条数','providerId':'Pi Provider标识，关联全局credentials.providerId',
'baseUrl':'模型API基址；空读回DeepSeek默认地址','extractionModel':'P1/direct提取模型ID；默认deepseek-flash','aggregationModel':'P2/P3归并模型ID；默认deepseek-v4-pro',
'aggregationContextWindow':'用户覆盖归并模型窗口tokens；可省略，UI要求整数≥8192','api':'Pi协议适配器标识，缺省走当前兼容协议',
'credential':'当前可用API Key凭据；OAuth仅为SDK可携带类型，应用无登录流程','value':'按key区分的设置值；不能混用分支','content':'Pi原始文本或内容块数组；不丢工具/推理字段','timestamp':'Pi时间戳Unix毫秒',
}

def expand(schema):
    if '$ref' in schema: return D[schema['$ref'].split('/')[-1]]
    return schema
def typ(schema):
    a=expand(schema)
    if 'const' in a: return json.dumps(a['const'],ensure_ascii=False)
    if 'enum' in a: return ' / '.join(map(str,a['enum']))
    if 'anyOf' in a or 'oneOf' in a: return ' 或 '.join(typ(x) for x in a.get('anyOf',a.get('oneOf')))
    t=a.get('type','JSON值')
    if t=='array': return typ(a.get('items',{}))+'[]'
    return t
def clean(v): return str(v).replace('|',' / ').replace('\n',' ').replace('\r',' ')
def meaning(path, schema):
    short=path.split('.')[-1]
    path=path.split('::')[-1]
    # Schema原文包含旧流程口吻时使用覆盖词典；字段不存在定义时直接报错要求补齐。
    return MEAN.get(path) or MEAN.get(short) or expand(schema).get('description') or '【待补释义】'+path
def rows(schema, prefix=''):
    schema=expand(schema)
    branches=schema.get('anyOf',schema.get('oneOf'))
    if branches and not schema.get('properties'):
        # 字符串枚举不展开；对象联合分支逐个展开，显示判别值。
        if any('properties' in expand(b) for b in branches):
            for idx,b in enumerate(branches):
                b=expand(b); pp=b.get('properties',{})
                tag=next((f'{k}={v["const"]}' for k,v in pp.items() if 'const' in v),str(idx+1))
                yield from rows(b, prefix+'['+tag+']::')
        return
    for key,value in schema.get('properties',{}).items():
        path=prefix+key; actual=expand(value)
        required='必填' if key in schema.get('required',[]) else '可省略'
        nullable='可null' if 'null' in typ(actual).split(' 或 ') else '非null'
        bounds='；'.join(f'{k}={actual[k]}' for k in ['minimum','maximum','minLength','maxLength','minItems','maxItems','uniqueItems'] if k in actual)
        default=json.dumps(actual['default'],ensure_ascii=False) if 'default' in actual else '无Schema默认'
        yield path,typ(value),required+'；'+nullable+'；'+default,bounds or '—',meaning(path,value)
        if actual.get('properties'): yield from rows(actual,path+'.')
        if actual.get('type')=='array':
            item=expand(actual.get('items',{}))
            if item.get('properties') or item.get('anyOf') or item.get('oneOf'): yield from rows(item,path+'[].')
        if actual.get('patternProperties'):
            for sub in actual['patternProperties'].values():
                yield path+'.{动态键}',typ(sub),'父对象存在时；非null','—',MEAN.get(key,'动态映射')
        branches=actual.get('anyOf',actual.get('oneOf'))
        if branches and any('properties' in expand(b) for b in branches): yield from rows(actual,path+'.')

text='''
## 8. 完整逐表字段字典（2026-10-23校订）

本节把18张目标表的字段放入正文。结构全集为[storage.schema.json](resources/v2.2/storage.schema.json)，与[data-contract.json](resources/v2.2/data-contract.json)的schemas一致。字段释义、来源和事务规则共同构成契约，JSON存在不代表应用已实现。

**存在性约定：** “可省略”不是“可null”；数据库目标行不存undefined，JSON序列化省略它。模型可选null在入库前转成省略；必填null拒绝。嵌套必填只在父对象存在时要求。空数组表示已知无条目，省略表示未提供/未计算；不得一律填空串或0。除表中明确default外，JSON Schema不负责补值，入口赋值见第9节。

**校验约定：** Schema只检查形状。Dexie索引不检查完整业务Schema、枚举或外键；应用命令服务必须执行结构、作用域、引用、引文、版本及租约校验。人工编辑按人工字段约束执行，不强加模型事实覆盖，但不能绕过引用/并发校验。历史弱校验记录与目标新写分开；导入不能静默猜补未知原文。

**时间和单位：** ISO时间由应用UTC序列化，界面再本地化；Unix数值时间为毫秒。正文字符数/offset按JavaScript UTF-16 code unit计数，字节限额按UTF-8 JSON计数。数据库索引首项为主键，`&`为唯一索引；所有关联均由应用维护，无SQL外键/自动级联。

以下字段保留原契约无上下界的number定义时，表示Schema未额外限制，不能宣称数据库已强制整数/范围。具体创建算法仍须生成合法业务值。
'''
missing=[]
for tid,name,definition,indexes,lifecycle in tables:
    text+=f'\n### {tid} · {name}\n\n'
    text+=f'库：'+('`westworld_settings` v2' if tid in ['T01','T02','T03'] else '`westworld_canon_{bookId}` 目标v5')+f'。索引：`{indexes}`。\n\n{lifecycle}\n\n'
    text+='| 字段路径 | 类型/枚举 | 必填、null、默认 | 结构限制 | 含义、来源与更新 |\n|---|---|---|---|---|\n'
    for row in rows(D[definition]):
        if '【待补释义】' in row[-1]: missing.append((name,row[0]))
        if name=='storyEditorNotes' and row[0]=='revision':
            row=(*row[:-1],'本次工作摘要修订号=提交前memory.revision+1；新/更新事项都赋本批修订号，不是各笔记独立加1')
        text+='| '+' | '.join(clean(c) for c in row)+' |\n'
    text+=f'\n[本表完整结构示例](resources/v2.2/table-examples/{name}.json)（固定人工数据；example指纹不作为实际恢复凭证）。\n\n```json\n'+json.dumps(samples[name][0],ensure_ascii=False,separators=(',',':'))+'\n```\n'

text+='''
## 9. 入口赋值、关联与迁移补充

| 表/字段 | 创建/更新入口与确定规则 |
|---|---|
| T01/T02 | API Key trim后按providerId覆盖；llm.config只保存一份，两模式共用。baseUrl缺省https://api.deepseek.com，提取模型deepseek-flash，归并模型deepseek-v4-pro。providerId/api是目标扩展，可省略时使用deepseek/openai-completions。compile.concurrency旧值可保留，但2.2调度固定单章在途，不读取旧并发值决定P1并发。 |
| T03–T05 | 导入分配新bookId；书名默认文件名；createdAt当前ISO时间；chapterIndex来自分章/切块，order从0连续；charCount=text.length；元信息和正文同章关联。书架与单书库跨库非原子，导入失败清理按04。 |
| T08/T10/T11 | P1成功后由代码分配章内ID并写bookId和章节信息，revision=1，createdBy=P1。人物/地点nameSource=extracted、manualKeep=false、sourceChapters=[chapterIndex]、aliases来自提取别名；手工新增ID=U-UUID，createdBy/manual名来源均manual，无原文章信息则manualSourceNote必填。confidence手工默认0.5。 |
| T08 | P1节点eventLineIds=[]；createdBy=P3用于有引文补点，manual用于人工节点；order代码生成。补点DTO无confidence时沿用补点服务默认0.6（模型未给置信度，不冒称模型评分）。actorIds不持久化。timeCoord/timePrecision/canonicalId为可携带兼容字段，不能推断存在独立时间推理/节点去重工具。 |
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
'''
path=next(ROOT.glob('03-*.md'))
original=path.read_text(encoding='utf-8').split('\n## 8. 完整逐表字段字典')[0]
original=original.replace('id, status | 当前事件线','id, lineStatus | 当前事件线')
original=original.replace('id, chapterIndex | 当前事件节点','id, chapterIndex, order | 当前事件节点')
original=original.replace('target/relation_type/direction/label','target/relation_type/direction/relation_label')
original=original.replace('{id,field,text,sourceChapters}', '{id,field,text,chapters}')
original=original.replace('timeText、timeCoord/precision（若有）、worldStateChanges、newFacts、initiatedActions','time_text/time_hint、timeCoord/timePrecision（若有）、world_delta、new_facts、started_actions')
original=original.replace('result、status、chapters','result、lineStatus、chapters')
original=original.replace('历史业务字段的详细类型可回查[2.1字段字典](resources/legacy-table-dictionary-2.1.md)，只复用未变字段；其生命周期/双层存储/发布规则已作废。当前机器结构和新增字段见[data-contract.json](resources/v2.2/data-contract.json)。','全部目标字段在本文件第8节逐表展开；第9节规定入口赋值和关联。历史字典仅用于追溯，不能替代当前字段定义。完整机器结构见[data-contract.json](resources/v2.2/data-contract.json)。')
path.write_text(original.rstrip()+'\n'+text,encoding='utf-8')
print('tables',len(tables),'missing meanings',missing)
