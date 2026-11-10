# 设计：P2 三步独立运行与运行控制

## 总体判断

复用现有 `pipelineRuns`、`storySessionEntries`、`organization` 状态、runtime 和 P2 整理详情。新增的是“目标步骤”和“暂停/取消控制”，不是新的 Agent 或新的历史系统。

核心状态：

```ts
type OrganizationRunStep = 'scan' | 'profiles' | 'relations'

OrganizationState {
  runStep?: OrganizationRunStep
  pauseRequested?: boolean
}
```

旧运行没有 `runStep` 时仍按原来的完整三步历史读取；新 P2 按钮只创建单步运行。

## 字段变化

| 字段 | 含义 | 类型 | 默认 | 写入/读取 |
|---|---|---|---|---|
| `organization.runStep` | 本次整本书运行的目标步骤 | `scan \| profiles \| relations` | 旧数据缺省 | 创建单步运行时写入；调度器、P2 详情、按钮状态读取 |
| `organization.pauseRequested` | 是否请求暂停 | boolean | false | 暂停时写入内存/运行状态；继续或取消时清除 |
| `pipelineRuns.status` | 运行状态 | 现有枚举 | — | `running/paused/cancelled/completed/failed` |
| `pipelineRuns.startedAt/finishedAt` | 运行时间 | string | — | 新建、暂停、取消、完成时 |
| `compileProgress.P2` | 当前活动 P2 运行 | 现有 | — | 只指向当前活动/暂停运行；单步完成或取消后不再作为可恢复指针 |

不新增数据库表，不修改 `storySessionEntries` 的请求格式。

## 数据流转

```text
开始第 X 步
  → 新建 runId
  → 读取当前人物/关系数据
  → 构建该步骤完整队列
  → 只运行该步骤
  → 完成：status=completed，按钮恢复
  → 暂停：status=paused，保留 queue/activeWork/context
  → 取消：status=cancelled，queue 失效，释放 lease

继续
  → 查找 paused 的同一步骤 run
  → 复用 runId、sessionId、剩余队列、上下文
  → 不重建队列，不重放确认提交

再次开始
  → 不读取旧 remainingWorkIds/游标/消息
  → 新建 runId
  → 重新读取当前数据库
  → 重新构建完整队列
```

### 单步初始化

- 第一步：`createOrganizationState(currentCharacterIds)`，`runStep='scan'`，只允许 scan/resolve；完成 resolve 后 step=done。
- 第二步：按当前人物构建全部 `profileItems`，`runStep='profiles'`；完成全部资料项后 step=done，不构建关系项。
- 第三步：按当前人物构建全部 `relationItems` 和 `pairChecks`，`runStep='relations'`；完成全部关系项后 step=done，不进入统计。

不使用旧运行的 scanPages、candidateGroups、profileItems、relationItems 或游标作为新运行队列。

## 触发逻辑

- 点击空闲步骤：新建 runId，构建该步骤队列，开始或暂停/继续只作用于目标步骤。
- 点击运行中步骤：置暂停请求；`finishTurn` 结束当前回合，`beforeToolCall` 拦截后续新工具，保存 paused。
- 点击暂停步骤：继续同一 runId、session/context 和剩余队列。
- 点击取消：先标记 cancelled，再 abort；write 前检查取消状态；旧队列失效。
- 页面刷新：根据 pipelineRuns 和 lease 恢复；无执行器且 lease 失效时将 running 处理为可继续的中断状态。
- 步骤完成/取消/失败后按钮恢复开始；只有 running/paused 占用整本书 P2。

## 运行状态机

```text
idle
  --开始第X步--> running
running
  --暂停--> paused
  --取消--> cancelled
  --正常完成--> completed
  --失败--> failed
paused
  --继续--> running
  --取消--> cancelled
completed/cancelled/failed
  --开始第X步--> running（新 runId）
```

- `paused` 保留 lease 和占用权；其他步骤按钮禁用。
- `cancelled` 释放 lease，旧 runId 永久不可继续。
- `completed`、`cancelled`、`failed` 后三个按钮都恢复开始入口。
- 刷新后从 `pipelineRuns` + lease 恢复；数据库 `running` 但无活动执行器且 lease 失效时显示“已中断，可继续”，不能当成正在运行。

## 暂停机制

### 安全边界

复用 Pi Agent 现有钩子：

1. `finishTurn`：当前 ASSISTANT 回复、当前工具批次和工具结果完成后，如果 `pauseRequested`，返回 `{ action: 'end' }`，不发起下一次模型请求。
2. `beforeToolCall`：暂停后尚未开始的工具调用返回 block + terminate，不执行新的工具/写库；当前已开始执行的工具允许安全结束。
3. `prepareRequest`：暂停/取消状态下不再准备下一次模型请求。
4. 事务不中途强杀；已经提交的写入保留，未提交事务按正常异常回滚。

暂停不要求等整个工作项结束。暂停后可能停在当前人物的中间状态；继续从同一 session/context 的剩余消息和工具状态继续。

### 暂停后的保存

- 保存当前 run 状态为 `paused`；
- 保存 activeWork、工作项剩余项和上下文；
- 不删除 task、消息、prompt/tool 快照；
- 暂停期间不释放 lease；
- 其他步骤启动被拒绝。

## 取消机制

取消必须在数据库和执行器两侧同时生效：

1. 在事务中把当前 run 标记 `cancelled`，记录 `finishedAt` 和取消原因；
2. 设置取消标志，调用 `AbortController.abort()`；
3. `beforeToolCall` 检查 run 状态/信号，取消后不再执行新工具；
4. `commitCommand` 在写事务内再次检查 run 状态、lease 和取消信号；取消后拒绝新写；
5. 已成功提交的事务不回滚；未提交事务回滚；
6. 删除/失效当前 lease，旧 `remainingWorkIds` 不再被读取；
7. 保留旧 run、API 请求、消息链和修改历史。

晚到的模型响应：

- 如果响应已经返回但尚未执行工具，`beforeToolCall` 拒绝；
- 如果写事务已经开始但未提交，事务回滚；
- 如果写事务在取消前已提交，修改保留，记录仍归旧 run。

## 继续机制

- 只接受 `paused` 且 `runStep` 与按钮步骤一致的 run；
- 使用原 runId、sessionId、contextId/unitId、剩余工作项和消息；
- 不重新生成队列，不重复已确认提交；
- runtime 继续进行当前人物，不回到该人物的第一步；
- 继续成功后 status 恢复 running。

## 出场统计分离

- `runCharacterOrganization` 的第三步不调用 `finalizeStatistics`。
- 保留 `updateStatistics` 独立服务能力，由单独入口触发；现有统计表和数据不删除。
- 统计失败不改变关系提交和 P2 历史。
- 检查报告、进度、备份中 `organizationSummary.statistics` 的依赖，兼容旧值。

## 按钮与 UI

`WorldPanel` 使用四个按钮：

```text
第一步：识别重复人物
第二步：优化人物资料
第三步：整理人物关系
取消整理
```

每个步骤按钮：

- 空闲：开始；
- running：显示暂停；点击后请求暂停；
- paused：显示继续；
- completed/cancelled/failed：开始。

其他两个步骤在 running/paused 时禁用。取消按钮只在有运行或暂停任务时可用。

P2 整理详情不重新设计：三步骤历史、连续 Agent 消息链、API 请求、Token、费用、修改前后和单人物记录保持现有行为。

## 文件影响

| 文件 | 改动 |
|---|---|
| `src/features/world/service.ts` | `startOrganizationStep`、`pauseOrganization`、`continueOrganization`、`cancelOrganization`、状态恢复 |
| `src/features/world/organization.ts` | `runStep` 初始化、目标步骤停止、暂停判断、取消检查、统计分离 |
| `src/features/agents/runtime.ts` | `finishTurn`/`beforeToolCall`/`prepareRequest` 暂停和取消钩子 |
| `src/features/agents/commands.ts` | 写事务前取消检查 |
| `src/features/world/WorldPanel.tsx` | 四个按钮、状态和刷新恢复 |
| `src/features/world/types.ts` | `runStep`、暂停字段 |
| 测试 | 独立步骤、暂停/继续/取消、晚到响应、刷新恢复、统计分离 |

## 测试设计

### 固定响应

- 第一步完成不进入第二步；
- 第二步独立处理完整人物列表；
- 第三步独立处理完整关系列表且不调用统计；
- 暂停检查点：第 5 次 API 后暂停，后续 32 次不执行；继续从当前人物继续；
- 取消后旧队列不被读取，新建 runId 重建完整队列；
- 取消后晚到模型响应不执行工具/写库；
- 已提交修改保留，旧 API/消息历史保留；
- 刷新恢复状态。

### 浏览器

- 三个步骤按钮与取消按钮的状态；
- running/paused 时其他步骤禁用；
- 完成后重新开始；
- 取消后重新全量开始；
- P2 整理详情三步骤历史和连续消息链不变。

### 真实模型

- 用户授权后分别独立运行三步，核对 Prompt、工具、队列和 Token；
- 暂停/继续/取消在真实关系任务上验证。

## 取舍

- **暂停在回合边界**：比等工作项结束及时，但当前已开始的工具调用允许结束；不在事务中途强杀，避免半成品。
- **取消在 DB 标记后 abort**：确保晚到响应不能写库；代价是取消需要等待当前事务落地或回滚。
- **不使用旧队列恢复取消运行**：保证“重新全量”；旧历史只读保留。
- **统计独立**：增加一个明确入口，不把统计偷偷放进第三步。
