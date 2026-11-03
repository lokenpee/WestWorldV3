from pathlib import Path
import importlib.util,json,copy
OUT=Path(__file__).resolve().parent.parent
sp=importlib.util.spec_from_file_location('m',Path(__file__).with_name('complete-spec.py'));m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m)
S=m.S;tools=json.loads((OUT/'resources/tool-contracts.json').read_text(encoding='utf-8'))['story_editor']
def obj(props,required=None,extra=False):return {'type':'object','properties':props,'required':list(props)if required is None else required,'additionalProperties':extra}
string={'type':'string'};num={'type':'number'};integer={'type':'integer'};boolean={'type':'boolean'};strings={'type':'array','items':string};null={'type':'null'}
overflow=obj({'id':string,'fields_omitted':strings,'hint':string},['fields_omitted','hint'])
error=obj({'error':{'type':'string','enum':['ABORTED','INVALID_ARGS','TOO_LARGE','INTERNAL','NOT_FOUND']},'message':string,'truncated':boolean},['error','message'])
def page(row):return obj({'data':{'type':'array','items':{'anyOf':[row,overflow]}},'totalCount':integer,'truncated':boolean,'nextOffset':{'anyOf':[integer,null]}})
def relaxed(row):
 # 弱校验人工编辑可省略原必填字段；这描述已有读取行为，不对原应用新增校验。
 out=copy.deepcopy(row);out.pop('required',None);return out
normal={
'query_nodes':page(obj({'id':string,'name':string,'summary':string,'actors':strings,'chapterIndex':string},['id','chapterIndex'])),
'get_node_detail':page(relaxed(S['StoredNodeSchema'])),
'query_event_lines':page(obj({'id':string,'title':string,'chapters':strings,'lineStatus':S['LineStatusSchema'],'cause':string,'result':string,'nodeCount':integer},['id','chapters','lineStatus','nodeCount'])),
'get_event_line_detail':page(relaxed(S['EventLineSchema'])),
'query_characters':page(obj({'id':string,'name':string,'aliases':strings,'identity':string,'sourceChapters':strings},['id','aliases','sourceChapters'])),
'get_character_detail':page(relaxed(S['StoredCharacterSnapshotSchema'])),
'query_locations':page(relaxed(S['StoredLocationSnapshotSchema'])),
'read_original':obj({'text':string,'totalChars':integer,'truncated':boolean,'nextOffset':{'anyOf':[integer,null]}}),
'list_editor_sessions':page(obj({'id':string,'title':string,'kind':{'enum':['initial','review']},'status':{'enum':['active','archived']},'parentSessionId':string,'entryCount':integer,'createdAt':string,'updatedAt':string},['id','title','kind','status','entryCount','createdAt','updatedAt'])),
'query_editor_session_history':page({'anyOf':[S['StorySessionEntrySchema'],obj({'id':string,'ordinal':integer,'type':string,'createdAt':string,'preview':string}),obj({'id':string,'text':string,'totalChars':integer,'charOffset':integer,'truncated':boolean,'nextCharOffset':{'anyOf':[integer,null]}})]}),
}
for t in tools:
 if t['name'] not in normal:normal[t['name']]=t['returns']
excluded=['mergeFacts','optimizedFactIds','optimizationFingerprint']
for k in excluded:normal['get_character_detail']['properties']['data']['items']['anyOf'][0]['properties'].pop(k,None)

def ts_type(s):
 if 'const'in s:return json.dumps(s['const'],ensure_ascii=False)
 if 'enum'in s:return ' | '.join(json.dumps(x,ensure_ascii=False)for x in s['enum'])
 if 'anyOf'in s:return '('+' | '.join(ts_type(x)for x in s['anyOf'])+')'
 if 'allOf'in s:return '('+' & '.join(ts_type(x)for x in s['allOf'])+')'
 t=s.get('type')
 if t=='array':return 'Array<'+ts_type(s.get('items',{}))+'>'
 if t=='object':
  required=set(s.get('required',[]));p=s.get('properties',{})
  fields='; '.join(json.dumps(k,ensure_ascii=False)+(''if k in required else'?')+': '+ts_type(v)for k,v in p.items())
  if s.get('patternProperties'):return 'Record<string, '+ ' | '.join(ts_type(v)for v in s['patternProperties'].values())+'>'
  return '{ '+fields+(' ; [key:string]: unknown'if s.get('additionalProperties') is True else'')+' }'
 return {'string':'string','integer':'number','number':'number','boolean':'boolean','null':'null'}.get(t,'unknown')
def alias(name):return ''.join(x.capitalize()for x in name.split('_'))+'Result'

def make():
 examples=json.loads((OUT/'resources/tool-response-examples.json').read_text(encoding='utf-8'))
 contracts=[]
 body='''## 1. 输入、输出与执行边界

系统有13个只读工具，其中资产整理只允许前8个，故事编辑允许全部13个。每个参数结构来自实际声明；本文件补齐原声明没有returns的成功形状和各分支，机器契约见`tool-results.schema.json`。

**这些补充输出Schema是重建说明与验收契约，不表示原运行时对13个工具都执行返回校验。** 原实现仅对3个声明returns的记忆工具校验返回；不得擅自扩大。人工弱校验可使原必填文本省略，因此普通读取结构保留缺字段的兼容分支。

通用分页：data、totalCount、truncated、nextOffset。一般offset0/limit100，再受工具maxResults限制。单行过大可替为{id?,fields_omitted:['oversized_detail'],hint}；累计正文约64512字节停止，Agent最终65536字节限制。页面总数为匹配集合数，nextOffset基于已返回条数。

错误对象：ABORTED（预取消）、INVALID_ARGS（参数结构错）、TOO_LARGE（Agent包装层超限）、INTERNAL（原有声明返回结构不符）、NOT_FOUND（历史条目不属于选择会话）。这些分支不都由每个工具直接生成；原本不支持某分支的工具不得新增业务失败规则。

提供不存在/归档错误session等内部条件时，部分工具可抛Error而不是返回error对象，须按原边界处理。不得把所有throw统一改成成功空页。

## 2. 逐工具参数与返回

'''
 for t in tools:
  name=t['name'];ex=next(x for x in examples['records']if x['name']==name)
  contracts.append({'name':name,'input':t['parameters'],'success':normal[name],'error':error,'runtimeChecksReturn':name in ['get_editor_memory','query_editor_notes','get_editor_note_detail'],'maxResults':t['maxResults'],'maxBytes':65536})
  body+=f"### TOOL-{len(contracts):02} · {name}\n\n{t['description']}\n\n"
  body+=f"- 条数上限：{t['maxResults']}；字节上限65536；运行时返回Schema校验：{'有（按原returns）'if contracts[-1]['runtimeChecksReturn']else'无（不要新增）'}。\n"
  body+='- 输入JSON Schema：\n\n```json\n'+json.dumps(t['parameters'],ensure_ascii=False,indent=2)+'\n```\n'
  body+='- 确定性成功输入与原边界输出（前置完整记录见tool-response-examples.json的seed）：\n\n```json\n'+json.dumps({'args':ex['args'],'result':ex['success']},ensure_ascii=False,indent=2)+'\n```\n'
  body+='- 参数错误样例：\n\n```json\n'+json.dumps({'input':{**ex['args'],'unsupported_parameter':True},'output':ex['invalid']},ensure_ascii=False,indent=2)+'\n```\n'
  body+=f"\n成功返回结构在`tool-results.schema.json`同名项；空/分页/截断语义按AI-06，不能仅凭本例数据项数推断容量。\n"
 body+='''
## 3. 具名消息模板与回放

### 模板变量定义

| 模板 | 变量及来源 | 组装/缺省 |
|---|---|---|
| P1_CHAPTER | chapterIndex、chapterName、text：T04/T05 | AI-02指定逐行拼接，正文全量不截2000；timestamp=当前毫秒 |
| LINK_BATCH | stage：调用参数；chapterFirst/Last和nodeIds：按仓储顺序batch；existingLines：当前Map前50 | 摘要cause/result各前100，成员ID逗号连接；不存在已有线用固定空线文案 |
| REVIEW_LINES | activeLines：当前复核batch中尚存在的线 | 每批30，按原摘要格式，附要求查重复/更新/原文 |
| LINK_MEMORY | message：上一层LINK/REVIEW；prior：readEditorMemory当前会话结果 | message后两换行+固定记忆标题+JSON.stringify(prior) |
| ALIAS_DOSSIERS | kind：人物/地点；batch：180条精简档案/160步进 | 身份/描述前160；只接受当前主名枚举，不接受查询新增名 |
| CHARACTER_OPTIMIZE | stage、items：待整编人、previous四字段、facts短ID、conflicts | JSON.stringify({stage,entities:items})；动态人物键及事实枚举 |
| LOCATION_FUSION | group：当前同地快照数组 | JSON.stringify({snapshots:group}) |
| COMPACTION_INPUT | previousSummary：前一摘要或无；transcript：旧条目数据串 | 固定旧摘要/需要压缩数据标签，不把它执行为新任务 |
| AGENT_SYSTEM | session.scope、profile.instruction、opts.system、maxSteps、MAX_RESULT_REPAIRS | 前缀会话说明→职责→有效Prompt→查询/提交限额，具体字面仍见消息模板资源 |
| SUBMIT_REPAIR | assistant原响应、各toolCall错误、schema/引用错误详情 | 保留原响应及推理字段，配对toolResult后仅一次修正用户指令 |

每个变量的取值范围、排序、预算与写入规则由ALG/AI Spec定义；原始模板字符串只作精确字面补充。不得用未定义的源码局部变量直接当规范变量。

### 完整HTTP/工具交互回放

| 回放 | 固定输入/服务返回 | 必须结果 |
|---|---|---|
| agent-query-submit.json | query_nodes查询后提交answer=confirmed | 2次HTTP请求，第二次上下文包含实际toolResult，结果ok |
| agent-submit-repair.json | 第一次answer为number，第二次string | 恰一次修正，携带原提交与错误工具反馈，2次请求后成功 |
| agent-submit-failure.json | 连续两次answer为number | 两次后validation失败，不无限修正 |

三份回放保存实际原SDK请求body、按序模拟SSE脚本和结果；请求不含真实凭据。第三方可将这些脚本接到同语义HTTP适配器，规范化随机工具ID和时间后比较消息/工具顺序。

P1部分失败/恢复、检查提交失败和压缩成功/失败由独立场景P06/P07/P19/P20/P28/P29提供确定输入与最终状态；它们在服务级注入，不冒充完整HTTP录制。真实限流的时间抖动、浏览器关闭和跨标签竞争仍须按相应Spec与人工步骤验证，不能把本节3份回放说成覆盖全部异步分支。
'''
 body+='\n## 4. 实际任务补充回放\n\nP33/P34/P35使用真实P1或P2与有效Prompt，拦截HTTP；文件分别为resources/replays/p1-world-and-narrative.json、link-query-commit.json、link-invalid-repair.json。前两项分别生成提取资产/线记忆检查点，最后一项用MISSING引用触发一次修正；不以通用answer演示代替实际任务。完整断言在acceptance/cases.json。\n'
 m.write('11-AI工具返回与回放契约.md','WW-TOOLS','AI工具返回与交互回放',body)
 m.dump('resources/tool-results.schema.json',contracts)
 types='// 可独立编译的结构类型；不包含业务实现，源签名摘录另为阅读材料。\n'
 for n,v in S.items():types+='export type '+n.removesuffix('Schema')+' = '+ts_type(v)+';\n'
 for n,v in normal.items():types+='export type '+alias(n)+' = '+ts_type(v)+';\n'
 types+='export interface AcceptanceHarness { reset(): Promise<void>; load(seed: unknown): Promise<void>; execute(command: string, args: unknown): Promise<unknown>; snapshot(bookId: string): Promise<unknown>; close?(): Promise<void>; }\n'
 (OUT/'resources/contracts.d.ts').write_text(types,encoding='utf-8')
 cases=json.loads((OUT/'acceptance/cases.json').read_text(encoding='utf-8'))
 cases=[c for c in cases if not c['id'].startswith('T')]
 for i,ex in enumerate(examples['records'],1):
  cases.append({'id':f'T{i:02}','requirement':'TOOL-'+str(i).zfill(2),'seed':examples['seed'],'steps':[{'command':'tool','args':{'bookId':m.book,'name':ex['name'],'args':ex['args']},'checks':[{'path':['last'],'equals':ex['success']}]},{'command':'tool','args':{'bookId':m.book,'name':ex['name'],'args':{**ex['args'],'unsupported_parameter':True}},'checks':[{'path':['last','error'],'equals':'INVALID_ARGS'}]}]})
 (OUT/'acceptance/cases.json').write_text(json.dumps(cases,ensure_ascii=False,indent=2),encoding='utf-8')
 print('13 complete tool returns, 13 fixed-response cases and compilable types written.')
if __name__=='__main__':make()
