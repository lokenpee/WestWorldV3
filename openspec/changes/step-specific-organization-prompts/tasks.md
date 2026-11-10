# 实施任务

关联 [BUG-34](../../缺陷池.md)、[提案](proposal.md)、[设计](design.md)、[验收](acceptance.md)及两份差异规格。代码实施和自动检查已完成；真实模型与用户验收待进行。

## 1. 提示词拆分与规则清理

- [x] 1.1 新增 `p2-organization-base.md`（权限、数据真实性、错误恢复、幂等、工具通则、跨步骤纠错边界），保留现有提示词中仍然有效的通用条款。
- [x] 1.2 新增 `p2-organization-directory.md`、`p2-organization-candidate.md`、`p2-organization-profiles.md`、`p2-organization-relations.md`，只放对应工作项规则。
- [x] 1.3 `organization.ts` 按当前 `workKind`（directory/candidate/profile/relations）拼接公共规则和工作项规则；`finalize` 不调用模型；`businessPrompt` 不再传完整三步手册。
- [x] 1.4 调整 `agent-wrapper.txt`：业务成功判定改为“当前合法写入工具返回持久确认并实际写库”；目录/疑似组保留 `submit_result`；资料/关系使用各自 done；删除 `100000`、“最后一次只能调用 submit_result”、通用“写入结构/领域/总结共用一次修正机会”等旧规则。
- [x] 1.5 更新提示词资源归属和校验哈希；旧 `p2-character-organization.md` 的去留及引用入口在实施时处理，不保留双重权威。
- [x] 1.6 通用 wrapper 的 `budgetRule`/`submitRule`/`repairRule`/`finishRule` 按 P2 工作项注入；P1/P3 和其他 Agent 保持原规则不变。检查 T13。

## 2. 默认工具集与工作项绑定

- [x] 2.1 运行器/工具装配接收固定工作项身份（workKind、step、contextId、workId/unitId、characterId）；提示词和工具集由 workKind 决定；dataVersion/targetId 可更新。
- [x] 2.2 工具过滤器只移除不属于当前工作项的专用完成/进度工具：资料/关系不提供 `submit_result`，资料不提供 `submit_relation_review`，关系不提供 `submit_profile_review`，资料/关系不提供 `record_organization_progress`。
- [x] 2.3 保留跨步骤查询、候选组、`merge_assets`、资料编辑、关系设置/删除工具，不能把它们从第二、三步删除；如未来要按需启用，另立变更。
- [x] 2.4 同一人物多轮 API 使用同一 `contextId/unitId`；换人物或换步骤新建上下文；工具提交导致步骤切换时结束旧运行，下一次重新取持久 step。
- [x] 2.5 在最终 `streamFunction` 记录实际 System Prompt、消息和工具 Schema；测试不以组织层的配置代替实际请求。
- [x] 2.6 后续候选生命周期：任何工作项保存的候选写入同一持久 `candidateGroups`；可在当前上下文 resolve，或在下一人物/步骤/finalize 前作为 candidate 工作项处理；需改调度器的 pending 优先级和恢复原工作项逻辑，`submit_result` 只结束 candidate 自身，不能推进主步骤；pending 组阻止完成，`clear_candidate_groups` 不得清除后续 pending 或候选结论。
- [x] 2.7 数据版本：固定工作项身份/提示词/工具配置；本次工作项自己的 done=false/编辑/合并/补查成功后更新有效 `dataVersion/targetId`；其他操作或真实冲突必须先重读并核对旧修改，不能只更新版本直接重放；提交仍校验真实 DB 版本，当前项不因自身修改重排。
- [x] 2.8 进度失效：合并只失效参与成员及其资料/关系/人物对；资料编辑只失效目标资料项；关系编辑只失效对应人物对；无关 checked 项保留，不冒充其他步骤完成。

## 3. 测试与验收

- [x] 3.1 固定响应测试：第二步 System Prompt 不含第一/三步长篇规则；工具列表无 `submit_result`、`submit_relation_review`，但仍有候选/合并/资料编辑/关系编辑能力。
- [x] 3.2 固定响应测试：第三步 System Prompt 不含第一/二步长篇规则；工具列表无 `submit_result`、`submit_profile_review`，但仍有候选/合并/资料编辑/关系能力。
- [x] 3.3 完成路径：目录/疑似组 `submit_result`；资料只用一次 `submit_profile_review(done=true)` 完成；关系 `submit_relation_review` 完成增删改；跨步骤纠错不能把其他步骤标记完成。
- [x] 3.4 上下文路径：同一人物两次 API 不重复创建上下文；下一人物不出现上一人物的工具、提示词和旧消息；暂停/恢复和步骤切换正确。
- [x] 3.5 最终请求路径：人物任务 JSON 只有一份；实际工具 Schema 与默认集合一致；已记录真实单人/8人的 System Prompt 长度、工具 Schema 字节、输入 Token 和缓存读取；供应商未返回费用。
- [x] 3.6 注册 `npm run typecheck`、lint、单元测试、世界/叙事开发/生产浏览器测试、build、治理和 OpenSpec 校验。
- [ ] 3.7 生命周期测试：第三步当前人物中途保存 pending 候选→插入 candidate→`submit_result` 只结束 candidate→恢复原人物上下文；uncertain/partial 结论持久；pending 时 P2 不能完成；clear 不清除新候选。检查 T10。
- [ ] 3.8 版本测试：done=false 后自身写库更新版本，再用专用提交不假冲突；外部版本 156→157 时重读核对旧修改，不直接重放；真实 DB 冲突仍拒绝，当前项不重排。检查 T11。
- [x] 3.9 进度失效测试：第二步合并后只重查受影响人物；第三步合并后只重查受影响关系；第三步编辑非关系资料不重置全部人物对。检查 T12。
- [x] 3.10 非 P2 回归：P3/其他 Agent 的 System Prompt、工具集、提交和总结行为不变。检查 T13。
- [x] 3.11 scan/resolve 回归：目录和疑似组仍使用各自提示词/工具及 submit_result。检查 T14。
- [x] 3.12 用户授权后用真实单人/8 人复核 P2；P3 仅做自动回归。未验收不归档、不提交 Git。

当前进展：`npm run typecheck`、全量单元测试（476 通过 / 3 跳过）、`npm run build`、`npm run governance:check`、OpenSpec 严格校验及世界/叙事/Agent 开发与生产浏览器测试（38 项）通过。`tests/organization.test.ts` 覆盖第二步/第三步候选优先调度、写后版本和跨步骤失效范围；`tests/agents.test.ts` 覆盖 P3 包装提示词未受影响。

真实单人（贾政，1 次请求，输入 12602/输出 297）和真实 8 人小批（8/8 资料项，18 次请求，输入 198451/输出 4896/缓存读取 257920）已通过；实际工具集和第二步提示词符合拆分要求，无工具错误。尚未完成：3.7、3.8 的候选插入恢复和外部并发冲突端到端测试；用户自测确认。

## 依赖与边界

- 1.x → 2.x → 3.x。
- 不改资产工具的业务语义、不新增删除人物能力、不改变 done=true 保存并换人的行为。
- 提示词、工具集、上下文必须绑定工作项快照，不能由模型调用中途重新读取全局步骤。
- 重复人物资料注入是独立问题，沿用已完成的去重修复和回归；本变更不把它作为提示词拆分的替代。
