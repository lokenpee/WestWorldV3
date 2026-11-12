# BUG-38 工具结束与提交结果一致性

## 用户要求与确认依据

2026-11-11，用户要求立即修复关系整理在查询、修改及登记待核对后无法空提交结束的问题，明确成功、部分成功及失败语义，检查其他工具，核查贾蓉有证据却显示未核实的原因。关联 REQ-019；中型局部修复，沿用当前活动变更。用户已明确修复目标、固定测试和约束：不增加业务白名单、不重构 Agent、不调用真实模型、不修改正式书库。

## 根因与影响表

| 当前行为 | 目标行为 | 影响模块与原因 | 任务 / 验收 |
|---|---|---|---|
| 无编号的关系/资料查询依赖 activeWork；结束清空它后 rebaseReadSet 重读报错，事务回滚 | 查询记录绑定首次实际人物，空提交仍从工作项获取人物 | agents/tools、commands；查询身份需跨越工作项生命周期 | 15.1 / B38-01、02 |
| 关系逐项失败仍被命令层包装 ok:true，进入成功账本 | 整次请求有失败项即 ok:false；部分成功保留真实确认；全失败无确认 | organizationCommands、commands、工具返回契约 | 15.2 / B38-03、04 |
| 旧完成回执重放会尝试结束当前 activeWork，可能已是下个人物 | 重放只认原工作项；旧轮重新挂起同工作项时核对租约后恢复完成，不重复修改资产 | commands、organizationCommands | 15.3 / B38-05 |
| 分批提交时 active.draft 的 uncertainPairs 被下一批覆盖 | 累积保留已经登记的待核对人物对 | organizationCommands | 15.1 / B38-01 |
| 普通关系保存无实际变化仍登记 changed，真实 no_change 总结被拒绝 | 按领域返回的 changed 登记真实修改 | commands、submit_result | 15.3 / B38-07 |
| 候选组 partial 按全部合并校验，提交号仅判断非空 | partial 应至少合并2人且仍有多个身份；确认号来自本轮本候选成员的实际人物合并 | organizationCommands | 15.3 / B38-08 |

权威依据：[工具返回与回放契约](../../../../docs/v2/11-AI工具返回与回放契约.md)、[关系提示词](../../../../docs/v2/resources/v2.2/prompts/active/p2-organization-relations.md)、[当前会话规格](../../../specs/agent-session/spec.md)。

## 字段变化

查询读集的 args 自动填入实际人物编号：query_character_profile 使用 id，query_relation_work 使用 characterId；不要求模型新增参数。历史省略编号的读集在提交前仍有 activeWork 时补齐，保存回任务读集。已有显式编号保持原值。

上述两种查询通过现有生命周期映射解析已合并人物编号；当前人物被合并到保留人物后，已绑定读集仍能刷新对应有效人物，避免绑定修复阻断已有跨步骤合并。

submit_relation_review 返回新增必填 status=succeeded/partial/failed（本次请求状态），ok 为布尔值；status=succeeded 时 ok:true，其他为 false。done/complete 只在请求 done=true 且无失败项时为 true。commitId 仅成功或部分成功提交存在；failed 不返回此字段且不进入 appliedCommands/appliedCommitIds。partial 的确认号仅证明其中成功部分已保存，重放保持原始状态。已有业务 outcome、applied、cumulativeApplied、uncertain、unverified、failed 含义保持；未核实不等同提交失败。合法无修改完成仍保存完成状态和确认。

pipelineRuns.appliedCommands 新增可选 unitId 字符串（非空工作项标识），命令层提交时从绑定 scope 赋值，恢复完成状态时读取并比对 activeWork.id；旧记录无此字段时沿用本次绑定工作项标识。数据库表、资产结构、备份格式无变化，存储 Schema 接受此可选字段，旧备份继续可读；沿用现有命令结果对象和 rejected 意图终态。旧结果无 status 时由 failed 及 changed 读取其实际结果，不能把失败恢复成成功。

## 数据流转

模型省略人物编号查询 → 工具读取绑定人物 A → 读集存入 A → 分批修改 B/C/D 并登记 E 等待核对 → 空 changes、done=true 读取 activeWork 的 A → 保存人物完成、清空 activeWork → 重读明确绑定 A 的查询 → 同事务提交确认 → 调度器推进下一人物。

例：A 修改 B 成功、C 自指/编号错误失败，则返回 ok:false、status:partial、applied:[B]、failed:[C]、complete:false 和真实确认号 K；修正时只重提 C。全部非法返回 failed，不生成成功账本。重复 K 返回原结果，不将当前人物 D 置完成。

## 触发逻辑与实施方法

沿用当前 Agent 工具调用和事务；固定查询身份、保留累积待核对、按领域结果决定命令是否成功、限制重放恢复到原工作项。资料工具共享查询身份修复。结构校验、租约校验、原文核验继续执行；未核实关系和显式待核对可合法完成。重复失败由已有错误止损处理，部分成功重试不重复已写内容。不新增模型请求及下游自动任务。

## 检查与验收场景

- B38-01：隔离样本 A 有20个目标，先两批省略人物编号查证，成功修改3对、登记17对待核对，跨多次 done=false 保存后空提交结束；complete=true、activeWork=null、3对修改保留、17对待核对保留，下一人物可继续。
- B38-02：资料查询省略 id 后修改及空 patch 完成；保存成功。恢复旧省略编号读集也可完成。
- B38-03：提交自指关系且 done=true；ok:false、status:failed、无 commitId、无成功账本，当前人物保留；之后空提交可完成。
- B38-04：合法修改和非法目标混批；返回 partial，合法项仅写一次，非法项可见，重放不能变为 succeeded。
- B38-05：A 已完成后绑定 B，再重放 A 原提交；不写 B、B 保持 pending。资料与关系均覆盖。
- B38-06：连续逐字引文、改写引文、错误章节、部分有效证据分别断言 verified/unverified/partial；历史贾蓉日志未提供时仅记录无法判定具体原因。
- B38-07：普通关系工具保存相同内容，changed=false；submit_result 的 no_change 总结正常接受。
- B38-08：3人候选组仅合并2人后可登记 partial；伪造确认号、其他组确认号、未合并或已全部合并时拒绝 partial。

## 接手说明

实施任务见 [任务15](../tasks.md#15-bug-38-工具结束与提交结果一致性)。本记录是 proposal/design 的本次补充，差异规格见 [Agent](../specs/agent-session/spec.md)。测试使用隔离内存/测试数据库，命令为 npm run test:unit、typecheck、lint、build、governance:check 及 OpenSpec 严格校验。实际检查和其他工具审查结果在本记录末尾补充。开发完成后保留活动变更，用户用副本自测再归档。

## 同类工具审查

基准为本轮修改前的工作区，维度为正确性；保留用户已有未提交改动。审查单位为参数/提示词→工具适配→领域操作→事务账本→完成/恢复，结论以可执行反例为依据。

| 工具链 | 检查与结果 |
|---|---|
| query_relation_work / submit_relation_review | 复现查询省略人物编号后结束失败；3对修改、17对待核对分批累计；自指失败、部分成功及重放；均已补回归并修复 |
| query_character_profile / submit_profile_review | 复现同类结束失败；新旧读集均覆盖。人物在跨步骤纠错中被合并时，查询跟随已有生命周期映射 |
| 两种专用提交的恢复路径 | 复现旧回执清空下一人物 activeWork；新增所属工作项校验和恢复前租约检查。保留旧轮同工作项重新挂起时的完成恢复，原有恢复/备份测试继续覆盖 |
| set_character_relation / delete_character_relation → submit_result | 普通关系无变化保存返回 changed=false，但上层仍登记 changed，导致真实 no_change 被拒绝；修复只在实际变化时登记。删除复用相同处理，原删除证据及事务检查保留 |
| save_candidate_group / merge_assets / resolve_candidate_group | 三人组仅合并两人后 partial 被当作全部合并校验；修正为部分身份归并，并验证确认号来自本轮该候选成员的实际人物合并。伪造确认不能进入结论 |
| clear_candidate_groups / record_organization_progress | 检查候选未处理、步骤未完成和统计未结束的拒绝分支；使用显式工作项编号，未发现与本次隐式人物身份释放相同的问题 |
| edit_character / edit_location / edit_event_node / edit_event_line | 检查读集、版本、领域修改结果、事务及报告；失败通过抛错回滚，不走关系批量失败包装路径。沿用 agents/assets 关联回归 |
| commit_asset_changes / commit_story_changes / submit_result | 检查原子提交、读集重读、账本及重复回执、最终逐项覆盖；已有多组合并失败回滚、叙事原子写入和断线回执测试覆盖；本轮未改其业务处理 |
| 其余查询工具 | 核对工具注册、参数和返回校验的共用路径，以及实际使用的显式编号/绑定会话。详情、分页、原文、记忆及历史读取由既有测试覆盖；未逐项重新审计其全部业务语义 |

已存在的事务回滚、租约核对和固定响应测试能阻止失败覆盖已提交数据；此次缺口主要在工作项生命周期、部分失败的上层包装，以及“调用成功”和“内容发生变化”的区别。检查不包括真实模型判断质量和正式书库历史数据修复。

## 贾蓉证据疑点

工作区没有用户提及的 `粘贴的文本 (1)(20261110-150723).txt`，无法取得该次提交的原始 evidence、章节编号及对应原文。已检查 evidenceProblems → submitRelationReview → saveCharacterPair → report：证据的章节须存在且属于本书，引文须为该章节连续逐字文本；全部匹配为 verified、全不匹配为 unverified、部分匹配为 partial。原文匹配只核对引用来源，不自动证明关系推论正确。

固定测试分别覆盖有效引文、改写引文、错误章节和混合证据，结果符合现有规则。不能据此断言贾蓉那条证据错误；该条的实际原因仍待原始日志核对。

## 用户副本自测

刷新修复后的应用，在书库副本继续第三步关系整理，观察最后一次空 changes、done=true 返回 complete:true、人物进度推进；已提交关系和待核对记录保留。若出现非法目标，核对 ok:false、failed 中具体原因、全失败无确认号；部分成功只重试失败项。原运行详情可继续查看；不自动重写历史报告。用户确认后再同步规格和归档。

## 实际检查记录

2026-11-11开发完成，用户验收待完成。改动前固定测试复现关系/资料结束回滚、失败误报成功、旧回执完成下一人物；追加反例复现普通关系无变化误记 changed、候选 partial 被拒绝。修复后的新增18项全部通过。

| 检查 | 结果 |
|---|---|
| `npm run test:unit -- tests/tool-completion.test.ts` | 18项通过，含完整3对修改+17对待核对场景及下一个人物完成 |
| `npm run test:unit -- --maxWorkers=2` | 最终固定版本：58个文件通过，549项通过、1项既有跳过，84.76秒 |
| `npm run typecheck` | 通过，含应用及测试类型 |
| `npm run lint` | 通过，无错误；7条警告位于本次未修改的界面文件及已有同步脚本 |
| `npm run build` | 通过；现有动态导入分包、依赖浏览器兼容与包体积警告保留 |
| `npm run prompts:sync -- --dry-run` / `npm run prompts:sync` | 预览后同步1项关系提示词哈希，请求示例无变化；工具/结果/存储资源哈希同步 |
| `npm run governance:check` | 通过 |
| `npm run openspec -- validate --all --strict` | 27项通过 |

初次默认并发全量检查中两项大样本测试超过30秒；降低并发后两项均通过。最终全量检查在代码固定后重新执行，不使用开发中的中间结果充当最终验证。

未执行真实模型、浏览器人工验收、正式书库修改、Git提交或推送。贾蓉该条证据的具体原因仍待原日志；不影响已复现结束故障的修复交付。
