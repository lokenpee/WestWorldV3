from pathlib import Path
from copy import deepcopy as cp
import json
ROOT=Path(__file__).resolve().parents[1];R=ROOT/'resources/v2.2'
recovery=json.loads((R/'acceptance/recovery-cases.json').read_text(encoding='utf-8'));seed=cp(recovery['cases'][0]['seed'])
def case(id,title,op,args,expected,seedValue=None,snapshot=None):return dict(id=id,title=title,seed=cp(seedValue or seed),steps=[dict(operation=op,input=args,expect=dict(output=expected,snapshot=snapshot or {}))])
cases=[]
cases.append(case('FIX-01','首标题前文字守恒','splitChapters',{'text':'导言\n第一章 开端\n正文','regex':'^第[一二三]+章.*$','maxChunkChars':10000},{'chapters.0.chapterIndex':'0','chapters.0.text':'导言\n','chapters.1.chapterIndex':'1','joinedText':'导言\n第一章 开端\n正文'}))
pair=[{'id':'A','name':'张三','aliases':[]},{'id':'B','name':'张三丰','aliases':[]}]
cases.append(case('FIX-02','名称包含只生成候选','planIdentityCandidates',{'kind':'character','records':pair},{'candidatePairs.0.memberIds':['A','B'],'automaticMerges':[]}))
action=cp(recovery['cases'][0]['steps'][0]);args=action['input'];group=args['arguments']['payload']['groups'][0];group.pop('confidence',None);group.pop('evidence',None)
cases.append(case('FIX-03','旧无证据合并命令拒绝','prepareCommand',args,{'error':'INVALID_ARGS'},snapshot={'characters.length':2,'run.appliedCommands.length':0,'run.commandIntents.length':0}))
cases.append(case('FIX-04','P1伪造引文拒绝','validateP1Narrative',{'chapterText':'沈青到了码头。','output':{'nodes':[{'name':'到达码头','summary':'沈青到达','actors':['沈青'],'quote':'沈青死了。','confidence':1}]}},{'valid':False,'errors.length':1}))
cases.append(case('FIX-05','同名歧义不取首项','resolveCharacterRefs',{'actors':['沈青'],'characters':[{'id':'A','name':'沈青','aliases':[]},{'id':'B','name':'沈青','aliases':[]}]},{'actorIds':[],'characterReferences':[{'name':'沈青','status':'ambiguous','candidateIds':['A','B']}]}))
cases.append(case('FIX-06','取消打断退避','retryWithAbort',{'retryAfterMs':30000,'abortAtMs':10},{'cancelled':True,'requestsStarted':1,'nextRequestStarted':False,'elapsedMs':10}))
(R/'acceptance/bugfix-cases.json').write_text(json.dumps({'kind':'adapter-driven-fix-first-cases','policyRevision':'2026-10-24.fix-first','applicationExecuted':False,'cases':cases},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print('6 fixed regression cases added; not executed against application')
