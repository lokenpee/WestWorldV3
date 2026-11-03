from pathlib import Path
import json,hashlib,subprocess,shutil,runpy

OUT=Path(__file__).resolve().parent.parent
ROOT=OUT.parents[2]
write=runpy.run_path(str(Path(__file__).with_name('write-specifications.py')))['write']
old=ROOT/'docs/reverse-prd/evidence'
refs=json.loads((old/'source-references.json').read_text(encoding='utf-8'))
extra=[('E36','app/src/features/assets/AssetsPanel.tsx','asset={selected}'),('E36','app/src/features/assets/AssetDetail.tsx',"value={asset.item.roleWeight ?? 'NPC'}"),('E36','app/src/features/assets/AssetDetail.tsx','value={asset.item.lineStatus}'),('E37','app/src/core/pipeline/asset-merge-policy.ts','config.allowContainment !== false'),('E38','app/src/features/store/compile-store.ts','applyEvent: (e)'),('E39','app/src/core/llm/models.ts','cacheKey(cfg: LlmConfig)')]
for eid,p,pattern in extra:
 lines=(ROOT/p).read_text(encoding='utf-8-sig').splitlines()
 n=next(i for i,s in enumerate(lines,1) if pattern in s)
 refs.append(dict(evidence=eid,path=p,line=n,pattern=pattern))
for item in refs:assert item['pattern'] in (ROOT/item['path']).read_text(encoding='utf-8-sig').splitlines()[item['line']-1]
(OUT/'evidence/source-references.json').write_text(json.dumps(refs,ensure_ascii=False,indent=2),encoding='utf-8')
for name in ['ui-network.txt','ui-editor.txt','ui-memory.txt','ui-play.txt','ui-play-after-switch.txt','ui-export-check.json']:
 shutil.copy2(old/name,OUT/'evidence'/name)
paths=sorted(set([p for p in (ROOT/'app/src').rglob('*') if p.is_file()]+[p for p in (ROOT/'app/tests').rglob('*') if p.is_file()]+[ROOT/'app'/n for n in ['package.json','pnpm-lock.yaml','vite.config.ts','tsconfig.json','tsconfig.app.json','tsconfig.node.json','eslint.config.js','index.html']]+list((ROOT/'app/public').glob('*'))))
baseline={'id':'WWV2-WORKTREE-20261021','date':'2026-10-21','timezone':'Asia/Shanghai','branch':subprocess.check_output(['git','branch','--show-current'],cwd=ROOT,text=True).strip(),'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'mode':'working-files-including-uncommitted','files':[{'path':p.relative_to(ROOT).as_posix(),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in paths if p.is_file()]}
(OUT/'evidence/baseline.json').write_text(json.dumps(baseline,ensure_ascii=False,indent=2),encoding='utf-8')
oldbase=json.loads((old/'source-baseline.json').read_text(encoding='utf-8'))
unchanged=all(hashlib.sha256((ROOT/r['path']).read_bytes()).hexdigest()==r['sha256'] for r in oldbase['files'])
mapping=[('FR-01','UI-01/02、ALG-11','E01,E17,E29,E38','AC-01/36'),('FR-02','UI-03、ALG-01、DATA-02','E04,E05,E06','AC-02/03/04/05'),('FR-03','UI-09、AR-05、AI-01/05','E02,E03,E25,E39','AC-06/07/35'),('FR-04','ALG-02、AI-02/03','E08,E35','AC-08/09'),('FR-05','ALG-03/11、AR-06/07','E07,E13,E16','AC-10/11/34'),('FR-06','UI-04/08、ALG-03','E14,E15','AC-12/13'),('FR-07','ALG-04/05、AI-02','E09,E10,E11,E13,E37','AC-14/15/16/17'),('FR-08','ALG-06、AI-06/07','E12,E13,E24','AC-18/19'),('FR-09','UI-05、ALG-07','E17,E18,E32,E36','AC-20/21/22'),('FR-10','ALG-08、DATA-03','E19','AC-23/24'),('FR-11','UI-06、ALG-09','E20','AC-25'),('FR-12','UI-07、AI-07/08','E21,E22,E23','AC-26/27/28'),('FR-13','ALG-10、DATA-05、UI-02/09','E26,E27,E28,E29','AC-29/30/31/32'),('FR-14','UI-10','E31','AC-33')]
body=f'''
## 1. 基线与取证边界

- 实际仓库：`E:\\WestWorldV2`；分支`{baseline['branch']}`；HEAD`{baseline['head']}`，工作区含原有未提交和未跟踪业务代码。
- [baseline.json](evidence/baseline.json)包含{len(baseline['files'])}个源码、测试、锁、构建配置和素材哈希；不得只检出HEAD宣称复现同一基线。
- 上一轮记录的135个源码/测试/配置文件本轮重新比对：{'全部相同' if unchanged else '存在变化'}。正文依据代码、接口、Schema及UI，不依赖旧PRD/ADR/背景/计划。
- 本轮以正式重建规格重新组织；不把上一版调查型PRD作为产品权威来源。保留的上一轮UI观察通过相同源码哈希确认适用。
- 本轮执行契约提取及校验，未运行真实模型、未读取真实Key，未更改产品代码或用户小说。

## 2. 验证记录

| 验证 | 结果 | 限制 |
|---|---|---|
| skill quick_validate.py | 通过，Python UTF-8模式 | 结构检查，不证明行为完整 |
| 本轮 `pnpm test` | 39个文件、325项通过；[原始日志](evidence/vitest-current.txt) | 使用fake-indexeddb、HTTP/模型替身；未执行scripts/live-pipeline |
| 导出契约与原Schema比对 | 52项一致；[结果](evidence/contract-validation.json) | 参数与结构一致，不保证所有文档语义无误 |
| 两个备份样本Schema | 共39行验证通过 | 人工P3状态不是模型运行证明 |
| 黄金输出 | 3组分章、2组相似度、事件图一致 | 小样本确定性输出，不是完整应用重建 |
| 上轮UI观察复用 | 同源码基线：导入、错正则、刷新、编辑、入库、图、导出、占位 | 本轮不将旧运行冒充新运行；有内容记忆与真实模型仍为静态/模拟证据 |

现有测试会写出自身`exports/本地导出回归演示.wwv2`和node_modules/.tmp临时文件；不是用户小说处理结果。曾误建`app/docs/reverse-prd/v2/`下空目录，自动审批拒绝清理后保留；实际文档在本目录，业务源码未变化。

### 2.1 独立重建状态

本轮完成的是规格与资源包，没有在空白工程中实现第二个应用。故不宣称“已验证任何AI均可100%复现”。未验证项包括真实模型质量/服务兼容、无Key本地服务、多浏览器/窄屏矩阵、配额耗尽、多标签压力与全部畸形备份路径。BUG-16为静态数据流支持，尚未单独浏览器复现。

## 3. 需求到实现与验收映射

| 需求 | 规格 | 实现证据组 | 验收 |
|---|---|---|---|
'''
for row in mapping:body+='| '+' | '.join(row)+' |\n'
body+='\n## 4. 源码证据索引\n\n证据类型：静态表示可达调用和数据流核对；运行表示实际UI/文件；测试表示本轮配置测试集通过。下面的路径仅用于追溯，不是重建者必需阅读的实现说明。\n\n'
for eid in dict.fromkeys(r['evidence'] for r in refs):
 body+=f'### {eid}\n\n'
 for item in [r for r in refs if r['evidence']==eid]:
  body+=f"- [{item['path']}:{item['line']}](../../../{item['path']}) — `{item['pattern']}`。\n"
 body+='\n'
body+=r'''
## 5. 可复查UI记录

| UI流程 | 保存材料 | 结果 / 可信边界 |
|---|---|---|
| 导入3章、错正则、仅导入后刷新 | resources/fixtures中的TXT；过程工具记录 | 运行观察；无独立新截图，不补造 |
| 人工备份新书恢复 | 人工资产样本.wwv2 | 草稿3人2地点4节点2线；完成标记人工设置 |
| 人物身份/ageText保存、刷新 | [DOM](evidence/ui-editor.txt)、[截图](resources/screenshots/02-editor-after-reload.jpg) | 修改与入库状态保留 |
| 图中共享/散落点与节点详情 | [DOM](evidence/ui-network.txt)、[截图](resources/screenshots/01-network.jpg) | 4节点1散落、1共有2线 |
| 记忆空历史 | [DOM](evidence/ui-memory.txt) | 0条真实会话，不证明模型已生成记忆 |
| UI实际下载 | [包](resources/fixtures/UI导出结果.wwv2)、[校验](evidence/ui-export-check.json) | checksum、保存字段、人物实体和引用存在 |
| 游玩发送与切页 | [发送DOM](evidence/ui-play.txt)、[切页DOM](evidence/ui-play-after-switch.txt)、[截图](resources/screenshots/03-play-placeholder.jpg) | 固定回复、切离清空；无模型或世界状态写入 |

## 6. 资源和接口覆盖

资源包含52个Schema（含兼容/非当前生效声明，必须以AI调用映射决定使用）、资产整理8工具/故事编辑13工具、82个模块公开类型与签名、14个UI模块属性/文案、7个有效Prompt、实际依赖锁与配置、图标、人工与实际导出样本。

内部契约导出包含未用于当前UI的历史辅助函数，例如旧共享人物关系图与旧融合Schema。这是结构追溯覆盖，不是要求恢复新的用户入口；PRD范围、有效Prompt表和当前图算法优先决定可达行为。

## 7. 维护和检查

1. 原仓库更新后重新固定基线，按脚本导出契约；Prompt加载器之外的`03`旧模板不随新流程自动生效。
2. 数据字典由schemas.json展开；补充字段来源不能改变结构。算法/AI/UI正文由人工维护。
3. 使用[包验证脚本](scripts/validate-package.py)核对链接、编号、资源checksum、字段覆盖及源文件不变；使用verify-contracts.ts核对原Schema和样本。
4. [质量检查记录](evidence/spec-quality-review.md)对应PRD七维检查；这是文档自检，不是独立第三方审计。
5. 修复BUG或新增玩法须提高新基线版本并重新验收，不覆盖本包兼容约定。
'''
write('08-追溯与验证记录.md',body)
review='''# 规格包质量检查

检查对象：v2内正式PRD、架构、数据/流程/AI Spec、UI、验收及资源。方法：按prd-review七维检查，结合独立重建所需契约。状态为文档自检，不是产品发布批准。

| 维度/子项 | 状态 | 证据与结论 |
|---|---|---|
| 业务起止与异常 | 通过 | PRD FR-01–14；ALG-01–11含失败、取消、重载和恢复 |
| 状态机与终态 | 通过 | PRD§5 Mermaid；DATA枚举；区分runtime与持久、testScope |
| 数据一致性/补偿 | 通过 | AR-06/07、ALG-06、DATA-05；明确原有非原子和弱锁，不伪造补偿 |
| ER关系 | 通过 | DATA-01 ER图；标明业务引用而非外键 |
| 字段、枚举、默认与来源 | 通过 | DATA-06完整565行展开，52个机器Schema；默认缺省与执行校验分离 |
| 查询/列表/按钮/表单 | 通过 | UI-02–09及完整控件属性资源；明确列表无分页/搜索的现状 |
| 组件类型与布局 | 通过 | UI公共tokens及逐页规定，className/尺寸资源 |
| 空态/加载/错误态 | 通过 | UI-03–10；未实现的统一错误态不新增；异常分支保留 |
| 权限矩阵与字段可见性 | 通过 | PRD§2；AR-04/05；明文凭据和本地范围，未虚构租户权限 |
| 审计留痕 | 部分满足（基线限制） | AI消息/提交/日志已定义，原应用无统一字段前后值审计；不新增该能力 |
| 系统职责与数据归属 | 通过 | AR-01/03/04系统图与模块表 |
| 接口同步异步/幂等/重试/失败 | 通过 | 内部契约、ALG、AI-03–05；无虚构REST服务 |
| 主档头/修订/术语/范围 | 通过 | 全文档控制头，统一入口术语，PRD目标和范围 |
| 成功指标 | 通过（按复现目标） | 确定性重建验收；商业和模型质量指标未由用户定义，不编造 |
| 附件与引用 | 通过（机械检查另见报告） | 数据、UI、API/规则由相关Spec承载，不以固定A/B文件名判断 |
| 语言和口吻 | 通过 | 正文写规范，调查记录放TRACE；原资源描述保持来源但不提升为行为保证 |
| 流程/状态/数据可视化 | 通过 | PRD流程与状态图、AR系统/时序、DATA ER |
| 完整独立重建实测 | 待确认/未执行 | 本次不构建第二个应用；不报告100%复现成功 |
| 真实模型/多环境质量 | 待确认/未执行 | 外部服务和环境依赖，验收规则存在但未触网实测 |

## 修订闭环

- 已将调查型口吻移出PRD；补足正式文档控制、术语、修订、范围和关联。
- 已补完整数据Schema、字段来源、工具契约、有效Prompt、消息模板、布局及独立禁用条件。
- 已保留16项兼容缺陷/边界，不用理想业务规则覆盖它们；BUG-16仅静态核实，标明未UI重现。
- 已提供36项功能/接口验收和黄金样本，明确文档完成不等于独立应用重建完成。

## 剩余事项

P1（验证范围）：未执行真正空白工程重建与全功能差分验收。需要后续独立实现任务，不通过修改文档状态伪装完成。

P2（外部条件）：模型服务、字体/原生控件、目录授权、多浏览器和存储压力验证尚未执行；文档中已限定。

本检查不要求为单用户应用增加RBAC、审批、服务端、全量审计或预算硬停止。未来如需修正兼容行为，应单独立项。
'''
(OUT/'evidence/spec-quality-review.md').write_text(review,encoding='utf-8')
print(f'Wrote traceability with {len(refs)} source locations; baseline {len(baseline["files"])} files.')
