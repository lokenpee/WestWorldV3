# 验收

关联 [BUG-34](../../缺陷池.md)、[提案](proposal.md)、[设计](design.md)和[任务](tasks.md)。代码实施和自动检查已完成，真实模型与用户验收待进行。

## 场景

| 编号 | 前置与操作 | 必须结果 | 当前证据 |
|---|---|---|---|
| T01 第二步提示词 | 进入 profiles，捕获最终 streamFunction 的 System Prompt | 只含公共规则和第二步规则；不含第一/三步目录、候选、关系操作手册；不含 `submit_result` 结束要求或 `100000` 旧预算 | 已通过：`tests/organization.test.ts` 捕获第二步最终 System Prompt，未包含 `100000`、“最后一次只能调用submit_result”及其他步骤长篇规则。 |
| T02 第二步工具 | 同上，捕获最终请求的工具 Schema | 不提供 `submit_result`、`submit_relation_review`、`record_organization_progress`；仍提供候选组、`merge_assets`、资料编辑、关系设置/删除等跨步骤纠错工具 | 已通过：同一测试捕获最终工具 Schema，资料工作项无 `submit_result`、`submit_relation_review`、`record_organization_progress`，保留 `merge_assets`、资料编辑和关系工具。 |
| T03 第三步提示词/工具 | 进入 relations，捕获最终请求 | 只含公共规则和第三步规则；不提供 `submit_result`、`submit_profile_review`、`record_organization_progress`；仍保留候选、合并、资料编辑和关系工具 | 已通过：同一测试捕获关系工作项最终请求，无 `submit_result`、`submit_profile_review`、`record_organization_progress`，保留候选、合并、资料编辑和关系工具。 |
| T04 完成工具 | 目录、资料、关系各跑一条固定响应 | 目录/疑似组用 `submit_result`；资料只用 `submit_profile_review(done=true)` 完成；关系用 `submit_relation_review` 完成；跨步骤编辑不能冒充其他步骤完成 | 已通过：固定响应和浏览器世界用例完成目录/疑似组 `submit_result`、资料 `submit_profile_review(done=true)`、关系 `submit_relation_review`；跨步骤编辑不会登记其他步骤完成。 |
| T05 工作项上下文 | 同一人物连续两次 API，再切换到下一人物；刷新恢复 | 同一人物共用 contextId/sessionId 和消息；不重复创建上下文；下一人物不带上一人物工具调用、提示词或消息；恢复后仍按持久 step/工作项 | 已通过：`每个工作项使用独立上下文` 验证同一人物多轮沿用、换人物/步骤不继承旧提示词和工具；暂停/恢复由世界浏览器用例验证。 |
| T06 最终 API 载荷 | 真实请求或固定响应，检查 streamFunction 输入 | System Prompt、消息、工具 Schema 与实际发送一致；人物任务 JSON 只有一份；不残留其他步骤/人物历史 | 已通过：最终请求只含一份人物任务 JSON；系统提示词、消息和工具 Schema 取自 trace 的最终 `streamFunction` 快照。 |
| T07 Token 比较 | 同一固定样本拆分前后各请求 | 记录 System Prompt 长度、工具 Schema 字节、输入 Token、缓存、费用和工具调用；不能只看工具数量 | 已记录真实单人/8人：单人 System 2465 字、业务 1517 字、工具 Schema 28038 字节、输入 12602/输出 297；8人 System 每请求 2465 字、工具 Schema 每请求 12461 字节、输入 198451/输出 4896/缓存读取 257920。费用未由供应商返回。拆分前基线未保留。 |
| T08 跨步骤纠错 | 第二步发现疑似同人或资料错误，第三步发现关系/资料错误 | 仍可保存候选、查询、合并、编辑资料或关系；不能把其他步骤标记已检查完成；原有进度和待办不被破坏 | 已通过：资料/关系工作项保留候选、合并、资料编辑和关系增删工具；浏览器用例验证第三步删除误连关系只修改一次，未冒充其他步骤完成。 |
| T09 真实模型 | 用户授权 DeepSeek Flash，单人/8 人 | 第二步实际提示词和工具符合本变更；无重复任务；done=true 直接换人；资产修改可核对 | 已通过真实单人（1 次请求，资料项完成）和真实 8 人小批（8/8 资料项完成，18 次请求，无工具错误）；证据见实际记录。P3 只做自动回归，未跑真实模型。 |
| T10 后续候选生命周期 | 第三步处理人物关系时保存 pending 疑似组；中途插入 candidate 工作项并提交结论，再恢复原人物 | candidate 工作项只结束自身，submit_result 不推进主步骤、不结束原人物；候选可立即处理或持久 pending；uncertain/partial 写持久结论；原人物进度保留；pending 时 P2 不能完成；clear 不清除后续候选 | 部分完成：`nextUnit` 单测验证 pending 候选优先插入并在完成后恢复原资料项；真实 8 人只覆盖资料项，候选插入/恢复和 pending 阻止完成仍待补。 |
| T11 数据版本更新 | 第二步 done=false 成功；再用自己的 edit_character/merge_assets 后 done=true；另模拟其他操作把版本从 156 改到 157 后尝试提交旧 patch | 自己的工作项成功写库后 dataVersion/targetId 更新且不重排当前项；外部修改/真实冲突时先重读并核对旧修改，不直接重放；真实 DB 冲突仍拒绝 | 部分完成：写后版本单测验证自身 `edit_character`/`merge_assets` 更新 `dataVersion` 且当前项不重排；done=false 已有测试，外部 156→157 冲突重读待补端到端用例。 |
| T12 跨步骤进度失效 | 第二步合并重复人物；第三步合并人物或编辑非关系资料；观察当前工作项 | 只重查参与合并/实际受影响的人物、关系项和人物对；当前工作项自己刚完成的修改不被重新排队；无关 checked 项保持；跨步骤编辑不冒充其他步骤完成 | 已通过：写后单测验证合并只失效参与人物/关系/人物对、当前项保留，关系编辑只失效对应人物对，无关 checked 项保持。 |
| T13 非 P2 回归 | P3 复核/串联和其他 Agent 请求 | P3/其他 Agent 的 System Prompt、工具集、submit_result/总结和错误恢复与变更前一致；P2 分步规则不外溢 | 已通过：`tests/agents.test.ts` 断言 P3 系统提示词仍含原 `submit_result` 收尾规则且不含 P2 工作项预算；叙事开发/生产浏览器用例通过。 |
| T14 scan/resolve | 目录页和疑似组各跑一条固定响应 | 目录使用目录提示词/工具和 submit_result；疑似组使用候选提示词/合并/结论和 submit_result；不因拆分导致第一步无法完成 | 已通过：固定响应世界用例完成目录页和疑似组，目录/候选仍使用各自规则与 `submit_result`；组织单测和开发/生产浏览器用例通过。 |
| T15 用户验收 | T01–T14 完成 | 用户确认提示词、工具、上下文和实际用量；未确认不归档、不提交 Git | 真实单人/8人已完成，待用户自测确认。 |

## 实际记录

| 日期 | 工作 | 结果 | 证据及限制 |
|---|---|---|---|
| 2026-11-08 | 文档阶段 | 登记 BUG-34；确认当前发送完整三步提示词、仅过滤 commit_asset_changes；明确保留 REQ-019 跨步骤纠错能力，不采用硬白名单 | 当时待用户审阅；代码未修改 |
| 2026-11-08 | 补充审查意见 | 补后续候选生命周期、dataVersion 更新、跨步骤合并/编辑失效范围、非 P2 wrapper 回归、scan/resolve 场景 | 设计、任务、验收及两份规格已更新；治理与 OpenSpec 校验通过 |
| 2026-11-08 | 二次补充审查 | 明确 candidate 工作项插入/恢复、submit_result 只结束自身、自身写库与外部版本变化的区别、当前项不重排；验收编号连续为 T01–T15 | 当时文档已同步；代码未修改 |

| 2026-11-08 | 代码实施与自动检查 | 提示词按目录/候选/资料/关系拆分，工作项专用完成工具按类型装配，跨步骤查询/候选/合并/编辑保留；候选优先调度、写后版本与进度失效已接入 | `npm run typecheck`、全量单元测试 476 通过 / 3 跳过、`npm run build`、`npm run governance:check`、OpenSpec 严格校验通过 |
| 2026-11-08 | 浏览器回归 | 世界、故事、Agent 开发与生产用例全部通过；修复测试对块式任务消息的解析，并恢复代码整理报告入口 | `npx playwright test --config playwright.workspace.config.ts world.spec.ts story.spec.ts agents.spec.ts`：38 项通过 |
| 2026-11-08 | 真实单人 | DeepSeek Flash 完成贾政资料工作项；1 次请求，输入 12602/输出 297，缓存读取 0；实际工具 26 个，无 `submit_result`、`submit_relation_review`、`record_organization_progress`，保留 `submit_profile_review`、`merge_assets`、资料/关系编辑；系统提示词只含第二步规则 | `test-results/live-single-character.json`；结论为 uncertain、无修改，资料与依据一致 |
| 2026-11-08 | 真实8人小批 | DeepSeek Flash 完成 8/8 资料项，均为 changed；18 次请求、18 条执行号、无工具错误；输入 198451/输出 4896/缓存读取 257920；每个请求系统提示词 2465 字、工具 Schema 12461 字节，无旧 P2 规则或其他步骤规则 | `test-results/live-eight-characters.json`；测试在 8 个资料项完成后主动取消，未覆盖关系步骤 |
| 2026-11-08 | 未完成项 | 候选插入恢复、外部版本冲突端到端用例、关系步骤真实验收及用户自测未完成 | 不归档、不提交 Git；P3 本轮只做自动回归 |
## 2026-11-21 P2 资料首轮与原文定位

只读查看了彩明的实际请求，确认两个参数值均为有效的书内章索引。固定响应检查首轮实际发送的档案完整性说明与空提交指引，覆盖无变更的一次请求完成、已知章索引放错字段时报错、正确字段一次读两章及失败不消耗额度。83 项合并单测、类型检查和 OpenSpec 严格校验通过。提示词已同步，复查无待更新项，真实模型行为待用户复测。
