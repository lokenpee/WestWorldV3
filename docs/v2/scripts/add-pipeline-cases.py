from pathlib import Path
import json,copy
r=Path(__file__).resolve().parent.parent
cases=json.loads((r/'acceptance/cases.json').read_text(encoding='utf-8'))
base=json.loads((r/'resources/scenarios/table-flow-seed.json').read_text(encoding='utf-8'))
B=base['bookId'];single={'bookId':B,'books':base['books'],'canon':{'chapters':base['canon']['chapters'][:1],'chapterTexts':base['canon']['chapterTexts']}}
def chk(p,equals):return {'path':p.split('.'),'equals':equals}
def snap(checks):return {'snapshot':B,'checks':checks}
world={'characters':[{'name':'沈青','confidence':1}],'locations':[{'name':'码头','confidence':1}]}
narrative={'nodes':[{'name':'会面','summary':'沈青在码头见到顾衡。','actors':['沈青','顾衡'],'quote':'沈青在码头见到顾衡。','confidence':1}]}
proposal={'event_line_ops':[{'op':'create','title':'会面线','node_ids':['C1-N001'],'cause':'会面','process':'见面','result':'','line_status':'open'}],'new_nodes':[],'memory_update':{'workingSummary':'已核对会面','notes':[]}}
linkseed=copy.deepcopy(single);linkseed['canon']['nodes']=[base['canon']['nodes'][0]]
new=[{'id':'P33','requirement':'AC-08','seed':single,'steps':[{'command':'pipelineHttp','args':{'bookId':B,'stage':'p1','script':[{'tool':'submit_result','args':world},{'tool':'submit_result','args':narrative}]},'checks':[chk('last.requestCount',2),chk('last.result.status','completed')]},snap([chk('snapshot.canon.characterSnapshots.0.id','C1-P001'),chk('snapshot.canon.locationSnapshots.0.id','C1-L001'),chk('snapshot.canon.nodes.0.id','C1-N001')])]},
{'id':'P34','requirement':'AC-18','seed':linkseed,'steps':[{'command':'pipelineHttp','args':{'bookId':B,'stage':'link','script':[{'tool':'query_nodes','args':{}},{'tool':'submit_result','args':proposal}]},'checks':[chk('last.requestCount',2),chk('last.result.failedBatches',0)]},snap([chk('snapshot.canon.eventLines.0.title','会面线'),chk('snapshot.canon.storyEditorMemory.0.workingSummary','已核对会面'),chk('snapshot.canon.storyEditorCheckpoints.0.status','completed')])]},]
bad=copy.deepcopy(proposal);bad['event_line_ops'][0]['node_ids']=['MISSING']
new.append({'id':'P35','requirement':'AC-19','seed':linkseed,'steps':[{'command':'pipelineHttp','args':{'bookId':B,'stage':'link','script':[{'tool':'submit_result','args':bad},{'tool':'submit_result','args':proposal}]},'checks':[chk('last.requestCount',2),chk('last.result.failedBatches',0)]},snap([chk('snapshot.canon.eventLines.0.nodeIds',['C1-N001']),chk('snapshot.canon.storyEditorMemory.0.revision',1)])]})
cases=[x for x in cases if x['id']not in['P33','P34','P35']]
cases=[x for x in cases if x['id'].startswith('P')]+new+[x for x in cases if x['id'].startswith('T')]
(r/'acceptance/cases.json').write_text(json.dumps(cases,ensure_ascii=False,indent=2),encoding='utf-8')
print(f'{len(cases)} total cases; 3 actual P1/P2 HTTP workflows added.')
