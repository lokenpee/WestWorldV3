"""可独立验证规格包；原仓库仍可访问时额外核对源码哈希和引用。"""
from pathlib import Path
import json,re,hashlib,zipfile,argparse

OUT=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser()
parser.add_argument('--source-root',default=str(OUT.parents[2]))
args=parser.parse_args()
ROOT=Path(args.source_root)
failures=[]
def check(value,message):
    if not value:failures.append(message)
def sha(data):return hashlib.sha256(data).hexdigest()
def strip_code(text):return re.sub(r'```[\s\S]*?```','',text)

docs=sorted(OUT.glob('[0-9][0-9]-*.md'))
check(len(docs)==13,'需要13份正式规格与覆盖文档')
broken=[]
for p in docs:
    text=p.read_text(encoding='utf-8')
    for token in ['文档编号','文档版本','复现基线','文档状态','编写 / 维护','创建 / 更新','修订记录']:
        check(token in text,f'{p.name}: 缺少{token}')
    for target in re.findall(r'!?\[[^\]]*\]\(([^)]+)\)',strip_code(text)):
        path=target.split('#',1)[0]
        if not path or re.match(r'\w+://',path):continue
        if not (p.parent/path).exists():
            if p.name.startswith('08-') and path.startswith('../../../app/'):continue
            broken.append(f'{p.name}: {target}')
check(not broken,'存在断链: '+repr(broken))
for p in (OUT/'resources').rglob('*.json'):
    if p.name.startswith('tsconfig'):continue  # TypeScript配置为JSONC，由verify-contracts.ts解析。
    try:json.loads(p.read_text(encoding='utf-8-sig'))
    except Exception as ex:failures.append(f'JSON错误:{p.name}:{ex}')
cases=json.loads((OUT/'resources/acceptance-cases.json').read_text(encoding='utf-8'))
bugs=json.loads((OUT/'resources/compatibility-cases.json').read_text(encoding='utf-8'))
check(len({x['id'] for x in cases})==len(cases),'验收编号重复')
check(len({x['id'] for x in bugs})==len(bugs),'缺陷编号重复')
alltext='\n'.join(p.read_text(encoding='utf-8') for p in docs)
definedbugs={x['id'] for x in bugs}
unknown=set(re.findall(r'BUG-\d+',alltext))-definedbugs
check(not unknown,f'缺陷引用不存在:{unknown}')
for n in range(1,15):check(f'FR-{n:02}' in alltext,f'功能FR-{n:02}缺失')
schemas=json.loads((OUT/'resources/schemas.json').read_text(encoding='utf-8'))
data=(OUT/'03-Spec-数据与存储.md').read_text(encoding='utf-8')
inventory=json.loads((OUT/'resources/storage-inventory.json').read_text(encoding='utf-8'))
check(len(inventory['tables'])==17,'实际表清单不是17种定义')
for item in inventory['tables']:check('### '+item['id']+' · '+item['name'] in data,f'缺逐表规格:{item["name"]}')
tools=json.loads((OUT/'resources/tool-contracts.json').read_text(encoding='utf-8'))
check(len(tools['asset_editor'])==8 and len(tools['story_editor'])==13,'工具集数量错误')
for profile,items in tools.items():
    check(len(set(x['name'] for x in items))==len(items),f'{profile}工具重名')
    for item in items:check(item['kind']=='read' and item['maxBytes']==65536 and 'parameters' in item,f'非法工具:{item["name"]}')
zipchecks=0
for p in (OUT/'resources/fixtures').glob('*.wwv2'):
    with zipfile.ZipFile(p) as z:
        m=json.loads(z.read('manifest.json'))
        for target,expected in m['checksums'].items():check('sha256:'+sha(z.read(target))==expected,f'备份校验失败:{p.name}/{target}')
    zipchecks+=1
manifest_path=OUT/'resources/resource-manifest.json'
if manifest_path.exists():
    manifest=json.loads(manifest_path.read_text(encoding='utf-8'))
    for item in manifest['files']:check(sha((OUT/item['path']).read_bytes())==item['sha256'],f'交付资源变化:{item["path"]}')

baseline=json.loads((OUT/'evidence/baseline.json').read_text(encoding='utf-8'))
source_checked=0
if (ROOT/'app/src').exists():
    for item in baseline['files']:
        p=ROOT/item['path'];check(p.exists() and sha(p.read_bytes())==item['sha256'],f'源码变化:{item["path"]}');source_checked+=1
    refs=json.loads((OUT/'evidence/source-references.json').read_text(encoding='utf-8'))
    for item in refs:
        lines=(ROOT/item['path']).read_text(encoding='utf-8-sig').splitlines()
        check(item['pattern'] in lines[item['line']-1],f'源码引用漂移:{item["path"]}:{item["line"]}')
report={'formalDocuments':len(docs),'schemas':len(schemas),'acceptanceCases':len(cases),'compatibilityCases':len(bugs),'toolCounts':{k:len(v) for k,v in tools.items()},'fixtureBackupsChecked':zipchecks,'sourceFilesChecked':source_checked,'brokenLinks':broken,'failures':failures,'checkLayer':'mechanical-structure-and-references-only','independentApplicationRebuilt':False}
(OUT/'evidence/package-validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
raise SystemExit(1 if failures else 0)
