"""把目标工具的参数和执行语义放入11正文，校正与完整存储契约的漂移。"""
from pathlib import Path
import sys
if '--legacy-snapshot' not in sys.argv:
    raise SystemExit('该生成器已由2026-10-24目标契约取代；如确需生成旧快照，显式使用--legacy-snapshot，并勿覆盖当前规格。')
from copy import deepcopy as cp
import json
ROOT=Path(__file__).resolve().parents[1]
R=ROOT/'resources/v2.2'
def load(n): return json.loads((R/n).read_text(encoding='utf-8'))
def save(n,x): (R/n).write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
D=load('data-contract.json')['schemas']['$defs']
tools=load('tool-contracts.json')
results=load('tool-results.schema.json')
def inline(x):
    if isinstance(x,list): return [inline(y) for y in x]
    if not isinstance(x,dict): return x
    if '$ref' in x: return inline(D[x['$ref'].split('/')[-1]])
    return {k:inline(v) for k,v in x.items()}
detail={'get_node_detail':'StoredNode','get_event_line_detail':'StoredEventLine','get_character_detail':'StoredCharacter','get_location_detail':'StoredLocation'}
for t in results['tools']:
    name=t['name']
    if name in detail:
        row=inline(D[detail[name]])
        row['properties']['resolvedFrom']={'type':'array','items':{'type':'string'}}
        if name in ['get_node_detail','get_event_line_detail']:
            row['properties']['actorIds' if name=='get_node_detail' else 'characterIds']={'type':'array','items':{'type':'string'}}
        t['success']['properties']['data']['items']['anyOf'][0]=row
        t['success']['properties']['missingIds']={'type':'array','items':{'type':'string'}}
        if 'missingIds' not in t['success']['required']: t['success']['required'].append('missingIds')
    if name in ['query_editor_notes','get_editor_note_detail']:
        row=inline(D['StoryEditorNote']); row['properties']['validity']={'enum':['current','stale']}; row['required'].append('validity')
        t['success']['properties']['data']['items']=row
    if name.startswith('commit_'):
        errors=t['error']['properties']['error']['enum']
        if 'TOO_LARGE' not in errors: errors.append('TOO_LARGE')
    if name in ['get_character_detail','get_location_detail']:
        errors=t['error']['properties']['error']['enum']
        if 'WRITE_SCOPE_DENIED' not in errors: errors.append('WRITE_SCOPE_DENIED')
    t['runtimeChecksReturn']=True
byresult={t['name']:t for t in results['tools']}
for group in tools['profiles'].values():
    for t in group:
        if 'returns' in t: t['returns']=cp(byresult[t['name']]['success'])
tools['wrapper']['returnValidation']='All target tools validate success against declared success schema; structuredContent plus model-facing JSON; errors set isError.'
save('tool-contracts.json',tools); save('tool-results.schema.json',results)

defs={
'query_nodes':('两角色；P2/P3查询','chapter_range按章节数字段比较且两端包含；actor精确匹配actors或targets中的称呼；event_line_id取线成员，线不存在则空。多过滤条件AND。按chapterIndex、order排序；同值保留主键扫描顺序。','T08/T09；记录实际节点版本及查询结果集合。','Page<NodeSummary>；name/summary/actors/chapterIndex来自节点，summary最多240字符。','无匹配为标准空页，不报NOT_FOUND。'),
'get_node_detail':('两角色','按请求ID解析T19并读当前节点；多个旧ID指向同一当前ID时返回一行，resolvedFrom列出旧ID。按当前ID码点顺序输出。','T08/T19及人物索引；记录节点版本和人物派生依赖。','DetailPage<NodeRow + {actorIds?:string[],resolvedFrom?:string[]}>；NodeRow逐字段见03 T08。','删除/不存在归missingIds；无匹配仍为成功空页。'),
'query_event_lines':('两角色','status对lineStatus精确匹配；name_like对title区分大小写includes；character按当前主名/别名扩展后查成员actors/targets；范围与任一chapters相交。AND过滤，按主键ID顺序。','T09/T08/T10；读集包含用于人物称呼解析的实体。','Page<LineSummary>；cause/result各截160字符，不返回完整process。','无匹配空页；status不是持久字段名。'),
'get_event_line_detail':('两角色','解析同书线ID；按当前ID码点顺序，最多返回10行。输入虽允许20个，调用方须把未返回ID拆成≤10的新请求；本工具没有offset参数。','T09/T19/T08/T10；成员与人物派生引用。','DetailPage<LineRow + {characterIds?:string[],resolvedFrom?:string[]}>，LineRow见03 T09。','未返回不等于不存在；只有missingIds明确表示缺失。'),
'query_characters':('两角色','name_like对name/aliases/aliases_mentioned任一称呼做区分大小写子串匹配；按ID Unicode码点排序；after_id排除≤游标ID；不得同时给offset。','T10；查询集合和所读revision；扫描结束核全量ID清单补前插项。','CursorPage<CharacterSummary>；identityHint=identity前160字符，缺省空串；aliases去重，sourceChapters缺省[]；无长字段。','空页nextAfterId=null；当前分页合并删除时使用稳定游标，不递增offset。'),
'get_character_detail':('两角色；include_facts受阶段限制','include_facts默认false，排除mergeFacts/optimizedFactIds/optimizationFingerprint；true仅asset_editor的optimize权限允许。当前optimize为direct：由应用预读该详情后传给direct，模型本身不获自主工具循环。','T10/T19；读取完整事实时核字节限制。','DetailPage<CharacterRow + {resolvedFrom?:string[]}>；CharacterRow见03 T10；省略的缓存字段不是事实不存在。','越权include_facts返回WRITE_SCOPE_DENIED；不存在进missingIds；超大行只能提示，不能视为已完成事实覆盖。'),
'query_locations':('两角色','名称/别名过滤、稳定游标同人物；descriptionHint=description前160字符，缺省空串。','T11；结果集合和revision。','CursorPage<LocationSummary>；禁止返回完整description或mergeFacts。','空页同人物。'),
'get_location_detail':('两角色；新增工具','按ID解析当前地点；include_facts权限/省略字段同人物。','T11/T19。','DetailPage<LocationRow + {resolvedFrom?:string[]}>；LocationRow见03 T11。','旧代码没有此工具；目标不可用query_locations完整行替代精简/详情分离。'),
'read_original':('两角色','chapter_range两端包含；按chapters.order拼接每章“\\n【章节 {index}：{name}】\\n{正文}”；offset从拼接串起点计。maxChars默认8000，Schema≤200000，实际钳制≤20000；字节超64512时反复保留前80%。','T04/T05；记录实际原文指纹，禁止访问其他书/文件路径。','OriginalSlice={text:string,totalChars:integer,truncated:boolean,nextOffset:integer|null}；totalChars含章节头，offset单位UTF-16。','空范围/offset越界返回text=""、truncated=false、nextOffset=null；缺失正文沿用空串拼接章节头的兼容行为，不能把章节头或无原文当作有效引文证据。'),
'get_editor_memory':('仅story_editor','session_id省略用绑定当前会话；指定值必须属于本书；返回活跃事项前10条和最近检查点前5条。','T13/T14/T15；查询不创建记忆。','MemoryResult，精确结构见公共返回定义。','无持久摘要返回03 T13虚拟空记录；归档会话可只读；不存在指定会话返回NOT_FOUND。'),
'query_editor_notes':('仅story_editor','kind/key精确匹配；status=stale表示validity派生过期，其余比较持久status；node_id/line_id做成员包含；条件AND。updatedAt降序。','T14及其依据节点/线/原文/实际世界依赖；不全世界一改全失效。','Page<NoteView>；NoteView为03 T14完整字段加validity:current|stale。','空页成功；status=stale不能写进事项持久status。'),
'get_editor_note_detail':('仅story_editor','ids限制在当前或指定同书会话，updatedAt降序；最多20。','T14及依据；无写入。','Page<NoteView>，与上一工具一致。','缺失ID从data省略；本工具无missingIds，需要调用方比较输入ID和返回ID。'),
'list_editor_sessions':('仅story_editor','仅当前书会话，createdAt降序；entryCount取nextOrdinal。','T16。','Page<SessionSummary>。','无会话空页；不得跨书选择。'),
'query_editor_session_history':('仅story_editor','session_id省略用当前会话；mode默认summary；列表按ordinal升序，summary最多50条、full最多20条。entry_id优先进入单条分段，忽略mode/offset/limit；char_offset默认0，maxChars默认8000、≤20000；JSON序列化条目后切片，字节收缩同read_original。','T16/T17；原始链，包含被omit标记的原始条目。','Page<HistorySummary|SessionEntry|HistorySlice>，entry分段data仅1行；SessionEntry完整分支见03 T17。','无当前会话空页；指定不存在会话或条目NOT_FOUND；下一段用nextCharOffset，不使用外层nextOffset。'),
'commit_asset_changes':('仅asset_editor / P2 ai_identity','operationKey非空；groups可空，每组同类型、≥2唯一成员、keepId必须在成员内；成员必须在当前任务读集中，组不得重叠。遵守人工主名/保护目标，不能凭模型选择覆盖多个manualKeep。','同事务写T10或T11、T19、T20命令凭据/报告；校验失败全命令零写入。','CommitAck；提交成功后数据立即有效；同键同payload原确认alreadyApplied=true。','空groups允许零变更确认；冲突先重读，用新的operationKey提交新payload；不是网络重试。'),
'commit_story_changes':('仅story_editor / P3 window_link或global_review','payload必须含event_line_ops/new_nodes/memory_update；每个线操作confidence≥0.85且有reason/evidenceNodeIds；补点必须有当前书原文逐字引文。执行顺序：验证全部计划→分配补点ID→替换临时引用→计算线和反向成员→校验记忆→短事务提交。','同事务写T08/T09/T13–T15/T19/T20，持久代码确认写T17；失败全命令回滚，先前成功命令保留。','CommitAck；new_nodes[].client_id只在本payload内，用正式ID替换后才可持久化。','允许两个操作数组为空而只写memory_update；不能通过此工具改世界人物/地点、原文、配置或删书。'),
}
mean={'chapter_range':'恰好2个章标识，两端包含；不等于P3零基半开窗口','actor':'原文称呼精确匹配','event_line_id':'限定所属线ID','offset':'行分页起点默认0；read_original中是字符起点','limit':'默认100，实际min(limit,该工具maxResults)','ids':'同书ID数组，1–20个；不允许书ID或文件路径','character':'人物主名/别名精确扩展后过滤','name_like':'区分大小写子串；省略或空串不筛选','status':'按工具区分：线open/closed，事项active/resolved/stale','after_id':'稳定ID游标，排除该ID及之前ID；与offset互斥','include_facts':'默认false；true仅应用绑定asset_editor/optimize权限','maxChars':'原文默认8000且实际≤20000；历史默认8000且Schema≤20000','session_id':'仅同书会话；省略用当前绑定会话','kind':'工具对应资产/事项类型','key':'事项主题精确匹配','node_id':'事项引用包含该节点','line_id':'已有事件线ID','mode':'默认summary，full返回原始条目','entry_id':'指定单条历史记录进入分段模式','char_offset':'单条JSON文本切片起点默认0','operationKey':'当前run的幂等命令键；重试同payload复用','payload':'全部业务操作；一次命令原子提交','groups':'可为空；各组互不重叠','keepId':'必须属于memberIds，且满足人工保护优先','memberIds':'至少2个已查到的同类当前ID','canonicalName':'保留主名；非空，受人工名优先规则约束','reason':'合并/线操作的可解释依据，非空','event_line_ops':'追加/创建/更新/合并线操作数组，可空','new_nodes':'有原文依据的补点数组，可空','memory_update':'必须给工作摘要和notes；不可省略','op':'操作联合判别字段','node_ids':'本操作节点ID；可引用同payload client_id；最终非空有效','cause':'起因','process':'经过','result':'结果','line_status':'DTO线状态，写库改名lineStatus','confidence':'线操作门槛0.85–1，不能用低分强写','evidenceNodeIds':'至少1个有效依据节点ID','title':'新线标题','keep_line_id':'合并后保留线ID','merge_line_ids':'被并入线ID，至少1条','client_id':'本payload内唯一临时节点ID，代码换正式ID','workingSummary':'1–2000字符工作摘要','notes':'最多20条事项修改，可空','statement':'1–1000字符判断或复核说明','nodeIds':'最多20个节点ID，每个≤128字符','lineIds':'最多20个线ID，每个≤128字符','evidence':'最多5条逐字引文；与节点/线引用至少一种非空','chapterIndex':'引文所在真实章标识','quote':'本章连续逐字原句，不得拼接改写'}
def typ(x):
    if 'const' in x: return str(x['const'])
    if 'enum' in x: return '/'.join(map(str,x['enum']))
    if 'anyOf' in x: return ' 或 '.join(typ(a) for a in x['anyOf'])
    return typ(x.get('items',{}))+'[]' if x.get('type')=='array' else x.get('type','JSON')
def rows(x,p=''):
    if 'anyOf' in x and any('properties' in v for v in x['anyOf']):
        for idx,v in enumerate(x['anyOf']): yield from rows(v,p+'<'+str(idx+1)+'>.')
    for k,v in x.get('properties',{}).items():
        rule='；'.join(f'{z}={v[z]}' for z in ['minimum','maximum','minItems','maxItems','minLength','maxLength','uniqueItems','default'] if z in v)
        yield [p+k,typ(v),'必填' if k in x.get('required',[]) else '可省略',rule or '—',mean.get(k,v.get('description','见所属业务对象的03字段定义'))]
        if v.get('properties'): yield from rows(v,p+k+'.')
        if v.get('type')=='array' and isinstance(v.get('items'),dict): yield from rows(v['items'],p+k+'[].')

text='''
## 6. 可直接实现的工具定义

本节所有16种业务工具均为应用注册的工具，Pi负责调度，不自带这些小说工具。当前代码仅实现13种只读工具（asset_editor 8个、story_editor 13个）；新增地点详情和两种写工具属于2.2目标。最终收集器另计：asset_editor实际注册11个名称，story_editor注册16个名称；两角色并集17个名称，业务工具并集16个。

### 6.1 Pi适配及统一返回

每个工具必须包含name、description、parameters和异步execute；应用适配成Pi AgentTool时提供label。成功返回同时设`content=[{type:'text',text:JSON.stringify(result)}]`、`details=result`及`structuredContent=result`；outputSchema对应本工具成功返回结构。失败必须设置`isError=true`，仅在文本中写“失败”不会让Pi识别错误。structuredContent不送入模型，不能省略content里的JSON。执行前后分别验证参数和成功结果；意外异常转INTERNAL，不把堆栈/凭据送入模型。

bookId、runId、profile、phase、sessionId、租约owner和读集由应用闭包绑定，不是模型可传参数。所有工具默认additionalProperties=false，模型伪造bookId或数据库路径必须INVALID_ARGS。异步DB读取没有自身网络重试；服从当前任务180秒/6步预算和AbortSignal。只读工具无业务表写入，持久消息由运行器保存；写工具只有事务成功才返回成功确认。

```text
Page<T> = {data:T[], totalCount:integer>=0, truncated:boolean, nextOffset:integer>=0|null}
CursorPage<T> = Page<T> + {nextAfterId:string|null}
DetailPage<T> = Page<T> + {missingIds:string[]}
Oversized = {id?:string, fields_omitted:["oversized_detail"], hint:string}
Error = {error:错误代码, message:string, truncated?:boolean}
CommitAck = {ok:true,commitId:string,operationKey:string,alreadyApplied:boolean,summary:string}
```

列表允许Oversized替代超长行；事项工具的完整NoteView总长度受自身Schema限制，返回结构不得擅自用占位行冒充NoteView。分页先按条件求totalCount，再取offset/limit；truncated表示仍有行，不是错误；末页nextOffset=null。DetailPage缺失ID不算数据行，missingIds仅含不存在/已删，不含被条数/字节限额截掉的ID。单行超过64512字节返回Oversized，累计达到64512停止加入；最终JSON超过65536字节返回TOO_LARGE。数组空页为`{data:[],totalCount:0,truncated:false,nextOffset:null}`，CursorPage再加nextAfterId:null，DetailPage再加missingIds。只读详情没有分页参数时，调用方以尚未返回的ID继续请求。

### 6.2 成功投影字段全集

本表的string[]默认要求每元素string；`?`仅可省略，只有写明null才可为null。表记录字段定义直接引用03中对应逐表字典，不以源码类型名代替。

| 返回行/对象 | 精确字段与来源 |
|---|---|
| NodeSummary | id:string、name:string、summary:string、actors:string[]、chapterIndex:string；旧弱校验行可能缺name/summary/actors，目标新行不得缺。 |
| LineSummary | id:string、title:string、chapters:string[]、lineStatus:open/closed、cause:string、result:string、nodeCount:integer=nodeIds.length；旧弱校验行title/cause/result可缺。 |
| CharacterSummary | id/name:string，aliases:string[]，identityHint:string≤160，sourceChapters:string[]，revision:integer≥1，estimatedDetailTokens:integer≥0，duplicateScore:number∈[0,1]；全部必填。 |
| LocationSummary | 同人物精简行，将identityHint换为descriptionHint；全部必填。 |
| NoteView | 03 T14全部字段，加validity:current/stale；stale为当前依据不匹配，不改status。 |
| SessionSummary | id/title:string、kind:initial/review、status:active/archived、parentSessionId?:string、entryCount:integer、createdAt/updatedAt:string。 |
| HistorySummary | id:string、ordinal:integer、type:message/compaction/omit/commit、createdAt:string、preview:string（JSON.stringify(entry)前800字符）。 |
| HistorySlice | id:string、text:string、totalChars:integer、charOffset:integer、truncated:boolean、nextCharOffset:integer/null；text为单条JSON分段，单段本身不保证可JSON解析。 |
| MemoryResult | memory=03 T13；dataChanged:boolean；pendingCount:integer（active且review）；staleCount:integer（依据过期）；notes:NoteSummary[]最多10；recentCheckpoints:CheckpointSummary[]最多5。 |
| NoteSummary | id/key:string、kind:decision/review、status:active/resolved、statement:string、nodeIds/lineIds:string[]、validity:current/stale、truncated:boolean；statement前240字符，nodeIds/lineIds各前5项；任一被截短则truncated=true。 |
| CheckpointSummary | id:string、stage:string、phase:string、status:string、scopeCount:integer=scopeIds.length、updatedAt:string；旧历史stage/phase原样展示，不能算新覆盖。 |

指标明确化：estimatedDetailTokens对人物identity/appearance/personality/background/speechStyleSample或地点description按字段顺序以换行连接，计算`ceil(UTF16长度/2)`；不计原始底稿与工具JSON包装。duplicateScore取同字段去空白、长度≥20且非完全相同片段两两字符3-gram集合Jaccard的最大值，无有效配对为0。指标用于选择详情/整编，不能证明同人/同地点。此处为目标补充算法，不宣称旧工具已输出该指标。
'''
unique={t['name']:t for group in tools['profiles'].values() for t in group}
order=['query_nodes','get_node_detail','query_event_lines','get_event_line_detail','query_characters','get_character_detail','query_locations','read_original','get_editor_memory','query_editor_notes','get_editor_note_detail','list_editor_sessions','query_editor_session_history','get_location_detail','commit_asset_changes','commit_story_changes']
for idx,name in enumerate(order,1):
    info=defs[name]
    t=unique[name]; scope,logic,db,output,edge=info
    text+=f'\n### TOOL-{idx:02d} · {name}\n\n角色/阶段：{scope}。单次最多{t["maxResults"]}条/结果，最终JSON最多65536字节。\n\n'
    text+='| 参数路径 | 类型/枚举 | 存在性 | 结构约束 | 含义/缺省 |\n|---|---|---|---|---|\n'
    rr=list(rows(t['parameters']))
    if not rr: text+='| 无 | object | 必须传{} | 不接收额外字段 | 作用域由应用绑定 |\n'
    for row in rr: text+='| '+' | '.join(str(x).replace('|',' / ').replace('\n',' ') for x in row)+' |\n'
    text+=f'\n处理：{logic}\n\n读写与副作用：{db}\n\n成功返回：{output}\n\n空/缺失/截断：{edge}\n'
text+='''
### 6.3 错误及调用方恢复

| 代码 | 适用/触发 | 返回后处理 |
|---|---|---|
| ABORTED | 开始前或执行中取消 | 停止本次请求；写事务已提交则不得报“未写入”，恢复时用原operationKey查确认。 |
| INVALID_ARGS | 结构错误、额外字段、after_id与offset并用、非法引用/引文/覆盖 | 无新业务写入；最多一次定向结果修正。 |
| NOT_FOUND | 指定同书会话或单条历史不存在 | 重查同书列表；普通资产详情使用missingIds，无需整请求失败。 |
| TOO_LARGE | 最终返回或写命令输入JSON超过65536字节 | 缩小ID/组/节点批；不能截掉半份写payload后执行。 |
| WRITE_SCOPE_DENIED | 错角色/阶段调用写工具；越权include_facts | 不执行；不能靠换工具参数提高权限。 |
| CONFLICT | 实际读集revision/查询结果集合、租约或手工保护目标变化 | 重新读取和判断；新payload用新operationKey；已成功同键重放优先返回原确认。 |
| IDEMPOTENCY_CONFLICT | 同run同operationKey换payload | 拒绝；查原确认或明确新操作键，不能覆盖账本。 |
| INTERNAL | 未预期异常或返回不符合声明Schema | 标工具失败，记录无密钥诊断；不把字段缺失视为模型正常回答。 |

原wrapper中的STALE_REFERENCE统一以CONFLICT暴露，不能出现有名字但没有返回分支的独立错误。机器error Schema与本表同步；工具不存在时Pi返回未知工具错误，不应转发到任何默认执行器。

### 6.4 submit_result：最终收集器

Agent参数四项均必填：status=`completed|partial`、commitIds=唯一非空string数组、summary=非空string、remainingWorkIds=非空string元素数组；数组本身可空。先校验提交ID属于当前run/子任务且已持久化，再检查completed无待覆盖项；通过返回`{accepted:true,status,commitIds}`并设置terminate=true。失败返回INVALID_ARGS且isError=true；不重演任何业务payload。该返回为2026-10-23补充目标契约。

direct只注册当前结构化输出Schema的同名收集器；没有AgentTool.execute循环，调用方解析响应、校验后调用业务服务。不得拿AgentTaskSummarySchema替代P1提取Schema，也不能以direct“没有执行写工具”为由漏掉调用方提交。

模型一次响应若同时调用submit_result和其他工具，必须在第一项业务副作用前拒绝整批。实现时在已await持久化assistant的message_end监听中检查该消息全部toolCall，记录该批阻断；beforeToolCall对该批每项返回block。仅在遇到submit_result时才拒绝会让前面的commit已经写入，不能满足本契约。

### 6.5 具体回放（规范样例，未执行目标应用）

1. 本书B已有C1-P001(name=沈青,revision=2)、C2-P001(name=沈青,revision=1)，当前run=R、asset_editor/ai_identity、world租约有效。query_characters({limit:100})返回两行，运行器记录这两个版本。
2. 模型调用commit_asset_changes({operationKey:"merge-1",payload:{groups:[{kind:"character",keepId:"C1-P001",memberIds:["C1-P001","C2-P001"],canonicalName:"沈青",reason:"原文确认同一人物"}]}})。代码核原文/读集/保护规则后同事务：保留目标revision=3、删除C2-P001、其T19变merged→C1-P001、报告追加组、T20追加确认K。
3. 返回{ok:true,commitId:"K",operationKey:"merge-1",alreadyApplied:false,summary:"合并2条人物为1条"}。若此反馈丢失，恢复R并用完全相同参数重试，返回K且alreadyApplied=true，目标仍revision=3，不增加第二组报告。
4. 单独一批submit_result({status:"completed",commitIds:["K"],summary:"本子任务已合并",remainingWorkIds:[]})只总结。其他页尚未核查时本子任务完成也不能将整个P2阶段置completed。
5. 若第1步后人工把目标改为revision=3，首次写命令返回CONFLICT，C2-P001保持存在，账本无merge-1；模型重查后以新键提交新判断。若同一已成功merge-1换canonicalName，则IDEMPOTENCY_CONFLICT。

无修改的故事回放：commit_story_changes({operationKey:"memory-1",payload:{event_line_ops:[],new_nodes:[],memory_update:{workingSummary:"本窗暂无可靠串联依据，保留孤点。",notes:[]}}})可只更新摘要/覆盖及确认；节点/线数量不变。最终模型断线不能回滚该摘要或伪造“整批未执行”。
'''
path=next(ROOT.glob('11-*.md'))
original=path.read_text(encoding='utf-8').split('\n## 6. 可直接实现的工具定义')[0]
path.write_text(original.rstrip()+'\n'+text,encoding='utf-8')
tools['wrapper']['newErrors']=[x for x in tools['wrapper']['newErrors'] if x!='STALE_REFERENCE']
tools['finalizer']['success']={'type':'object','additionalProperties':False,'required':['accepted','status','commitIds'],'properties':{'accepted':{'const':True},'status':{'enum':['completed','partial']},'commitIds':{'type':'array','uniqueItems':True,'items':{'type':'string','minLength':1}}}}
save('tool-contracts.json',tools)
print('tools expanded',len(unique))
