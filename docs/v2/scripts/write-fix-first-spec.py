from pathlib import Path
import json,re
ROOT=Path(__file__).resolve().parents[1];R=ROOT/'resources/v2.2'
contract=json.loads((R/'bugfix-contract.json').read_text(encoding='utf-8'))
rev='| 2.2 | 2026-10-24 | 用户明确要求规划时修复已知缺陷，撤销错误行为兼容义务 | 修复后结果作为重建验收；旧失败只作历史证据 |'
replacements={
'本次流程变更按2.2执行；未受影响行为沿用2.1，适用表见07':'已知缺陷优先修复，禁止复现旧错误；07修复条款优先',
'选择器接受TXT，拖放取第一文件，保留拖放不复验扩展名的BUG-02。':'选择器与拖放统一校验单个TXT；busy禁用，仅最新加载结果生效，失败不得导入旧预览。',
'保留无Key文案与实际入口差异BUG-05。':'按适配器鉴权能力统一禁用条件与提示，修复BUG-05。',
'同章人物/地点按名称去重保首项':'同章人物/地点仅去除完整DTO相同项，同名不同资料均保留',
'同章人物/地点按trim名称去重保首条':'同章人物/地点仅去除规范完整DTO相同项，不按名称丢弃不同资料',
'同名/人物包含聚组和主名+别名相似度严格大于0.9沿用ALG-04；地点不因包含关系自动合并。':'同名、包含与别名相似度严格大于0.9仅生成候选；实际融合须人工确认或通过带原文证据的AI提交。',
'窄视口须保留固定宽度和拥挤现象，不在忠实重建中自动响应式改版。':'窄视口保证全部操作可达；小于768px使用堆叠区域和内部滚动，不复现拥挤缺陷。',
'缺陷修复、无Key本地服务适配、真实模型质量目标、移动改版和未来游玩均不在本基线内，后续必须另行决定。':'已知缺陷按07修复要求纳入本基线；未知服务适配、模型语义质量保证及未来游戏引擎仍需另外定义。',
'此次补缺不把已知机械误合并风险默认为修复完成。':'名称误合并已纳入修复规格，实际实现通过回归后才可标记已修复。',
'更新指定资产；不存在行通常无变化':'校验必要字段和expectedRevision；不存在行返回NOT_FOUND，不得静默成功',
'常规错误作为结果；畸形统计JSON可拒绝Promise':'损坏/畸形JSON统一返回ok=false/errors，不产生未处理拒绝',
'新书恢复；无覆盖；跨库非原子':'新书恢复；无覆盖；完整恢复后发布书架，日志支持跨库恢复',
'有标题时，仅从首个标题起点切到下个标题/文本末尾；不创建序言章（BUG-01）。章节编号取匹配顺序i+1，不提取原标题数字。':'有标题时，非空前缀保存为序文chapterIndex=0；纯空白前缀并入首章。正文切片不trim，拼接必须还原规范化输入。标题章仍按匹配顺序1..N编号，不取原标题数字。',
'第一轮人物只比归一化主名，相等或一方包含另一方就合并，**没有短名≥2守卫**；地点只相等。所有匹配对用连通分量归并，不使用依赖遍历结果的贪心相邻合并。':'第一轮按名称相等/包含建立候选；连通分量只服务检索，不授权删除不同originId的实体。人物地点都不能仅凭同名/包含自动融合。',
'严格`>0.9`合并，恰好0.9不合并。第一轮组完成后再一次性计算第二轮关系。':'严格`>0.9`加入相似候选，恰好0.9不因本条件入候选；候选不直接落融合结果，须人工确认或有效AI证据。',
'机械合并先提交本地结果。':'机械阶段先生成候选及报告，不因名称信号删除不同来源实体。',
'`keepId/memberIds/canonicalName/reason`':'`keepId/memberIds/canonicalName/reason/confidence/evidence`',
'设置路径立即revoke，保留入口差异':'设置路径同样至少延迟1000ms revoke，修复过早回收差异',
'等待sleep不实现signal中断，取消可能等到退避结束。':'退避等待必须响应signal；取消在下一事件循环结束等待并阻止下一请求，清理timer/listener；已提交确认保留。',
'必须保留桌面固定宽度和默认窄视口拥挤，不新增移动端折叠导航或弹窗替代详情。':'桌面保持既定布局；小于768px书架/列表/详情上下排列，按钮换行，长内容区域内滚动，全部操作可达。',
'不额外按busy禁用这两个入口，保留现有不对称':'选择与拖放统一按busy禁用，并校验单个TXT及非空内容',
'同名/包含/别名>0.9聚组；文本确定性融合':'名称信号仅生成候选；人工确认或AI证据通过后确定性融合',
'不新增NaN校验；目录仍需权限':'有限数/整数范围校验失败拒绝写入；目录仍需权限',
'缺失正文沿用空串拼接章节头的兼容行为，不能把章节头或无原文当作有效引文证据。':'章节存在但正文缺失时返回SOURCE_MISSING并指出chapterIndex，禁止伪装成功空原文。',
'本轮完善缺失需求，不借此默改已明确的名称包含机械规则；风险和建议保留，另按具体行为变更处理 | 已说明范围；误合并风险未宣称修复':'最新用户授权缺陷优先；名称信号仅生成候选，强证据后才融合 | 修复规格已定义；应用待回归',
'严格>0.9；人物主名包含/地点不包含沿用旧算法 | 用户要求与原机械规则相同，保留既有单字包含边界；报告暴露结果':'严格>0.9仅作为候选阈值；名称包含不直接合并 | 最新用户授权修复误合并；人工确认或有效证据后才融合',
}
for f in ROOT.glob('[0-1][0-9]-*.md'):
    x=f.read_text(encoding='utf-8')
    if not f.name.startswith('08-'):
        for a,b in replacements.items():x=x.replace(a,b)
    if '### 修订记录' in x and rev not in x:
        lines=x.splitlines();idx=lines.index('### 修订记录')+1
        while not lines[idx].startswith('|'):idx+=1
        while idx<len(lines) and lines[idx].startswith('|'):idx+=1
        lines.insert(idx,rev);x='\n'.join(lines)+'\n'
    f.write_text(x,encoding='utf-8')
f=next(ROOT.glob('07-*.md'));x=f.read_text(encoding='utf-8').replace('验收与兼容缺陷','验收与缺陷修复要求')
start=x.index('## 3.');end=x.index('## 4.',start)
section='## 3. 缺陷修复要求（当前权威）\n\n用户已明确要求规划时修复已知缺陷。以下均为重建验收义务，旧失败行为不得作为兼容目标。状态为“修复已规格化、应用尚未验证”，不是当前代码已经修好。\n\n| 编号 | 问题 | 固定触发 | 必须结果 |\n|---|---|---|---|\n'
for b in contract['bugs']:section+='| '+' | '.join([b['id'],b['problem'],b['trigger'].replace('\n',' / '),b['required']])+' |\n'
section+='\n机器清单见[bugfix-contract.json](resources/v2.2/bugfix-contract.json)，执行细则见04 ALG-FIX。BUG-12消除占位误导而不扩展游戏引擎；BUG-15保证窄屏可操作，不新增未定义移动功能。\n\n'
x=x[:start]+section+x[end:];x=x.replace('沿用人物包含；地点包含分开；恰0.9不并，严格>0.9并；不同类型不合','所有名称信号只生成候选，未确认前实体数不减；无原文证据AI提交拒绝，人工确认或证据通过才融合');f.write_text(x,encoding='utf-8')
cases=json.loads((R/'acceptance-cases.json').read_text(encoding='utf-8'))
for c in cases['cases']:
    if c['id']=='AC-V22-08':c.update(title='名称信号不得直接误合并',given='张三/张三丰、同名异人、地点包含、分数0.9与>0.9',when='执行候选阶段并尝试无证据AI写入',then='实体数不因候选减少；无证据拒绝；有效原文证据或人工确认后才融合')
(R/'acceptance-cases.json').write_text(json.dumps(cases,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
subs={'file选择器accept=.txt；drop不复验后缀，无busy统一禁止':'选择与拖放统一校验单个.txt及非空内容；busy禁用','catch error字符串显示，未清旧preview':'失败显示错误并清当前预览，导入禁用；旧异步结果不得覆盖新选择','parse→await arrayBuffer→decode→split；顺序不调用模型':'递增loadToken→统一文件校验→parse/read/decode/split→仅最新token写预览；不调用模型','列表状态变化，旧详情Select回显规则同BUG-16':'成功按返回revision刷新Select；失败回滚，有dirty保留输入','await exportBook→Blob URL→a.click→立即revoke→flash→finally':'await exportBook→Blob URL→a.click→至少1000ms后revoke→提示已触发下载→finally'}
op=json.loads((R/'operation-catalog.json').read_text(encoding='utf-8'));f=next(ROOT.glob('09-*.md'));x=f.read_text(encoding='utf-8')
for a,b in subs.items():x=x.replace(a,b)
for o in op['operations']:
    for k,v in o.items():
        if isinstance(v,str):
            for a,b in subs.items():v=v.replace(a,b)
            o[k]=v
f.write_text(x,encoding='utf-8');(R/'operation-catalog.json').write_text(json.dumps(op,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
f=R/'data-flows.json';x=f.read_text(encoding='utf-8')
for a,b in replacements.items():x=x.replace(a,b)
f.write_text(x,encoding='utf-8')
print('00–13 fix-first policy, BUG matrix, operations and acceptance assertions updated')
