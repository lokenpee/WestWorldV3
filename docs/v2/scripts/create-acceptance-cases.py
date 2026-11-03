from pathlib import Path
import json,importlib.util,copy
OUT=Path(__file__).resolve().parent.parent
sp=importlib.util.spec_from_file_location('m',Path(__file__).with_name('complete-spec.py'));m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m)
B=m.book;cases=[]
def ck(path,**k):return dict(path=path.split('.'),**k)
def step(command,args={},checks=[],saveAs=None,allowError=False):
 r=dict(command=command,args=args,checks=checks)
 if saveAs:r['saveAs']=saveAs
 if allowError:r['allowError']=True
 return r
def snap(checks):return dict(snapshot=B,checks=checks)
def case(id,req,steps,seed=None):
 c=dict(id=id,requirement=req,steps=steps)
 if seed:c['seed']=seed
 cases.append(c)
def seed(tables):return dict(bookId=B,books=[m.sample['books']],canon=tables)
def ok(data):return dict(ok=True,data=data,stopReason='toolUse',attempts=1,attemptsUsage=[])
def fail():return dict(ok=False,stopReason='error',errorKind='auth',errorMessage='fixture auth error',attempts=1,attemptsUsage=[])
node1=dict(m.sample['nodes']);node2=dict(m.seed['nodes'][1]);line=dict(m.seed['eventLines'][0]);line['nodeIds']=[node1['id'],node2['id']];line['chapters']=['1']
data=seed({'chapters':m.seed['chapters'],'chapterTexts':[m.sample['chapterTexts']], 'characterSnapshots':m.seed['characterSnapshots'],'locationSnapshots':m.seed['locationSnapshots'],'nodes':[node1,node2],'eventLines':[line]})
case('P01','AC-04',[step('split',{'text':'x'*4001},[ck('last',length=2),ck('last.0.charCount',equals=4000),ck('last.1.charCount',equals=1),ck('last.1.chapterIndex',equals='2')])])
long='第一章 长章\n'+'甲'*10001
case('P02','AC-04',[step('split',{'text':long},[ck('last',length=2),ck('last.0.chapterIndex',equals='1.1'),ck('last.0.charCount',equals=10000),ck('last.1.charCount',equals=len(long)-10000),ck('last.1.order',equals=1)])])
case('P03','AC-05',[step('split',{'text':'序言内容\n第一章 开始\n甲。'},[ck('last',length=1),ck('last.0.text',equals='第一章 开始\n甲。')])])
case('P04','AC-03',[step('parseRegex',{'value':'('},[ck('error.message',match='分章正则无效')],allowError=True),step('split',{'text':'abc','regex':'(?=a)'},[ck('error.message',match='匹配了空内容')],allowError=True)])
case('P05','AC-02',[step('import',{'id':B,'title':'测试书','text':'第一章 会面\n甲见乙。'}),snap([ck('snapshot.books',length=1),ck('snapshot.canon.chapters',length=1),ck('snapshot.canon.chapterTexts.0.text',equals='第一章 会面\n甲见乙。'),ck('snapshot.canon.compileProgress.0.status',equals='idle'),ck('snapshot.canon.characterSnapshots',length=0)])])
world=ok({'characters':[{'name':'沈青','identity':'人工模型回复','confidence':1}],'locations':[]})
narrative=ok({'nodes':[{'name':'会面','summary':'会面','actors':['沈青'],'quote':'沈青在码头见到顾衡。','confidence':1}]})
single=seed({'chapters':[m.seed['chapters'][0]],'chapterTexts':[m.sample['chapterTexts']]})
case('P06','AC-08',[step('runP1',{'bookId':B,'responses':[world,fail()]},[ck('last.status',equals='failed'),ck('last.requests',length=2)]),snap([ck('snapshot.canon.characterSnapshots',length=1),ck('snapshot.canon.nodes',length=0),ck('snapshot.canon.compileProgress.0.partialChapters.1',equals=['narrativeAssets'])]),step('runP1',{'bookId':B,'responses':[narrative]},[ck('last.requests',length=1),ck('last.requests.0.kind',equals='narrative'),ck('last.status',equals='completed')]),snap([ck('snapshot.canon.characterSnapshots',length=1),ck('snapshot.canon.nodes',length=1),ck('snapshot.canon.compileProgress.0.completedChapters',equals=['1'])])],single)
case('P07','AC-09',[step('runP1',{'bookId':B,'responses':[world,narrative],'abortAfterResponse':1},[ck('last.status',equals='cancelled')]),snap([ck('snapshot.canon.characterSnapshots',length=0),ck('snapshot.canon.nodes',length=0)])],single)
case('P08','AC-20',[step('updateCharacter',{'bookId':B,'id':'C1-P001','patch':{'identity':'修改身份','profile.ageText':'约二十岁'}}),snap([ck('snapshot.canon.characterSnapshots.0.identity',equals='修改身份'),ck('snapshot.canon.characterSnapshots.0.profile.ageText',equals='约二十岁'),ck('snapshot.canon.characters',length=0)])],data)
case('P09','AC-15',[step('setRole',{'bookId':B,'id':'C1-P001','roleWeight':'主要人物'}),snap([ck('snapshot.canon.characterSnapshots.0.roleWeight',equals='主要人物'),ck('snapshot.canon.characterSnapshots.0.roleWeightSource',equals='manual')])],data)
case('P10','AC-21',[step('mergeCharacter',{'bookId':B,'keepId':'C1-P001','mergeIds':['C1-P002']}),snap([ck('snapshot.canon.characterSnapshots',length=2),ck('snapshot.canon.characterSnapshots.0.aliases',includes='顾衡')])],data)
case('P11','AC-23',[step('publish',{'bookId':B},[ck('last.characters',equals=3),ck('last.locations',equals=2)]),step('publish',{'bookId':B}),snap([ck('snapshot.canon.characters',length=3),ck('snapshot.canon.locations',length=2),ck('snapshot.canon.nodes.0.actors',equals=['沈青','顾衡']),ck('snapshot.canon.nodes.0.actorIds',equals=['P001','P002']),ck('snapshot.canon.eventLines.0.characterIds',equals=['P001','P002'])])],data)
case('P12','AC-24',[step('resolveName',{'entries':[{'id':'P1','names':['同名']},{'id':'P2','names':['同名']}],'name':'同名'},[ck('last',equals='P1')]),step('resolveName',{'entries':[{'id':'P1','names':['沈青甲']},{'id':'P2','names':['沈青乙']}],'name':'沈青'},[ck('last',exists=False)])])
case('P13','AC-21',[step('deleteNode',{'bookId':B,'id':'C1-N001'}),snap([ck('snapshot.canon.nodes',length=1),ck('snapshot.canon.eventLines.0.nodeIds',equals=['C1-N002'])]),step('deleteNode',{'bookId':B,'id':'C1-N002'}),snap([ck('snapshot.canon.eventLines',length=0)])],data)
case('P14','AC-21',[step('deleteLine',{'bookId':B,'id':'L01'}),snap([ck('snapshot.canon.nodes',length=2),ck('snapshot.canon.eventLines',length=0),ck('snapshot.canon.nodes.0.eventLineIds',equals=[])])],seed({'nodes':[dict(node1,eventLineIds=['L01']),dict(node2,eventLineIds=['L01'])],'eventLines':[line]}))
case('P15','AC-37',[step('tool',{'bookId':B,'name':'query_nodes','args':{'limit':1}},[ck('last.data',length=1),ck('last.totalCount',equals=2),ck('last.truncated',equals=True),ck('last.nextOffset',equals=1)])],data)
case('P16','AC-37',[step('tool',{'bookId':B,'name':'query_nodes','args':{'limit':0}},[ck('last.error',equals='INVALID_ARGS')]),step('tool',{'bookId':B,'name':'get_node_detail','args':{'ids':['missing']}},[ck('last.data',equals=[]),ck('last.totalCount',equals=0),ck('last.nextOffset',equals=None)])],data)
case('P17','AC-19',[step('validateLink',{'bookId':B,'proposal':{'new_nodes':[],'event_line_ops':[{'op':'append','line_id':'L01','node_ids':['MISSING'],'cause':'','process':'','result':'','line_status':'open'}]}},[ck('last',length=1),ck('last.0',match='不存在或无效的节点')])],data)
case('P18','AC-19',[step('validateLink',{'bookId':B,'proposal':{'event_line_ops':[],'new_nodes':[{'client_id':'tmp','chapterIndex':'1','name':'编造','summary':'','actors':[],'quote':'原文没有这句话'}]}},[ck('last.0',match='真实原文依据')])],data)
case('P19','AC-18',[step('runLink',{'bookId':B,'responses':[ok({'event_line_ops':[{'op':'create','title':'会面线','node_ids':['C1-N001'],'cause':'会面','process':'见面','result':'','line_status':'open'}],'new_nodes':[],'memory_update':{'workingSummary':'已核对会面','notes':[]}})]},[ck('last.failedBatches',equals=0)]),snap([ck('snapshot.canon.eventLines',length=1),ck('snapshot.canon.eventLines.0.title',equals='会面线'),ck('snapshot.canon.storyEditorMemory.0.workingSummary',equals='已核对会面'),ck('snapshot.canon.storyEditorCheckpoints.0.status',equals='completed')])],seed({'chapters':[m.seed['chapters'][0]],'chapterTexts':[m.sample['chapterTexts']],'nodes':[node1]}))
case('P20','AC-19',[step('runLink',{'bookId':B,'responses':[fail()]},[ck('last.failedBatches',equals=1)]),snap([ck('snapshot.canon.eventLines',length=0),ck('snapshot.canon.storyEditorMemory',length=0),ck('snapshot.canon.storyEditorCheckpoints.0.status',equals='failed')])],seed({'chapters':[m.seed['chapters'][0]],'chapterTexts':[m.sample['chapterTexts']],'nodes':[node1]}))
case('P21','AC-29',[step('backupRoundTrip',{'bookId':B},[ck('last.inspect.ok',equals=True),ck('last.newTitle',equals='逆推验证样本（导入）'),ck('last.originalStillExists',equals=True),ck('last.sameBookId',equals=False),ck('last.restoredCounts.nodes',equals=2),ck('last.restoredCounts.characterSnapshots',equals=3)])],data)
case('P22','AC-30',[step('inspectInvalid',{'kind':'notZip'},[ck('last.ok',equals=False),ck('last.errors.0',match='zip')]),step('inspectInvalid',{'kind':'missingManifest'},[ck('last.errors.0',match='manifest')]),step('inspectInvalid',{'kind':'newer'},[ck('last.ok',equals=False),ck('last.errors.0',match='更新版本')])])
case('P23','AC-32',[step('saveKey',{'key':'test-only-not-a-real-key'}),step('deleteBook',{'bookId':B}),step('keyConfigured',{},[ck('last',equals=True)]),snap([ck('snapshot.books',length=0)])],data)
case('P24','AC-10',[step('windows',{'count':181,'splitChapter':100},[ck('last',length=3),ck('last.0',includes='100.1'),ck('last.0',includes='100.2'),ck('last.1.0',equals='81'),ck('last.2.0',equals='161')])])
case('P25','AC-14',[step('groups',{'records':[{'name':'甲','aliases':[]},{'name':'甲乙','aliases':[]}],'kind':'character'},[ck('last.first',length=1)]),step('groups',{'records':[{'name':'码头','aliases':[]},{'name':'码头仓库','aliases':[]}],'kind':'location'},[ck('last.first',length=2)])])
case('P26','AC-15',[step('frequency',{'entities':[{'name':'甲','roleWeight':'路人','roleWeightSource':'manual'},{'name':'乙'}],'texts':[{'chapterIndex':'1','text':'甲甲乙'}]},[ck('last.0.roleWeight',equals='路人'),ck('last.0.frequency.mentions',equals=2),ck('last.1.frequency.mentions',equals=1)])])
case('P27','AC-26',[step('newSession',{'bookId':B},saveAs='session'),step('newSession',{'bookId':B,'newReview':True},saveAs='review'),snap([ck('snapshot.canon.storySessions',length=2),ck('snapshot.canon.storySessions.0.status',equals='archived'),ck('snapshot.canon.storySessions.1.kind',equals='review'),ck('snapshot.canon.storySessions.1.parentSessionId',equals={'$ref':['session','id']})])])
case('P28','AC-27',[step('sessionWithMessages',{'bookId':B,'chars':14000},saveAs='session'),step('compact',{'bookId':B,'id':{'$ref':['session','id']},'summary':'摘要完成'},[ck('last.compactions',equals=1),ck('last.originalMessageCount',equals=3),ck('last.summary',equals='摘要完成')])])
case('P29','AC-27',[step('sessionWithMessages',{'bookId':B,'chars':14000},saveAs='session'),step('compact',{'bookId':B,'id':{'$ref':['session','id']},'summaryFailure':True},[ck('error.message',match='压缩未产生有效摘要')],allowError=True),snap([ck('snapshot.canon.storySessionEntries',length=3)])])
case('P30','AC-35',[step('agentHttp',{'bookId':B,'script':[{'tool':'query_nodes','args':{}},{'tool':'submit_result','args':{'answer':'confirmed'}}]},[ck('last.result.ok',equals=True),ck('last.result.data.answer',equals='confirmed'),ck('last.requestCount',equals=2)])],data)
case('P31','AC-35',[step('agentHttp',{'bookId':B,'script':[{'tool':'submit_result','args':{'answer':5}},{'tool':'submit_result','args':{'answer':'repaired'}}]},[ck('last.result.ok',equals=True),ck('last.result.attempts',equals=2),ck('last.result.data.answer',equals='repaired')])],data)
case('P32','AC-35',[step('agentHttp',{'bookId':B,'script':[{'tool':'submit_result','args':{'answer':5}},{'tool':'submit_result','args':{'answer':5}}]},[ck('last.result.ok',equals=False),ck('last.result.errorKind',equals='validation'),ck('last.requestCount',equals=2)])],data)
(OUT/'acceptance/cases.json').write_text(json.dumps(cases,ensure_ascii=False,indent=2),encoding='utf-8')
m.dump('resources/scenarios/table-flow-seed.json',data)
print(f'Created {len(cases)} portable cases with concrete inputs and expected outputs.')
