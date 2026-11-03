from pathlib import Path
import json,runpy

OUT=Path(__file__).resolve().parent.parent
ns=runpy.run_path(str(Path(__file__).with_name('write-specifications.py')))
write=ns['write']
schemas=json.loads((OUT/'resources/schemas.json').read_text(encoding='utf-8'))
stores=json.loads((OUT/'resources/stores.json').read_text(encoding='utf-8'))
mapping={
'chapters':'ChapterSchema','chapterTexts':'ChapterTextSchema','characterSnapshots':'StoredCharacterSnapshotSchema',
'locationSnapshots':'StoredLocationSnapshotSchema','nodes':'StoredNodeSchema','eventLines':'EventLineSchema',
'characters':'CharacterSchema','locations':'StoredLocationSchema','compileProgress':'CompileProgressSchema',
'storyEditorMemory':'StoryEditorMemorySchema','storyEditorNotes':'StoryEditorNoteSchema',
'storyEditorCheckpoints':'StoryEditorCheckpointSchema','storySessions':'StorySessionSchema','storySessionEntries':'StorySessionEntrySchema'}
labels={'id':'记录编号','bookId':'书籍归属','sessionId':'会话归属','name':'名称/主名','title':'标题','author':'作者','sourceFileName':'源文件名','createdAt':'创建时间','updatedAt':'更新时间','chapterIndex':'章节标识','chapterName':'章节名称','charCount':'字符数','order':'章内/全书顺序','text':'正文','aliases':'累计别名','aliases_mentioned':'本章提及别名','identity':'身份','profile':'基础资料','age':'精确年龄','ageText':'原文年龄描述','gender':'性别','appearance':'外貌','personality':'性格','background':'背景','speech_style_sample':'原话片段（草稿字段）','speechStyleSample':'原话片段（实体字段）','relations':'人物关系','target':'关系目标称呼','relation_type':'关系类型','relation_label':'关系文案','direction':'关系方向','confidence':'置信度','roleWeight':'人物层级','roleWeightSource':'层级来源','sourceChapters':'来源章集合','mergeNotes':'冲突与复核信息','frequency':'出场统计','chapters':'涉及/覆盖章节','mentions':'主名提及次数','scopeChapters':'统计原章总数','percentile':'相对分位','mergeFacts':'合并事实底稿','field':'事实所属字段','optimizedFactIds':'已整编事实编号','optimizationFingerprint':'整编资料指纹','description':'描述','summary':'摘要','process':'详细经过','actors':'行动者称呼','targets':'对象称呼','world_delta':'状态变化描述','new_facts':'新出现事实','started_actions':'开始的行动','time_text':'明确时间原文','time_hint':'相对时间原文','quote':'逐字引文','offset':'字符偏移','createdBy':'节点创建阶段','eventLineIds':'所属线编号','actorIds':'映射人物编号','timeCoord':'已有时间坐标','timePrecision':'时间精度标记','canonicalId':'去重主节点编号','nodeIds':'成员/依据节点','timeRange':'已有时间范围','cause':'起因','result':'结果','lineStatus':'事件线状态','characterIds':'人物实体编号','stage':'编译阶段','status':'状态','totalChapters':'阶段总单元数','completedChapters':'完成单元标识','failedChapters':'失败单元标识','lastWindowIndex':'连续完成窗口索引','planKey':'编排计划签名','editorSessionId':'编排所用会话','testScope':'样本章块范围','partialChapters':'缺失子步骤','key':'稳定主题键','kind':'类型','statement':'判断/事项说明','lineIds':'依据线编号','evidence':'原文证据','workingSummary':'工作摘要','notes':'工作记录增量','revision':'修订号','dataFingerprint':'全局资料指纹','basisFingerprint':'引用依据指纹','validity':'依据有效性','phase':'检查阶段类型','scopeIds':'批次对象范围','sourceFingerprint':'检查输入指纹','memberships':'节点归线快照','parentSessionId':'父复核会话','leafId':'消息链末端','nextOrdinal':'下一消息序号','leaseOwner':'当前租约持有者','leaseUntil':'租约到期毫秒','ordinal':'消息序号','parentId':'父条目编号','type':'条目/结构类型','message':'原始PI消息','role':'消息角色','content':'消息内容','timestamp':'毫秒时间戳','firstKeptEntryId':'压缩保留边界','tokensBefore':'压缩前token估算','tokensAfter':'压缩后token估算','systemMessage':'系统消息快照','usage':'用量','input':'输入量','output':'输出量','totalTokens':'总token量','cost':'估算费用','omittedEntryIds':'不参与投影的条目','reason':'原因','op':'操作类型','line_id':'已有线编号','node_ids':'操作成员节点','line_status':'提交线状态','keep_line_id':'保留线编号','merge_line_ids':'待合并线编号','client_id':'提交临时节点编号','event_line_ops':'线操作集合','new_nodes':'补点集合','memory_update':'记忆增量','canonicalName':'分组主名','names':'分组档案主名','groups':'合并组','entity':'融合实体','merge_notes':'模型冲突说明','entities':'以人物ID为键的结果','covered_fact_ids':'本次覆盖事实编号','truncated':'截断标记','relationType':'旧融合关系类型','relationLabel':'旧融合关系文案'}

def kind(s):
    if 'const' in s:return json.dumps(s['const'],ensure_ascii=False)
    if 'anyOf' in s:return ' / '.join(kind(x) for x in s['anyOf'])
    if 'allOf' in s:return '交集'
    if s.get('type')=='array':return 'array<'+kind(s.get('items',{}))+'>'
    return s.get('type','unknown')
def constraints(s):
    keys=['minimum','maximum','minLength','maxLength','minItems','maxItems','uniqueItems','additionalProperties','default','pattern']
    return '；'.join(f'{k}={json.dumps(s[k],ensure_ascii=False)}' for k in keys if k in s) or '无额外结构约束'
def esc(t):return str(t).replace('|','\\|').replace('\n',' / ')
def origin(schema_name,key):
    field=key.split('.')[-1].replace('[]','')
    if schema_name.startswith(('Alias','Merged','Optimized','CharacterOptimization','EventLineOp','NewNodeDraft','LinkEventLinesResult','WorldAssets','NarrativeAssets','SessionCompactionResult','EditorMemoryUpdate','EditorNoteDraft','EditorEvidence')):return '模型提交；动态枚举由代码注入' if field not in ['bookId'] else '代码归属'
    if field in ['id','bookId','sessionId','createdAt','updatedAt','revision','ordinal','parentId','leafId','nextOrdinal','leaseOwner','leaseUntil']:return '代码生成/更新；恢复时按DATA-05映射'
    if field in ['actorIds','characterIds','eventLineIds','chapters','timeRange','sourceChapters','mergeFacts','frequency','mentions','scopeChapters','percentile','optimizationFingerprint','optimizedFactIds','dataFingerprint','basisFingerprint','sourceFingerprint','memberships','validity']:return '代码派生；见相关算法'
    if 'Compile' in schema_name or 'Checkpoint' in schema_name:return '编排器/检查流程'
    if 'Session' in schema_name or 'NativeMessage' in schema_name:return 'PI原始消息或会话执行器'
    if 'StoryEditor' in schema_name:return '经校验的模型增量与代码元数据'
    if schema_name in ['ChapterSchema','ChapterTextSchema']:return '导入分章结果'
    if schema_name=='BookSchema':return '文件名/导入参数或备份元数据'
    if field=='roleWeight' or field=='roleWeightSource':return '主名频次统计或人工选择'
    return '模型提取/合并或允许的人工编辑；恢复可携带'
def flatten(s,prefix='',parent_optional=False):
    if 'anyOf' in s:
        rows=[]
        for i,v in enumerate(s['anyOf'],1):rows+=flatten(v,prefix+f'<分支{i}>',parent_optional)
        return rows
    rows=[]; req=set(s.get('required',[]))
    for k,v in s.get('properties',{}).items():
        key=f'{prefix}.{k}' if prefix else k
        optional=k not in req
        required='否' if optional else ('父对象存在时必填' if parent_optional else '是')
        desc=v.get('description',labels.get(k,k))
        rows.append((key,labels.get(k,k),kind(v),required,'未定义' if 'default' not in v else v['default'],constraints(v),desc))
        child=v.get('items',{}) if v.get('type')=='array' else v
        if child.get('properties') or child.get('anyOf'):
            rows+=flatten(child,key+('[]' if v.get('type')=='array' else ''),parent_optional or optional)
        for pattern,ps in v.get('patternProperties',{}).items():
            rows.append((key+'{动态键}', '按键索引的值',kind(ps),'由记录键决定','无',constraints(ps),ps.get('description','键匹配 '+pattern)))
            rows+=flatten(ps,key+'{动态键}',parent_optional or optional)
    return rows

body=r'''
## DATA-01 数据库、表与索引

系统必须创建全局`westworld_settings`，版本2：`credentials:'providerId'`、`appSettings:'key'`、`books:'id, createdAt'`。凭据和设置不属于任何单书库。

每书数据库名为`westworld_canon_{bookId}`，版本4。主键、复合索引和唯一约束必须按下表创建；Dexie索引声明的第一项为主键，`&`唯一，`[a+b]`复合。没有索引的字段可在内存排序，不得自动新增跨书全局表。

| 表 | 数据结构 | Dexie索引声明 |
|---|---|---|
'''
for table,index in stores['v4'].items():body+=f'| `{table}` | `{mapping[table]}` | `{index}` |\n'
body+=r'''

### 数据关系

```mermaid
erDiagram
 BOOK ||--o{ CHAPTER : contains
 BOOK ||--o{ CHARACTER_DRAFT : owns
 BOOK ||--o{ LOCATION_DRAFT : owns
 CHAPTER ||--o{ NODE : locates
 NODE }o--o{ EVENT_LINE : member
 CHARACTER_DRAFT ||--o| CHARACTER_ENTITY : publish_copy
 NODE }o--o{ CHARACTER_ENTITY : actorIds
 BOOK ||--o{ STORY_SESSION : owns
 STORY_SESSION ||--o{ SESSION_ENTRY : chain
 STORY_SESSION ||--o{ EDITOR_NOTE : notes
```

关系为业务引用，不是数据库外键。节点actorIds包含行动者和对象。人物relations.target仍是称呼。单书库隔离书内重复ID；实体/节点引用不会自动跨书解析。

## DATA-02 值、默认与校验阶段

1. 未提供可选属性时保留省略，不自动填空字符串、空数组或null；显式构造处的默认按下表及算法执行。
2. 模型工具边界须执行对应Schema和业务校验；strict协议可选null按原Schema恢复为省略，必填null不得删除来逃避校验。
3. 普通人工编辑写入不统一运行完整Schema。必填string被界面清空后可写成undefined；不得在复现中自动添加required校验（BUG-06）。
4. JSON导出省略undefined；IndexedDB与JSON的undefined处理差异必须保留。书内字段命名中snake_case/camelCase混用为外部兼容结构，不统一改名。
5. 字段描述中历史用途仅表示字段含义；实际执行规则由流程/AI/UI Spec决定。例如timeCoord存在不要求实现自动推断。

| 值 / 对象 | 创建源 | 明确默认或更新方式 |
|---|---|---|
| Book | 小说/备份导入 | id见DATA-03；createdAt为当前ISO字符串，作者未提供则省略 |
| Chapter/ChapterText | 固定分章 | order从0；正文与元数据分表；bookId统一 |
| 人物/地点快照 | P1、归并、手动编辑 | confidence来自模型；roleWeight可省略，UI显示NPC |
| 人物/地点实体 | 入库 | roleWeight缺省NPC、relations缺省[]、实体aliases去主名 |
| 节点 | P1或P2/P3补点 | P1 order从0；补点confidence=0.6、createdBy=当前阶段；actorIds入库才生成 |
| 事件线 | AI操作 | chapters派生、characterIds由节点派生、updatedAt当前ISO |
| 进度 | 导入和任务 | 初次P1 idle、completed/failed=[]；不同stage总数单位不同 |
| 工作记忆 | 按会话提交 | 初次revision0、摘要与指纹空字符串、更新时间空；提交revision+1 |
| 复核/判断 | 模型有效增量 | revision≥1，主题键在会话内唯一；依据指纹随提交更新 |
| 会话 | 初次或新全书复核 | UUID、active、nextOrdinal0；复核归档旧会话、parentSessionId指旧会话 |
| 条目 | 追加消息/压缩/确认/省略 | UUID，ordinal=nextOrdinal，parentId=旧leafId或null，然后更新末端 |
| 目录句柄 | 浏览器选择 | 存在appSettings，导出只显示目录名；不是JSON文件路径 |

### 全部关键枚举

| 字段 | 值：文案/用途 |
|---|---|
| CompileStage | P1：逐章提取；P2：窗口归并与串联；P3：全书合并与检查 |
| CompileStatus | idle：未运行；running：运行；paused：暂停；cancelling：声明存在但取消入口不强制经过；cancelled：已取消；failed：失败；completed：本阶段范围完成 |
| roleWeight | 主要人物；重要配角；NPC；路人（值与文案相同） |
| roleWeightSource | frequency：自动频次；manual：人工 |
| lineStatus | open：进行中；closed：已结束 |
| relation.direction | bidirectional：双向；directed：有向 |
| timePrecision | explicit、inferred_hour、inferred_day、order_only；仅字段兼容，不新增推断过程 |
| EditorNote.kind/status | decision：编辑判断；review：复核事项；active：有效/待处理；resolved：已解决 |
| NoteView.validity | current：依据当前；stale：依据变化 |
| Checkpoint.phase/status | link：节点串联；review：线复核；completed/failed/cancelled |
| Session.kind/status/profile | initial：初次；review：新复核；active/archived；profile固定story_editor |
| SessionEntry.type | message、compaction、omit、commit |
| NativeMessage.role | system、user、assistant、toolResult |
| EventLineOp.op | append、create、update、merge |
| ErrorKind | network、rate_limit、server、auth、content_policy、context_length、validation、unknown |

## DATA-03 ID、编号与时间

| 对象 | 规则 |
|---|---|
| 小说新书 | `bk_${crypto.randomUUID()}` |
| 备份新书 | `bk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}` |
| P1快照/节点 | `C{chapterIndex}-{P或L或N}{序号padStart(3,'0')}`；序号从1，不截断大于3位 |
| 自动合并保留项 | ID numeric locale顺序最早；手动合并保留指定keepId |
| 固定人物/地点 | 每次入库从P001/L001重新编排，不保持跨次永恒ID |
| 新线 | 现有匹配`^L(\d+)$`最大值+1，至少2位，不冲突；merge保留目标 |
| 检查补点 | 原章最大-N数字+1，至少3位；同章同name同quote视为已存在并重映射 |
| 会话/消息/租约 | crypto.randomUUID；条目序号从0递增 |
| 工作记录 | 跨本书所有旧notes最大`SN`数字+1，至少6位；更新同会话key沿用id |
| 检查点 | 对work（含sessionId）和去重排序scopeIds作JSON序列化后SHA-256十六进制 |

书籍和业务更新时间用ISO8601；leaseUntil用毫秒时间戳；日志时间由运行环境`toLocaleTimeString('zh-CN')`显示。备份文件名用UTC ISO日期片段，不使用客户端显示时区替换。原文时间文本与系统时间分开。

## DATA-04 迁移

| 升级 | 必须执行的变换 |
|---|---|
| 设置v1→v2 | 保留credentials/appSettings，新增books |
| 单书v1→v2 | 人物/地点sourceChapters缺省[chapterIndex]、mergeNotes缺省[]；地点aliases缺省[]；P1 partialChapters缺省{}；地点实体aliases缺省[] |
| 单书v2→v3 | 新增storyEditorMemory/Notes/Checkpoints，旧资产与人工资料不改 |
| 单书v3→v4 | 新会话及条目表；记忆相关会话索引按stores.json；旧notes/checkpoints的sessionId缺省空串 |
| 首次建立完整故事会话 | 旧story_editor记忆复制到新sessionId；旧未归属notes迁至新会话；旧检查点保留但不冒充新完整会话恢复点 |

不得将旧工作记录伪造成历史原始聊天。数据库迁移与备份版本兼容分别实现。

## DATA-05 备份结构与恢复

manifest字段：`format='westworld-v2'`、`formatVersion=4`、`appVersion='1.0.0'`、`exportedAt:ISO`、`book:{id,title,author?,chapterCount}`、`contents:string[]`、`excludes:['apiKey','eventLog']`、`checksums:{相对路径:'sha256:'+64位hex}`。

`data/book.json`为单个Book；其余下列JSON是数组：chapters、characterSnapshots、locationSnapshots、characters、locations、nodes、eventLines、compileProgress、storyEditorMemory、storyEditorNotes、storyEditorCheckpoints、storySessions、storySessionEntries。每个文件UTF-8、JSON缩进2。原文为`chapters/{chapterFileName}.txt`，普通101→0101.txt，101.1→0101_1.txt。ZIP压缩level6；manifest自身不加入自己的checksum。

导出必须在单书全表只读事务中读取资产/进度/历史，去掉session leaseOwner/leaseUntil；book元数据从全局书架读取。文件名书名替换Windows非法字符为`_`并截前40字符，加`new Date().toISOString().slice(0,16).replace(/[:T]/g,'')`和`.wwv2`。保存到目录另加UUID前8字符，不覆盖成固定文件。

预检顺序：解ZIP→manifest存在/可解析→format和过新版本→校验manifest列出的文件→解析五类统计JSON。保持BUG-07的无完整基础Schema/缺失统计文件抛错分支，不新增友好兜底。

恢复前必须对记忆、notes、checkpoints、sessions、entries做对应Schema与重复id检查，notes会话+key唯一；最多一个active session；父会话必须存在且不指自己；leaf属于本session；nextOrdinal>0须有leaf；entry必须有session、同session序号唯一且小于nextOrdinal；父entry同session且序号更小；compaction边界属于该session。仅执行上述已有检查，不自行增强为任意图完整性审计。

导入所有归属改为newBookId，其余书内ID保持。新标题为原书名+“（导入）”；createdAt为新时间；lease清空；缺省旧会话字段sessionId归一空串。章节正文只从manifest checksums中列出的chapters文件匹配恢复。先创建全局书架，再单书事务写入；后者失败不自动回滚书架。不得增加覆盖原书模式。

## DATA-06 字段字典使用规则

以下各表完整展开对象与数组成员，必填以当前层及父对象存在为条件。`未定义`表示Schema无default；实际构造默认见DATA-02。类型联合分支分行列出。来源按对象段落确定，字段语义以中文含义及详细Spec共同约束；原始描述保留供理解，但其中历史推断功能不自动生效。

'''
priority=['BookSchema','ChapterSchema','ChapterTextSchema']+list(mapping.values())
seen=set();ordered=[]
for k in priority+list(schemas):
 if k not in seen:ordered.append(k);seen.add(k)
rowcount=0
for name in ordered:
 s=schemas[name]; rows=flatten(s)
 source=('章节导入/进度代码' if name.startswith(('Book','Chapter','Compile')) else '模型提交后代码执行/人工编辑/备份恢复')
 if name.startswith(('Story','Editor','Session','Native')):source='故事编辑会话与工作记忆流程；部分结构为工具返回视图'
 if name.startswith(('MergedEntity','OptimizedCharacterSchema')):source='兼容声明；实际生效入口与AI-02映射区分，不据此新增旧融合功能'
 body+=f'### {name}\n\n来源：{source}。对象约束：{esc(constraints(s))}。\n\n'
 if not rows:
  body+=f'取值结构：`{esc(kind(s))}`；约束：{esc(constraints(s))}。完整机器结构见`schemas.json`中的同名键。\n\n';continue
 body+='| 英文字段路径 | 中文含义 | 类型 / 枚举值 | 必填 | Schema默认 | 校验 | 来源 | 语义说明 |\n|---|---|---|---|---|---|---|---|\n'
 for row in rows:body+='| '+' | '.join(esc(x) for x in (*row[:6],origin(name,row[0]),row[6]))+' |\n'
 body+='\n';rowcount+=len(rows)
write('03-Spec-数据与存储.md',body)
print(f'Wrote full data dictionary: {len(schemas)} schemas, {rowcount} expanded field rows.')
