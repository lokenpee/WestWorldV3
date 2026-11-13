# BUG-31 人物资料整理质量再次反馈

## 用户原意与状态

2026-11-12，用户反馈第二步 system prompt 冗杂，人物资料仍有重复与废话、字数不符合要求；询问 mergeFacts 的来源与必要性，以及 assistant 只有工具调用是否由提示词或日志采集造成。提供贾珩 submit_profile_review 的空 patch、done=true 和 no_change 成功回执。沿用 REQ-019 / BUG-31，按中型缺陷讨论。最初只读诊断见下节；用户随后明确确认修改范围，现按确认方案实施。

## 修复前诊断事实

- 当前第二步使用 `docs/v2/resources/v2.2/prompts/active/p2-organization-profiles.md`，要求去重、保留独有信息，但没有人物字段字数要求。强调保留任职阶段与无变化可空提交，没有明确区分保留事实含义和保留原句。
- 共用 `output-discipline.txt` 明确要求“直接调用工具提交结果，不写前言、提醒、免责、建议和态度表述”；第二步还要求不发额外结束总结。没有可见正文不能推断模型没有进行内部推理。
- `extraction/service.ts` 在首次提取时生成 mergeFacts；`assets/derive.ts` 的 rebuildFacts 按分号和换行拆分、精确去重并生成稳定编号；`assets/merge.ts` 合并同字段同文本并排序。整齐不代表经过语义去重。
- `assets/assetPatch.ts` 编辑四个文本字段后也重建对应 mergeFacts。因此这些条目不是独立、不可变的原文证据，章节关联也不等于逐字验证。
- `agents/organizationData.ts` / `organizationReview.ts` 把当前人物字段、mergeFacts、来源章节全部预载；`world/organizationPrompt.ts` 将其注入首轮。可能与展示字段重复，但是否包含展示字段遗漏的独有信息需对实际样本核对。
- `agents/organizationCommands.ts` 接受合法空 patch + done=true，记录 no_change 并推进；没有语义去重或字段字数质量检查。成功回执证明提交/完成协议成功，不证明模型判断正确。无变化仍返回“人物资料已保存并完成”，反馈可更精确。
- `agents/trace.ts` 支持 thinking_delta 与最终 thinking 部分；`ExecutionChainView.tsx` 有思考内容展示。modelEnd 在最终 message 存在时以最终内容覆盖流式累计值，存在最终消息缺字段时丢失已收到片段的路径；实际提供的这一次请求是否发生该路径尚无原始响应证据。

## 已确认方案与实施方法

确认依据：2026-11-12用户明确给出七项字数上限，强调“只是提示词约束，不要做代码核验”；明确 mergeFacts 不应该传入；继续优化提示词，参考关系提示词的表达而不照搬格式；要求不禁止思考，保留工具调用以外的输出用于排查。

| 范围 | 原行为 → 目标行为 | 模块与任务 |
| --- | --- | --- |
| 第二步提示词 | 强调完整/保留、多余运行说明 → 明确同义、跨字段去重，压缩措辞、保留事实和时间变化，七字段长度仅写作要求 | p2-organization-profiles.md；17.1 |
| 第二步输入 | 预装及刷新包含 mergeFacts → 不包含该数据与字段名；库内存储、内部指纹保留 | organizationData、organizationPrompt；17.2 |
| 输出限制 | 所有Agent追加仅工具纪律 → 第二步使用自身说明，允许正常正文 | runtime；17.1 |
| 无变化回执 | 已保存并完成 → 本次未修改，已结束检查；先前已有修改仍按真实累计结果报告 | organizationCommands；17.2 |
| 思考请求 | SDK省略reasoning会对已知思考模型发送关闭 → P2非probe调用传medium，gateway只对声明支持的模型透传；SDK按模型支持等级映射 | models/types、gateway、runtime；17.3 |
| 输出保存 | 最终缺字段清空delta → 非空最终优先，否则保留当前尝试已收片段；重试清空前次响应，失败/取消保留当前片段 | trace、既有executionChain/UI；17.3 |

### 字段变化

- 七项上限：别名合计≤50字、年龄描述≤20字、身份≤150字、外貌≤200字、性格≤150字、背景≤300字、原话片段≤300字。只在提示词要求模型归纳表达，工具 Schema、存储校验和提交逻辑不增加长度门槛、截断或重试。
- 第二步预装数据与 query_character_profile 的 data 删除 mergeFacts，fields 列表去掉该名称；发给模型的展示数据去掉内部 fields/revision。Character.mergeFacts 与 profileContent 内部指纹无变化，不迁移、不清理现有数据，备份格式无变化。
- CallOptions 增加可选 reasoning（Pi ThinkingLevel 类型）；P2运行器赋 medium，其余调用不赋新默认，gateway 仅向声明 reasoning 能力的模型传递。当前SDK对 deepseek-v4-pro 将 medium 映射为 high（该模型目录支持 high/max）；不新增模型设置或存储字段。
- trace 的 text/thinking 等字段类型与存储位置不变，只改采集赋值；旧详情保留原记录，不伪造缺失输出。

### 数据流转

当前人物 → profileWork 去掉 mergeFacts → organizationPrompt 生成用户输入 → 第二步业务提示词独立组装 → P2模型请求按已声明能力启用思考 → 流式正文/思考及工具调用保存 → submit_profile_review 按原业务校验保存并完成 → 详情展示真实正文、思考、工具与修改。刷新 query_character_profile 复用同一人物投影。

例如原性格“沉稳果断；为人沉稳，处事果决；精于谋略”，提示词要求归纳为“沉稳果断，精于谋略”；底层 mergeFacts 无论是否包含这些条目，均不预装给第二步。若模型仍提交151字性格，程序按原规则完整保存，不报字数错误。

### 触发逻辑

用户启动或继续第二步时使用当前提示词与人物投影；事实疑点由模型按需查原文，普通去重不强制查询。可有正常说明，done=true成功仍直接推进，不额外请求结束总结。重复触发、部分保存、取消及业务冲突沿用原工作项与回执规则。网络重试只清空当前请求上一尝试的响应累计，不改变业务提交；失败/取消留存已返回片段。

## 验收与接手

任务入口：[任务17](../tasks.md#17-bug-31-资料整理质量与输出采集2026-11-12)，差异规格见 world-organization / agent-session；技术正文见 docs/v2/05-Spec-AI与会话.md。

自动检查使用独立内存数据库和固定API响应：实际输入无 mergeFacts、查询刷新一致、底层事实与指纹不变、七项超长字段完整保存、真正无变化及先修改后空完成、DeepSeek实际请求启用思考、其他调用默认不变、流式与最终内容去重、失败/取消/重试隔离和P2详情投影。运行非live测试、类型、静态、构建、提示词同步、治理及OpenSpec校验。

用户验收：选一名具有同义重复、跨字段重复和时间变化的人物，运行第二步；查看API输入确认无 mergeFacts，查看正文/可见思考和工具调用，核对实际修改及七项字数。字数不合要求属于模型效果问题，不应触发程序报错。无需修改的短资料允许空提交并显示本次未修改。真实质量由此验收，固定响应测试不宣称真实模型效果通过。

## 开发检查记录

2026-11-12，开发完成，待用户副本验收。未调用真实模型，未修改正式书库，未提交或推送Git。贾珩该次请求的原始响应尚未提供，因此确证代码路径不代表已确定该次缺失的唯一原因。

- `tests/profile-input.test.ts` 新增5项；与 organization 合计40/40通过：实际模型消息无 mergeFacts 或底稿独有标记，查询无底稿，存储与指纹不变；七项超长字段完整保存；无变化与先修改后空完成文案正确。
- `tests/trace.test.ts` 新增4项，修复前四项均失败；修复后与 execution-chain 合计14/14通过，验证落库后P2投影仍有正文、思考和工具调用，最终完整内容不重复，失败/取消/重试不串内容。UI已有展示入口，未改布局。
- models与organization新增3项，相关文件70/70通过；agents 25/25通过。固定fetch实际请求验证默认DeepSeek思考enabled/high、普通direct/P3/probe不变、目录外模型不猜测支持。
- `npm run typecheck` 通过；`npm run build` 通过，既有SDK浏览器兼容、动态导入和大包提示保留；`npm run lint` 无错误，5项既有警告。
- 首轮全量与构建并行时，story/world两个大样本在30秒超时，593项通过。构建结束后运行 `npm run test:unit -- --maxWorkers=2`，62文件全部通过，595项通过、1项跳过，82.46秒；未调整业务代码或测试时限。
- `npm run prompts:sync -- --dry-run` 预览并完成同步，最终预览0项变化；`npm run governance:check` 与 `npm run openspec -- validate continuous-character-organization --strict` 通过。开发检查不等于实际模型整理质量验收。
