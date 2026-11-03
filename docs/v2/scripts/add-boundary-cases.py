from pathlib import Path
import json,copy
r=Path(__file__).resolve().parent.parent
cases=json.loads((r/'acceptance/cases.json').read_text(encoding='utf-8'))
base=json.loads((r/'resources/scenarios/table-flow-seed.json').read_text(encoding='utf-8'));B=base['bookId']
def ck(p,**kw):return {'path':p.split('.'),**kw}
large=copy.deepcopy(base);large['canon']['nodes']=large['canon']['nodes'][:1];large['canon']['nodes'][0]['name']='甲'*30000
many=copy.deepcopy(base)
many['canon']['nodes']=[dict(base['canon']['nodes'][0],id=f'C1-N{i:03}')for i in range(1,12)]
many['canon']['eventLines']=[dict(base['canon']['eventLines'][0],id=f'L{i:02}',nodeIds=[f'C1-N{i:03}'])for i in range(1,12)]
new=[
 {'id':'P36','requirement':'AC-30','steps':[{'command':'inspectInvalid','args':{'kind':'missingStats'},'allowError':True,'checks':[ck('error.message',exists=True),ck('last',exists=False)]}]},
 {'id':'P37','requirement':'AC-37','seed':large,'steps':[{'command':'tool','args':{'bookId':B,'name':'get_node_detail','args':{'ids':['C1-N001']}},'checks':[ck('last.data.0.fields_omitted',equals=['oversized_detail']),ck('last.data.0.name',exists=False),ck('last.totalCount',equals=1)]}]},
 {'id':'P38','requirement':'AC-38','seed':many,'steps':[{'command':'tool','args':{'bookId':B,'name':'get_event_line_detail','args':{'ids':[f'L{i:02}'for i in range(1,12)]}},'checks':[ck('last.data',length=10),ck('last.totalCount',equals=11),ck('last.truncated',equals=True),ck('last.nextOffset',equals=10)]}]},
]
cases=[c for c in cases if c['id']not in['P36','P37','P38']]
cases=[c for c in cases if c['id'].startswith('P')]+new+[c for c in cases if c['id'].startswith('T')]
(r/'acceptance/cases.json').write_text(json.dumps(cases,ensure_ascii=False,indent=2),encoding='utf-8')
print(f'{len(cases)} concrete scenarios; malformed backup/oversize/detail limits added.')
