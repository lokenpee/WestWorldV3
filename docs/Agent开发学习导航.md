# Agent 开发学习导航

阅读与核对日期：2026-11-19。结合 WestWorld 的小说资产提取、人物整理、事件串联，以及导演／编剧／写手规划整理。

每个入口后都附具体做法、优化思路和阅读建议。文章与文档摘要来自正文；源码入口依据 README、目录结构及文中点名的关键实现整理，目录摘要不代表整库审计。“对本项目的用处”是结合当前代码提出的应用建议。

**导航：** [先读这几篇](#先读这几篇) · [Claude 官方](#claude-官方) · [Codex 官方与源码](#codex-官方与源码) · [Pi 源码](#pi-源码) · [Claude Code 泄露快照](#claude-code-泄露快照) · [游戏人物与长期记忆](#游戏人物与长期记忆) · [按问题查资料](#按问题查资料) · [对照本项目](#对照本项目)

## 先读这几篇

时间有限时，按下面的顺序选读。详细摘要在后面的对应分类中。

| 顺序  | 直达入口                                                                                                                   | 读完能得到什么                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | [Building effective agents（如何构建有效的智能体）](https://www.anthropic.com/research/building-effective-agents)                  | 区分固定工作流和自主循环，按任务选择串联、路由、并行、动态分工或反馈改写。适合先决定哪些环节值得做成 Agent。  |
| 2   | [Writing effective tools for agents（工具设计）](https://www.anthropic.com/research/writing-tools-for-agents)                | 把“枚举所有数据”改成“检索当前任务所需数据”，减少工具重叠和冗长返回；最直接对应 P2/P3 的无效调用。     |
| 3   | [Effective context engineering（上下文工程）](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents) | 用资料索引和按需读取控制上下文，把关键决定、待办和原始证据引用留下来。适合解决忘线索、上下文很长却答不好的问题。   |
| 4   | [Unrolling the Codex agent loop（展开执行循环）](https://openai.com/index/unrolling-the-codex-agent-loop/)                     | 看懂请求组装、工具结果回填和前缀缓存；便于追查应用配置最后变成了什么模型请求。                    |
| 5   | [Demystifying evals for AI agents（智能体评测）](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)         | 用真实任务、最终业务状态和多次运行判断改动是否有效，同时记录耗时与 Token。适合摆脱“感觉变聪明了”的比较方式。 |

当前的“长时间思考却没有正文”问题，先看[思考配置与延迟](#按问题查资料)。准备做游戏人物行为时，再读[人物记忆与计划](#游戏人物与长期记忆)。

## Claude 官方

### [Building effective agents（如何构建有效的智能体）](https://www.anthropic.com/research/building-effective-agents)

文章将预先规定步骤的工作流与模型自主决定步骤的 Agent 分开，给出五种组织方式：步骤串联、任务路由、并行处理、主 Agent 动态分派、评价后反复改写。复杂度应随实际效果增加；自主执行要不断读取环境反馈，并设置完成条件。

**阅读建议：先读。** 对 WestWorld，P1 的稳定提取流程、P2/P3 的查询与修改循环、导演／编剧／写手的职责分工可以分别选择组织方式。它帮助你决定架构，不提供一套更换后就自动变聪明的框架。

### [Claude Code 工作原理](https://code.claude.com/docs/en/how-claude-code-works)

核心是获取上下文、执行动作、验证结果，再根据反馈继续。运行层负责工具、会话与上下文，模型负责判断下一步。文档还说明：技能和工具定义可以按需加载；子 Agent 使用独立上下文；会话可持久化、恢复和分支；压缩摘要会丢细节，长期规则需独立保存。

**阅读建议：快速通读。** 用它检查你的循环是否具备“读取结果并验证完成”这一环。对 P2，提交工具返回成功后，还应有明确的业务完成依据；这比只判断模型停止输出更有用。

### [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)

SDK 通过 Python／TypeScript 在你运行的进程中调用 Claude Code，提供现成的工具循环、上下文管理、会话、权限、hooks（生命周期钩子）和扩展能力。它与直接调用 Claude API 的客户端 SDK 不同：后者通常需要你组织自己的循环。

**阅读建议：考虑接入 Claude Code 能力时读。** 这页主要帮助选择接入方式，算法细节较少。WestWorld 已用 Pi 接入自己的业务工具与持久化，适合把它作为能力清单对照，是否替换要另行比较模型、部署方式和业务接口适配成本。

### [Writing effective tools for agents（工具设计）](https://www.anthropic.com/research/writing-tools-for-agents)

工具围绕任务设计：用搜索替代全量列表，把经常连续进行的查询合成一个业务工具。返回内容突出有意义的名称与相关事实，按需提供精简／详细模式，并支持筛选、分页。错误应说明如何修正参数。通过真实任务回放，比较准确率、调用次数、错误、耗时和 Token，而非只看工具能否运行。

**阅读建议：优先精读。** 可以直接对照 P3 检索与 P2 人物工具：一次返回的信息是否足以做下一步判断？模型反复查询是否因为结果缺字段、名称含糊或分页太碎？这是目前最值得试验的改进方向之一。

### [Effective context engineering（上下文工程）](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)

文章把上下文视为有限的注意力资源。先保留路径、标识和简短描述，需要时再取原文；关键资料预装，其他资料按需检索。长任务通过摘要、持久笔记和独立子任务上下文延续；摘要应保留决定、未解决问题及继续工作所需信息，优先清掉重复工具输出。

**阅读建议：优先精读。** 对 WestWorld，候选人物、相关事件和原文依据应围绕本次判断选择。现有自动压缩解决容量问题，召回是否准确仍需单独检查。

### [Effective harnesses for long-running agents（长任务运行机制）](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents)

作者观察到：只有压缩，Agent 仍会一次做太多，或看到部分成果就宣布完成。做法是首次建立启动脚本、功能清单和进度记录；后续会话先恢复环境、检查基本功能，再推进一个小目标，验证后记录结果和交接信息。编码示例用 Git 保存可恢复进度。

**阅读建议：P2/P3 长任务必读。** 可借鉴“已处理对象、已验证结果、待处理对象、下一步”这类结构化进度。项目已有持久化，应重点检查中断后能否准确知道从哪里继续，而不是再增加一份泛泛的会话摘要。

### [Demystifying evals for AI agents（智能体评测）](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)

评测区分任务、一次运行、完整轨迹、评分器和最终状态；模型说“完成”不能代替结果验证。规则检查适合确定事实，模型评分适合开放质量，并需人工校准。相同任务要多次运行：`pass@k` 看至少一次成功，`pass^k` 看每次都成功。能力提升与回归检查分别维护。

**阅读建议：准备改提示词、工具或模型前读。** 本项目可以固定一批小说片段，核对人物合并、关系依据和事件衔接，并记录耗时、Token 与无效调用。玩家体验更关心稳定成功，而非多试几次总能成功。

## Codex 官方与源码

### [Codex 开源仓库](https://github.com/openai/codex)

README 提供 CLI 安装、使用、构建和开发入口；核心运行实现主要在 Rust 工程 `codex-rs`。阅读价值在于模型外围如何组织会话、工具、执行环境和客户端事件，模型本身的能力不会从这些代码中获得。

**阅读建议：先收藏，再按下面五个入口读。** 直接通读仓库会把大量时间花在终端界面、平台适配等与你当前问题关系较远的模块上。

### [Unrolling the Codex agent loop（展开执行循环）](https://openai.com/index/unrolling-the-codex-agent-loop/)

文章逐步拆开初始指令、工具定义、项目规则和用户输入，展示模型调用工具后如何回填调用结果。性能重点是让后续请求尽量保留相同前缀：工具顺序不稳定、修改较早的消息都会损害缓存复用。上下文到阈值后压缩，再继续循环。

**阅读建议：精读请求示例与性能部分。** 对照 WestWorld 的模型网关和轨迹，检查最终请求、工具顺序及历史变化。文章中的传输与压缩方式属于发表时实现，读当前源码时以当前分支为准。

### [Run long horizon tasks with Codex（运行长任务）](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex)

案例把目标、里程碑、执行规则、进度与决策分别写入持久文档。每个里程碑都有验收命令，验证失败先修复，再进入下一步；模型持续使用文件、测试结果和日志恢复工作方向。文章报告了一次长时间编码实验，重点在明确的完成标准与持续验证。

**阅读建议：按需读，与 Claude 长任务文章配合。** 对本项目可借鉴任务状态和验收依据的分离。实验采用较高思考强度，不能据此推导玩家每回合也应长时间推理；离线资产整理与即时游玩的延迟目标不同。

### [Latency optimization（延迟优化）](https://developers.openai.com/api/docs/guides/latency-optimization)

先测首次可见文字和全流程完成时间，再按请求类型比较中位数与慢请求。主要方法是选满足质量要求的较快模型、减少输出与思考、缩小输入、合并串行请求、并行独立工作、流式显示，以及用代码处理确定步骤。输出上限可能同时覆盖思考和正文，过低会在正文出现前截断。

**阅读建议：当前速度问题必读。** WestWorld 应分别测“首字出现、正文完成、回合解锁”。导演完成后的写手与编剧若按已确认流程并行，收益来自减少串行等待；流式显示则主要改善开始阅读的时间。

### [Prompt caching（提示词缓存）](https://developers.openai.com/api/docs/guides/prompt-caching)

缓存复用相同输入前缀已经完成的计算，主要节省重复输入的处理时间与费用。稳定指令、工具定义放前面，变化内容追加在后；名称、定义、顺序等前缀内容变化会影响命中。文档还区分不同模型的缓存边界、保存时间和计费，并提供命中用量的检查方法。

**阅读建议：请求形态稳定后读。** 可用于重复使用世界规则、角色设定和长会话历史。它不会直接消除模型本轮的长思考；应根据实际服务商记录缓存命中，不能把 OpenAI 的参数直接套给 DeepSeek。

### [core/src：核心运行代码](https://github.com/openai/codex/tree/main/codex-rs/core/src)

从目录及下述实现能看到，会话、历史、压缩、工具分成独立模块。当前可沿 `session/turn.rs` 的 `run_turn` 进入运行流程，再转到上下文与工具处理。这里同时存在持久状态、一次请求的上下文和事件反馈，三者职责不同。

**阅读建议：用于定位，不逐文件通读。** 对照 WestWorld 时，先画出“业务状态 → 请求上下文 → 模型输出 → 工具结果 → 状态更新”这一条路径，再追相应模块。

### [session：会话模块](https://github.com/openai/codex/tree/main/codex-rs/core/src/session)

本次重点读 `session.rs` 与 `turn.rs`。会话保存状态、输入队列、当前轮次和服务对象；轮次执行接受取消信号，组织输入与模型交互，并接入自动压缩。状态访问与部分持久化排序分开管理，避免存储操作长时间占住运行状态。

**阅读建议：研究中断、恢复和排队输入时读。** 对 WestWorld 的直接参照是：用户补充要求、中断当前任务、恢复历史任务，是否各自有明确的进入位置和状态，而不是全部拼成下一条聊天文本。

### [context_manager：上下文管理](https://github.com/openai/codex/tree/main/codex-rs/core/src/context_manager)

重点读 `history.rs` 的历史记录、`for_prompt` 和 `normalize_history`。工具返回按策略控制体积；发给模型前补齐缺失的调用结果、清除无对应调用的结果，并处理模型不支持的图片或音频。持久记录与实际请求投影因此可以不同。

**阅读建议：上下文异常时精读。** 可对照本项目压缩后、取消后和恢复后的消息配对。保存了完整日志，并不意味着可以不加处理地直接重放给模型。

### [compact.rs：压缩入口](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs)

该文件实现一条摘要压缩路径：准备压缩请求、处理失败、重建历史并重新放入必要的初始上下文。输入超窗时会减少旧历史再尝试；成功后更新压缩记录。当前工程还存在独立的远端压缩实现，因此这个文件并不包含全部压缩策略。

**阅读建议：与 Pi 压缩实现对照读。** 值得学习的是切换历史时保留哪些内容、失败后是否误恢复已移除内容、压缩后如何继续。对 WestWorld，应核对原文引用和待办能否跨压缩保留。

### [tools：工具模块](https://github.com/openai/codex/tree/main/codex-rs/core/src/tools)

重点读 `router.rs` 与 `parallel.rs`。路由器把模型输出转为已登记工具调用；执行层依据工具是否支持并行安排执行，可并行调用共享通行，需独占的调用等待其他执行结束，并处理取消与运行事件。

**阅读建议：优化工具耗时时读。** 先找真正独立的查询，例如两个互不依赖的资料读取；修改同一人物或事件的操作需要保持业务顺序。并行能力应由工具语义决定。

## Pi 源码

WestWorld 当前使用 `@earendil-works/pi-ai` 和 `@earendil-works/pi-agent-core`，锁定版本为 `1.0.2`。以下源码链接跟随上游 `main`，接口与行为需同本地版本对照。

### [earendil-works/pi：仓库总入口](https://github.com/earendil-works/pi)

README 将能力分成多模型 API、Agent 运行库、完整 coding-agent 应用等包。Pi 的取向是核心简洁、通过扩展与技能适配工作方式；完整应用还提供交互、JSON、RPC 和 TypeScript SDK 接入。

**阅读建议：先看包的分工。** WestWorld 使用运行库并自行实现业务应用层。评估“Pi 是否太朴素”时，应检查应用层是否给了模型合适的信息、工具与完成反馈；包的体积不能直接代表模型判断质量。

### [Pi Has a New Home at Earendil（迁移说明）](https://pi.dev/changelog/2026/5/7/pi-has-a-new-home)

说明仓库由 `badlogic/pi-mono` 迁至 `earendil-works/pi`，npm 包从 `@mariozechner` 迁到 `@earendil-works`；旧包被标记弃用，已有版本仍保留。迁移时主要处理依赖与导入名称，会话和配置沿用既有位置。

**阅读建议：可略过正文。** 用于识别旧教程与当前包名，不是提升智能或速度的方法文章。

### [pi-agent-core README](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)

介绍消息、状态、事件与工具循环的接口。上下文变换与模型消息转换分开；`prepareRequest` 可在请求前准备数据，`finishTurn` 可判断结束或继续。工具有调用前后钩子和执行策略，用户中途引导与结束后跟进分成两类队列。

**阅读建议：本项目最应先读的源码文档。** 它解释你的扩展应放在哪一层：检索与压缩放在请求准备侧，业务完成判定放在轮次结束侧。无需为了这些接口另换整套框架。

### [agent-loop.ts：工具循环](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)

重点读 `runLoop`：准备请求、接收回复、执行工具、追加结果、调用结束判定，再处理排队消息。当前上游还对 `stopReason=length` 下的工具调用返回截断错误，避免执行可能不完整的参数；这条分支依赖回复中存在工具调用。

**阅读建议：排查“为什么还在继续”时精读。** 纯思考耗尽预算、没有工具调用的情况，需要另查应用的结束与继续策略。上游这一分支不能证明 WestWorld 的 112 秒问题已经解决。

### [agent.ts：状态与运行控制](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent.ts)

这是底层循环的有状态包装：维护消息、思考档位、正在流出的回复、待执行工具及错误；提供引导、跟进、取消和等待空闲。当前上游默认工具策略为并行，事件监听器会按顺序等待完成，`agent_end` 的监听处理结束后才真正空闲。

**阅读建议：排查交互与耗时时读。** 可检查事件监听中是否放入慢操作、界面为何迟迟未解锁，以及应用是否覆盖了默认工具策略。上游默认值不能代替本项目实际配置。

### [coding-agent README：完整应用能力](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)

介绍终端应用如何提供会话、压缩、扩展、技能、提示模板和程序化接入。它将可定制的工作方式放在扩展层，计划模式或子 Agent 等能力可由扩展补充。

**阅读建议：查缺失的应用能力时读。** 与运行库 README 对照，能看出安装 Agent 核心并不等于获得完整产品的所有能力。你已有业务持久化和工具，重点比较能力，不必照搬编码终端界面。

### [coding-agent 核心目录](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/core)

本次读了 `agent-session-runtime.ts`、`session-manager.ts` 和 `compaction/compaction.ts` 的关键实现。会话记录通过 `id/parentId` 形成分支，再投影为模型上下文；压缩按剩余容量触发，保留近期消息，并选合法切分点，避免拆散工具调用与结果。切在轮次中间时还要总结该轮前半段。

**阅读建议：设计历史分支和压缩时读。** 对照 WestWorld 的父链、摘要记录和近期消息保留机制，重点检查实际差异。对“最后一轮改写”，还须按本项目规划恢复对应业务状态，不能只切换消息分支。

## Claude Code 泄露快照

以下是第三方仓库保存的代码。仓库自述来自 2026 年 3 月暴露的源码；本次已读取 README 和所列关键实现，未独立验证来源及完整性。源码中的功能开关意味着某段代码存在，不等于所有发行版本都会启用。

### [镜像仓库与说明](https://github.com/dhrbc/claude-code)

README 交代快照来源与整理背景，仓库主要展示客户端的 TypeScript 工程结构。它可用于观察运行层如何组合查询、工具、会话和界面，不能由此取得 Claude 模型或完整服务端。

**阅读建议：放在官方文章和 Pi 之后。** 先带着一个具体问题读源码，例如“输出截断后怎样恢复”，比从头翻整个快照更省时间。

### [src：源码目录](https://github.com/dhrbc/claude-code/tree/main/src)

目录把 `query.ts`、`QueryEngine.ts`、`context.ts` 与工具、查询辅助模块等分开。结合下面的实现，能看到核心循环、会话状态和初始上下文分别承担不同职责。

**阅读建议：作为地图使用。** 先读 `query.ts` 的循环，再按问题进入会话或工具模块；目录本身不是一套可直接复用的“智能算法”。

### [query.ts：查询与恢复循环](https://github.com/dhrbc/claude-code/blob/main/src/query.ts)

关键实现先做轻量上下文处理，再判断是否摘要压缩；围绕模型输出组织工具执行，并区分超窗和输出 Token 截断。快照中的截断恢复有次数限制；另有受功能开关控制的“扩大输出预算后重试”分支。部分压缩失败路径会直接结束，避免错误与继续钩子相互触发。

**阅读建议：当前故障最值得看的快照文件。** 可学习把结束原因分开处理。扩大预算可能增加耗时与费用，应通过样本评测选择恢复方式，不能当成你这个问题的现成修复。

### [QueryEngine.ts：会话生命周期](https://github.com/dhrbc/claude-code/blob/main/src/QueryEngine.ts)

类实例跨轮次保存消息、读文件缓存和累计用量，再将查询循环的结果转为 SDK 事件。实现中会持久化消息及压缩边界，压缩后释放旧内存记录，并向调用方报告重试、用量、停止原因和结构化输出失败等结果。

**阅读建议：研究可观测性与恢复时读。** 它的价值在于让调用方知道“还在重试、真正结束、超过预算、输出不合法”分别是什么。可对照本项目轨迹和任务状态，减少界面上只看到一直转圈的情况。

### [context.ts：初始上下文](https://github.com/dhrbc/claude-code/blob/main/src/context.ts)

该文件主要组装 Git 状态、项目记忆文件和日期等初始信息，并缓存会话期间可复用的结果；读取 Git 信息使用并行调用，状态文本设有长度限制。长期压缩和完整检索逻辑并不集中在这里。

**阅读建议：按需略读。** 借鉴点是把稳定资料与运行中变化的信息分开管理，避免每次请求重复收集。WestWorld 的当前人物、页码、任务进度仍应按各自时效更新。

### [tools：工具实现](https://github.com/dhrbc/claude-code/tree/main/src/tools)

本次对照 `FileReadTool` 与 `FileEditTool`。读工具声明只读且可并发，并在读取范围、修改时间等条件吻合时返回“未变化”，减少重复内容。编辑工具检查是否已有读取记录、文件是否变化、待替换文本是否存在，再执行修改。

**阅读建议：研究工具可靠性时读。** 可借鉴“读取结果带版本依据，提交时验证依据仍有效”。对人物与事件资产，检查应由业务工具执行；这样模型的计划失误不会直接变成错误写入。

## 游戏人物与长期记忆

### [Generative Agents 论文](https://arxiv.org/abs/2304.03442)

重点是第 4 节架构与评测部分。记忆召回结合近期访问、重要性和语义相关性；重要经历累计到阈值后，生成高层判断，并保留所依据的记忆记录。计划从一天安排逐步细化，遇到事件再调整，以减少反复执行相同动作等不连贯行为。消融评测分别检查观察、计划和反思的作用。

**阅读建议：做人物认知与行动时精读。** 对 WestWorld，可参考“经历 → 有依据的认识 → 当前目标 → 行动”这条链；同时按项目规划区分原著资料、本局事实、人物所知和未来计划。研究展示的是 2023 年小镇模拟机制，具体调用频率需按游戏回合成本重新设计。

### [Generative Agents 配套源码](https://github.com/joonspk-research/generative_agents)

README 说明仿真服务与前端运行方式。本次还读了 `persona/cognitive_modules` 下的检索、反思与计划关键实现：检索分别归一化三类分数、加权取前若干条，并更新访问时间；反思按累计阈值触发。值得注意的是，源码给近期访问／相关性／重要性使用的额外权重为 `0.5/3/2`，与论文描述的等权设置不同。

**阅读建议：想实现这些机制时读。** 先追“观察进入记忆、检索选中记录、形成判断、更新行动”一条路径。权重与触发频率需要自己的样本验证，论文中的参数和仓库中的参数也应分别核对。

## 按问题查资料

### [DeepSeek 思考模式：先核对实际请求](https://api-docs.deepseek.com/guides/thinking_mode/)

当前文档把思考开关和思考强度分开：默认启用思考且为 `high`，`low` 映射为低档，`medium` 映射为 `high`。思考模式下 `temperature` 等部分参数不生效。带 `tools` 的请求还要求按协议完整回传历史 `reasoning_content`，不能直接沿用普通聊天的历史处理方法。

**阅读建议：现在先读参数表与工具调用部分。** 检查应用经过 Pi 转换后的 HTTP 请求，而非只看界面或配置对象中的名称。

[本项目思考配置核查](../openspec/changes/continuous-character-organization/evidence/reasoning-config-audit-2026-11-19.md)记录了代码与模拟 HTTP 检查结果：P2 目录／候选阶段的低档映射已补齐，后续人物档案／关系阶段仍映射到高档；Agent 路径尚无专门处理纯思考截断的分支。因此结论是部分修复，不能保证不再出现长时间思考耗尽预算。本记录没有通过付费真实请求重新复现 112 秒样本。

| 现在遇到的问题 | 优先入口与已读结论 | 用本项目验证什么 |
|---|---|---|
| 长时间思考，没有正文或工具调用 | [DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)：档位名称需核对实际映射；[延迟优化](https://developers.openai.com/api/docs/guides/latency-optimization)：减小输出上限可能提前截断正文。 | 实际档位、思考与正文用量、结束原因、是否产生业务进展。 |
| 忘记旧线索、接不上事件 | [上下文工程](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)：保存索引并按当前任务取细节。 | 应召回的跨章线索是否进入了这次请求。 |
| 工具很多，却反复查错或查重 | [工具设计](https://www.anthropic.com/research/writing-tools-for-agents)：围绕任务组织搜索与返回，减少职责重叠。 | 重复调用是在补缺失信息，还是工具描述与返回结构造成误解。 |
| 跑得久，但进展很少 | [Claude 长任务](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents)：小目标与可恢复进度；[Codex 长任务](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex)：里程碑与验证反馈。 | 每一轮完成了什么，中断后能否定位下一步。 |
| 改提示词后不知道是否变好 | [Agent 评测](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)：固定任务、多次运行，检查最终结果。 | 同一批小说样本的质量、稳定性、耗时与成本变化。 |
| 玩家等很久才看到正文 | [延迟优化](https://developers.openai.com/api/docs/guides/latency-optimization)：减少串行步骤、并行独立任务、流式展示；[SDK 概览](https://code.claude.com/docs/en/agent-sdk/overview)：提供现成运行能力，仍需应用接好交互。 | 首字出现、正文完成、下一轮解锁三个时间点。 |
| NPC 记得事件却不会据此行动 | [Generative Agents](https://arxiv.org/abs/2304.03442)：召回后形成认识与计划，再决定反应。 | 当前行动是否能追溯到人物知道的事实和目标。 |

## 对照本项目

以下入口也附上当前内容摘要，便于把外部方法落到实际代码。游戏需求文件描述后续规划，源码行描述当前实现。

| 本地入口 | 内容摘要与对照用途 |
|---|---|
| [游戏阶段需求](WestWorld-游戏Agent产品需求-分阶段.md) | 规划导演处理当前行动及结果、编剧调整后续宏观剧情、写手生成正文。对照工作流与并行文章，判断各角色需要的信息和调用时机。 |
| [跨窗口交接](WestWorld-游戏Agent-跨窗口任务交接.md) | 汇总已讨论的职责、回合锁与最后一轮改写等约定。改写涉及回到上一轮之前的业务状态；阅读会话分支源码时据此检查恢复范围。 |
| [模型网关](../src/features/models/gateway.ts) | 统一请求、重试与响应记录。当前 Agent 路径中，服务商流事件会实时记录到轨迹，传给上层 Agent 的事件还有缓冲处理；因此应沿整条链检查流式展示，不能只看请求设置了 stream。 |
| [模型能力解析](../src/features/models/registry.ts) | 根据模型与服务商解析能力，并处理 DeepSeek 思考档位兼容。适合对照官方参数表和实际请求，检查配置名称经过转换后的含义。 |
| [Agent 运行器](../src/features/agents/runtime.ts) | 组织任务阶段、工具集合、请求准备和完成判定。P2 按阶段设置思考强度；普通回复后可能继续引导，业务完成有自己的工具与状态依据。对应 Pi 的循环及结束钩子。 |
| [上下文投影](../src/features/agents/context.ts) | 沿持久消息父链选择当前历史，结合摘要与近期消息生成请求上下文，并处理缺失的工具结果。对应 Codex 的历史规范化与 Pi 的分支投影。 |
| [压缩实现](../src/features/agents/compaction.ts) | 在容量不足时选择切分点，结合旧摘要与消息分段总结；检查压缩后体积，并在持久化前核对历史叶节点。阅读时重点验证证据引用、任务进度和近期消息是否保留。 |
| [P3 检索](../src/features/story/retrieval.ts) | 使用中文词项、显式名称、关联节点等信息评分，并按章节过滤、分页和内容预算返回。可与论文的语义召回比较，先用跨章样本检查漏召回原因。 |
| [请求轨迹](../src/features/agents/trace.ts) | 记录请求快照、工具定义、流式文本／思考及最终结果，并区分重试。用于确认模型实际看到了什么、输出了什么，以及时间花在哪一段。 |
| [模型请求测试](../tests/models.test.ts) | 通过模拟请求核对参数、能力、历史和协议转换。适合发现档位映射等工程错误；小说理解与叙事质量还需要原文样本评测。 |

# 学习记录
## **1. 把一部分模型推理工作转移给工具**
**模型是不是在替代码完成数据库关联工作？**
Agent 需要不断决定查什么、如何关联、是否继续查询。

另一种设计是增加任务级工具：

```
get_relationship_context(
    person_a,
    person_b,
    detail_level
)
```

内部一次完成：

- 定位两个角色及其别名
    
- 查询已有关系
    
- 查找双方共同参与的事件
    
- 获取关联章节与原文证据
    
- 去重并按相关性排序
    
- 返回可进一步检索的证据引用
    

重要的是，这个工具只整合资料，**不替模型判定人物关系是否成立**。

这样就把大量数据库查询和确定性的信息整理从模型那里转移到代码中，模型专注于真正需要理解小说的部分。

Anthropic 的原文明确建议把经常连续调用的操作整合为更符合任务目标的工具。

Anthropic
## **2. 工具返回的信息，应该服务于下一次决策**
**工具是否返回了足以支撑下一步判断的信息？**

例如原本工具返回：

```
{
  "id": "8f32aa",
  "relation_id": "d134c",
  "event_ids": ["e11", "e42", "e93"]
}
```

这对于程序没问题，但对模型来说还得进一步查询。

改进后：

```
{
  "person_a": "贾宝玉",
  "person_b": "林黛玉",
  "existing_relation": "...",
  "evidence": [
    {
      "chapter": 3,
      "summary": "...",
      "evidence_id": "e42"
    }
  ],
  "has_more": true
}
```

模型能够直接判断现有信息是否足够，需要时再按 `evidence_id` 获取原文。

这里存在一个很重要的设计权衡：

**返回太少，Agent 会反复查；返回太多，又会占用上下文，干扰判断。**

Anthropic 提供的方式是为工具增加简洁和详细两种返回模式（`concise` / `detailed`），并通过评测选择合适的信息结构。

Anthropic

对你的项目，我会进一步考虑三个层级：

|层级|内容|使用时机|
|---|---|---|
|概览|人物、现有关系、证据数量、主要疑点|默认|
|证据|关联事件、摘要、章节、证据 ID|需要核对|
|原文|精确原文片段及位置|存在矛盾或需要修改事实|

这部分是我的项目设计建议，并非 Anthropic 原文规定的三级结构。
## **4. 用完整轨迹做工具优化，而不是凭感觉调整**

文章还有一个更工程化的方法：先建立评测任务，再让 Agent 分析它自己的工具调用轨迹，提出工具改进建议。

我会把它用于你之前出现的几十次重复 API 调用问题。

具体看四个指标：

|指标|用来发现什么|
|---|---|
|重复查询次数|工具返回的信息是否不足|
|无效调用比例|工具选择、参数或描述是否有问题|
|单任务 Token|是否存在大量无意义的工具输出|
|最终关系正确率|减少调用是否损害实际质量|

然后让 Codex 根据失败轨迹提出修改，再用相同评测集对比；另留一批未参与优化的样本检查泛化效果。

这就是文章提出的「通过 Agent 评测反过来优化工具」的方法。

Anthropic
## **一、最重要的技术方向：Just-in-time Context**
原文：[Effective context engineering for AI agents](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents?utm_source=chatgpt.com)

Anthropic 提到一种值得重点关注的方式：**按需加载上下文（Just-in-time Context）**。

传统 RAG 往往在模型执行前检索资料，将结果直接放进上下文。

按需加载则允许 Agent 在执行过程中，根据当前判断继续探索数据。

举个实际例子。玩家在城堡里发现一枚刻有奇怪徽章的戒指。

传统方式可能提前检索：

- 当前城堡的相关资料
    
- 戒指所属的物品资料
    
- 与戒指相关的人物与事件
    
- 所有可能相关的历史背景
    

但这些资料中，大部分可能对当前行动没有价值。

采用按需加载时，导演首先得到的信息可以简化为：

```
{
  "location": "castle_01",
  "object": {
    "id": "ring_027",
    "description": "一枚刻有陌生徽章的戒指",
    "related_event_count": 3,
    "related_character_count": 2
  }
}
```

当玩家试图辨认戒指时，导演才调用检索工具查找徽章的来源。假如发现徽章与某个家族有关，再进一步获取对应人物的经历。

这是一种**渐进式信息披露（Progressive Disclosure）**：先提供索引，真正需要时再展开细节。

Anthropic 指出，这种方式能避免一次性加载大量资料，但代价是增加运行时搜索成本，因此实际应用经常采用预加载和按需搜索结合的混合架构。

Anthropic