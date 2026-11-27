# 逐库逐表数据与生命周期

## 1. 当前数据只有一层

正常启动后，书架和书籍数据落在本机 `workspace.sqlite`。逻辑范围 `settings` 有 3 张表，`book:<bookId>` 有 22 张表。每本书有独立的书籍编号；在同一磁盘文件内按范围、逻辑表名和主键寻址。资产提交成功即可读取，书架发布另有跨范围日志。[本机逻辑表](../../src/features/local-storage/schema.ts) · [SQLite 记录存储](../../src/features/local-storage/sqliteStore.ts) · [导入服务](../../src/lib/storage/importService.ts)

备份预检逐表校验字段，再检查记录所属书籍、主键、正文与资产的关联。设置与缓存各自按逻辑表的主键读取。[备份字段结构](resources/v2.2/storage.schema.json) · [表间校验](../../src/features/backup/data.ts)

## 2. 逐表清单与索引

| 范围 | 逻辑表 | 主键 | 数据归属 |
|---|---|---|---|
| 设置 | credentials | providerId | 聊天服务商和检索角色使用的密钥，本机加密存储。 |
| 设置 | appSettings | key | 聊天配置、检索模型配置、存储就绪标记、书籍生命周期日志等。 |
| 设置 | books | id | 书架元数据。单书备份将该书条目写入 `data/book.json`。 |
| 单书 | chapters | chapterIndex | 章名、字符数、排序。 |
| 单书 | chapterTexts | chapterIndex | 与章节一一对应的完整正文。 |
| 单书 | nodes | id | 带章节位置、涉及人物和地点的事件节点。 |
| 单书 | storyEvents | id | 事件卡及有序成员节点。 |
| 单书 | eventLines | id | 故事线的事件、节点成员和章节范围。 |
| 单书 | characters | id | 人物资料、称呼、来源和层级。 |
| 单书 | locations | id | 地点描述、称呼和来源。 |
| 单书 | characterRelations | id | 原始关系事实、称呼绑定和证据。 |
| 单书 | characterRelationEdits | pairKey | 人物对的当前编辑或删除结果。 |
| 单书 | legacyRelationRecords | id | 归档的左右端点关系、对应人物对及解析结果。 |
| 单书 | compileProgress | stage | P1/P2/P3 各阶段进度。 |
| 单书 | storyEditorMemory | id | 会话工作摘要。 |
| 单书 | storyEditorNotes | id | 有依据的事项、疑点及状态。 |
| 单书 | storyEditorCheckpoints | id | 会话检查范围、依据指纹及结果。 |
| 单书 | storySessions | id | 会话归属、状态、末端与下个序号。 |
| 单书 | storySessionEntries | id | 会话条目、请求追踪及快照引用。 |
| 单书 | extractionReceipts | key | 章节和子步骤的成功凭据。 |
| 单书 | extractionTasks | id | P1 每个请求任务、状态及输入快照引用。 |
| 单书 | extractionInputs | id | P1 请求使用的正文，以内容摘要去重。 |
| 单书 | assetLifecycle | key | 人物、地点、节点、事件线的来源映射及墓碑。 |
| 单书 | pipelineRuns | id | 阶段运行、租约、整理记录、P3 任务和工具回执等多种记录。 |
| 单书 | eventRetrievalVectors | id | 检索模型命名空间与文本哈希对应的向量，仅在本书缓存。 |

逻辑表主键由服务端校验。客户端可按索引键或复合字段读取。磁盘后端以记录封装中的 `version` 标识存储变动，业务对象自身的 `revision` 用于编辑冲突判断。[查询和事务协议](项目技术说明.md#本机存储协议)

## 3. 当前实体的逐字段约定

### 3.1 公共元数据

`bookId` 绑定资料所属书，`id` 在本书、同对象类型内标识记录。普通资产保存 `revision` 及 `createdBy`；人工更新需携带看到的修订号。事件卡有自己的类型与修订号。P1 生成的对象依据章号和对象类型编号。导入副本更换书籍编号，书内对象引用按副本归属核对。[资产类型](../../src/features/assets/types.ts) · [资产读写](../../src/features/assets/service.ts)

### 3.2 characters

`name` 为主名，`aliases` 为别名，`verifiedAliases` 保存已核实称呼。资料包括身份、外貌、性格、背景、年龄和性别、语言风格示例。`sourceChapters` 保留来源章，`mergeFacts` 记录含字段名、事实文本与章节的底稿。出场频次与人物层级分开保存；层级来源可以是频次、人工或 Agent。[人物类型](../../src/features/assets/types.ts) · [称呼处理](../../src/features/assets/characterNames.ts) · [频次](../../src/features/assets/frequency.ts)

P1 输出中的 `aliases_mentioned` 存为 `aliases`，`speech_style_sample` 存为 `speechStyleSample`。年龄使用 `profile.ageText`。回包只提供数值 `age` 时，校验器将其转成“数值＋岁”；写入前移除提取响应中的 `confidence`。[提取校验](../../src/features/extraction/contracts.ts) · [字段落库](../../src/features/extraction/service.ts)

关系事实属于 `characterRelations`。每条记录保存来源人物、双方称呼、方向、正反标签、可解析的人物编号及证据。`characterRelationEdits` 以一对人物为单位存两向标签、修订、证据状态与提交编号，删除保留该对的删除状态。界面叠加事实和编辑结果，并按当前人物的视角显示。[关系事实与投影](../../src/features/assets/relations.ts) · [人物对编辑](../../src/features/assets/relationEdits.ts)

### 3.3 locations

地点使用 `name`、`aliases`、`description` 及来源、修订、合并底稿等字段。合并保留目标 ID、汇集来源章，已并入的来源 ID 仍可查到保留对象。节点记录的 `locationNames` 是原文地点称呼。[地点与关系类型](../../src/features/assets/types.ts) · [合并事务](../../src/features/assets/mergeCore.ts)

### 3.4 节点、事件与故事线

REQ-032 第二阶段拟在故事线上保存贯穿问题、进展、遗留、线索列表及每件成员事件的作用和依据。旧成员缺少依据时在复核中补写。字段类型、赋值者、旧书和备份转换见[第二阶段字段设计](../../openspec/changes/recast-p3-storyline-workflow/design.md#字段变化)。

| 对象 | 当前字段与成员 | 写入与读取 |
|---|---|---|
| 节点 `nodes` | `chapterIndex/chapterName/order` 定位，`name/summary/process/quote` 记录原章事实。`actors/actorIds/actorBindings/manualActorIds` 分别保存涉及人物的称呼、编号、逐称呼绑定和人工选择。`locationNames/clues` 为地点与线索数组。节点还可保存时间、`world_delta`、`new_facts` 等。 | P1 或人工写入。未绑定称呼保留，人物合并、改名及删除触发关联更新。同一称呼可保留多个匹配 ID。 |
| 事件 `storyEvents` | `title/summary/latestProgress/unresolved/clues/status/nodeIds` 对应名称、概况、最新进展、遗留问题、线索数组、状态、成员节点。状态取“进行中／暂时搁置／已闭环”。 | 由 `edit_events` 写入，成员按原文位置整理。多件可共享同一节点。事件浏览、检索和复核读取当前卡。 |
| 故事线 `eventLines` | `title/summary/coreClue/lineStatus` 表示名称、概况、核心线索及开闭状态。按事件组织的线用 `eventIds` 引用成员；直接按节点组织的线使用 `nodeIds`。 | 大纲线依据所挂事件同步 `nodeIds/chapters/timeRange` 和节点反向 `eventLineIds`；未归线的事件可独立存在。故事线自动调度关闭。 |

例如，事件 `E1.nodeIds=["C1-N001","C2-N001"]`，大纲线 `L1.eventIds=["E1"]`。调整 E1 成员后，同一事务同步 L1 的节点清单和受影响节点的线归属。人物集合按成员节点推导。[大纲同步](../../src/features/story/outline.ts) · [事件字段与编辑](../../src/features/story/eventWorkflow.ts)

## 4. 提取凭证、来源和报告

### 4.1 extractionReceipts

必填 `key/bookId/chapterIndex/substep/inputFingerprint/originIds/committedAt/runId`。例如 `1:worldAssets` 记录第 1 章世界子步骤的成功结果。成功而结果为空时，`originIds` 可为空数组；失败时没有成功凭据。普通继续或重试按凭据查缺。用户显式重提会预览清理范围、核对原文，再针对所选章节和类别处理该范围的提取结果。[提取提交](../../src/features/extraction/service.ts) · [重提清理](../../src/features/extraction/reextract.ts)

### 4.2 assetLifecycle

`key` 按 `kind:originId` 构造，`kind` 取 character、location、node、eventLine。新增记录为 `live`；合并后标记 `merged`，`currentId` 指向保留对象；删除保存 `deleted` 墓碑。人物合并时同步事实绑定与人物对编辑。事件卡通过 `storyEvents` 及 P3 工具回执记录变动。[合并核心](../../src/features/assets/mergeCore.ts) · [事件回执](../../src/features/story/narrativeTools.ts)

### 4.3 pipelineRuns

| 记录 | 关键持久内容 | 恢复和消费 |
|---|---|---|
| 运行 `run` | `id/bookId/stage/status/startedAt/planVersion`；依阶段另含报告、请求用量、执行计划等。 | P1 读取提取任务和凭据，P2 读取 `organization` 中的工作项及位置，当前 P3 读取 `narrative`。 |
| 执行权 `lease` | `lockKey/owner/runId/expiresAt`（毫秒），P1 可附 `extractionStep`。 | 领域服务在短事务核对、续租、释放；导出排除执行权。 |
| P3 `narrative_task` | 任务 ID、运行、任务输入、系统规则、工具声明、已观察版本及任务状态。 | 查看请求链、恢复同一任务时按运行和任务定位。 |
| P3 `narrative_receipt` | 以任务 ID 和工具调用 ID 构造主键，保存 `name/signature/arguments/result`。 | 业务写入和回执同事务；写入已成功时，重复调用先核对运行和签名再返回已存结果。 |
| P2 `history_index` | 人物、步骤与运行位置。 | 用于查找整理详情。属于可重建索引，恢复后按需重建。 |

事件任务由 `narrative.active` 和逐节点、逐事件版本确认定位；独立复核运行携带 `reviewOnly`，读取本书最近一条独立复核运行。[P3 运行](../../src/features/story/narrativeService.ts) · [通用运行结构](resources/v2.2/storage.schema.json#/$defs/PipelineRun) · [P2 记录索引](../../src/features/agents/p2HistoryIndex.ts)

## 5. 进度、会话与事务

P1 在 `compileProgress` 保存各步骤进度、错误及用量，成功凭据对应到具体章和步骤。P2 分别保存识别重复人物、资料和关系的运行。P3 主任务的进度使用 `planKey=narrative-events-v1`，独立事件复核把进度保存在自己的运行内。阶段状态描述任务进展，资产提交后即可使用。[P1 服务](../../src/features/extraction/service.ts) · [P2 组织状态](../../src/features/world/organization.ts) · [P3 进度](../../src/features/story/narrativeService.ts)

### 5.1 会话与运行实例

`bookId` 确定书，`sessionId` 确定消息链，`runId` 确定一次执行，`taskId` 确定本次分配。原始请求和工具结果、摘要、提交及追踪记录按书保存。P2 和 P3 按任务使用各自的上下文。当前 P3 暂停继续读取已有运行；取消后重新开始独立事件复核，则创建新运行和新会话，并保留已写回的事件。[会话写入](../../src/features/agents/sessions.ts) · [P3 恢复](../../src/features/story/narrativeService.ts)

<a id="6-迁移与备份"></a>

## 6. 导入与备份

### 6.1 从浏览器书库导入

用户在原浏览器中选择迁移后，服务读取 IndexedDB 的设置与书籍，将书籍资料复制到磁盘暂存范围，核对摘要和各表数量，再发布书架条目。浏览器内的源数据保留。[浏览器数据导入](../../src/features/local-storage/migration.ts)

### 6.2 当前单书备份与本机恢复副本

`.wwv2` 写出 `formatVersion=15`，预检接受格式 4–15。包内有清单、应用版本、书架元数据、该书各业务表及分章原文，文件逐一核对 SHA-256。导出表清单有 21 张单书表，含 `chapterTexts`（按章节写入 TXT）。`eventRetrievalVectors` 可重算，包内省略；全局设置和凭据亦不在包内。运行中的状态按备份规则转为可恢复状态，活动租约和可重建的整理记录索引从导出数据过滤。[表清单与状态处理](../../src/features/backup/data.ts) · [清单、版本与校验和](../../src/features/backup/codec.ts)

导入总是分配新书编号，重写归属并换算恢复范围。预检失败返回具体路径，不发布书架条目。P3 的重建副本另按专用入口清理已有叙事整理结果。本机服务生成的 SQLite 恢复副本保存在数据目录的 `backups`，覆盖整个磁盘工作空间。[恢复映射](../../src/features/backup/rebase.ts) · [备份与重建服务](../../src/features/backup/service.ts) · [磁盘恢复副本](../../src/features/local-storage/sqliteStore.ts)

## 7. Pi运行时、应用持久化与写命令凭据

Pi 管理当前请求与工具循环。应用将业务状态、必要的消息、工具调用和确认存入书库。通用整理命令按运行、逻辑操作键和载荷指纹验证重放；事件工作流按任务、调用 ID、工具名和参数签名验证回执。收到工具响应前断线时，从对应记录判断写入是否已经生效。[通用命令与意图](../../src/features/agents/commands.ts) · [叙事工具与回执](../../src/features/story/narrativeTools.ts)

## 8. 逐表字段与结构入口

书籍备份中的必填、可省略、允许值及嵌套形状，使用下表所列的结构定义。业务文本长度是填写提示，入库以类型、必填及引用要求校验。

| 记录 | 写入、字段含义和读取 |
|---|---|
| 凭据及设置 | 实际凭据行使用平铺的 `{providerId,type:"api_key",key}`；SQLite 持久化的 key 是 Windows 当前用户密文。聊天配置键为 `llm.config`，检索角色另存配置；手动导出目录的浏览器句柄单独保管。[聊天配置读写](../../src/features/models/config.ts) · [检索设置](../../src/features/models/retrievalSettings.ts) · [目录选择](../../src/features/backup/files.ts) |
| 书籍、章节及正文 | [Book](resources/v2.2/storage.schema.json#/$defs/Book) 保存书名、来源和创建时间；[Chapter](resources/v2.2/storage.schema.json#/$defs/Chapter) 的 `order` 从 0 开始，`charCount` 为 UTF-16 长度；[ChapterText](resources/v2.2/storage.schema.json#/$defs/ChapterText) 按同一章号保存原文。 |
| 节点、事件、故事线 | [StoredNode](resources/v2.2/storage.schema.json#/$defs/StoredNode)、[StoryEvent](resources/v2.2/storage.schema.json#/$defs/StoryEvent)、[StoredEventLine](resources/v2.2/storage.schema.json#/$defs/StoredEventLine)。字段及派生方向见第 3.4 节。 |
| 人物与地点 | [StoredCharacter](resources/v2.2/storage.schema.json#/$defs/StoredCharacter)、[StoredLocation](resources/v2.2/storage.schema.json#/$defs/StoredLocation)。人工保留标识、来源章与合并底稿随目标实体保存，编辑及合并重核修订。 |
| 关系三表 | [StoredRelation](resources/v2.2/storage.schema.json#/$defs/StoredRelation) 保存事实，[CharacterRelationEdit](resources/v2.2/storage.schema.json#/$defs/CharacterRelationEdit) 保存当前人物对结果，[LegacyRelationRecord](resources/v2.2/storage.schema.json#/$defs/LegacyRelationRecord) 保存归档的原始关系行、对应人物对和处理结果。 |
| 阶段进度 | [CompileProgress](resources/v2.2/storage.schema.json#/$defs/CompileProgress) 保存阶段状态、完成/失败章、当前运行 ID、计划及覆盖情况。P1 还可保存两类任务范围与状态。 |
| 摘要、事项与检查点 | [摘要](resources/v2.2/storage.schema.json#/$defs/StoryEditorMemory)与[事项](resources/v2.2/storage.schema.json#/$defs/StoryEditorNote)各有修订；事项业务键 `key` 必须非空。[检查点](resources/v2.2/storage.schema.json#/$defs/StoryEditorCheckpoint)记录范围和依据指纹。 |
| 会话及条目 | [StorySession](resources/v2.2/storage.schema.json#/$defs/StorySession) 保存 `profile/status/leafId/nextOrdinal` 等。[StorySessionEntry](resources/v2.2/storage.schema.json#/$defs/StorySessionEntry) 按类型保存消息、压缩记录、提交或执行追踪。压缩 `summary` 为非空字符串，提交 `summary` 为字符串；两者均按实际内容保留。 |
| 提取凭据、来源及运行 | [提取凭据](resources/v2.2/storage.schema.json#/$defs/ExtractionReceipt)、[来源及墓碑](resources/v2.2/storage.schema.json#/$defs/AssetLifecycle)、[运行与租约](resources/v2.2/storage.schema.json#/$defs/PipelineRecord)。业务赋值与恢复分别见第 4 节、第 10 节。 |
| 提取任务与输入 | [ExtractionTask](resources/v2.2/storage.schema.json#/$defs/ExtractionTask) 使用 `input.snapshotId` 引用 [ExtractionInput](resources/v2.2/storage.schema.json#/$defs/ExtractionInput)，详情见第 12 节。 |
| 检索向量 | `id` 由模型命名空间及输入文本哈希组成，`vector` 为数值数组。缓存按书寻址，清理仅针对对应命名空间中已失效的文本。[向量缓存](../../src/features/story/eventVectorCache.ts) |

## 9. 入口赋值与关联更新

- 导入时生成书籍 ID、章号和顺序。书架发布前验证元数据与分章正文。跨库操作从记录的阶段恢复。[导入服务](../../src/lib/storage/importService.ts)
- P1 从原章和任务编号生成章节资产、来源映射及成功凭据。后续编辑保留初始来源，合并更新所有受影响的关联。单章重提前核对所选范围内的原文、凭据与成员，叙事重提允许重新使用本章已清理的节点编号并递增修订。[重提范围](../../src/features/extraction/reextract.ts) · [编号分配](../../src/features/extraction/service.ts)
- P2 关系变更保留人物对状态、证据与修订，提交报告可按运行定位。P3 编辑事件时重核成员和当前版本，再同步已有故事线的派生数据。[人物对写入](../../src/features/assets/relationEdits.ts) · [事件编辑](../../src/features/story/eventWorkflow.ts)

## 10. 任务、命令意图与覆盖账本

通用运行中，`TaskRecord` 标识一次工作项分配与输入，`CommandIntent` 保存经校验的操作载荷和预期读集，`appliedCommands` 保存已提交的确认。处于 `prepared` 的记录还需核对业务状态。运行覆盖可以涉及实际读到的记录版本、查询结果指纹及 `ReviewItem` 中的结果和非空原因 `reason`。各分支的条件和可选字段见[执行结构](resources/v2.2/execution.schema.json)和[命令服务](../../src/features/agents/commands.ts)。

P2 三步以 `organization` 保存候选、人物资料、关系工作项及 `activeWork`。当前 P3 以 `narrative` 保存节点处理结果、活动任务、两步事件复核及版本。P3 的 `confirm` 结束当前任务时，服务更新计划及任务状态，工具回执保留实际结果。[P2 状态服务](../../src/features/world/organization.ts) · [P3 编排](../../src/features/story/narrativeService.ts) · [两步确认](../../src/features/story/twoStepReview.ts)

## 11. 生命周期日志与只读字段

`appSettings` 的动态键 `book.lifecycle:<operationId>` 将跨范围导入／删除关联到唯一书籍。日志写入操作编号、归属、状态、创建／更新时间、所有者和执行权期限。导入准备就绪后可发布书架项；删除或清理中断时依日志核对目标及剩余工作。不同执行者须先检查所有权。[操作日志](../../src/lib/storage/importService.ts) · [所有权与恢复](../../src/lib/storage/importOwnership.ts)

请求用量和费用来自模型返回及定价元数据。`unknown` 代表价格信息不足；请求记录与书内汇总保留各自的来源。资产详情中的成员章节、涉及人物和图谱归属为投影，写入仍经过资产或事件服务。[执行统计](../../src/features/agents/executionStats.ts) · [大纲统计](../../src/features/story/outline.ts)

## 12. P1独立任务与正文快照

P1 运行以 `taskStorage='separate'` 标记独立任务结构，`nextTaskOrdinal` 分配序号。注册任务时，`extractionTasks.id` 使用 runId/taskId 的 JSON 数组编码；`input` 保存章号、当时章名和 snapshotId。`extractionInputs.id` 为正文 SHA-256。读取请求详情时按快照取出请求当时的原文，同一章的两类任务可引用同一份快照。[独立任务与输入](../../src/features/extraction/taskStore.ts)

单书备份包含任务及其输入快照。恢复副本重写书籍归属，保留任务 ID、当时的原文和输入指纹。待处理、运行中或准备中的独立任务在导出时标为 `partial`。任务和正文快照的引用及书籍归属由[备份校验](../../src/features/backup/data.ts)核对。

### P2 整理详情索引

人物资料与关系分别维护 `profile:<人物编号>`、`relations:<人物编号>` 的记录位置。新一轮完成并持久化后按该人物和步骤清理过期详情，保留仍在使用的关联记录。备份省略可重建位置。[P2 整理详情索引](../../src/features/agents/p2HistoryIndex.ts)

### 资产列表与详情读取

`assetPage` 对人物、地点、节点、事件和故事线返回分页结果，默认 100 条、最多 200 条。响应包括 `items,total,matched,offset,limit,missingIds`。缺失编号按整个栏目判断，跨页选择仍有效。节点、事件与故事线可按相应字段检索。读取详情时再装载完整记录与依赖，保存时核对修订。[分页投影](../../src/features/assets/assetPage.ts) · [叙事字段检索](../../src/features/assets/narrativeSearch.ts)
