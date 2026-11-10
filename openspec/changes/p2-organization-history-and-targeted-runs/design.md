# 设计：P2 三步骤历史与单人物整理

## 总体判断

这次不改请求存储格式，只补查询、分页、步骤归属和一个新的运行入口。数据仍来自现有两张表：

- `pipelineRuns`：一次运行的步骤状态、报告、资产修改记录。
- `storySessionEntries`：`request_trace` 和提示词/工具快照。

P2 详情的显示层级从“运行 → 人物窗口”改为“步骤 → 人物/目录页/疑似组 → 运行记录 → API 详情”。API 详情组件本身不改。

## 字段变化

### 已有字段

`request_trace` 现有字段足以分组：

```text
runId          运行编号
contextId      identity / profiles / relations
unitId         directory:* / candidate:* / profile:* / relations:*
characterId    人物编号
purpose        work / retry / compaction / repair
startedAt      请求时间
input          实际输入消息和快照引用
toolCalls      工具调用及结果
usage          输入、输出、缓存、费用
```

### 新增字段

```ts
type OrganizationMode = 'full' | 'profile' | 'relations'

interface OrganizationState {
  mode?: OrganizationMode
  targetCharacterId?: string
}

interface CandidateGroup {
  originStep?: OrganizationStep
}

interface CandidateDecision {
  originStep?: OrganizationStep
}

interface WorldRun {
  scope: 'fullBook' | 'character'
}
```

兼容规则：

- 旧运行没有 `mode` 时按 `full` 处理。
- 旧运行没有 `scope` 时按 `fullBook` 处理。
- 单人物运行必须有 `mode` 和 `targetCharacterId`。
- 候选组和候选结论的 `originStep` 记录它由哪一步产生；旧数据缺失时按运行范围回退。
- 不新增历史表。

## 查询层

查询分成两层，不能再用“最近 50 条请求”推导对象列表。

### 步骤索引

`readOrganizationStepIndex(bookId, step)` 从 `pipelineRuns.organization` 生成完整对象索引，不读取请求正文：

```text
IndexEntry {
  runId
  runStartedAt
  mode: full | profile | relations
  step: scan | profiles | relations
  kind: directory | candidate | profile | relations
  objectKey
  label
  status / outcome
  requestCount     仅用于显示，不决定是否展示对象
  hasTrace
}
```

数据来源：

- 第一步：完整运行的 `scanPages`、`candidateGroups`、`candidateDecisions`，只取来源为 `scan`/`resolve` 的候选。
- 第二步：所有运行（完整 + 单人物资料）的 `profileItems`；单人物运行只返回目标人物。展示全部对象，包括 pending，标出状态；不因 API 请求页限制隐藏人物。
- 第三步：所有运行（完整 + 单人物关系）的 `relationItems` 和人物对；单人物运行只返回目标人物。
- 旧运行没有请求明细时仍生成索引，`hasTrace=false`。

### 对象请求

`readOrganizationRequests({ bookId, runId, step, objectKey, before, limit })` 读取某个对象自己的请求页：

```text
requests       当前页请求
snapshots      当前页引用的提示词和工具快照
hasEarlier     是否还有更早请求
nextBefore     下一页游标
```

实现步骤：

1. 先按运行和对象工作项筛选 `request_trace`：资料为 `unitId=profile:<id>`，关系为 `relations:<id>`，目录/候选按对应工作项；单人物运行还按运行范围兜底。
2. 只返回该对象的请求，不把同一步其他人的请求混入。
3. 使用 `(startedAt, requestId)` 游标，不使用 offset。
4. 快照只加载当前页引用，避免一次读取全部 Prompt、工具 Schema 和消息正文。
5. 运行中订阅 trace hub 合并新请求；按 `requestId` 去重。

`readBookTrace` 保留给 P3 和单运行兼容读取；新增查询复用它的排序和快照加载逻辑，不改变 P3 行为。

## 数据流转

```text
pipelineRuns.organization（目录页/疑似组/人物项/关系项）
  → readOrganizationStepIndex(bookId, step)
  → 步骤对象索引（不读取请求正文）

用户点击对象
  → readOrganizationRequests(runId, step, objectKey, before?)
  → 该对象请求页 + 快照 + 下一游标
  → P2OrganizationPanel 复用 ApiRequest / Changes 渲染

单人物按钮
  → startCharacterOrganization(bookId, characterId, profile|relations)
  → 新建 scope=character 的 pipelineRun
  → 复用现有 P2 runtime、提示词、工具和 TraceSession
  → 运行记录按 mode 归入第二/第三步，不更新 compileProgress
```

旧运行没有 `request_trace` 时，索引仍从 `organization` 工作项生成，详情标记“无 API 明细”。

## 详情 UI

### 外层结构

[AgentRunPanel.tsx](../../../src/features/agents/AgentRunPanel.tsx) 的 P2 模式增加固定步骤导航：

```text
整理详情
  [第一步：识别与合并] [第二步：整理人物资料] [第三步：整理人物关系]
  当前步骤对象索引（一次显示全部对象）
    运行时间 / 状态 / 范围
    目录页、疑似组、人物或单人物运行入口
  点击对象
    该对象的 API 请求列表（沿用现有 ApiRequest，按游标加载）
    修改前后（沿用现有 Changes）
```

步骤导航不依赖 `organization.step`。即使运行当前在第三步，第一步和第二步仍可点击。对象索引不等待 API 请求分页；只有点击对象后才读取该对象的请求正文。

### 步骤归属

内部 `workKind` 和 UI 展示步骤分开计算：

```text
displayStep(request, run):
  1. run.scope = character        → run.organization.mode（profile→第二步，relations→第三步）
  2. 完整运行 directory          → 第一步
  3. 完整运行 profile            → 第二步
  4. 完整运行 relations          → 第三步
  5. 完整运行 candidate          → 候选组 originStep；缺失时回退
  6. 其他未知工作项              → 其他（不混入三步）
```

候选组创建时记录 `originStep`：

- 目录/疑似组阶段的候选：`scan` 或 `resolve`。
- 第二步发现的候选：`profiles`。
- 第三步发现的候选：`relations`。
- 单人物运行内的候选：运行本身决定展示步骤，候选组仍可保留来源信息。

因此，单人物资料运行时临时核实、合并候选的请求仍显示在第二步该人物记录下；`unitId=candidate:*` 不能单独把请求划到第一步。

### 分组规则

第一步：

- 目录页按 `pageId` 或 `directory:` 工作项分组。
- 来源为第一步的疑似组按 `groupId` 分组。
- 显示扫描页数、疑似组、合并结论和对象请求入口。
- 没有请求明细时使用 `scanPages`、`candidateGroups`、`candidateDecisions` 生成摘要。

第二步：

- 先按人物编号分组，再按运行记录展示。
- 同一人物多次资料运行显示多条运行记录，按时间倒序；每次记录点击后加载该运行的 API 请求。
- 单人物资料运行中的 `candidate` 临时工作项作为该次运行内部子过程，不单独出现在第一步。
- 没有请求明细时使用 `profileItems` 的 checked、outcome、reason、commitIds 生成摘要。

第三步：

- 先按人物编号分组，再按运行记录展示。
- 同一人物多次关系运行显示多条运行记录。
- 展示人物对、修改前后、核对依据和对象请求入口。
- 单人物关系运行中的 `candidate` 临时工作项归入本步骤。
- 没有请求明细时使用 `relationItems`、`pairChecks` 和 `report.assetEdits` 生成摘要。

### 分页与实时更新

- 步骤索引一次加载完整对象集合，不受请求分页影响。
- 点击对象后首次加载该对象最近 50 条请求。
- 请求按 `(startedAt, requestId)` 排序；加载更早时传入当前最早记录的游标，查询严格早于该游标的记录。
- 不使用 offset：运行中的新请求追加不会使旧页位置漂移。
- 新请求通过 trace hub 合并到当前对象，按 `requestId` 去重；当前视图不因新请求重新加载全部历史。
- 切换对象时保留各对象已加载的游标和请求；不删除、不覆盖原始记录。

### API 详情不变

`ApiRequest`、`MessageBlock`、工具调用、工具结果、`Changes` 组件保持不变：

- SYSTEM、USER、ASSISTANT、TOOL CALL、TOOL EXECUTION、TOOL RESULT 的顺序不变。
- 工具参数和结果展开方式不变。
- Token、耗时、费用字段不变。
- 修改前后对比不变。

## 触发逻辑

- 切换步骤：只切换当前步骤对象索引，不改变运行状态。
- 点击对象：按 `runId + objectKey` 读取该对象请求；没有请求时显示摘要。
- 加载更早：用当前最早请求的 `(startedAt, requestId)` 作为 before 游标；新请求追加并按 requestId 去重。
- 点击编辑页 AI 按钮：校验未保存、冲突、锁和运行状态；通过后创建独立单人物运行并打开 P2 详情。
- 单人物运行完成：只结束本次运行，不进入 finalize、统计或其他步骤；失败/取消保留已有请求和提交。

## 单人物运行

### 服务入口

在 [service.ts](../../../src/features/world/service.ts) 增加：

```ts
startCharacterOrganization(bookId, characterId, kind: 'profile' | 'relations'): Promise<string>
```

返回新运行编号；实际执行在后台继续，调用方立即可以打开运行详情。

### 运行记录

每次点击创建新的 `pipelineRuns` 记录：

```text
scope: 'character'
stage: 'P2'
phase: 'character_organization'
workflow: 'character_organization_v1'
organization.mode: 'profile' | 'relations'
organization.targetCharacterId: 人物编号
```

不更新 `compileProgress`，不修改完整三步运行的 `organizationSummary`。

### 状态构建

资料运行：

```text
step = profiles
scanPages = []
candidateGroups = []
profileItems = [目标人物]
relationItems = []
pairChecks = []
statisticsPending = false
```

关系运行：

```text
step = relations
scanPages = []
candidateGroups = []
profileItems = []
relationItems = [目标人物]
pairChecks = 目标人物相关人物对
statisticsPending = false
```

关系项通过现有 `reviewContext`、`relationWork` 生成，不复制一套关系计算逻辑。

### 结束条件

复用 [organization.ts](../../../src/features/world/organization.ts) 的工作项循环和现有 `runtime.run`：

- 目标资料项 checked 后结束；不再自动进入关系步骤。
- 目标关系项和其人物对完成后结束；不进入 finalize 和出场统计。
- 运行中发现的 pending 候选仍按现有候选优先级处理；候选完成后回到目标工作项。
- 单人物运行内的所有请求，包括临时 `candidate` 核实和合并，都按该运行的 `mode` 归属，资料运行归第二步，关系运行归第三步。
- 候选组在完整运行中保存 `originStep`：目录/疑似组阶段为 `scan`/`resolve`，资料阶段为 `profiles`，关系阶段为 `relations`；UI 不再用 `candidate:` 前缀直接划入第一步。
- 失败、取消或额度不足时保留已提交修改和请求记录，状态写入该运行。

### 并发与保护

- 单人物运行取得世界资产执行权。
- 已有完整 P2 或另一个单人物运行时拒绝启动。
- 使用现有版本校验、关系重检和写事务；不另造并发规则。
- 单人物运行不改变完整运行的 lease、compileProgress 或统计。
- 单人物运行完成后，人物编辑页的 AI 按钮恢复可用。

## 按钮位置与交互

按钮放在 [AssetEditor.tsx](../../../src/features/assets/AssetEditor.tsx) 底部操作栏，只在以下条件显示：

- `kind === 'character'`
- 已存在人物，不是新增
- 人物未被合并或删除

显示为两个次要按钮，和“保存 / 取消编辑 / 删除条目”同一行：

```text
[保存] [取消编辑] [AI 整理人物资料] [AI 整理人物关系] [删除条目]
```

禁用条件：

- 表单有未保存修改或关系有未保存修改。
- 当前人物版本冲突。
- 世界资产锁定。
- 完整 P2 或单人物整理正在运行。
- 当前人物已不可用。

点击后：

1. 启动对应单人物运行。
2. 立即打开 P2 整理详情，定位到第二步或第三步的当前运行。
3. 运行中详情可刷新；完成后记录永久保留。
4. 失败或取消显示在该次运行，不弹出覆盖编辑表单的对话框。

`AssetEditor` 不直接依赖世界服务；由上层传入两个回调，避免资产模块和世界模块互相引用。

## 旧数据与备份

### 旧运行

没有 `request_trace` 的运行：

- 第一步显示目录页、疑似组和合并结论摘要。
- 第二步显示已检查人物、结论和修改记录。
- 第三步显示人物项、人物对和修改记录。
- 每条摘要标记“旧版本未保存 API 明细”。

不伪造 SYSTEM、USER、TOOL CALL 等请求内容。

### 备份

`storySessionEntries` 已在现有备份表中，继续随书备份和恢复：

- 不删除历史请求记录。
- 不新增备份格式版本。
- 恢复后运行和请求按原 `runId`、`unitId` 读取。
- 旧备份没有请求明细时按旧数据回退显示。

## 文件影响

| 文件 | 改动 |
|---|---|
| `src/features/agents/trace.ts` | P2 步骤索引、对象请求查询、稳定游标 |
| `src/features/agents/AgentRunPanel.tsx` | 固定三步骤导航、对象索引、对象请求分页 |
| `src/features/world/WorldPanel.tsx` | 传入全部 P2 运行；主进度只取完整运行 |
| `src/features/world/service.ts` | `startCharacterOrganization`、运行范围 |
| `src/features/world/organization.ts` | 单人物状态构建、结束条件、过滤 |
| `src/features/world/types.ts` | `mode`、`targetCharacterId`、`originStep`、运行范围 |
| `src/features/assets/AssetEditor.tsx` | 底部两个按钮和回调 |
| `src/features/assets/AssetsPanel.tsx` | 传递按钮回调 |
| `src/features/books/BookOverview.tsx` | 连接人物入口与世界运行、打开详情 |
| 测试 | 对象索引、候选归属、稳定游标、旧数据、单人物运行、进度隔离 |

## 测试设计

### 固定响应

- 构造第二步 138 个人物、超过 50 条请求，验证打开第二步立即列出全部人物，而不是只显示最近请求涉及的人物。
- 构造单人物资料运行和两次单人物关系运行，验证第二步/第三步各有多条运行记录。
- 在单人物资料运行中插入 `candidate` 核实/合并请求，验证全部请求仍显示在第二步该人物下，不进入第一步。
- 构造运行中追加请求，验证加载更早记录不重复、不遗漏。
- 构造旧运行无 `request_trace`，验证摘要和“无 API 明细”。

### 真实模型

- 用户授权后运行单人物资料和单人物关系各一次，检查工具、提示词、请求详情和实际修改。
- 验证运行完成后完整三步报告的 checked/modified 统计不变。

### 浏览器

- 人物编辑页按钮位置和禁用状态。
- 步骤切换、加载更早请求、多次运行记录。
- 备份恢复后历史仍可查看。

## 取舍

- **按步骤查询而不是一次加载全部请求**：避免把整本书的提示词和工具 Schema 一次放入页面；代价是切换步骤和加载更多时增加查询。
- **单人物运行使用新运行记录而不是复用完整运行状态**：保证完整三步统计不被覆盖，代价是运行数量和报告数量增多；记录使用现有表，不新增系统。
- **旧数据只回退摘要**：旧备份没有请求明细，不能还原 SYSTEM/USER/TOOL 内容；明确标注而不猜测。
