> 2026-11-11 后续变更：P2 四份工作项提示词已改为各自独立完整文件，删除 `p2-organization-base.md`；`agent-wrapper.txt` 已删除，作用域/预算/结束约束由 `runtime.ts` 直接生成。以下“公共规则 + 工作项规则”和 wrapper 描述为历史实施记录。

# P2 提示词与默认工具按工作项拆分

## 为什么

当前 P2 每次模型调用都把完整的 `p2-character-organization.md` 作为 System Prompt，里面同时包含目录页、疑似组、人物资料、人物关系四段操作说明；`createAgentTools` 对人物整理只去掉了 `commit_asset_changes`，其余工具全部发给模型。结果是：

- 第三步请求仍携带第一步、第二步的长篇规则，目录和疑似组的结束约束也会进入当前上下文。
- 第二步能看到 `submit_result`、`submit_relation_review` 等不属于当前工作的完成工具，靠提示词“不要调用”约束，既浪费工具 Schema token，也存在误调用风险。
- 旧的通用规则仍写“只有 commit_asset_changes/commit_story_changes 才算成功”“写入结构、领域和最终总结共用一次修正机会”，与 `submit_profile_review`/`submit_relation_review` 的逐人物流程冲突。
- 现有 REQ-019 设计的一条边界是“步骤表示工作顺序，不隔离合法资产工具”，因此不能简单把跨步骤工具全部禁用。

## 目标

1. System Prompt 只发送“P2 公共规则 + 当前工作项规则”，不再每次发送三步手册。
2. 默认工具集按当前工作项精简，但保留跨步骤查询、候选组、合并、资料编辑和关系编辑能力。
3. 专用完成工具只保留当前工作项的入口：目录/疑似组用 `submit_result`，资料用 `submit_profile_review`，关系用 `submit_relation_review`。
4. 提示词、工具集和消息上下文都绑定当前工作项快照；同一人物多轮调用沿用同一上下文，换人物或换步骤不继承旧消息。步骤/工作项身份和配置固定，业务 `dataVersion` 在成功写库后更新。
5. 以最终 `streamFunction` 收到的 System Prompt、消息和工具 Schema 验收，而不是只看配置代码。
6. 重复人物资料注入是独立问题，继续单独修复和验证，不用提示词拆分掩盖。
7. 第二、三步发现的新候选组必须持久化并可继续核实/合并/记录未决；调度器需要在下一人物/步骤/finalize 前插入 candidate 工作项，完成候选后回到原工作项，不能把主步骤切回 resolve 或结束原人物。pending 组不能被清空或让 P2 误判完成。
8. 跨步骤合并/编辑只使实际受影响的人物、关系和人物对重新检查，不重置无关已完成项，也不冒充其他步骤完成。
9. P2 的分步结束规则不能改变 P3 或其他 Agent 的提示词与提交行为。

## 保留的 REQ-019 约束

- 三步是工作顺序，不是资产类型隔离；第二、三步发现遗漏疑似同人、资料错误或关系错误，仍可查询、保存候选、合并、编辑。
- 同一 P2 轮次共用 `runId`/`sessionId`；第二、三步按人物建立独立工作上下文；同一人物多轮 API 继续当前上下文。
- `done=true` 保存并结束当前人物；不额外请求模型总结。
- 不设置固定请求/token 上限；不强制完整阅读证明。
- 不允许直接删除人物、地点、节点、事件线；合并是保留编号的资产操作，不是直接删除。
- `delete_character_relation` 删除的是人物关系，不是人物本身；第三步及跨步骤纠错仍可使用。

## 需要变更的 REQ-019 条款

| 原条款 | 处理 |
|---|---|
| “profile及工具集不随步骤变化”“全工具权限不随阶段改变”（REQ-019 design） | 变更为：System Prompt 按工作项拆分；默认工具集按工作项精简，但跨步骤纠错工具保留，不在本阶段做硬禁用。 |
| “三步使用统一提示词” | 变更为：公共规则 + 当前步骤规则；其他步骤的长篇操作说明不进入当前 System Prompt。 |
| “所有步骤使用同一完整工具集” | 变更为：默认工具集可不同；只移除不适用于当前工作的专用完成/进度工具，跨步骤查询、候选、合并、编辑、关系工具继续可用。 |
| 通用提示词中的 submit_result、commitId、修正次数约束 | 按步骤替换；目录/疑似组保留 submit_result；资料/关系使用各自 done 提交；不把目录结束规则带进第二、三步。 |

## 具体方案

### 提示词拆分

拆成公共规则和四个工作项规则：

- 每个 P2 工作项提示词独立包含书籍权限、数据真实性、错误恢复、幂等、工具调用通则和当前工作项规则，不再保留公共 base。
- `p2-organization-directory.md`：目录页读取、候选保存、进度登记、submit_result。
- `p2-organization-candidate.md`：疑似组完整资料、merge_assets、结论、submit_result。
- `p2-organization-profiles.md`：当前人物资料、其他资产补查、submit_profile_review 的 done 语义。
- `p2-organization-relations.md`：当前人物完整关系、关系读写、submit_relation_review 的 done 语义。

`organization.ts` 按 `organization.step` 只拼接公共规则和当前规则；`finalize` 由程序完成，不调用模型。

### 默认工具集

工具分三层：

1. **所有工作项可用的读取/纠错能力**：人物、地点、节点、事件线、原文、关系读取；`merge_assets`；`edit_character`/`edit_location`/`edit_event_node`/`edit_event_line`；候选组的保存/查询/核实工具；`set_character_relation`/`delete_character_relation`。这些工具保留是为了跨步骤纠错，不是“当前步骤完成”的声明。
2. **当前工作项专用完成工具**：
   - 目录页/疑似组：`record_organization_progress`、`submit_result`。
   - 人物资料：`submit_profile_review`。
   - 人物关系：`submit_relation_review`。
3. **当前工作项明确不需要的完成工具**：
   - 第二步不提供 `submit_result`、`submit_relation_review`。
   - 第三步不提供 `submit_result`、`submit_profile_review`。
   - 第二步、第三步不提供 `record_organization_progress`。
   
如果后续要移除跨步骤候选/合并/编辑/关系工具，必须先设计明确的按需启用路径；本阶段不使用“默认集合”名义做硬禁用。

### 上下文绑定

- 每次运行开始时固定工作项身份和执行配置：`workKind`、`step`、`contextId`、`workId/unitId`、人物编号、`promptKey`、`toolSetKey`。
- `dataVersion` 不属于永久固定配置：本次工作项自己的成功写库、补查或冲突恢复后可以更新；但其他操作改了数据或发生真实冲突时，必须重新读取并核对旧 patch 是否仍有效，不能只更新版本后直接重放旧修改。
- 提示词、工具集由固定工作项快照选择；工具提交导致工作项/步骤切换后，旧运行立即结束，下一次运行重新取持久状态，不中途换系统提示词。
- 加载消息只按当前 `contextId/unitId`；同一人物多轮沿用，下一人物/下一步骤不继承旧工具调用和旧提示词。
- `runId`/`sessionId` 保持不变，用于业务归属和恢复；不代表把其他工作项消息重新装入当前请求。
- 第二、三步保存的新候选组保持 pending；既可在当前上下文立即核实，也可在下一人物、下一步骤或 finalize 前作为 candidate 工作项处理。未决必须写成 `uncertain/partial` 结论，不能悄悄丢失。
- `clear_candidate_groups` 仍只清空第一步已解决的工作集，不能清掉后续 pending 组或持久结论；有 pending 组时不允许 P2 完成。
- 跨步骤合并/编辑只失效受影响的人物资料、关系项和人物对；无关已完成项保持 checked，不因一次修改全量重做。

### 最终请求核验

在 `streamFunction` 记录最终 System Prompt、消息和工具 Schema；测试比对：

- 当前步骤提示词不包含其他步骤的长篇正文。
- 实际工具列表与默认集合一致；不出现错误步骤的专用完成工具。
- 人物任务 JSON 只有一份，旧步骤/旧人物消息不进入当前上下文。
- 记录拆分前后输入 Token、缓存、输出和费用。

## 实施顺序

1. 先拆提示词、清理旧规则、按步骤选择专用完成工具；保留跨步骤纠错工具。
2. 用固定响应测试和最终 API 载荷核对；再观察真实用量。
3. 如仍需减少工具 Schema Token，再单独设计按需启用机制，不能直接把跨步骤能力删掉。

## 确认依据

2026-11-08 用户明确要求：提示词按工作项拆分；不能把工具限制成硬白名单；第二、三步保留跨步骤查询、编辑、合并和候选处理；专用完成工具可按工作项精简；提示词和工具集绑定当前工作项；验收最终 streamFunction 请求；先改文档，审核后再改代码。

## 接手说明

读本提案、[设计](design.md)、[任务](tasks.md)、[验收](acceptance.md)及差异规格后接手。当前代码入口：`src/features/world/organization.ts`、`src/features/agents/tools.ts`、`src/features/agents/runtime.ts`、`src/features/agents/organizationCommands.ts` 及 `docs/v2/resources/v2.2/prompts/active/p2-organization-*.md`。代码与自动检查已完成，真实模型和用户验收待进行。
