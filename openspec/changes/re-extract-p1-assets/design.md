# 实施设计

需求、范围和已确认规则见[提案](proposal.md)。本设计定义清空范围、生命周期与关联处理、失败继续、执行权、下游失效和界面接入。

## 模块协作

| 模块 | 职责 |
|---|---|
| `extraction/service.ts` | 新增强制重提模式，写入重提范围，先清空对应范围，再逐章调用模型 |
| `extraction/ExtractionPanel.tsx` | 整书重提按钮、确认框、继续重提入口和进度显示 |
| `books/ChapterBrowser.tsx` | 成功标签旁的回收按钮，点击直接执行 |
| `assets/invalidate.ts` | 按受影响编号失效 P2/P3 读取依赖 |
| `lib/storage/workspace` | 不改变表结构；使用现有资产、凭证、进度和运行记录 |
| `storage.schema.json` | 增加 `compileProgress.reExtract` 可选字段 |

## 重提请求与范围

```ts
type ReExtractRequest =
  | { scope: 'all'; step: 'worldAssets' | 'narrativeAssets' }
  | { scope: 'chapter'; chapterIndex: string; step: 'worldAssets' | 'narrativeAssets' }

interface ReExtractScope {
  step: 'worldAssets' | 'narrativeAssets'
  scope: 'all' | 'chapter'
  chapterIndex?: string
  startedAt: string
}
```

服务新增：

- `reExtractPreview(bookId, request)`：只读返回将清空的资产数量、下游影响和阻断原因（模型未配置、活动任务、无成功凭证、已有待继续重提）。
- `reExtract(bookId, request)`：校验后写入范围、清空并执行重提。
- `continueReExtract(bookId)`：按 `reExtract` 范围继续缺失步骤；主按钮在存在待继续重提时调用它。
- 现有 `start`/`retry` 继续只补缺口，不改变普通提取行为。

`compileProgress` P1 行新增可选 `reExtract: ReExtractScope`。清空时写入，本次范围全部成功凭证完成后清除。旧数据缺省按普通提取处理。

## 清空规则

### 生命周期映射

不删除其他章节的成功凭证和来源映射。所有受影响的 `assetLifecycle` 行改为：

```ts
{ ...mapping, state: 'deleted', revision: mapping.revision + 1, updatedAt: timestamp }
delete mapping.currentId
```

保留 `originId` 和 `key`。`checkReceiptSources` 对 `state='deleted'` 的来源直接判定有效，因此其他章节凭证不会因本章重提报“来源记录不完整”。

受影响映射包括：

- `originId` 在本章 `originIds` 内的映射；
- `currentId` 指向这些编号的其他章节映射。

### 世界资产清空

整书：

- 删除全部 `characters`、`locations`、`characterRelations`、`characterRelationEdits`、`legacyRelationRecords`。
- 全部人物/地点生命周期改为 `deleted`。
- 删除全部世界资产凭证。
- 保留 `nodes`，但移除节点中引用已删人物的编号：
  - `actorIds`、`targetCharacterIds`、`manualActorIds`、`manualTargetCharacterIds`、`legacyActorIds`、`legacyTargetCharacterIds` 过滤已删编号；
  - `actorBindings`、`targetBindings` 中过滤已删编号，保留 `mention` 文字和 `ids: []`；
  - 节点的命名、正文、章节、事件线归属不变。
- 清除 P2 进度、P2 运行记录、队列、报告和资产核对；P3 进度标记 `stale`，事件线保留。

单章：

- 按本章 `originIds` 删除人物、地点。
- 本章编号及 `currentId` 指向本章编号的其他映射改为 `deleted`。
- 删除 `originCharacterId` 属于本次改为 `deleted` 的来源编号的关系事实，包括其他章节合并到本章编号的来源；保留的关系用 `syncRelations` 收敛来源和目标。
- 删除涉及已删编号的 `characterRelationEdits`；旧关系迁移归档保留，作为历史。
- 节点中的旧编号按整书规则移除，保留称呼文字。
- 其他章节世界资产凭证保留；本章世界凭证删除。
- 保留关系的 `sourceId` 和 `targetIds` 用 `syncRelations` 重新收敛；被删人物、地点和关系变化都加入 `invalidateAssetProgress` 的变更清单。
- 受影响节点和事件线的 P3 依赖失效。

### 叙事资产清空

整书：

- 删除全部 `nodes`、`eventLines`。
- 节点和事件线生命周期改为 `deleted`。
- 删除全部叙事资产凭证。
- 删除 P3 进度、运行记录、故事编辑工作记忆、检查点和备注。
- 人物、地点、关系及 P2 保留。

单章：

- 按本章 `originIds` 删除节点，节点生命周期改为 `deleted`。
- 事件线移除这些节点：
  - 仍有节点：更新 `nodeIds`、`chapters`、`timeRange`、相关节点的 `eventLineIds` 和修订号；
  - 没有节点：删除事件线，生命周期改为 `deleted`。
- 本章叙事凭证删除；其他章节凭证保留。
- 受影响节点和事件线失效 P3 依赖。

## 新资产写入与重新绑定

清空后按现有 P1 插入规则逐章写入：

- 人物、地点、节点使用章节编号和步骤前缀生成新编号。
- 每成功一章，世界资产步骤继续调用 `remapCharacterLinks`，把节点中保留的称呼文字重新绑定到新人物编号。
- 关系在全部人物写入后按现有 `syncRelations` 绑定目标和来源。
- 新资产不继承已删除来源的合并事实。

## 失败、取消与继续

- 清空事务失败：回滚，旧数据保持，显示存储错误。
- 清空成功后模型失败：该章该步骤记为失败；已完成的新资产和凭证保留；`reExtract` 保留。
- 取消、刷新或关闭页面：已成功写入的新资产和凭证保留；`reExtract` 保留；进度状态为暂停或中断。
- 主按钮在 `reExtract` 存在时显示“继续重提世界资产/叙事资产”；单章范围显示“继续重提第X章世界资产/叙事资产”。点击只处理该范围内的缺失凭证，不重新清空。
- 本次范围全部成功后清除 `reExtract`，恢复普通“开始/继续提取”入口。
- 存在待继续重提时，整书重提和章节回收按钮禁用，避免重复清空。

## 执行权

重提同时持有：

- `lease:extraction`：阻止其他 P1。
- 世界资产重提持有 `lease:world`；叙事资产重提持有 `lease:narrative`：阻止 P2/P3、人物编辑、合并和关系保存。

两个租约使用同一 `owner` 和 `runId`，每 8 秒续期。执行前若已有其他任务租约，直接拒绝，不抢占。提交或失败后释放两个租约。

现有 `checkLease` 把除 extraction 外的任何租约视为冲突；重提模式需要允许同一 owner/runId 的目标域租约，其他租约仍然拒绝。

## 备份有效性

清空后即使首章模型请求失败，也必须能立即导出和恢复：

- 其他章节世界凭证的来源映射状态为 `deleted`，`checkReceiptSources` 通过。
- 关系事实来源和目标只引用现存人物；已删端点的人物对编辑已删除。
- 节点不保留已删人物编号；绑定组可保留空 `ids` 的称呼。
- 事件线只引用现存节点；空线已删除。
- 生命周期 `deleted` 行不带 `currentId`。

实现后用“清空 + 首章失败 + 立即导出恢复”场景验收。

## 下游失效

| 重提范围 | P2 | P3 |
|---|---|---|
| 整书世界 | 删除 P2 进度、队列、报告、资产核对和关系编辑 | 进度标记 `stale`；事件线保留 |
| 整书叙事 | 不变 | 删除事件线、P3 进度/运行记录/工作记忆/检查点 |
| 单章世界 | 按受影响人物编号失效相关队列/核对/覆盖 | 受影响节点的 P3 依赖失效 |
| 单章叙事 | 不变 | 受影响节点和事件线的 P3 依赖失效；空线删除 |

## 界面

### P1 标题区

主提取按钮右侧增加：

- `重新提取世界资产`
- `重新提取叙事资产`

按钮仅在对应步骤至少有一个成功凭证、无待继续重提时可用；运行中、检查中、恢复失败时禁用。点击先调用 `reExtractPreview`，显示确认框。

存在 `reExtract` 时，主按钮改为“继续重提世界资产/叙事资产”，整书重提和章节回收按钮禁用。

### 章节状态

`ChapterBrowser` 的成功状态块改为“状态 + 回收图标按钮”。按钮只在 `completed` 显示，aria-label 为“重新提取第X章世界资产”或“重新提取第X章叙事资产”。点击直接调用 `reExtract`，不弹确认；运行中或存在待继续重提时禁用。按钮 `title` 提示“将清空本章该类资产并重新提取，不弹确认”。

### 整书确认框

显示：

- 范围：整书世界资产或整书叙事资产。
- 将清空数量：人物、地点、关系或节点、事件线。
- 将清除的下游结果。
- 阻断原因（如模型未配置、有活动任务、已有待继续重提）。

确认按钮文案：“清空并重新提取”。取消不发请求。

## 性能与限制

- 整书重提逐章保存，不在内存保留全部结果；单章结果直接写入。
- 清空与写入都是本地事务；模型调用费用按实际章节和重试次数累计。
- 重提不保证旧资产可恢复，确认框和按钮提示必须写明。

## 测试与验收

- 单元：整书世界/叙事清空与重提、单章清空、合并后单章清空、其他章节凭证仍有效、节点/关系/事件线清理、失败继续、取消/刷新、租约冲突、下游失效、清空后首章失败立即导出。
- 浏览器：两个整书按钮、章节回收按钮、整书确认框、单章无确认、继续重提入口、运行中禁用、失败提示。
- 真实模型：先用短样本或副本，确认新格式和费用；用户确认后再对原书执行。
- 具体命令、样本和证据见[验收](acceptance.md)。

## 字段变化

新增 `compileProgress.reExtract` 可选对象，字段含义、类型、赋值和读取见[提案](proposal.md#字段变化)。其他表沿用现有结构。

## 数据流转

重提请求 → 校验模型与执行权 → 写 `reExtract` → 清空范围资产、凭证和下游结果 → 逐章提取并保存 → 完成后清除 `reExtract`。详细顺序见上文“执行顺序”。

## 触发逻辑

整书重提由整书确认框触发；单章重提由章节成功标签回收按钮直接触发；失败或刷新后由主按钮按 `reExtract` 继续。详细条件见[提案](proposal.md#触发逻辑)。
