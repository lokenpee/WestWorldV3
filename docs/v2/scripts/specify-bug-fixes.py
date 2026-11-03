"""Fix-first target specification maintenance; never modifies application code."""
from pathlib import Path
from copy import deepcopy as cp
import json,re,hashlib
ROOT=Path(__file__).resolve().parents[1];R=ROOT/'resources/v2.2'
def read(p):return json.loads(p.read_text(encoding='utf-8'))
def save(p,x):p.write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def obj(p,required=None):return {'type':'object','properties':p,'required':list(p) if required is None else required,'additionalProperties':False}
S={'type':'string','minLength':1};policy='2026-10-24.fix-first'
bugs=[
('BUG-01','首标题前正文丢失','导言\n第一章 开端\n正文','非空前缀存为序文chapterIndex=0；全部章块拼接等于去BOM并统一LF后的输入，禁止trim正文'),
('BUG-02','文件入口校验与异步预览不一致','拖入exe；先选慢文件A再选快文件B','选择/拖放统一单个.txt及非空内容验证；busy禁用；仅最新loadToken生效；失败清预览并禁用导入'),
('BUG-03','旧固定实体统计误导','P1有资产但P2/P3未运行','统计当前四类实体，不以发布副本或整理状态控制资产可用性'),
('BUG-04','同名引用取首项','两个沈青、节点actors=[沈青]','仅唯一候选解析ID；多个候选显示ambiguities及候选ID，不静默取首项'),
('BUG-05','无Key文案与鉴权能力矛盾','no-auth适配器无Key','按requiresCredential统一禁用和提示；无鉴权端点正常Pi探测，不伪造Key'),
('BUG-06','人工弱校验/不存在行静默成功','空name、无效成员或旧revision','必要字段/引用/expectedRevision统一校验；不存在返回NOT_FOUND；失败无写且保留表单'),
('BUG-07','损坏备份及跨库残留','坏JSON；书库写完后书架提交失败','统一预检返回结构化错误；完整恢复后才发布书架；T02生命周期日志支持重试或清理，不假称跨库原子'),
('BUG-08','锁与人工并发保护不足','两标签同阶段启动；提交前人工改资料','资源租约原子核owner；按实际读集revision拒绝冲突，保留人工结果'),
('BUG-09','P1引文弱校验和按名丢资料','不存在的quote；同章同名不同资料','P1叙事非空逐字引文/offset校验；一次修正仍错不写该子步骤凭证。人物地点仅完整DTO相同才去重'),
('BUG-10','名称信号直接误合并','张三/张三丰；同名异人','同名/包含/相似度仅生成候选；AI融合须confidence>=0.9和覆盖全成员的有效原文证据；不足保持分开'),
('BUG-11','样本完成冒充全书完成','仅前3章成功后启动P2/P3','正式全书两类成功凭证齐全才解锁；测试副本不写正式覆盖'),
('BUG-12','占位游玩造成能力误解','进入游玩并刷新','明确演示/未接故事引擎及不保存状态；不伪造正式存档/AI成功，不扩展游戏引擎'),
('BUG-13','日志费用与完成报告串书','书A运行中查看书B','按bookId/stage/runId隔离；B不弹A报告；取消仅作用目标运行'),
('BUG-14','未知模型价格/能力错误','模型不在目录','不套首项元数据；能力不足拒绝；费用标known/estimated/unknown，未知不显示0元或推测币种'),
('BUG-15','窄屏操作不可达','375px视口打开长表单','小于768px上下排列及区域内滚动，保存/取消/阶段入口均可达，图保留平移'),
('BUG-16','详情旧值回显/覆盖脏输入','即时改层级或外部revision更新','成功使用返回记录；无dirty随revision重读，有dirty保留输入提示冲突；失败回滚控件'),
('BUG-17','退避等待不响应取消','30秒退避时取消','下一事件循环结束等待且不再发请求，清理timer/listener，保留已提交确认'),
('BUG-18','非法数值配置落库','NaN/Infinity/空串配置','UI与服务校验有限数及整数范围，非法不写；旧非法值读回安全默认并提示'),
('BUG-19','缺正文静默当空串','chapters有行而chapterTexts无行','read_original返回SOURCE_MISSING及缺失章标识；P1/引文提交失败，不写成功凭证'),
('BUG-20','下载URL回收过早','设置页下载立即revoke','两下载入口均点击后至少1000ms回收，只提示已触发下载；目录close成功才算已保存'),
]
save(R/'bugfix-contract.json',{'version':'2.2','policyRevision':policy,'strategy':'fix-known-defects-before-rebuild','applicationImplemented':False,'bugs':[dict(id=n,problem=p,trigger=t,required=v,status='specified-not-application-verified') for n,p,t,v in bugs]})
m=read(R/'model-output-contract.json');g=m['schemas']['IdentityGroupsSchema']['properties']['groups']['items']
g['properties']['confidence']={'type':'number','minimum':0.9,'maximum':1}
g['properties']['evidence']={'type':'array','minItems':1,'maxItems':10,'items':obj({'chapterIndex':S,'quote':{'type':'string','minLength':1,'maxLength':1000},'memberIds':{'type':'array','minItems':1,'uniqueItems':True,'items':S}})}
for k in ['confidence','evidence']:
    if k not in g['required']:g['required'].append(k)
save(R/'model-output-contract.json',m)
t=read(R/'tool-contracts.json');out=read(R/'tool-results.schema.json')
for group in t['profiles'].values():
    for tool in group:
        if tool['name']=='commit_asset_changes':tool['parameters']['properties']['payload']=cp(m['schemas']['IdentityGroupsSchema'])
for tool in out['tools']:
    if tool['name']=='commit_asset_changes':tool['input']['properties']['payload']=cp(m['schemas']['IdentityGroupsSchema'])
    if tool['name']=='read_original' and 'SOURCE_MISSING' not in tool['error']['properties']['error']['enum']:tool['error']['properties']['error']['enum'].append('SOURCE_MISSING')
    if tool['name'] in ['get_node_detail','get_event_line_detail']:
        row=tool['success']['properties']['data']['items']['anyOf'][0]
        row['properties']['characterReferences']={'type':'array','items':obj({'name':S,'status':{'enum':['resolved','not_found','ambiguous']},'characterId':S,'candidateIds':{'type':'array','uniqueItems':True,'items':S}},['name','status','candidateIds'])}
        if 'characterReferences' not in row['required']:row['required'].append('characterReferences')
save(R/'tool-contracts.json',t);save(R/'tool-results.schema.json',out)
data=read(R/'data-contract.json');D=data['schemas']['$defs']
D['BookLifecycleJournal']=obj({'operationId':S,'action':{'enum':['import','delete']},'bookId':S,'state':{'enum':['preparing','ready','deleting','cleanup_pending']},'createdAt':S,'updatedAt':S,'book':cp(D['Book']),'error':{'type':'string'}},['operationId','action','bookId','state','createdAt','updatedAt'])
pattern='^book\\.lifecycle:.+$';branches=D['AppSettingRow']['oneOf'];branches[:]=[b for b in branches if b.get('properties',{}).get('key',{}).get('pattern')!=pattern]
branches.append(obj({'key':{'type':'string','pattern':pattern},'value':{'$ref':'#/$defs/BookLifecycleJournal'},'updatedAt':S}))
for name in ['Usage','ModelSnapshot']:D[name]['properties']['costStatus' if name=='Usage' else 'pricingStatus']={'enum':['known','estimated','unknown']}
D['ModelSnapshot']['properties']['pricingCurrency']={'type':'string','description':'known/estimated必须声明；unknown省略，不能推测本币'}
for b in D['CommandIntent']['oneOf']:
    if b['properties']['toolName']['const']=='commit_asset_changes':b['properties']['payload']=cp(m['schemas']['IdentityGroupsSchema'])
data['bugfixPolicyRevision']=policy;save(R/'data-contract.json',data);save(R/'storage.schema.json',{'$schema':'https://json-schema.org/draft/2020-12/schema','$defs':D})
exe=read(R/'execution.schema.json');exe['$defs']['CommandIntent']=cp(D['CommandIntent']);save(R/'execution.schema.json',exe)
p=read(R/'pipeline-contract.json');p['bugfixPolicyRevision']=policy;p['mechanicalPolicy'].update(characterNameContainment='candidate-only-no-automatic-merge',sameNormalizedName='candidate-only-no-automatic-merge',aliasSimilarityAction='candidate-only',automaticIdentityMerge='same-origin-idempotent-replay-only',aiIdentityMinimumConfidence=0.9,aiIdentityEvidenceRequired=True);p['importPolicy']={'preservePreamble':True,'preserveNormalizedText':True,'unifiedFileValidation':True,'crossDatabaseRecovery':'appSettings book.lifecycle journal'};save(R/'pipeline-contract.json',p)
runtime=read(R/'ai-runtime-contract.json');runtime['bugfixPolicyRevision']=policy;runtime['sharedErrors']['backoffCancellation']='AbortSignal ends delay before next request';save(R/'ai-runtime-contract.json',runtime)

active=R/'prompts/active'
f=active/'p2-identity.md';x=f.read_text(encoding='utf-8').replace('代码先做机械融合。','代码只生成候选，未因名称信号删除不同来源实体。');addition='\n【缺陷修复要求】同名、包含或相似度不证明同一实体。每组必须提供confidence>=0.9及evidence数组；每项有chapterIndex、quote、memberIds。先用read_original核实逐字引文，证据成员并集覆盖全组；无有效证据保持分开。禁止仅因张三包含于张三丰而合并。\n';f.write_text(x if '【缺陷修复要求】' in x else x+addition,encoding='utf-8')
for name,addition in [('p1-world.md','同章同名不同资料条目不得静默丢弃，空名称不合法；完整对象完全相同才由代码去重。'),('p1-narrative.md','quote必须非空且逐字存在于本章；offset若提供须指向引文。应用实际校验，失败必须修正。')]:
    f=active/name;x=f.read_text(encoding='utf-8');mark='\n【提交校验补充】'+addition+'\n';f.write_text(x if mark in x else x+mark,encoding='utf-8')
quote='第二章的沈青就是第一章的沈青。'
(active/'probe_asset.txt').write_text('探针taskId={taskId}。第1轮get_character_detail({"ids":["C1-P001","C2-P001"]})以及read_original({"chapter_range":["2","2"]})，原文为“第二章的沈青就是第一章的沈青。”。第2轮commit_asset_changes，operationKey={operationKey}，payload.groups=[{kind:"character",keepId:"C1-P001",memberIds:["C1-P001","C2-P001"],canonicalName:"沈青",reason:"原文明示同一人",confidence:1,evidence:[{chapterIndex:"2",quote:"第二章的沈青就是第一章的沈青。",memberIds:["C1-P001","C2-P001"]}]}]。第3轮仅submit_result，status=completed、实际commitIds、summary、remainingWorkIds=[]、reviewedItems=[]。\n',encoding='utf-8')
def augment(v):
    if isinstance(v,list):
        for a in v:augment(a)
    elif isinstance(v,dict):
        if {'kind','keepId','memberIds','canonicalName','reason'}<=v.keys():v.update(confidence=1,evidence=[dict(chapterIndex='2',quote=quote if v['canonicalName']=='沈青' else f"第二章的{v['canonicalName']}就是第一章的{v['canonicalName']}。",memberIds=v['memberIds'])])
        for a in list(v.values()):augment(a)
for f in [R/'examples.json',R/'execution-examples.json',R/'acceptance/recovery-cases.json']:
    x=read(f);augment(x)
    if f.name=='recovery-cases.json':
        for c in x['cases']:c['seed']['tables']['chapters']=[dict(bookId='book-a',chapterIndex='2',chapterName='第2章',charCount=len(quote),order=1)];c['seed']['tables']['chapterTexts']=[dict(bookId='book-a',chapterIndex='2',text=quote)]
    if f.name=='execution-examples.json':x['preparedIntent']['payloadFingerprint']=hashlib.sha256(json.dumps(x['preparedIntent']['payload'],ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    save(f,x)
manifest=read(R/'prompt-call-manifest.json')
for c in manifest['calls']:
    if c.get('prompt'):c['promptSha256']=hashlib.sha256((ROOT/'resources'/c['prompt']).read_bytes()).hexdigest()
manifest['bugfixPolicyRevision']=policy;save(R/'prompt-call-manifest.json',manifest)
