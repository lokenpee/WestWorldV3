"""独立验收夹具：固定输入和固定预期，不调用应用计算业务预期。"""
from pathlib import Path
from copy import deepcopy as cp
import json,hashlib
ROOT=Path(__file__).resolve().parents[1]; R=ROOT/'resources/v2.2'; OUT=R/'acceptance'; OUT.mkdir(exist_ok=True)
def canonical(x): return json.dumps(x,ensure_ascii=False,sort_keys=True,separators=(',',':'))
def h(x): return hashlib.sha256(canonical(x).encode()).hexdigest()
def save(p,x): p.write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
stamp='2026-10-24T00:00:00.000Z'; now=1792800000000; book='book-a'; run='R'; task='T1'
chars=[dict(id=ident,bookId=book,name='沈青',chapterIndex=chapter,chapterName='第'+chapter+'章',revision=1,createdBy='P1',confidence=1,aliases=[],sourceChapters=[chapter],manualKeep=False) for ident,chapter in [('C1-P001','1'),('C2-P001','2')]]
def fact(row): return h({k:v for k,v in row.items() if k not in ['bookId','revision','updatedAt','frequency','optimizedFactIds','optimizationFingerprint']})
work=[dict(workItemId='ai_identity:fullBook:character:'+x['id'],kind='character',id=x['id'],revision=1,factFingerprint=fact(x)) for x in chars]
readset={'records':[dict(table='characters',id=x['id'],resolvedId=x['id'],revision=1,factFingerprint=fact(x)) for x in chars],'queries':[]}
input={'bookId':book,'runId':run,'taskId':task,'planVersion':'2.2','remainingCount':2,'resume':{'reason':'initial','appliedCommitIds':[],'nextOperationKey':'T1:1','remainingWorkIds':[w['workItemId'] for w in work]},'stage':'P2','phase':'ai_identity','kind':'character','scope':'fullBook','workItems':work,'afterId':None,'pageLimit':100}
t=dict(taskId=task,ordinal=0,callId='PROMPT-P2-IDENTITY',phase='ai_identity',status='running',workItemIds=[w['workItemId'] for w in work],input=input,inputFingerprint=h(input),promptHash='fixture-known-prompt-hash',attempt=1,repairCount=0,stepsUsed=1,appliedCommitIds=[],reviewedItems=[],readSet=readset,createdAt=stamp,updatedAt=stamp)
coverage=[dict(workItemId=w['workItemId'],phase='ai_identity',kind='character',id=w['id'],status='assigned',inputRevision=1,inputFingerprint=w['factFingerprint'],coveredRevision=0,coveredFingerprint='',dependencies={'records':[],'queries':[]},taskId=task,outcome=None,reason='',invalidations=0,updatedAt=stamp) for w in work]
rr=dict(recordType='run',id=run,bookId=book,stage='P2',status='running',startedAt=stamp,planVersion='2.2',contractRevision='2026-10-24',phase='ai_identity',tasks=[t],commandIntents=[],appliedCommands=[],coverageItems=coverage,reconciliationPass=0,nextTaskOrdinal=1,noProgressTasks=0,coverage={'total':2,'checked':0,'pendingIds':[w['workItemId'] for w in work]})
lifecycle=[dict(key='character:'+x['id'],bookId=book,kind='character',originId=x['id'],currentId=x['id'],state='live',revision=1,updatedAt=stamp) for x in chars]
seed={'clockMs':now,'uuidSequence':['K1','E1','K2','E2'],'binding':{'bookId':book,'runId':run,'taskId':task,'profile':'asset_editor','phase':'ai_identity','owner':'owner-1'},'tables':{'characters':chars,'assetLifecycle':lifecycle,'pipelineRuns':[rr,dict(recordType='lease',id='lease:world',bookId=book,lockKey='world',owner='owner-1',runId=run,expiresAt=now+300000)]}}
payload={'groups':[dict(kind='character',keepId='C1-P001',memberIds=['C1-P001','C2-P001'],canonicalName='沈青',reason='已读资料确认同一人物')]}
prepare={'operation':'prepareCommand','input':dict(bookId=book,runId=run,taskId=task,toolCallId='call-1',toolName='commit_asset_changes',arguments={'operationKey':'T1:1','payload':payload},readSet=readset)}
execute={'operation':'executePrepared','input':dict(bookId=book,runId=run,operationKey='T1:1')}
def step(action,output=None,snapshot=None): return {**cp(action),'expect':{'output':output or {},'snapshot':snapshot or {}}}
cases=[]
cases.append({'id':'GAP-REC-01','title':'提交后反馈丢失：重放同一确认','seed':cp(seed),'steps':[step(prepare,{'state':'prepared'}, {'run.commandIntents.0.state':'prepared','characters.length':2}),step(execute,{'ok':True,'commitId':'K1','alreadyApplied':False},{'characters.length':1,'characters.0.revision':2,'run.appliedCommands.length':1,'run.appliedCommands.0.taskId':'T1','run.commandIntents.0.state':'applied'}),step(execute,{'ok':True,'commitId':'K1','alreadyApplied':True},{'characters.0.revision':2,'run.appliedCommands.length':1})]})
changed=cp(prepare); changed['input']['arguments']['payload']['groups'][0]['reason']='不同的判断'
cases.append({'id':'GAP-REC-02','title':'同键不同payload不得覆盖意图','seed':cp(seed),'steps':[step(prepare,{'state':'prepared'}),step(changed,{'error':'IDEMPOTENCY_CONFLICT'},{'characters.length':2,'run.commandIntents.length':1,'run.appliedCommands.length':0})]})
manual={'operation':'manualUpdate','input':dict(bookId=book,kind='character',id='C1-P001',expectedRevision=1,patch={'identity':'新的人工身份'})}
cases.append({'id':'GAP-REC-03','title':'prepared后人工修改：恢复拒绝旧依据','seed':cp(seed),'steps':[step(prepare,{'state':'prepared'}),step(manual,{'ok':True},{'characters.0.revision':2}),step(execute,{'error':'CONFLICT'},{'characters.length':2,'characters.0.identity':'新的人工身份','run.appliedCommands.length':0,'run.commandIntents.0.state':'rejected'})]})
checked=cp(seed)
for c in checked['tables']['pipelineRuns'][0]['coverageItems']:
    c.update(status='checked',coveredRevision=1,coveredFingerprint=c['inputFingerprint'],dependencies={'records':[next(x for x in readset['records'] if x['id']==c['id'])],'queries':[]},outcome='no_change',reason='已检查，无变更')
checked['tables']['pipelineRuns'][0]['tasks'][0]['status']='completed'
checked['tables']['pipelineRuns'][0]['coverage'].update(checked=2,pendingIds=[])
cases.append({'id':'GAP-REC-04','title':'逐项覆盖只失效被改人物','seed':checked,'steps':[step(manual,{'ok':True}),step({'operation':'reconcileCoverage','input':{'bookId':book,'runId':run}}, {'ok':True},{'run.coverage.checked':1,'run.coverage.pendingIds':[work[0]['workItemId']],'run.coverageItems.0.status':'stale','run.coverageItems.1.status':'checked'})]})
badfinal={'operation':'finalizeTask','input':{'bookId':book,'runId':run,'taskId':task,'summary':{'status':'completed','commitIds':[],'summary':'全部完成','remainingWorkIds':[],'reviewedItems':[{'workItemId':work[0]['workItemId'],'outcome':'no_change','reason':'只检查了一项'}]}}}
cases.append({'id':'GAP-REC-05','title':'最终总结不能漏掉分配项','seed':cp(seed),'steps':[step(badfinal,{'error':'INVALID_ARGS'},{'run.tasks.0.status':'running','run.coverage.checked':0})]})
other=cp(seed); other['tables']['pipelineRuns'][0]['appliedCommands']=[dict(operationKey='old-key',taskId='T0',payloadFingerprint='old-fingerprint',commitId='K0',committedAt=stamp,resultSummary='先前子任务确认')]
older=cp(t); older.update(taskId='T0',ordinal=0,status='partial',appliedCommitIds=['K0']); older['input']=cp(input); older['input']['taskId']='T0'; older['inputFingerprint']=h(older['input']); other['tables']['pipelineRuns'][0]['tasks'].append(older);other['tables']['pipelineRuns'][0]['tasks'][0]['ordinal']=1;other['tables']['pipelineRuns'][0]['nextTaskOrdinal']=2
bad=cp(badfinal);bad['input']['summary'].update(commitIds=['K0'],reviewedItems=[dict(workItemId=w['workItemId'],outcome='no_change',reason='已核查') for w in work])
cases.append({'id':'GAP-REC-06','title':'不能冒用同run其他task的确认','seed':other,'steps':[step(bad,{'error':'INVALID_ARGS'},{'run.tasks.0.status':'running'})]})
save(OUT/'recovery-cases.json',{'contractRevision':'2026-10-24','kind':'adapter-driven-target-cases','applicationExecuted':False,'cases':cases})
save(R/'execution-examples.json',{'task':t,'coverageItem':coverage[0],'preparedIntent':dict(operationKey='T1:1',taskId='T1',toolCallId='call-1',toolName='commit_asset_changes',payload=payload,payloadFingerprint=h(payload),expectedReadSet=readset,state='prepared',createdAt=stamp,updatedAt=stamp),'run':rr})
print('6 fixed recovery/coverage cases and execution records written; application not executed')
