from pathlib import Path
import json
ROOT=Path(__file__).resolve().parents[1];R=ROOT/'resources/v2.2'
def read(p):return json.loads(p.read_text(encoding='utf-8'))
def save(p,x):p.write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
changes={
'重建验收、缺陷复现输入和必须保留的结果':'重建验收、缺陷触发输入和必须修复后的结果',
'已切章的文本；不保证包含首标题前的文件内容':'完整保留规范化输入的分章文本，含首标题前序文',
'确定性分章、相似度、层级与图布局的输入及精确预期结果':'2.1历史黄金结果；纯算法可复用，涉及已修复缺陷时用当前FIX断言',
'2.1历史异常；2.2是否沿用或撤销按07处置':'2.1历史异常；当前已知缺陷均按07修复后结果验收',
'错regex/解码显示错误，旧preview保留':'错误显示并清当前预览；过期loadToken结果忽略',
'File首文件':'通过统一校验的单个TXT',
'先await设置库单行put':'先写T02 import/preparing日志，完整书库成功后才发布T03',
'后续失败没有跨库回滚':'失败按日志清理未发布新库，不能显示可用半成书',
'事务失败两表不部分写；T03可能已存在':'事务失败不发布T03，日志保留以清理/重试',
'本书两表同事务bulkPut':'章节、正文及P1初始进度同一单书事务',
'独立put，不与建书/章节合为同事务':'与章节/正文同一单书事务，随后全局发布书架',
'这里失败仍可能已有书/章节':'失败整个单书事务回滚，书架不发布',
'缺统计JSON可拒绝Promise无友好兜底':'所有预检失败返回结构化errors，不能确认导入',
'先T03新记录；后目标库T04–T20':'T02生命周期日志→目标库T04–T20→全局事务发布T03并清日志',
'目标写失败可留书架；不回滚已有原书':'目标失败保持书架未发布，按日志清理；已有原书不变',
'关闭/删除单书库→删除T03书架':'全局写delete日志并隐藏T03→关闭/删除单书库→清日志',
'书架跨库仍非原子':'跨库非原子但日志保证可恢复，不显示半成书',
'handlePickBackup无catch，畸形统计JSON可未处理拒绝':'捕获文件/ZIP/JSON预检错误，展示errors.message并禁用确认',
'confirm catch显示flash；跨库可留书架':'显示失败阶段与可重试清理状态；不发布半成书',
'T03新书；目标新书T04–T17；ui.bookId':'T02日志；目标新书T04–T20；成功后T03及ui.bookId',
'file label未按全局busy禁用':'文件入口按busy禁用；预检期间禁止重复确认',
'导入label/file无全局busy禁用':'导入label/file按busy禁用',
'取消按钮未统一busy禁用，保留基线。':'提交前取消清预览；提交中取消只请求停止，等待日志/事务结果，不伪报成功。',
}
for f in ROOT.glob('[0-1][0-9]-*.md'):
    if f.name.startswith('08-'):continue
    x=f.read_text(encoding='utf-8')
    for a,b in changes.items():x=x.replace(a,b)
    if f.name.startswith('07-'):
        x=x.replace('未变导入/分章、模型协议/重试、图布局、设置、游玩占位继续参照2.1固定样本和黄金结果','未变纯算法可参照2.1样本；导入/分章/取消/判同等已修复行为必须按当前FIX断言，旧错误预期作废')
    if f.name.startswith('13-'):
        x=x.replace('此次补缺不扩大成全项目重新设计，不更改已明确的机械名称包含规则；其误合并风险仍在07/RQ-08登记。','此前补缺阶段未更改名称包含规则；此限制已被后续用户“规划时直接修复BUG”的授权取代，当前按07及ALG-FIX执行。')
    if f.name.startswith('02-'):
        x=x.replace('建议优先修复：人物名称包含直接融合导致误合并','已纳入必须修复：人物名称包含直接融合导致误合并')
    f.write_text(x,encoding='utf-8')
def walk(x):
    if isinstance(x,dict):return {k:walk(v) for k,v in x.items()}
    if isinstance(x,list):return [walk(v) for v in x]
    if isinstance(x,str):
        for a,b in changes.items():x=x.replace(a,b)
    return x
for name in ['operation-catalog.json','data-flows.json']:save(R/name,walk(read(R/name)))
# Startup recovery is a real trigger, so inventory it rather than hiding it in prose.
tr=read(R/'automatic-triggers.json');entry=dict(id='AUTO-17',trigger='应用启动扫描book.lifecycle日志',guard='仅接管租约过期且原owner不活跃的本机日志；全局事务CAS成功',steps='ready复验后发布；preparing/cleanup_pending清理未发布库；deleting继续删除；失败保留日志并提示，不调用模型',data='T02日志→单书库完整性/删除→T03可用书架',lifecycle='每次状态变更核owner；活操作不抢占；刷新可重试，delete被阻塞不报成功')
tr['triggers']=[v for v in tr['triggers'] if v['id']!='AUTO-17']+[entry];save(R/'automatic-triggers.json',tr)
f=next(ROOT.glob('09-*.md'));x=f.read_text(encoding='utf-8')
if '## AUTO-17 · 生命周期恢复' not in x:x+='\n## AUTO-17 · 生命周期恢复\n\n'+entry['trigger']+'；'+entry['guard']+'。'+entry['steps']+'。'+entry['lifecycle']+'。\n'
f.write_text(x,encoding='utf-8')
for prefix in ['00','09']:
    f=next(ROOT.glob(prefix+'-*.md'));x=f.read_text(encoding='utf-8').replace('16自动触发','17自动触发').replace('16自动动作','17自动动作');f.write_text(x,encoding='utf-8')
v=ROOT/'scripts/validate-v2.2.py';x=v.read_text(encoding='utf-8').replace('(60, 16, 14, 17, 30)','(60, 17, 14, 17, 30)');v.write_text(x,encoding='utf-8')
data=read(R/'data-contract.json');D=data['schemas']['$defs'];j=D['BookLifecycleJournal'];j['properties'].update(owner={'type':'string','minLength':1},leaseUntil={'type':'integer','minimum':0})
for field in ['owner','leaseUntil']:
    if field not in j['required']:j['required'].append(field)
j['allOf']=[{'if':{'properties':{'action':{'const':'import'},'state':{'const':'ready'}}},'then':{'required':['book']}}]
save(R/'data-contract.json',data);save(R/'storage.schema.json',{'$schema':'https://json-schema.org/draft/2020-12/schema','$defs':D})
print('cross-document flows, journal ownership and 17-trigger inventory synchronized')
