"""2.1补全：按实际表/操作与字段级数据流生成文档，不改应用。"""
from pathlib import Path
import json,re,zipfile,hashlib,ast
OUT=Path(__file__).resolve().parent.parent
ROOT=OUT.parents[2]
def dump(path,value):
 p=OUT/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def header(code,title):
 return f'''# WestWorld V2 · {title}

| 文档控制项 | 内容 |
|---|---|
| 文档编号 | {code} |
| 文档版本 | 2.1 |
| 产品 / 应用包版本 | WestWorld V2 / 1.0.0 |
| 复现基线 | WWV2-WORKTREE-20261021；实际工作区含未提交文件 |
| 文档状态 | 待评审；用户已确认忠实保留行为与缺陷 |
| 编写 / 维护 | Codex；后续维护负责人待指定 |
| 创建 / 更新 | 2026-10-21 / 2026-10-21（Asia/Shanghai） |
| 适用范围 | 当前工作区可达应用；不包含未来游玩功能 |
| 共同术语 / 关联 | [统一入口](00-阅读入口与术语.md)、[PRD](01-PRD.md)、[覆盖矩阵](12-验收执行与覆盖矩阵.md) |

### 修订记录

| 版本 | 日期 | 内容 | 影响 |
|---|---|---|---|
| 2.0 | 2026-10-21 | 建立正式规格包 | 保留历史约束 |
| 2.1 | 2026-10-21 | 按17种实际表、操作链、字段流及独立验收补全 | 不改变应用行为；校正覆盖结论 |

'''
def write(name,code,title,body): (OUT/name).write_text(header(code,title)+body.strip()+'\n',encoding='utf-8')
S=json.loads((OUT/'resources/schemas.json').read_text(encoding='utf-8'))
stores=json.loads((OUT/'resources/stores.json').read_text(encoding='utf-8'))
book='bk_acceptance'; stamp='2000-01-01T00:00:00.000Z'
with zipfile.ZipFile(OUT/'resources/fixtures/人工资产样本.wwv2') as z:
 seed={n:json.loads(z.read('data/'+n+'.json')) for n in ['book','chapters','characterSnapshots','locationSnapshots','nodes','eventLines','compileProgress']}
def remap(v):
 if isinstance(v,dict):return {k:(book if k in ['bookId'] else remap(x))for k,x in v.items()}
 if isinstance(v,list):return [remap(x)for x in v]
 return v
seed=remap(seed);seed['book']['id']=book
sample={
 'books':seed['book'],
 'credentials':{'providerId':'deepseek','credential':{'type':'api_key','key':'test-only-not-a-real-key'}},
 'appSettings':{'key':'llm.config','value':{'baseUrl':'https://api.deepseek.com','extractionModel':'deepseek-flash','aggregationModel':'deepseek-v4-pro'},'updatedAt':stamp},
 'chapters':seed['chapters'][0], 'chapterTexts':{'bookId':book,'chapterIndex':'1','text':'第一章 码头会面\n沈青在码头见到顾衡。顾衡将信交给沈青。'},
 'characterSnapshots':seed['characterSnapshots'][0], 'locationSnapshots':seed['locationSnapshots'][0],
 'nodes':seed['nodes'][0], 'eventLines':seed['eventLines'][0],
 'characters':{'id':'P001','bookId':book,'chapterIndex':'1','name':'沈青','aliases':[],'roleWeight':'NPC','relations':[],'confidence':1},
 'locations':{'id':'L001','bookId':book,'chapterIndex':'1','name':'码头','aliases':[],'confidence':1},
 'compileProgress':{'bookId':book,'stage':'P1','status':'idle','totalChapters':3,'completedChapters':[],'failedChapters':[],'updatedAt':stamp},
 'storyEditorMemory':{'id':'session_example','bookId':book,'sessionId':'session_example','revision':1,'workingSummary':'已核对第一章。','dataFingerprint':'example-fingerprint','updatedAt':stamp},
 'storyEditorNotes':{'id':'SN000001','bookId':book,'sessionId':'session_example','revision':1,'stage':'P2','key':'会面','kind':'decision','status':'active','statement':'会面属于书信交付线。','nodeIds':['C1-N001'],'lineIds':['L01'],'evidence':[],'basisFingerprint':'example-fingerprint','createdAt':stamp,'updatedAt':stamp},
 'storyEditorCheckpoints':{'id':'example-checkpoint-hash','bookId':book,'sessionId':'session_example','stage':'P2','phase':'link','scopeIds':['C1-N001'],'sourceFingerprint':'example-fingerprint','status':'completed','memberships':{'C1-N001':['L01']},'updatedAt':stamp},
 'storySessions':{'id':'session_example','bookId':book,'profile':'story_editor','kind':'initial','title':'初次故事编辑','status':'active','leafId':'entry_example','nextOrdinal':1,'createdAt':stamp,'updatedAt':stamp},
 'storySessionEntries':{'id':'entry_example','bookId':book,'sessionId':'session_example','ordinal':0,'parentId':None,'createdAt':stamp,'type':'message','message':{'role':'user','content':'核对第一章。','timestamp':946684800000}},
}
meta=[
('T01','settings','credentials','模型凭据','providerId','凭据的一条provider记录','设置保存/清除；CredentialStore.modify事务更新','模型、拉取/测试；页面仅状态和掩码','明文、每provider覆盖；不随删书删；不进入单书备份',None),
('T02','settings','appSettings','全局配置','key','一个设置键及其值','保存模型/并发/目录句柄；updatedAt更新','配置读取、模型适配、书架目录提示','除Key外配置及目录句柄；不备份；无业务级默认迁移',None),
('T03','settings','books','书架','id, createdAt','一次导入的一本书','小说/备份导入createBook；整书删除移除','useBooks倒序、export读取标题；无改书名UI','与单书库不跨库原子；同名书不去重','BookSchema'),
('T04','canon','chapters','章节元信息',stores['v4']['chapters'],'一个章/切块','importBook/saveChapters与正文同事务；备份恢复','预览后的章数、窗口、工具范围与章序','整书删除；无单章手动增删UI；顺序order为权威','ChapterSchema'),
('T05','canon','chapterTexts','分章原文',stores['v4']['chapterTexts'],'一个章/切块的正文','导入与chapters同事务；备份恢复','P1、单章试跑、频次、read_original、引文校验','不保存原始完整字节；首标题前丢弃；不直接UI编辑','ChapterTextSchema'),
('T06','canon','characterSnapshots','人物草稿',stores['v4']['characterSnapshots'],'一份当前保留的人物档案；初始逐章快照','P1 bulkPut；归并替换选中集合；编辑/手动合并/删除','人物列表详情、资产工具、频次、故事依据、入库','草稿可改，入库不删；删除不立即修改固定实体','StoredCharacterSnapshotSchema'),
('T07','canon','locationSnapshots','地点草稿',stores['v4']['locationSnapshots'],'一份当前保留的地点档案','P1、归并、手动更新并入删除','地点列表详情、工具、入库、记忆资料指纹','原始提取无aliases；归并/人工补；不与人物规则混用','StoredLocationSnapshotSchema'),
('T08','canon','nodes','事件节点',stores['v4']['nodes'],'一个原章事件；P1或检查补点','P1、runLink补点/反向归属、updateNode、deleteNode、入库actorIds','节点列表、图、事件工具、线派生、记忆依据','唯一当前表；没有独立冻结节点副本；timeCoord等无自动推断写入','StoredNodeSchema'),
('T09','canon','eventLines','事件线',stores['v4']['eventLines'],'一条有序事件成员集合','runLink create/append/update/merge；人工四字段/状态；删点/入库派生','线列表、图、工具、记忆依据','成员多对多；删线清节点归属，删点清空线','EventLineSchema'),
('T10','canon','characters','当前人物实体',stores['v4']['characters'],'本次入库的一个人物实体','publishCanon清表重建；备份恢复','资产包状态、actorIds映射；没有独立固定实体编辑UI','草稿改后不会自动同步；重复入库编号可变；relations.target仍称呼','CharacterSchema'),
('T11','canon','locations','当前地点实体',stores['v4']['locations'],'本次入库的一个地点实体','publishCanon清表重建；备份恢复','备份和已预留读取；无实际游玩消费','不生成节点地点ID映射；只有地点时书架可能未入库','StoredLocationSchema'),
('T12','canon','compileProgress','编译进度',stores['v4']['compileProgress'],'一个P1/P2/P3阶段记录','导入P1 idle；各任务写；阶段重跑删旧P3/P2','继续任务、CompilePanel、入库UI门槛','成功失败数组的单元意义随stage/模式变；不是只有章号','CompileProgressSchema'),
('T13','canon','storyEditorMemory','工作摘要',stores['v4']['storyEditorMemory'],'一条会话的最新摘要','ensure迁旧记忆；runLink与资产/检查点事务提交','下一批模型输入、记忆面板、get_editor_memory','id通常sessionId；旧id story_editor兼容；revision及指纹','StoryEditorMemorySchema'),
('T14','canon','storyEditorNotes','判断与复核事项',stores['v4']['storyEditorNotes'],'会话内一个稳定key的工作主题','runLink提交新增/更新/解决；初次会话迁旧空sessionId','面板筛选、工具、依据validity计算','唯一sessionId+key，resolved保留；stale为读取视图不是持久status','StoryEditorNoteSchema'),
('T15','canon','storyEditorCheckpoints','检查批次恢复点',stores['v4']['storyEditorCheckpoints'],'会话/阶段/phase/scope的一次检查','成功随资产事务；失败或取消单独recordEditorFailure','恢复跳批、面板最近5条','检查点不是游戏存档；保留失败/取消标记；指纹变化重做','StoryEditorCheckpointSchema'),
('T16','canon','storySessions','故事会话头',stores['v4']['storySessions'],'一个初次/完整复核会话','ensure建/归档；acquire/release租约；append更新末端','会话选择、恢复、工具历史','仅一个active由服务控制，非唯一索引；旧会话只读','StorySessionSchema'),
('T17','canon','storySessionEntries','追加会话条目',stores['v4']['storySessionEntries'],'一条message/compaction/omit/commit','append事务增加ordinal/parent并更新头；备份恢复','历史列表、投影、token估算、工具回查','原始不因压缩删除；末端链投影；唯一sessionId+ordinal','StorySessionEntrySchema'),
]
settings_schema={
'credentials':{'type':'object','properties':{'providerId':{'type':'string'},'credential':{'anyOf':[{'type':'object','properties':{'type':{'const':'api_key'},'key':{'type':'string'}},'required':['type','key'],'additionalProperties':True},{}],'description':'本UI写api_key/key；其他SDK凭据仅原样兼容，不主动生成'}},'required':['providerId','credential']},
'appSettings':{'type':'object','properties':{'key':{'type':'string'},'value':{'description':'按设置键判别；见配置键字典'},'updatedAt':{'type':'string'}},'required':['key','value','updatedAt']}}

def fields(s,path='',ancestor_optional=False):
 if 'anyOf'in s:
  out=[]
  for i,x in enumerate(s['anyOf'],1):
   if x.get('properties'):out+=fields(x,path+f'<分支{i}>',ancestor_optional)
  return out
 out=[];required=set(s.get('required',[]))
 for k,v in s.get('properties',{}).items():
  p=path+'.'+k if path else k
  out.append((p,v,k in required,ancestor_optional))
  c=v.get('items',{}) if v.get('type')=='array' else v
  if c.get('properties') or c.get('anyOf'):out+=fields(c,p+('[]'if v.get('type')=='array'else''),ancestor_optional or k not in required)
  for pat,x in v.get('patternProperties',{}).items():
   out.append((p+'{key}',x,True,True));out+=fields(x,p+'{key}',True)
 return out
def typ(v):
 if 'const'in v:return json.dumps(v['const'],ensure_ascii=False)
 if 'anyOf'in v:return ' / '.join(typ(x)for x in v['anyOf'])
 if v.get('type')=='array':return 'array<'+typ(v.get('items',{}))+'>'
 return v.get('type','SDK/按键判别')
def constraint(v):return '；'.join(f'{k}={json.dumps(v[k],ensure_ascii=False)}'for k in ['minimum','maximum','minLength','maxLength','minItems','maxItems','uniqueItems','pattern']if k in v)or'无额外结构限制'
def esc(v):return str(v).replace('|','\\|').replace('\n',' / ')

rules={
 'id':('按DATA-03生成；导入保留书内ID','仅建记录/整体重编；PK覆盖或add冲突'),
 'bookId':('当前书ID；备份恢复换newBookId','归属冗余字段；选库仍按bookId'),
 'chapterIndex':('分章序号/切块字符串；快照来自当前章','节点和快照创建后不随并入重新编号'),
 'chapterName':('切章标题；P1复制当前章','非自动从原文件名推断'),
 'order':('Chapter全书序0起；Node章内序0起','补点可按引文位置重排Node.order'),
 'createdAt':('创建时new Date().toISOString()','除恢复既有条目外不更新'),
 'updatedAt':('相应写入当前ISO时间','并非所有编辑都会更新：节点/事件线普通更新不统一加时间'),
 'name':('P1主称呼/归并保留或人工输入','草稿表单允许空写undefined，不自动强制Schema'),
 'aliases':('合并所有称呼去主名，或CSV人工输入','数组并集/人工替换；缺省不自动视为[]，实体构造有明确默认'),
 'confidence':('P1模型0–1；补点固定0.6；实体复制','无confidence<0.6自动阻止入库'),
 'roleWeight':('频次分位或人工Select；实体缺省NPC','manual优先，非manual重算；不是模型因果重要性'),
 'roleWeightSource':('自动frequency / 人工manual','manual更新后自动归并不得覆盖层级'),
 'profile':('模型精确年龄/原文描述/性别；合并冲突保留说明','ageText点路径更新；保留age/gender'),
 'relations':('原文人物关系；按target/type/direction融合','target始终称呼；无自动全量实体ID转换'),
 'sourceChapters':('合并来源chapterIndex并集numeric排序','范围选择同时检查它；不拿来源章冒充真实主名出场'),
 'frequency':('代码扫描最终主名正文命中','合并末重算；chapters原章去重，mentions非重叠匹配'),
 'mergeFacts':('四文本拆分去重及稳定事实ID','改四文本时替换对应事实、清退休优化ID'),
 'mergeNotes':('本地冲突或AI merge_notes并集','可在详情查看，无单独解决按钮'),
 'optimizedFactIds':('人物整编成功后当前底稿事实ID全集','人工改字段移除退休ID；非模型直接写长哈希'),
 'optimizationFingerprint':('names/facts/notes JSON签名','资料变则失效；不是全库指纹'),
 'actorIds':('入库匹配actors+targets所得人物ID并集','仅入库重算，不随普通actors编辑立即同步'),
 'eventLineIds':('runLink/deleteNode/deleteEventLine根据线成员反算','无归属明确[]；P1/导入可能省略'),
 'characterIds':('线成员节点actorIds有序并集','runLink/删点/入库重算，普通线表单不重算'),
 'chapters':('线成员节点chapterIndex去重排序','runLink和删点重算；不是章节表正文副本'),
 'nodeIds':('AI线操作的成员，临时补点ID映射后排序','append并集/update替换/merge多线并集'),
 'timeCoord':('只保留导入/已有值；没有自动生成流程','可参与时间范围和记忆指纹'),
 'timePrecision':('已有或导入值；不由本基线自动推断','枚举存在不增加世界时钟'),
 'canonicalId':('兼容可携带字段','无当前自动节点去重流程'),
 'sessionId':('当前/历史故事会话ID；旧数据缺省空串','会话归属过滤；不能查另一书'),
 'revision':('记忆预期版本+1；note引用本次revision','提交前校验memory.revision防冲突'),
 'status':('按对象/流程转移表赋值','不能从同名status推断同一业务语义'),
 'dataFingerprint':('全库选定事实与assetFingerprint SHA256','读记忆时计算dataChanged；不保存派生显示布尔'),
 'basisFingerprint':('本note引用事实/原文与资产指纹','读取时比对得到current/stale，不改note.status'),
 'sourceFingerprint':('该批范围的原文/节点或线/资产指纹','相同completed且归属未变才跳过'),
 'memberships':('该link批每节点的线ID快照','恢复比较当前归属，review通常空映射'),
 'leaseOwner':('acquire生成UUID','release清除；不导出恢复旧执行租约'),
 'leaseUntil':('取得/持owner追加时Date.now()+300000','毫秒值；失去owner探测后可恢复'),
 'nextOrdinal':('新会话0；每次append+1','与条目新增和leafId同事务'),
 'leafId':('最新追加条目ID','投影从末端追父链；恢复校验所属会话'),
 'parentId':('append时旧leafId，无旧条目null','必须同session较小序号；原始链不因压缩重写'),
 'ordinal':('append时session.nextOrdinal','会话内唯一，从0递增'),
}

def rule(table,p,v):
 top=re.sub(r'<分支\d+>', '', p).lstrip('.').split('.')[0];src,update=rules.get(top,('见本表创建源与对象语义；从提交/表单对应字段复制','本表生命周期规定覆盖、合并或追加方式'))
 if top=='id':
  ids={'books':'小说bk_UUID；备份bk_时间36进制_随机4字符', 'characterSnapshots':'C{chapterIndex}-P{去重后序号至少3位}', 'locationSnapshots':'C{chapterIndex}-L{去重后序号至少3位}', 'nodes':'C{chapterIndex}-N{序号至少3位}；补点取本章已有最大序号+1', 'eventLines':'L{现有L数字最大+1，至少2位}', 'characters':'每次入库按来源ID排序从P001重编', 'locations':'每次入库按来源ID排序从L001重编', 'storyEditorMemory':'当前sessionId，旧无会话id兼容story_editor', 'storyEditorNotes':'同会话key沿用旧id；新增取本书SN数字最大+1，至少6位', 'storyEditorCheckpoints':'work含sessionId及排序去重scopeIds JSON的SHA256 hex', 'storySessions':'crypto.randomUUID()', 'storySessionEntries':'crypto.randomUUID()'}
  return(ids.get(table,'本表主键生成规则'), '创建后作为本表主键；覆盖/重编/恢复的例外按本表生命周期执行')
 if table=='credentials':return ('保存Key写deepseek/api_key，实际Key trim；SDK CredentialStore可携带其他凭据','modify在credentials事务内读改写；UI清除delete')
 if table=='appSettings':return ('由key判定具体value；配置键字典逐项定义','setAppSetting put覆盖value/updatedAt；无全量设置校验')
 if table=='books' and top=='title':return('小说文件去最后扩展名；备份原title+（导入）','没有UI改书名；同名可多条')
 if table=='chapters' and top=='charCount':return('text.length，UTF-16单位','分章时一次生成；无token换算')
 if table=='chapterTexts' and top=='text':return('已解码章节片段','不包含首标题前丢弃片段；不保存完整原始bytes')
 if table=='compileProgress':
  overrides={'completedChapters':('P1章块ID；P2窗口序号字符串；P3 assets/lines','代码Set/数组更新，样本模式按当前步骤'), 'failedChapters':('P1失败章块；P2失败窗口；P3失败步骤','成功恢复清对应失败，P3另计上游失败'), 'partialChapters':('key为失败章块ID，value缺worldAssets/narrativeAssets','恢复只请求缺子步骤；全部成功delete键'), 'testScope':('阶段测试P1完成章/块集合','完整流程不使用其完成标记跳过剩余章'), 'planKey':('完整JSON{version:4,windows,useAi}；样本JSON{mode,scope}','不匹配重置窗口恢复'), 'lastWindowIndex':('P2连续成功窗索引，初-1','失败后不越过空洞'), 'editorSessionId':('编排ensure得到的active session.id','不匹配时恢复点失效')}
  return overrides.get(top,(src,update))
 if (src,update)==('见本表创建源与对象语义；从提交/表单对应字段复制','本表生命周期规定覆盖、合并或追加方式'):
  if table in ['characterSnapshots','locationSnapshots']:
   array='characters'if table=='characterSnapshots'else'locations'
   editable={'characterSnapshots':{'name','aliases','identity','profile','personality','background','appearance','speech_style_sample'},'locationSnapshots':{'name','aliases','description'}}[table]
   return(f'P1 world.{array}[i].{top}；合并按字段融合保留',f'合并更新{top}；'+('UI对应字段保存覆盖，profile仅ageText'if top in editable else'无直接UI编辑入口；备份恢复可携带'))
  if table=='nodes':
   editable={'name','summary','process','actors','time_text','time_hint','targets','world_delta','new_facts','started_actions'}
   return(f'P1 narrative.nodes[i].{top}；检查new_nodes[i].{top}',f'普通编辑{top}'+('按表单patch替换'if top in editable else'无直接UI编辑；补点时从已验证提取结果复制')+'；相关派生按DF-03/09执行')
  if table=='eventLines':
   mapping={'title':'create.title（其他操作保留旧title）','cause':'op.cause','process':'op.process','result':'op.result','lineStatus':'op.line_status'}
   return(mapping.get(top,'当前事件线操作对应字段'),f'人工{top}表单/状态可覆盖；普通update不重算成员和更新时间')
  if table in ['characters','locations']:
   source='characterSnapshots'if table=='characters'else'locationSnapshots'
   sourcefield='speech_style_sample'if top=='speechStyleSample'else top
   return(f'入库读取{source}.{sourcefield}',f'每次入库清表后重新复制{top}；草稿修改不即时同步；备份恢复可携带')
  if table=='storyEditorMemory':return(f'memory_update.{top}（由代码补元数据）','同批事件/记忆事务覆盖当前会话记录')
  if table=='storyEditorNotes':return(f'memory_update.notes[i].{top}；元数据来自当前work','按sessionId+key更新；原kind不允许改变；stale为读取派生')
  if table=='storyEditorCheckpoints':return(f'当前work.{top}或该批执行结果','成功同批事务/失败取消单写；恢复时核指纹和成员')
  if table=='storySessions':
   sm={'profile':'代码常量story_editor','kind':'newReview?review:initial','title':'初次故事编辑或全书复核n','parentSessionId':'归档旧active.id'}
   return(sm.get(top,f'ensure/acquire/append生成的{top}'),'会话头服务按对应生命周期更新，UI不能直接编辑')
  if table=='storySessionEntries':return(f'appendSessionEntry的data.{top}（type决定字段）','追加后不回写原条目；compaction/omit改变投影不删除消息')
  if table=='books':return('创建书籍参数或备份元数据对应字段','创建时复制；author/sourceFileName未提供则省略，无UI改写')
  if table in ['chapters','chapterTexts']:return(f'ChapterDraft.{top}或同bookId元数据','导入/恢复写入；不主动生成额外字段')
 return src,update

def meaning(path, value):
 module=ast.parse((OUT/'scripts/write-data-spec.py').read_text(encoding='utf-8'))
 labels=next(ast.literal_eval(n.value) for n in module.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='labels' for t in n.targets))
 key=re.sub(r'<分支\d+>', '', path).split('.')[-1].replace('[]','')
 return {'providerId':'模型提供者标识','credential':'凭据对象','value':'按配置键判别的值'}.get(key,labels.get(key, value.get('description',key)))

def make_data():
 previous=OUT/'03-Spec-数据与存储.md'
 archive=OUT/'resources/schema-dictionary-v2.0.md'
 if not archive.exists():archive.write_bytes(previous.read_bytes())
 body='''## 1. 库表数量与计数口径

系统有 **2种数据库定义**：全局设置库1个，单书资产库按书复制。全局库 **3张表**，每书库 **14张表**，共 **17种实际表定义**。持有N本书时通常有`1+N`个业务数据库和`3+14N`张表实例；空书架仅设置库。创建顺序/失败可能留下空单书库或孤立书架项，实例数以实际存在为准。

52个Schema包含持久实体、模型DTO、操作联合及视图，**不等于52张表**。本文件按17张物理表组织；完整机器结构在schemas.json，模型DTO不再冒充存储表。

| 表编号 | 数据库 | 表 | 中文用途 | 行的粒度 | 结构 |
|---|---|---|---|---|---|
'''
 for tid,db,t,name,index,grain,creator,reader,life,schema in meta:body+=f'| {tid} | '+('westworld_settings'if db=='settings'else'westworld_canon_{bookId}')+f' | `{t}` | {name} | {grain} | {schema or "按SDK/设置键判别"} |\n'
 body+='''
## 2. 配置键、内存状态与非表结构

| 容器 | 内容/键 | 值与更新 |
|---|---|---|
| appSettings | llm.config | baseUrl（空读回官方）、extractionModel、aggregationModel、可选aggregationContextWindow；模型保存按trim；窗口UI校验整数≥8192 |
| appSettings | compile.concurrency | 默认3；Math.round后clamp1–16；不存在自动返回默认，非法NaN仍按原算式结果，不额外补验证 |
| appSettings | assets.exportDirectory | FileSystem目录句柄，不是JSON路径；读写权限在实际保存时检查 |
| ui-store内存 | activeView/bookId/assetTab/selectedAssetId | 资产/空/人物/空初值；刷新重置；工作台实际详情还用局部selected |
| compile-store内存 | status/stage/total/completed/failed/cost/logs/abortController | 事件驱动；无独立日志表，最近2000行；刷新不恢复cost/logs |
| 局部组件内存 | 预览bytes/表单/弹窗/选中详情/分页/高亮/游玩消息 | 按挂载卸载重置；不能用数据库持久化偷偷增强 |
| 文件 | .wwv2 ZIP/章节txt/manifest | 备份为独立文件，不是另一个数据库或游戏存档 |

字段必填是结构契约，**不是宣称所有写入入口都执行该校验**。模型提交走Schema+业务规则；人工编辑可写undefined，普通Node/EventLine更新不执行完整Schema。JS undefined在JSON导出被省略。

## 3. 逐表字段、生命周期与消费关系

示例均为脱敏人工结构样本；含example-fingerprint的指纹只是合法字段示意，不代表该样本已通过真实恢复检查。可运行测试使用scenarios与acceptance中的确定性前后值。

'''
 fieldmap=[];inventory=[]
 for tid,db,t,name,index,grain,creator,reader,life,schema in meta:
  sch=S[schema] if schema else settings_schema[t]
  rows=fields(sch);sample_path='resources/table-examples/'+t+'.json';dump(sample_path,sample[t])
  fieldsinfo=[]
  # 独立拼接，避免把读写生命周期埋在Schema附录。
  intro=f'''### {tid} · {t}（{name}）

| 项目 | 规定 |
|---|---|
| 所属库/版本 | {'westworld_settings / v2'if db=='settings'else'westworld_canon_{bookId} / v4'} |
| 记录粒度/范围 | {grain}；{'本机浏览器来源全局'if db=='settings'else'本书物理库'} |
| 主键及索引 | `{index}`；首项主键、&唯一、[a+b]复合，无额外外键 |
| 创建与更新 | {creator} |
| 读取者 | {reader} |
| 删除/保留/关联 | {life} |
| 备份 | {'配置与凭据不导出；books作为book.json元数据'if db=='settings'else'同名data/'+t+'.json；chapterTexts另为chapters/*.txt'} |
| 示例 | [人工记录]({sample_path}) |

| 字段路径 | 中文含义/单位 | 类型/枚举 | 必填/缺省/null | 限制 | 来源/生成 | 更新/引用与消费 |
|---|---|---|---|---|---|---|
'''
  body+=intro
  for p,v,required,parentOptional in rows:
   src,upd=rule(t,p,v);presence=('父存在则必填'if parentOptional else'必填')if required else'可省略'
   nullable=any(x.get('type')=='null'for x in v.get('anyOf',[]))or v.get('type')=='null'
   presence+='；'+('允许null'if nullable else'非null（人工弱校验另见操作）')+'；无Schema默认'
   body+='| '+' | '.join(map(esc,[p,meaning(p,v),typ(v),presence,constraint(v),src,upd]))+' |\n'
   fieldsinfo.append({'path':p,'schema':v,'required':required,'parentOptional':parentOptional,'source':src,'update':upd})
   fieldmap.append({'table':tid,'field':p,'section':f'{tid} · {t}','source':src,'update':upd})
  body+='\n'
  inventory.append({'id':tid,'database':db,'name':t,'index':index,'schema':schema,'purpose':name,'grain':grain,'writers':creator,'readers':reader,'lifecycle':life,'fields':fieldsinfo,'example':sample_path})
 body+='''## 4. 结构关系、迁移和交换契约

数值缺省、ID及备份细则见[DATA-02～05](resources/数据值-ID与备份格式.md)；完整Schema结构另存schemas.json，历史Schema目录不再充当实际表字典。17张实际表及其生效生命周期以上文为权威。关键关系：books.id决定选库；章文本/章元数据按chapterIndex对应；nodes与eventLines成员多对多；actorIds引用当前characters；工作摘要/notes/checkpoints按sessionId归属；消息parentId/leafId形成追加链。

入库清空并重建characters/locations，不删除快照；Node和EventLine没有单独冻结副本。临时DTO经验证不等于已提交，只有对应事务成功后才生效。详细步骤与前后值见[字段级数据流](10-字段级数据流与状态转移.md)。

### 迁移执行表

| 对象/版本 | 字段变化 | 保留/限制 |
|---|---|---|
| settings v1→v2 | 加books表 | credentials/appSettings保留 |
| canon v1→v2 | 快照sourceChapters缺省[chapterIndex]、mergeNotes=[]，地点aliases=[]；P1 partialChapters={}，地点实体aliases=[] | 不重提取正文或覆盖人工资料 |
| canon v2→v3 | 增记忆、notes、checkpoints | 不生成原始聊天 |
| canon v3→v4 | 加session与entry，notes/checkpoints sessionId缺省空串并更新索引 | 旧记忆首次ensure复制到新会话，旧检查点不当新消息恢复点 |

### 必须分开的非表结构

WorldAssetsExtraction/NarrativeAssetsExtraction为模型结果；AliasGroups/CharacterOptimization/LinkEventLinesResult为提交意图；StoryEditorNoteView、分页响应、图布局为读取视图；旧MergedEntity及旧关系图为兼容声明。它们不得增加数据库表或新UI功能。
'''
 write('03-Spec-数据与存储.md','WW-DATA','逐库逐表数据与生命周期',body)
 oldtext=archive.read_text(encoding='utf-8')
 sub=oldtext[oldtext.index('## DATA-02'):oldtext.index('## DATA-06')]
 (OUT/'resources/数据值-ID与备份格式.md').write_text('# 数据值、ID与备份格式（2.1规范附件）\n\n适用基线未改变；与逐表说明共同阅读，ID生成和实体重编例外按主文档表项执行。\n\n'+sub,encoding='utf-8')
 dump('resources/storage-inventory.json',{'databaseDefinitions':2,'globalTableDefinitions':3,'perBookTableDefinitions':14,'totalTableDefinitions':17,'instanceFormula':{'databases':'1+N','tables':'3+14N'},'tables':inventory})
 dump('resources/field-coverage.json',fieldmap)

if __name__=='__main__':
 make_data();print('Wrote 17 actual table specifications.')
