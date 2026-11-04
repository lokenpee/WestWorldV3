# BUG-21 只读排查证据

取证日期：2026-11-04；代码基线：b408b91（v0.3.0）；工作目录：D:/mic/WestWorldV3。排查没有写入用户浏览器原库、修改备份或恢复旧stash。

## 用户现象与已确认原因

书名《红楼之挽天test》，用户描述于2026/10/31导入。开书显示：

```text
无法读取本书资料
Cannot read properties of undefined (reading 'trim')
重新读取资料
```

BookOverview读取getBookSummary，后者打开单书库；新版BookDatabase.ready调用repairRelationBindings。它把所有characterRelations当成当前结构交给syncRelations；characterNameHits读取targetName.trim()。历史left/right行没有targetName，故抛错并使书籍概览读取失败。

代码入口：[BookOverview](../../../src/features/books/BookOverview.tsx)、[workspace](../../../src/lib/storage/workspace.ts)、[repair](../../../src/features/assets/repair.ts)、[relations](../../../src/features/assets/relations.ts)、[备份预检](../../../src/features/backup/codec.ts)。

## 版本追溯

| 时间（北京时间） | Git对象 | 内容及影响 |
|---|---|---|
| 2026-11-03 20:35:49 | 46076e0 | v0.2.0，当前独立关系事实结构与全命中绑定，数据库版本6 |
| 2026-11-04 01:57:42 | b408b91 | v0.3.0，当前版本7增加characterRelationEdits；开库ready新增关系修复，触发旧结构异常 |
| 旧开发保留对象 | 7c7d94f | stash说明rollback-backup-before-v0.1.4-2026-11-03；workspace曾使用版本6创建left/right索引、版本7执行另一种关系升级 |
| 旧未跟踪文件保留对象 | f1651fc | src/features/relations/types.ts、roles.ts、upgrade.ts等保存旧结构与角色解释 |

只读核对命令：

```powershell
git log -3 --format="%h %ad %s" --date=iso-strict
git show 7c7d94f:src/lib/storage/workspace.ts
git show f1651fc:src/features/relations/types.ts
git show f1651fc:src/features/relations/roles.ts
git show f1651fc:src/features/relations/upgrade.ts
```

历史版本7没有当前characterRelationEdits表；仅补trim判空之后仍可能遇到缺表、索引和读模型错误。备份预检也把所有格式7当成当前清单，历史7缺编辑表时在CONTENTS校验阶段即会被拒绝；仅修开书不足以完成兼容。

## 真实备份样本

样本是用户已有的本地忽略文件，当前位于仓库根目录；本次没有新增或搬动这些文件，不提交小说或完整备份进Git。

| 文件 | 格式 | 人物 | 节点 | 关系表 |
|---|---|---|---|---|
| 红楼之挽天test-2026-11-01T04-01-38-599Z-6f0ac6d2.wwv2 | 5 | 2637 | 613 | 无独立表 |
| 红楼之挽天test-2026-11-01T07-15-22-060Z-3769088d.wwv2 | 5 | 401 | 613 | 无独立表 |
| 红楼之挽天test-2026-11-01T16-29-14-713Z-e6d75115.wwv2 | 历史7 | 395 | 613 | 1562条left/right行 |

最后一个样本 SHA-256：`e8511f6e061555dfcd2360b1b20e4ff9facc2c8d67735826b8d68a602f149019`。

bookId：`f956ea7c-71fd-413e-99fa-f170851df80c`。分章/切块138条（不是138个原章的断言）。1562条关系全部缺targetName；status为pending的604条、active的958条；verification为legacy的1557条、manual的5条；829条leftRole/rightRole都为null。5条人工记录含主仆方向，不能因为旧界面表现而认定所有数据都没有方向。

人工记录重点：R-1prf5f8（抱琴/元春）、R-dfmw60和R-dfmw61（彩屏/惜春）、R-dfmw62（彩儿/惜春）、R-s4trg6（凤姐/彩明）。有重复人物对，不能用关系行数等同网络连线数。真实样本未发现excluded，不代表无需测试删除兼容，必须用合成样本覆盖。

## 最小结构与复现

下例缩减自R-1013q41，完整旧行另含第二条来源证据和时间字段。其source/target语义不能用新结构字段名直接强转：

```json
{
  "id":"R-1013q41","bookId":"f956ea7c-71fd-413e-99fa-f170851df80c","revision":1,
  "left":{"characterId":"C4-P023","nameHint":"齐王","binding":"owner"},
  "right":{"characterId":"C46-P016","nameHint":"许绍真","binding":"exact_name","matchedName":"许绍真"},
  "kind":"authority","leftRole":null,"rightRole":null,"qualifier":"",
  "label":"府中典客","labelVariants":["府中典客"],"labelSource":"original",
  "status":"pending","issues":["roleUnclear"],"verification":"legacy",
  "evidence":[{"id":"E-6ss9g2","origin":"legacy","originCharacterId":"C4-P023","sourceChapterIndices":[],"chapterHints":["4","46"],"quoteStatus":"empty","raw":{"target":"许绍真","relation_type":"superior_subordinate","direction":"directed","relation_label":"府中典客"}}]
}
```

已执行的复现方法：fflate解压指定备份到内存，使用Vite SSR加载现有repair.ts，注入只读rows和阻断put的MergeStore。调用在第一次写入前失败，未访问浏览器IndexedDB。等价可复现命令（Node依赖已安装）：

```powershell
@'
import fs from 'node:fs';
import {unzipSync,strFromU8} from 'fflate';
import {createServer} from 'vite';
const file='红楼之挽天test-2026-11-01T16-29-14-713Z-e6d75115.wwv2';
const archive=unzipSync(fs.readFileSync(file));
const tables=Object.fromEntries(Object.entries(archive)
  .filter(([name])=>name.startsWith('data/')&&name.endsWith('.json'))
  .map(([name,bytes])=>[name.slice(5,-5),JSON.parse(strFromU8(bytes))]));
const server=await createServer({server:{middlewareMode:true},appType:'custom'});
try {
  const {repairRelationBindings}=await server.ssrLoadModule('/src/features/assets/repair.ts');
  await repairRelationBindings({
    rows:async name=>tables[name]??[],
    put:async()=>{throw new Error('Read-only diagnosis: write blocked')}
  },tables.characterRelations[0].bookId);
} catch(error) { console.log(error.stack) }
finally { await server.close() }
'@ | node --input-type=module
```

实际错误调用链（Vite转换后的行号不作为源文件行号）：

```text
TypeError: Cannot read properties of undefined (reading 'trim')
characterNameHits → bindTargetIds → syncRelations → repairRelationBindings
```

复现确认了当前代码对真实历史备份的失败路径；不等于已证实用户浏览器原库每一行都与该备份一致。实施时先记录原库版本、表清单、记录数和只读快照，再测试原地升级。

## 实施样本要求

在tests/fixtures建立最小自写人物和原文，不复制整本小说。fake-indexeddb和浏览器测试必须用历史真实schema创建版本7库（没有characterRelationEdits、旧left/right索引），关闭后再用新BookDatabase打开。不能先用当前schema建库后只塞入旧行冒充真实升级。

额外合成：角色单向/不明、同名不同ID、manual/ai、excluded和其他有效记录同对、已删除端点、生命周期自连、混合新旧行、当前deleted编辑、超限标签、未知形状、长依据、活租约和失败注入。样本准备任务及验收详见 [tasks](tasks.md)、[acceptance](acceptance.md)。
