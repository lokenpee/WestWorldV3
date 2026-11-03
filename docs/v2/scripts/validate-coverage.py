"""机械对账：不以此报告语义闭合或独立重建通过。"""
from pathlib import Path
import json,re,hashlib
OUT=Path(__file__).resolve().parent.parent
def load(name):return json.loads((OUT/name).read_text(encoding='utf-8'))
errors=[]
def check(ok,reason):
 if not ok:errors.append(reason)
inv=load('resources/storage-inventory.json');schemas=load('resources/schemas.json');stores=load('resources/stores.json')
check(len(inv['tables'])==17,'表清单数量')
check({t['name']for t in inv['tables']if t['database']=='canon'}==set(stores['v4']),'单书实际定义未全部纳入')
check({t['name']for t in inv['tables']if t['database']=='settings'}=={'books','credentials','appSettings'},'设置三表未全部纳入')
def roots(schema):
 if 'anyOf'in schema:return set().union(*(roots(s)for s in schema['anyOf']))
 return set(schema.get('properties',{}))
for t in inv['tables']:
 check(bool(t['writers'])and bool(t['readers'])and bool(t['lifecycle']),t['id']+'生命周期缺失')
 check((OUT/t['example']).is_file(),t['id']+'示例不存在')
 if t['schema']:
  expected=roots(schemas[t['schema']]);actual={re.sub(r'<分支\d+>','',r['path']).lstrip('.').split('.')[0]for r in t['fields']}
  check(expected<=actual,t['id']+'字段根遗漏:'+str(expected-actual))
ops=load('resources/operation-catalog.json');flows=load('resources/data-flows.json');autos=load('resources/automatic-triggers.json')
flowids={f['id']for f in flows};opids={o['id']for o in ops};autoids={a['id']for a in autos}
for o in ops:
 for key in ['page','event','inputs','guard','steps','success','error','repeat']:check(bool(o[key]),o['id']+'/'+key+'空')
 check(not o['flow']or o['flow']in flowids,o['id']+'流程引用无效')
matrix=load('resources/coverage-matrix.json')
linked=set().union(*(set(v)for v in matrix['uiModules'].values()))
check(opids<=linked,'未映射到UI源模块的操作:'+str(opids-linked))
for f in flows:
 check(len(f['steps'])>0and bool(f['example']),f['id']+'缺步骤或前后例子')
 for step in f['steps']:
  check(all(step.get(k)for k in ['input','read','transform','write','commit','failure','consumer']),f['id']+'流转列缺失')
cases=load('acceptance/cases.json');result=load('evidence/portable-baseline-results.json')
check({c['id']for c in cases}=={r['id']for r in result['cases']},'断言场景和运行结果ID不符')
check(result['failed']==0,'参考边界存在失败')
gold=load('resources/golden-results.json')
check(any(len(c['input'])>10000and c['result'][0]['chapterIndex']=='1.1'for c in gold['split']),'长章黄金样本未落实')
source=(OUT/'acceptance/suite.mjs').read_text(encoding='utf-8')
check(not re.search('(?:from|import\\()[^\\n]*(?:app/src|core/pipeline|baseline\\.adapter)',source),'独立suite依赖原实现')
docs=list(OUT.glob('[0-9][0-9]-*.md'))
table_errors=[]
for p in docs:
 in_fence=False;columns=None
 for n,line in enumerate(p.read_text(encoding='utf-8').splitlines(),1):
  if line.startswith('```'):in_fence=not in_fence;columns=None;continue
  if in_fence:continue
  if line.startswith('|'):
   size=len(re.split('(?<!\\\\)\\|',line))-2
   if columns is None:columns=size
   elif columns!=size:table_errors.append(f'{p.name}:{n} expected {columns}, got {size}')
  else:columns=None
check(not table_errors,'Markdown表列不齐:'+repr(table_errors[:12]))
report={'checkLayer':'mechanical-coverage-reconciliation-only','tableDefinitions':17,'tableFieldRows':sum(len(t['fields'])for t in inv['tables']),'uiOperationGroups':len(ops),'automaticTriggers':len(autos),'dataFlows':len(flows),'stateTransitions':len(load('resources/state-transitions.json')),'portableScenarios':len(cases),'baselinePasses':result['passed'],'errors':errors,'semanticReview':'See 12-验收执行与覆盖矩阵.md; not inferred by this script','independentApplicationRebuilt':False}
(OUT/'evidence/coverage-validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
raise SystemExit(1if errors else 0)
