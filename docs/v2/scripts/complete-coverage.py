from pathlib import Path
import json,re,importlib.util
OUT=Path(__file__).resolve().parent.parent
sp=importlib.util.spec_from_file_location('m',Path(__file__).with_name('complete-spec.py'));m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m)

def load(n):return json.loads((OUT/n).read_text(encoding='utf-8'))
def refs(text):
 for a,b in re.findall(r'T(\d{2})[–—-](?:T)?(\d{2})',text):text+=' '+','.join('T'+str(i).zfill(2)for i in range(int(a),int(b)+1))
 return set(re.findall(r'T\d{2}',text))
def make():
 inv=load('resources/storage-inventory.json');ops=load('resources/operation-catalog.json');flows=load('resources/data-flows.json');autos=load('resources/automatic-triggers.json');cases=load('acceptance/cases.json');result=load('evidence/portable-baseline-results.json')
 definitions=load('resources/acceptance-cases.json');schemas=load('resources/schemas.json')
 source_ui=load('resources/ui-copy-and-styles.json')
 module_ops={
 'features/app-shell/AppShell.tsx':['OP-01','AUTO-01'],
 'features/import/ImportPanel.tsx':['OP-04','OP-05','OP-06','OP-07','OP-08','OP-09','OP-10'],
 'features/assets/BookSidebar.tsx':['OP-02','OP-03','OP-52','OP-53','OP-54','OP-55','OP-56','OP-57','OP-58','AUTO-09'],
 'features/assets/AssetsPanel.tsx':['OP-02','OP-03','OP-11','OP-12','OP-13','OP-23','OP-24','OP-25','OP-27','OP-30','OP-31','OP-32','OP-60','AUTO-02','AUTO-04'],
 'features/assets/AssetDetail.tsx':['OP-14','OP-15','OP-16','OP-17','OP-18','OP-19','OP-20','OP-21','OP-22','OP-26','AUTO-05'],
 'features/assets/AssetFields.tsx':['OP-26'],
 'features/compile/CompilePanel.tsx':['OP-29','AUTO-06'],
 'features/compile/StageTestPanel.tsx':['OP-28'],
 'features/assets/TryOnePanel.tsx':['OP-32','OP-33','OP-26'],
 'features/network/NetworkPanel.tsx':['OP-34','OP-35','OP-60','AUTO-11'],
 'features/assets/EditorMemoryPanel.tsx':['OP-36','OP-37','OP-38','AUTO-14'],
 'features/assets/SessionHistory.tsx':['OP-26','OP-39'],
 'features/settings/SettingsPanel.tsx':['OP-40','OP-41','OP-42','OP-43','OP-44','OP-45','OP-46','OP-47','OP-48','OP-49','OP-50','OP-51','AUTO-08','AUTO-10'],
 'features/play/PlayPanel.tsx':['OP-01','OP-59','AUTO-07'],
 }
 checkids={x['id']for x in ops}|{x['id']for x in autos}
 for name in source_ui:
  assert name in module_ops,name
  assert set(module_ops[name])<=checkids
 rows=[]
 for t in inv['tables']:
  tid=t['id'];rw=[]
  for o in ops:
   if tid in refs(';'.join(o['reads']+o['writes'])):rw.append(o['id'])
  ff=[f['id']for f in flows if tid in refs(json.dumps(f,ensure_ascii=False))]
  rows.append({'table':tid,'name':t['name'],'operations':rw,'flows':ff,'fields':len(t['fields']),'spec':'03-Spec-数据与存储.md','documentation':'逐表字段、生命周期和例子已说明','validation':'执行用例覆盖部分路径；其余源调用链审阅'})
 semantic=[
 ('库表数量','已明确','3全局+14每书=17表定义，N本书3+14N实例；配置/凭据不是遗漏的Schema外对象'),
 ('逐表字段与生命周期','已说明','17表独立章节与例子；字段来源/更新按表分开，DTO另放附录；是否实际读写仍以调用映射核对'),
 ('UI与自动触发','已说明','60组动作、14自动触发；原14个UI模块对账，不把class数组当执行逻辑'),
 ('字段级流转','已说明','14流、20状态转移，独立列事务/失败残留和输入前后值；不承诺全流程原子'),
 ('工具入参与返回','已补齐','13个成功形状/错误分支和真实样例；原运行仅3个返回校验保持'),
 ('AI回放','部分运行验证','6完整HTTP回放（含真实P1/P2任务）+服务级部分失败/压缩样例；真实限流时序和所有动态Prompt组合未自动逐一回放'),
 ('UI画面','部分运行验证','17张参考画面；本轮新增默认/预览/错误/地点/线/节点/空记忆/弹窗/试跑空态；真实模型加载/失败态仅源码规格'),
 ('独立验收入口','已可执行','suite只读固定cases；所列场景接原边界全过，13工具预期为一次录制后冻结；原实现不在suite依赖中'),
 ('契约可编译','已验证','新contracts.d.ts独立编译；旧internal-contracts只读材料，不能冒充SDK'),
 ('实际第二应用重建','未执行','不声称任意AI已能100%复现；需重建自己的adapter再运行并对比UI'),
 ]
 body=f'''## 1. 验收执行方式

将本目录整体交给重建者；无需读取原业务源码。按照[适配器协议](acceptance/adapter-contract.md)连接重建能力，然后执行：

```text
node acceptance/suite.mjs --adapter /absolute/path/rebuilt-adapter.mjs
```

suite内不导入原实现，读取静态cases.json并比较实际返回和持久状态。`evidence/baseline.adapter.ts`是原应用的验证连接器，不能作为重建应用或自己的预期计算器。`scripts/verify-contracts.ts`仅原资源对账，不能称为独立重建验证。

本包有 **{len(cases)} 个可执行场景**，包括38个服务/数据/协议场景及13个工具完整成功/非法参数场景；本轮接原应用结果 **{result['passed']}通过/{result['failed']}失败**。Vitest外层按两组测试汇总，不要将其“2个测试”或原套件325项与此51个场景混淆。

场景输入、步骤、固定预期和随机引用连接在[acceptance/cases.json](acceptance/cases.json)。所有预期预先存储，不在断言时用原函数计算。13个工具样例来自参考应用一次录制后冻结；完整HTTP回放在resources/replays。Node原生断言抛错时给出case/step/path。

## 2. 库表、字段与操作对账

字段条数包括嵌套和联合分支，不当作不同物理字段总数。本文用表定义和实际使用位置对账，不用52个Schema宣布数据完整。

| 表 | 名称 | 字段说明条目 | 相关UI动作 | 字段流 | 文档/验证 |
|---|---|---|---|---|---|
'''
 for row in rows:body+=f"| {row['table']} | {row['name']} | {row['fields']} | {','.join(row['operations'])or'主要由自动任务读写'} | {','.join(row['flows'])} | 逐表规格已说明；部分路径运行，其余静态 |\n"
 body+='\n## 3. UI源模块到操作清单\n\n该表按相同基线源模块对账，操作正文完全在09中；源路径仅追溯，不要求第三方回读。组件内的原生details等无显式事件也由对应动作规定。\n\n| UI模块 | 操作/自动触发 | 原始显式事件绑定数量 |\n|---|---|---|\n'
 for name,resource in source_ui.items():
  count=sum(len(c['events'])for c in resource.get('controls',[]))
  body+='| '+name+' | '+','.join(module_ops[name])+f' | {count}（分组不等于控件数） |\n'
 body+='\n## 4. 原验收清单到可执行场景\n\n一个文字验收可能有多项条件；链接用例只证明其实际断言覆盖的子路径，不把同编号视为全部条件已自动验收。UI交互条件需同时按06/09和画面操作核对。\n\n| 原验收 | 可执行场景 | 补充验证状态 |\n|---|---|---|\n'
 for d in definitions:
  ids=[c['id']for c in cases if c['requirement']==d['id'] or (d['id']=='AC-38'and c['id'].startswith('T'))]
  state='仅对应服务/数据断言已运行；UI条件按操作验收'if ids else'已有操作/算法规格；本包未为该整条生成独立自动断言，须人工/后续适配验收'
  body+=f"| {d['id']} | {','.join(ids)or'无'} | {state} |\n"
 body+='\n## 5. 语义审阅与剩余范围\n\n| 维度 | 状态 | 具体结论 |\n|---|---|---|\n'
 for row in semantic:body+='| '+' | '.join(row)+' |\n'
 body+='''
### 还不能声称已验证的范围

1. 未从空白工程实现第二应用，未进行全页面像素/交互差分；51个参考边界通过不能替代该验证。
2. 全部浏览器关闭时点、多标签竞争、存储满、真实服务限流与长篇模型质量没有完整自动回放；规则和现有缺陷保持，但验证状态不得写成通过。
3. 有内容编辑记忆、异步加载/失败态的布局以源码与操作规范说明；空记忆截图不能作为这些状态已运行的证据。
4. 为维护规格而保留的旧write-*脚本会生成2.0内容，属于历史工具；当前2.1以complete-*和本包文档为准，不应一键运行旧脚本覆盖新版。

这些是验证范围和外部条件，不是把可补的字段/操作遗漏无限延期。任何重建过程中必须回原源码才能回答的必要问题，仍应登记并修订本包，不能自行猜值后宣称一致。
'''
 m.write('12-验收执行与覆盖矩阵.md','WW-COVERAGE','独立验收执行与覆盖矩阵',body)
 m.dump('resources/coverage-matrix.json',{'tables':rows,'uiModules':module_ops,'semantics':[dict(zip(['area','status','conclusion'],r))for r in semantic]})
 (OUT/'evidence/semantic-coverage-review.md').write_text(body.replace('](acceptance/','](../acceptance/'),encoding='utf-8')
 print(f'{len(rows)} table rows; {len(source_ui)} UI modules reconciled; {len(cases)} runnable scenarios')
if __name__=='__main__':make()
