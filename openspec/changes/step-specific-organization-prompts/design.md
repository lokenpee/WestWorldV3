> 2026-11-11 后续变更：P2 四份工作项提示词已改为各自独立完整文件，删除 `p2-organization-base.md`；`agent-wrapper.txt` 已删除，作用域/预算/结束约束由 `runtime.ts` 直接生成。以下“公共规则 + 工作项规则”和 wrapper 描述为历史实施记录。

# 设计：按工作项拆分 P2 提示词与默认工具

## 总体结构

```text
organization.step
  ├─ scan      → 目录页独立提示词
  ├─ resolve   → 疑似组独立提示词
  ├─ profiles  → 人物资料独立提示词
  ├─ relations → 人物关系独立提示词
  └─ finalize  → 程序处理，不调用模型

最终模型输入 = 当前工作项提示词 + 当前人物/上下文资料 + 默认工具 Schema + 已有消息
```

提示词、工具集、消息上下文由运行时开始时的**工作项快照**决定，而不是由模型调用过程中可能变化的全局 `organization.step` 临时读取。

## 提示词文件

| 文件 | 内容 | 使用时机 |
|---|---|---|
| `p2-organization-directory.md` | 目录页读取、字段范围、疑似组保存、进度登记、submit_result | `scan` |
| `p2-organization-candidate.md` | 完整资料、合并、结论、submit_result | `resolve` |
| `p2-organization-profiles.md` | 当前人物资料、其他资产补查、submit_profile_review/done | `profiles` |
| `p2-organization-relations.md` | 当前人物关系、关系读写、submit_relation_review/done | `relations` |

组合规则：`systemPrompt` = 通用 wrapper + `base` + 当前工作项提示词。当前工作项提示词不得包含其他步骤的完整操作手册。

## 规则清理

运行时直接生成的通用结束规则不能无条件进入所有 P2 工作项。按工作项注入：

| 规则 | 目录/疑似组 | 人物资料 | 人物关系 |
|---|---|---|---|
| 业务成功判定 | 合法写入工具返回持久确认并实际写库 | 同左 | 同左 |
| 结束方式 | `submit_result` 独占本批 | `submit_profile_review` 的 `done` | `submit_relation_review` 的 `done` |
| 总结/剩余项 | 保留目录/组结论规则 | 不做额外模型总结 | 不做额外模型总结 |
| 修正次数 | 按当前工具错误反馈处理，不写固定通用次数 | 同左 | 同左 |
| 请求额度 | 不设固定上限 | 不设固定上限 | 不设固定上限 |

通用文案改为“业务修改是否成功，以当前合法写入工具返回的持久化确认和实际数据库提交为准”，不再只列 `commit_asset_changes`/`commit_story_changes`。

## 默认工具集

### 所有工作项保留

- 读取：`query_characters`、`get_character_detail`、`query_locations`、`get_location_detail`、`query_nodes`、`get_node_detail`、`query_event_lines`、`get_event_line_detail`、`read_original`、`get_character_relation`、`get_legacy_relation_records`。
- 跨步骤纠错：`merge_assets`、`edit_character`、`edit_location`、`edit_event_node`、`edit_event_line`、`set_character_relation`、`delete_character_relation`。
- 候选处理：`save_candidate_group`、`query_candidate_groups`、`resolve_candidate_group`、`clear_candidate_groups`、`query_character_catalog`、`get_organization_progress`。
- 当前人物专用查询：`query_character_profile`、`query_relation_work` 按需保留，不能因为不在当前步骤就隐藏。

这些工具不是“当前步骤已完成”的声明。它们用于发现遗漏疑似同人、资料错误或关系错误时纠错。

### 专用完成/进度工具

| 工具 | 目录页 | 疑似组 | 人物资料 | 人物关系 |
|---|---:|---:|---:|---:|
| `submit_result` | 是 | 是 | 否 | 否 |
| `record_organization_progress` | 是 | 是 | 否 | 否 |
| `submit_profile_review` | 否 | 否 | 是 | 否 |
| `submit_relation_review` | 否 | 否 | 否 | 是 |

不提供直接删除人物的工具；`delete_character_relation` 只修改人物关系。

### 不做的限制

本阶段不移除跨步骤候选、合并、编辑和关系工具，也不以“默认工具”名义做事实上的硬白名单。若未来要减少这些工具，必须另立变更设计按需启用入口。

## 通用 wrapper 的作用域

- 运行时按 `workKind` 为 directory/candidate/profile/relations 注入对应结束规则。
- P3、P1 和其他 Agent 继续使用原有通用结束规则、工具集和错误恢复；P2 的 `submit_result`/done/候选规则不能外溢。
- `submitRule`、`repairRule`、`finishRule` 必须按工作项选择，不能把第二步/第三步的 done 规则写回全局 wrapper。
- 增加非 P2 回归：比较改动前后 P3 请求的 System Prompt、工具 Schema、`submit_result` 行为和恢复路径。

## 工作项快照

运行时开始处理一个工作项时分成两组状态：

```ts
// 当前执行期间固定
{
  workKind, step, contextId, workId, unitId, characterId,
  promptKey, toolSetKey, startedAt
}

// 允许随真实写库更新的业务数据
{
  dataVersion, targetId
}
```

- `workKind` 是 directory/candidate/profile/relations；提示词和默认工具集由 `workKind` 选择，不只看全局 `organization.step`。这样第二步/第三步发现的新候选可以以 candidate 工作项插入处理。
- 同一人物多轮 API 使用同一 `contextId/unitId`，继续同一消息数组。
- 工具提交导致工作项或步骤切换时，当前运行结束；下一次运行重新读取持久状态，使用新的工作项快照。
- 暂停、恢复、刷新后按持久工作项恢复；不把旧人物/旧步骤消息重新装入。
- `runId`/`sessionId` 只表示业务轮次和会话归属，不等于把所有历史重新发送。


## 后续新增疑似组的生命周期

候选组不是只属于第一步。第二、三步保存的候选必须进入同一份持久 `candidateGroups`，并遵循以下规则：

1. `save_candidate_group` 在任何工作项都可保存，初始 `status=pending`。
2. 当前工作项可以立即读取并 `resolve_candidate_group`；结论写入 `candidateDecisions`。
3. 当时不能判断时，必须调用 `resolve_candidate_group` 记录 `uncertain` 或 `partial`；这是持久结论，不能只把模型文本留在消息里。
4. 没有结论的 `pending` 组由调度器在当前工作项结束后、下一人物/步骤/finalize 前作为 candidate 工作项处理。candidate 工作项使用候选提示词和候选工具，即使当前 `organization.step` 仍是 profiles/relations。
5. 调度器需要新增“pending 候选优先”分支：profiles/relations 的 `nextUnit` 先检查 pending 候选；candidate 工作项完成后，仍按原 `organization.step` 和当前 profile/relation 待办继续，不把主步骤切回 resolve，也不清空原人物任务。
6. `submit_result` 只结束当前 candidate 工作项的模型回合；候选组的状态由 `resolve_candidate_group` 更新。不能把 `submit_result` 解释为推进整个 P2 步骤。
7. `clear_candidate_groups` 仍只在第一步 resolve 阶段使用；它只清空已解决的第一阶段工作集，不能清空后续 pending 组，也不能清除 `candidateDecisions`。
8. P2 只有在 `profileItems`、`relationItems`、`pairChecks` 完成且 `candidateGroups` 没有 `pending` 组时才可进入完成；有 pending 组必须继续处理。
9. 候选处理失败或刷新恢复时保留组和错误状态，不重新生成候选，不把未结论组计入已完成。

**实施核对**：当前 `nextUnit` 只在 `resolve` 步骤处理候选，`submit_result` 是通用任务总结；不要声称现有调度已经支持“后续候选插入”。实施时必须修改/验证调度器，不改资产工具的业务语义。

## 业务数据版本

- `dataVersion` 不属于固定运行配置。开始工作项时读取一次，作为首次提交的版本基准。
- **本次工作项自己的成功写库**（`done=false`、当前人物的 `edit_character`、当前工作项的合法合并/关系写入）：使用成功提交后返回的最新版本更新 `activeWork.dataVersion/targetId`；下一次 `submit_profile_review(done=true)` 可基于这次已确认的写入继续处理。
- **其他操作修改了数据，或出现真实版本冲突**：不能只把 `dataVersion` 改成最新值后重放旧 patch。必须重新读取当前人物/关系，核对原修改是否仍成立，重新生成或放弃旧修改，再提交。
- `submit_relation_review`/关系编辑成功后更新当前人物或关系上下文的有效版本；提交仍校验真实数据库版本，不得跳过冲突保护。
- 若跨步骤合并把当前人物映射到其他编号，按生命周期解析 keepId 并更新当前工作项目标；当前目标已不存在时，只重建该工作项和受影响的资料/关系项。
- 读取补查、冲突恢复成功后刷新有效版本；不能把旧的初始 `dataVersion` 永久沿用。
- 当前工作项自己刚才的合法修改不能让当前资料项立即重新排队；失效只作用于其他受影响项，当前 activeWork 保持并可继续提交。

## 跨步骤修改的进度失效

- `merge_assets`：只使实际参与合并的成员、其资料/关系项和涉及这些成员的人物对失效；用生命周期把编号重定向到保留编号；不受影响的已完成项保持 checked。
- `edit_character`（非关系资料）：只使目标人物的资料项和当前工作项版本失效；没有改变关系数据时，不重置无关人物对。
- `set_character_relation`/`delete_character_relation`：只使受影响人物对失效；人物资料项保持原完成状态。
- 跨步骤编辑/合并不能把第二步或第三步标记为完成；它只写真实资产和确认号，当前步骤的完成仍由对应提交工具决定。
- 重新检查只针对失效项；不因一次合并重建全部人物/关系，不重置无关人物的 checked 状态。

## 字段与数据流

| 内容 | 变化 |
|---|---|
| 持久化字段 | 无新增业务字段；`organization.step`、`contextId`、`unitId` 继续作为归属依据。 |
| `organization.candidateGroups` | 不新增字段；任何工作项保存的候选都进入同一数组，`status=pending/resolved`；`uncertain/partial` 写入 `candidateDecisions` 并持久保留。 |
| `activeWork.dataVersion/targetId` | 不属于固定快照；成功写库、补查或冲突恢复后更新；提交仍校验真实 DB revision。 |
| `businessPrompt` | 从原完整 `p2-character-organization.md` 拆分为“公共 + 当前工作项”的组合文本，不持久化新副本。 |
| 工具集 | 运行时派生，不写入数据库；请求日志记录实际工具名和 Schema 快照。 |
| 请求记录 | 使用现有 `request_trace` 的提示词/工具快照，不需要新表。 |
| 备份 | 不改格式；提示词资源文件随应用版本，请求快照随书保存。 |

数据流：

```text
读取 organization.step + activeWork + workKind + contextId/unitId
  → 若有 pending 候选，优先创建 candidate 工作项
  → 选择公共规则和当前工作项规则
  → 选择默认工具集（保留跨步骤纠错工具）
  → 按 contextId/unitId 加载当前消息
  → 进入最终 streamFunction
  → trace 记录实际 System Prompt、消息和工具 Schema
  → 工具提交推进工作项/步骤；成功写库后更新 dataVersion 和受影响进度
  → 下一次运行重新取工作项快照
```

## 触发与失败

| 触发 | 处理 |
|---|---|
| 开始目录/疑似组/资料/关系 | 取当前 step，组装对应提示词和工具集 |
| 同一人物第二次 API | contextId/unitId 不变，继续同一消息；不重复创建上下文 |
| 切换到下一人物 | 新建该人物对应 contextId 的上下文，不继承上一人物消息 |
| 第二步切换到第三步 | 当前第二步运行结束，第三步新上下文使用关系提示词/工具 |
| 工具提交成功 done=true | 程序推进；下一次运行重新取 step，不中途换提示词 |
| 工具返回跨步骤资产错误 | 当前合法纠错工具继续可用，返回具体错误和恢复动作；不能冒充当前步骤完成 |
| 工具提交后步骤变化 | 旧运行停止；新运行读取持久 step，提示词/工具集不沿用旧快照 |
| 后续新增候选 | 保存 pending；可立即 resolve，或在下一人物/步骤/finalize 前作为 candidate 工作项处理；pending 不允许 finalize |
| done=false 后继续 | 成功写库更新 dataVersion/targetId；下一次提交使用最新版本并仍校验真实 DB |
| 跨步骤合并/编辑 | 只失效受影响人物、关系和人物对；不重置无关 checked；不冒充其他步骤完成 |
| 最终请求异常 | 记录实际 System Prompt/工具/消息，不把配置层的预期当作已发送内容 |
| 重复任务 JSON | 单独去重并校验；拆分提示词不能替代该修复 |

## 验收方法

- 固定响应测试捕获每次请求的实际 `body.messages` 和 `body.tools`。
- 对第二步请求检查：无第一/第三步长篇规则；无 `submit_result`、`submit_relation_review`；仍有候选/合并/资料编辑/关系编辑工具。
- 对第三步请求检查：无第一/第二步长篇规则；无 `submit_result`、`submit_profile_review`；仍有候选/合并/资料编辑/关系工具。
- 检查同一人物两次请求上下文相同，下一人物不出现上一人物消息。
- 比较拆分前后同一真实样本的 System Prompt 长度、工具 Schema 字节、输入 Token、缓存和费用。

## 与 REQ-019 的关系

保留：三步顺序、逐人物上下文、跨步骤查询/候选/合并/编辑、同一会话、done 语义、无固定额度、无额外总结、不删除资产。

变更：REQ-019 原有“提示词和工具集不随步骤变化”“全工具集始终注册”的条款。新的默认工具集仍保留跨步骤纠错能力，但不再把每个专用完成/进度工具都发给所有步骤。具体替代关系见[提案](proposal.md#需要变更的-req-019-条款)。
