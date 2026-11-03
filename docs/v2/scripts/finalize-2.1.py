from pathlib import Path
import json,re,hashlib
OUT=Path(__file__).resolve().parent.parent
def append_once(file,marker,text):
 p=OUT/file;s=p.read_text(encoding='utf-8')
 if marker not in s:p.write_text(s.rstrip()+'\n\n'+text.strip()+'\n',encoding='utf-8')

for p in OUT.glob('[0-9][0-9]-*.md'):
 text=p.read_text(encoding='utf-8').replace('| 文档版本 | 2.0 |','| 文档版本 | 2.1 |')
 if '| 2.1 | 2026-10-21 |' not in text and '| 2.0 | 2026-10-21 |'in text:
  lines=text.splitlines();at=next(i for i,l in enumerate(lines)if l.startswith('| 2.0 | 2026-10-21 |'))
  lines.insert(at+1,'| 2.1 | 2026-10-21 | 补17张实际表、60组UI动作、14字段流、完整工具返回及独立验收 | 保留应用与兼容行为 |')
  text='\n'.join(lines)+'\n'
 text=text.replace('参数初值属于契约','参数初值属于契约')
 p.write_text(text,encoding='utf-8')

index=OUT/'00-阅读入口与术语.md'
text=index.read_text(encoding='utf-8')
if '[09-操作与自动触发契约]'not in text:
 marker='| [08-追溯与验证记录](08-追溯与验证记录.md) | 实现来源、版本哈希、执行结果和验证限制 |'
 text=text.replace(marker,marker+'\n| [09-操作与自动触发契约](09-操作与自动触发契约.md) | 60组UI动作和14自动触发的参数、读写、反馈、恢复 |\n| [10-字段级数据流与状态转移](10-字段级数据流与状态转移.md) | 14核心流、20状态转移、具体输入前后值 |\n| [11-AI工具返回与回放契约](11-AI工具返回与回放契约.md) | 13工具完整输出、错误及命名消息/回放 |\n| [12-验收执行与覆盖矩阵](12-验收执行与覆盖矩阵.md) | 45独立场景入口、表/字段/操作对账与具体验证范围 |')
 text=text.replace('一个关键参数','一个关键参数')
text=text.replace('重建者无需访问原仓库，即可从本目录获得约束、契约、有效 Prompt、配置与样本。','本目录提供独立重建所需的约束、契约、有效Prompt、配置与样本；契约覆盖与实际验证状态按12逐项区分，不宣称已经实现第二个应用。')
index.write_text(text,encoding='utf-8')
append_once('00-阅读入口与术语.md','## 4. 2.1交付与入口', '''## 4. 2.1交付与入口

实际存储为3张全局表+每书14张表，共17种定义，N本书通常3+14N实例。请先读03逐表规格，再用09查看具体UI操作，用10追数据如何流转；52个Schema不是表数。

独立验收：[适配器协议](acceptance/adapter-contract.md)，运行`node acceptance/suite.mjs --adapter /absolute/path/rebuilt-adapter.mjs`。断言不导入原业务实现；51场景连接参考应用已通过，但未创建第二个应用或完成全部UI差分。

可编译结构类型为`resources/contracts.d.ts`，旧internal-contracts为只读摘录。实际表/字段及例子在`storage-inventory.json`、`field-coverage.json`、`table-examples/`；操作与数据流在`operation-catalog.json`、`data-flows.json`、`state-transitions.json`；完整工具输出在`tool-results.schema.json`、`tool-response-examples.json`。

所有资源须随文件夹交付。历史write-*脚本仅生成2.0，不能用来覆盖2.1；2.1对应complete-*与finalize-2.1脚本。''')

p=OUT/'01-PRD.md';text=p.read_text(encoding='utf-8')
if '### 1.3 业务数据与表数量'not in text:
 marker='## 2. 用户、权限与数据边界'
 block='''### 1.3 业务数据与表数量

系统必须使用1个全局设置库（3表：credentials凭据、appSettings配置、books书架），以及每书1个资产库（14表）：chapters章节、chapterTexts原文、characterSnapshots人物草稿、locationSnapshots地点草稿、nodes事件节点、eventLines事件线、characters当前人物实体、locations当前地点实体、compileProgress进度、storyEditorMemory工作摘要、storyEditorNotes判断事项、storyEditorCheckpoints批次恢复点、storySessions会话头、storySessionEntries原始条目。

合计17种实际表定义；N本书通常产生3+14N张实例表。逐表字段、默认/缺省、来源、更新、读写生命周期及例子见[03](03-Spec-数据与存储.md)。临时模型结果、图视图和UI内存状态不另计表，也不得偷偷持久化为新产品能力。

每个UI动作的完整链路见[09](09-操作与自动触发契约.md)，字段变换/跨表时序见[10](10-字段级数据流与状态转移.md)。实现必须遵守这些调用、写入和反馈约定，不能仅凭“支持编辑/入库”等功能名补设计。

'''
 text=text.replace(marker,block+marker)
p.write_text(text,encoding='utf-8')
append_once('02-架构与技术规格.md','## AR-10 逐表与触发链规范','''## AR-10 逐表与触发链规范

系统具体有17种表定义：设置3表，单书14表。每实例范围、字段、索引、写入/读取消费者及删除/迁移见03；不得以Schema导出代替建库设计。核心跨层执行和原子边界以10的14个字段流为准，UI/非UI触发以09为准。结构类型已整理为可独立编译的contracts.d.ts，原函数签名摘录不要求直接编译。''')
append_once('05-Spec-AI与会话.md','## AI-09 补齐输出与回放','''## AI-09 补齐输出与回放

13个工具的成功/空/错误/截断返回形状、真实前置记录与响应见[11](11-AI工具返回与回放契约.md)。原有tool-contracts仅记录声明；不能据其10个无returns项省略说明，也不能在运行时擅自给全部工具新增校验。

具名模板、变量绑定和组装表在11；原始ai-message-templates仅精确字面补充。6份完整HTTP录制与服务级失败/恢复用例共同覆盖本包实际验证范围；独立验收入口与未覆盖时序见12。''')
append_once('06-界面与交互规格.md','## 3. 2.1操作与画面清单','''## 3. 2.1操作与画面清单

本文件规定页面结构和视觉；[09](09-操作与自动触发契约.md)逐动作规定输入、守卫、读写与反馈，[10](10-字段级数据流与状态转移.md)给具体事务与数据前后结果。不能用样式目录代替动作逻辑。

| 参考图 | 页面/状态 | 前置与验证 |
|---|---|---|
| [04](resources/screenshots/04-import-empty.jpg) | 空书架/导入 | 新5274来源，无Key与书 |
| [05](resources/screenshots/05-settings-default.jpg) | 默认设置 | 无Key，默认模型/并发 |
| [06](resources/screenshots/06-backup-preview.jpg) | 备份校验预览 | 人工包，3章/0固定人物地点/4节点2线 |
| [07](resources/screenshots/07-workspace-draft.jpg) | 草稿工作台 | 人工恢复3人2地4点2线，P3标记人工 |
| [08](resources/screenshots/08-location-editor.jpg) | 地点详情 | 码头，名称/别名/描述 |
| [09](resources/screenshots/09-line-editor.jpg) | 事件线详情 | 书信交付，起因/经过/结果/状态 |
| [10](resources/screenshots/10-memory-empty.jpg) | 工作记忆空态 | 无摘要和notes |
| [11](resources/screenshots/11-export-dialog.jpg) | 导出确认 | 仅打开，不授权新目录 |
| [12](resources/screenshots/12-delete-confirm.jpg) | 删除确认 | 取消，不执行删除 |
| [13](resources/screenshots/13-import-error.jpg) | 无效正则 | 输入(后应用，错误提示 |
| [14](resources/screenshots/14-chapter-preview.jpg) | 正常分章预览 | 人工3章TXT；不启动提取 |
| [15](resources/screenshots/15-node-editor.jpg) | 节点详情 | 交付书信，完整字段 |
| [16](resources/screenshots/16-try-one-idle.jpg) | 试跑未启动 | 弹窗可见，没有模型请求 |
| [17](resources/screenshots/17-history-empty.jpg) | 原始历史空态 | 无原始会话，不伪造历史 |

这些图与原01/02/03合计17张，均桌面参考；真实异步加载/模型失败/非空记忆/窄屏矩阵未全部运行截图，以对应结构与状态规定实现，验证状态不能由空态图冒充。BUG-16本轮通过实际选择已确认：列表层级变更，当前详情仍旧值；证据见ui-role-change.txt。''')
append_once('07-验收与兼容缺陷.md','## 6. 2.1可执行验收入口','''## 6. 2.1可执行验收入口

本包新增[独立执行与覆盖矩阵](12-验收执行与覆盖矩阵.md)，其中51个固定输入/预期场景已连接参考应用运行。文字验收与可执行场景不是1:1等价，每条的实际覆盖和人工部分以该矩阵为准。

| 新增编号 | 前置/操作 | 必须结果 | 对应 |
|---|---|---|---|
| AC-37 | 2节点/合法limit、非法limit、缺ID详情 | 分页/空/INVALID_ARGS结构准确 | P15/P16 |
| AC-38 | 固定工具seed，对13工具成功/非法参数 | 响应JSON与预先冻结记录一致 | T01–T13 |
| AC-39 | 结构类型contracts.d.ts，TypeScript6 | 不依赖原业务类型文件可编译 | 独立类型编译 |

AC-04的10001字符长章现已具备P02真实输入和对应黄金分块结果；不能再用短章样例代替。BUG-16已获本轮UI运行证据，旧“静态兼容缺陷”标签仅描述2.0验证阶段，兼容结果不变。
''')
append_once('08-追溯与验证记录.md','## 8. 2.1本轮验证','''## 8. 2.1本轮验证

- 原基线143个源码/配置/锁/素材重新核对无变化，业务代码未修改，未参考旧PRD/ADR补规则。
- 新增03逐17表文档、09的60组UI/14自动动作、10的14流/20状态、11完整工具返回与回放、12独立执行及覆盖矩阵。
- 验收suite不导入原实现；51场景经原边界适配全部通过。13个工具成功返回由一次录制后冻结，验证时不重新计算预期。baseline adapter仅参考连接器，不是新应用。
- 6份HTTP/SSE回放为本轮拦截真实SDK产生；没有实际向外部模型发送请求。P1/串联/压缩场景使用受控响应。
- contracts.d.ts已用TypeScript6独立编译通过。旧internal-contracts摘录不宣称可直接编译。
- 本轮新采14张页面状态图，合计17张；BUG-16从静态提升为UI确认，实际DOM见[ui-role-change](evidence/ui-role-change.txt)。
- 旧325项原应用测试通过日志仍只作为原基线记录；本轮51场景的结果见[portable-baseline-results](evidence/portable-baseline-results.json)和[日志](evidence/portable-baseline.log)。不混用计数。
- 结构/引用检查与语义审阅分开；语义状态和具体未覆盖路径见12，不沿用旧“章节齐全即通过”的结论。未开发第二应用，独立重建验证仍未执行。

当前package-validation只记录机械对账；evidence/semantic-coverage-review单独记契约覆盖，真实重建状态为未执行。
''')
(OUT/'evidence/spec-quality-review.md').write_text('''# 2.1规格质量审阅入口

上一版按章节判断的通过结论已被替换。请阅读[语义覆盖审阅](semantic-coverage-review.md)及[正式覆盖矩阵](../12-验收执行与覆盖矩阵.md)。

机械检查只证明计数、资源/引用/Schema、样本对应和源码未变化。51个固定场景证明参考边界满足所列预期；未覆盖的UI时序、真实服务和独立第二应用不得标通过。
''',encoding='utf-8')
print('Updated formal documents to 2.1 and linked closed-loop specifications.')
