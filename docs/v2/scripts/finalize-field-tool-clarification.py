"""只更新本轮文档修订头及跨章入口，不修改应用。"""
from pathlib import Path
import json
ROOT=Path(__file__).resolve().parents[1]
note='| 2.2 | 2026-10-23 | 补18表完整字段与样例、16业务工具契约、Pi迁移/coding取舍与禁用能力 | 明确当前实现与目标补充；专项验收待应用执行 |'
cross={
'01':'业务对象字段的完整定义见[03第8–9节](03-Spec-数据与存储.md#8-完整逐表字段字典2026-10-23校订)。模型能执行的业务工具见11第6节；本产品不因使用Pi而获得编码Shell或任意文件访问，包与能力范围见02 AR-12。',
'04':'本文件算法所操作的持久字段必须使用03第8–9节准确命名。世界精简查询的estimatedDetailTokens及duplicateScore计算见11第6.2节；写工具的执行/提交/重放见11第6.3–6.5节；不能把Agent最终submit_result再次作为业务增量应用。',
'06':'详情表单写入字段与03第8–9节一致：profile.age/profile.ageText/profile.gender是嵌套属性，relation_label是关系中文标签；节点snake_case字段和lineStatus不得按界面中文标签另造键。工具事务确认后刷新当前实体；原始工具、错误和不可用能力见11/02 AR-12。',
'07':'字段及Pi迁移增加[12专项验收AC-PI-DOC-01–08](12-验收执行与覆盖矩阵.md#2026-10-23--字段及pi迁移专项验收)，包括空旧表迁移、配置共用、角色工具、提交后断线、混合批原子拒绝、分页超限、同会话恢复和coding能力隔离。八项均未执行目标应用，不计入历史通过数。',
'09':'本文件操作中的字段名和默认值以03第8–9节逐表规范为准；Agent工具参数、返回和错误以11第6节为准。UI文件导入/导出不等同于向Agent开放宿主read/write工具；02 AR-12列明这种边界。',
'10':'本文件读写表编号与03第8–9节一致；记忆事项revision沿用本批摘要revision（不是每条笔记各自+1），实体revision按本行修改递增。DTO line_status→持久lineStatus、speech_style_sample→speechStyleSample；mergeFacts[].chapters保留准确键名。受控工具事务与T20凭据写入次序见11第6节。',
}
for file in sorted(ROOT.glob('[0-1][0-9]-*.md')):
    text=file.read_text(encoding='utf-8')
    text=text.replace('2026-10-21 / 2026-10-22（Asia/Shanghai）','2026-10-21 / 2026-10-23（Asia/Shanghai）')
    if file.name.startswith('13-'):
        text=text.replace('2.2 / 2026-10-22（Asia/Shanghai）','2.2 / 2026-10-23（Asia/Shanghai）')
    elif note not in text:
        lines=text.splitlines(); idx=next(i for i,line in enumerate(lines) if line=='### 修订记录'); end=idx+1
        while end<len(lines) and not lines[end].startswith('|'): end+=1
        while end<len(lines) and lines[end].startswith('|'): end+=1
        lines.insert(end,note); text='\n'.join(lines)+'\n'
    key=file.name[:2]
    if key in cross and '## 2026-10-23 · 字段与工具契约对接' not in text:
        text+='\n## 2026-10-23 · 字段与工具契约对接\n\n'+cross[key]+'\n'
    if key=='03':
        text=text.replace('profile.age / gender / ageText','profile.age / profile.gender / profile.ageText')
        text=text.replace('### 3.1 公共元数据\n','### 3.1 公共元数据\n\n本表是跨实体字段汇总，不表示每个实体携带全部字段；各表是否存在/必填以第8节为准。节点不新增updatedAt，人物/地点才携带sourceChapters。\n') if '本表是跨实体字段汇总' not in text else text
    file.write_text(text,encoding='utf-8')
# 公用运行契约指向实际的包/能力边界，不再只列架构口号。
p=ROOT/'resources/v2.2/ai-runtime-contract.json'
runtime=json.loads(p.read_text(encoding='utf-8'))
runtime['packageBoundary']={'retain':{'@earendil-works/pi-ai':'1.0.2','@earendil-works/pi-agent-core':'1.0.2'},'codingLayer':'not-a-web-runtime-dependency','excludedCapabilities':['host-shell','arbitrary-host-file-read-write-edit','coding-cli-tui','coding-file-session-store','automatic-mcp-or-extension-loading'],'migrationSpecification':'../../02-架构与技术规格.md#ar-12-pi接入coding包取舍与迁移顺序','status':'target-not-implemented'}
p.write_text(json.dumps(runtime,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print('updated 00-13 revision headers and cross-document ownership')
