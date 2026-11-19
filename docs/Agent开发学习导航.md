# Agent 开发学习导航

入口核对日期：2026-11-19。结合 WestWorld 的小说资产提取、人物整理、事件串联，以及导演／编剧／写手规划选取资料。

**导航：** [先读这几篇](#先读这几篇) · [Claude 官方](#claude-官方) · [Codex 官方与源码](#codex-官方与源码) · [Pi 源码](#pi-源码) · [Claude Code 泄露快照](#claude-code-泄露快照) · [游戏人物与长期记忆](#游戏人物与长期记忆) · [按问题查资料](#按问题查资料) · [对照本项目](#对照本项目)

## 先读这几篇

建议按顺序阅读；每一篇后面都带一个可以拿本项目回答的问题。

| 顺序 | 直达入口 | 阅读重点 | 对照 WestWorld 的问题 |
|---|---|---|---|
| 1 | [Building effective agents（如何构建有效的智能体）](https://www.anthropic.com/research/building-effective-agents) | 固定工作流、自主工具循环与复杂度取舍 | P1 提取和写手是否需要自主循环？哪些判断值得多轮推理？ |
| 2 | [How Claude Code works（Claude Code 如何工作）](https://code.claude.com/docs/en/how-claude-code-works) | 获取上下文、执行动作、验证结果的循环 | 目前怎样判定一次人物整理已经完成？ |
| 3 | [Effective context engineering（上下文工程）](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents) | 信息选择、按需检索、压缩与持久笔记 | 模型这次需要哪些人物、事件和旧判断？ |
| 4 | [Unrolling the Codex agent loop（展开 Codex 的执行循环）](https://openai.com/index/unrolling-the-codex-agent-loop/) | 请求组装、工具往返、上下文增长与性能 | 从任务输入到最终 HTTP 请求，中间改了什么？ |
| 5 | [Demystifying evals for AI agents（智能体评测）](https://www.anthropic.com/research/demystifying-evals-for-ai-agents) | 任务、运行轨迹、评分与最终状态 | 怎样证明关系判断和事件串联质量提高了？ |

读完后，再沿下面的源码入口追一条实际请求，比较“文档描述的流程”和“代码真正执行的流程”。

## Claude 官方

| 资料 | 类型 | 重点看什么 |
|---|---|---|
| [Claude Code 工作原理](https://code.claude.com/docs/en/how-claude-code-works) | 产品架构说明 | 工具循环、模型与运行环境的分工；从页面继续进入上下文和会话说明 |
| [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) | 官方接入文档 | 以 Python／TypeScript 调用 Claude Code 的能力；目录中可继续查会话、流式输出、自定义工具和 hooks（调用前后钩子） |
| [Writing effective tools for agents（工具设计）](https://www.anthropic.com/research/writing-tools-for-agents) | 工程文章 | 工具职责、参数描述、返回信息的有效性与 Token 开销 |
| [Effective context engineering（上下文工程）](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents) | 工程文章 | 预装资料与按需检索怎样配合；压缩、笔记和分工各解决什么问题 |
| [Effective harnesses for long-running agents（长任务运行机制）](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents) | 工程文章 | 跨上下文窗口继续工作；怎样保留明确进度、交接信息和验证结果 |
| [Demystifying evals for AI agents（智能体评测）](https://www.anthropic.com/research/demystifying-evals-for-ai-agents) | 工程文章 | 区分模型声称完成、工具调用成功和最终业务结果 |

对本项目，建议先把“工具返回”和“上下文选择”两篇应用到 P2/P3 的实际请求回放，再研究更复杂的多 Agent 协作。

## Codex 官方与源码

| 入口 | 阅读重点 |
|---|---|
| [Codex 开源仓库](https://github.com/openai/codex) | 官方源码总入口；README 提供文档和构建入口 |
| [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/) | 先理解输入如何组装、模型如何调用工具、消息怎样增长，再进入代码 |
| [Run long horizon tasks with Codex（运行长任务）](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex) | 外部状态、真实验证反馈、失败修正和持续推进任务 |
| [Latency optimization（延迟优化）](https://developers.openai.com/api/docs/guides/latency-optimization) | 调用次数、输出量、并行和流式显示等优化方向 |
| [Prompt caching（提示词缓存）](https://developers.openai.com/api/docs/guides/prompt-caching) | 重复输入如何复用缓存；结合实际服务商的缓存规则和用量核对 |

源码可从这些目录进入。链接跟随 `main` 分支，文件结构会随上游更新。

| 源码入口 | 建议追踪的问题 |
|---|---|
| [core/src：核心运行代码](https://github.com/openai/codex/tree/main/codex-rs/core/src) | 一次用户输入怎样进入会话、请求和执行流程？ |
| [session：会话模块](https://github.com/openai/codex/tree/main/codex-rs/core/src/session) | 会话状态与执行过程怎样组织？ |
| [context_manager：上下文管理](https://github.com/openai/codex/tree/main/codex-rs/core/src/context_manager) | 哪些历史进入下一次请求，哪些内容需要裁剪或重组？ |
| [compact.rs：压缩入口](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs) | 压缩如何触发，完成后怎样继续运行？ |
| [tools：工具模块](https://github.com/openai/codex/tree/main/codex-rs/core/src/tools) | 工具怎样声明、执行、反馈结果并进入下一轮？ |

## Pi 源码

WestWorld 当前使用 `@earendil-works/pi-ai` 和 `@earendil-works/pi-agent-core`，锁定版本为 `1.0.2`。上游现在位于 [earendil-works/pi](https://github.com/earendil-works/pi)，旧仓库名为 `badlogic/pi-mono`；迁移说明见 [Pi Has a New Home at Earendil](https://pi.dev/changelog/2026/5/7/pi-has-a-new-home)。

建议先读运行库，再读完整 coding-agent 的应用层。上游 `main` 的接口需与本地锁定版本对照。

| 顺序 | 源码或文档 | 阅读重点 |
|---|---|---|
| 1 | [pi-agent-core README](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md) | 消息、事件、工具执行、请求准备和轮次结束接口 |
| 2 | [agent-loop.ts](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts) | 模型回复与工具结果如何驱动下一轮 |
| 3 | [agent.ts](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent.ts) | Agent 状态、输入、取消和运行控制 |
| 4 | [coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md) | 完整应用提供了哪些会话、扩展、技能和接入能力 |
| 5 | [coding-agent 核心目录](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/core) | 重点沿 `agent-session`、`session-manager`、`compaction`、`tools` 查找调用关系 |

本项目已自行实现持久化、业务工具、压缩和任务恢复。阅读时记录哪些能力已经具备、哪些环节值得改进，再决定是否调整接入方式。

## Claude Code 泄露快照

这是第三方保存的源码快照入口，与上面的官方文档、官方开源仓库分开列出。仓库自述来自 2026 年 3 月暴露的 Claude Code 源码；已核对下列目录和文件可访问，尚未验证快照的真实性与完整性。

| 入口 | 建议阅读方式 |
|---|---|
| [镜像仓库与说明](https://github.com/dhrbc/claude-code) | 先读 README，了解来源与快照范围 |
| [src：源码目录](https://github.com/dhrbc/claude-code/tree/main/src) | 从总目录定位查询、上下文和工具模块 |
| [query.ts](https://github.com/dhrbc/claude-code/blob/main/src/query.ts) | 跟踪请求和多轮执行相关逻辑 |
| [QueryEngine.ts](https://github.com/dhrbc/claude-code/blob/main/src/QueryEngine.ts) | 对照查询入口及其调用者阅读 |
| [context.ts](https://github.com/dhrbc/claude-code/blob/main/src/context.ts) | 跟踪上下文来源与组装位置 |
| [tools：工具目录](https://github.com/dhrbc/claude-code/tree/main/src/tools) | 选一个读工具和一个写工具，比较输入、结果和错误处理 |

源码快照用于理解客户端工程结构，不能据此取得 Claude 模型或完整服务端。镜像失效时，仍可沿官方 SDK 文档、Pi 和 Codex 源码继续学习。

## 游戏人物与长期记忆

| 入口 | 阅读重点 | 对应游戏能力 |
|---|---|---|
| [Generative Agents 论文](https://arxiv.org/abs/2304.03442) | 经历记录、记忆召回、反思与计划如何影响行为 | 人物认知、动机和后续行动 |
| [Generative Agents 配套源码](https://github.com/joonspk-research/generative_agents) | 结合论文追踪人物的观察、记忆和行为生成过程 | 后续 NPC 演化与世界模拟的参考 |

这项研究发表于 2023 年，适合学习机制。对照 WestWorld 时，重点区分原著资料、本局事实、人物所知和未来计划，结合自己的回合流程设计。

## 按问题查资料

| 现在遇到的问题 | 优先入口 | 建议留下的检查结果 |
|---|---|---|
| 模型长时间思考，没有调用工具 | [DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)；[本项目配置核查](../openspec/changes/continuous-character-organization/evidence/reasoning-config-audit-2026-11-19.md) | 实际请求档位、输出预算、结束原因、是否产生业务进展 |
| 忘记旧线索、接不上事件 | [上下文工程](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents) | 一组应召回的跨章线索，以及实际返回了哪些 |
| 工具很多，却反复查错或查重 | [工具设计](https://www.anthropic.com/research/writing-tools-for-agents) | 每个工具的用途、重叠点、返回体积和无效调用 |
| 跑得久，但进展很少 | [长任务运行机制](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents)；[Codex 长任务](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex) | 完成条件、可恢复进度、下一步依据 |
| 修改提示词后不知道是否变好 | [Agent 评测](https://www.anthropic.com/research/demystifying-evals-for-ai-agents) | 固定样本的质量、耗时、请求次数和 Token 对比 |
| 玩家等很久才看到正文 | [延迟优化](https://developers.openai.com/api/docs/guides/latency-optimization)；[Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) | 首次可见文字、正文完成、下一轮解锁三个时间点 |
| NPC 记得事件却不会据此行动 | [Generative Agents](https://arxiv.org/abs/2304.03442) | 人物知道什么、如何理解、当前想做什么 |

## 对照本项目

| 本地入口 | 对照阅读的内容 |
|---|---|
| [游戏阶段需求](WestWorld-游戏Agent产品需求-分阶段.md)、[跨窗口交接](WestWorld-游戏Agent-跨窗口任务交接.md) | 导演／编剧／写手职责、回合锁、最后一轮改写 |
| [模型网关](../src/features/models/gateway.ts)、[模型能力解析](../src/features/models/registry.ts) | 实际请求参数、SDK 映射、流式数据和重试 |
| [Agent 运行器](../src/features/agents/runtime.ts) | 工具循环、完成条件、失败继续与阶段配置 |
| [上下文投影](../src/features/agents/context.ts)、[压缩实现](../src/features/agents/compaction.ts) | 哪些历史进入模型，压缩后怎样恢复 |
| [P3 检索](../src/features/story/retrieval.ts) | 如何召回旧节点、事件线和未解决事项 |
| [请求轨迹](../src/features/agents/trace.ts)、[模型请求测试](../tests/models.test.ts) | 对照提示词、实际 HTTP 请求和真实响应 |

## 交付记录

REQ-028，小修改。2026-11-19 用户要求将官方资料、开源代码和 Claude Code 泄露快照整理为可快速访问的 Markdown 导航。本文件提供页内导航、阅读顺序、资料重点和项目代码入口；相关登记见[需求池](../openspec/需求池.md)。外部入口已通过网页或 GitHub 连接器核对；本导航与关联核查记录合计 33 个不同外部链接、29 处本地链接，其中 8 处包含页内锚点，本地链接和锚点检查通过。`npm run governance:check`、关联变更的 OpenSpec 严格校验及 Git 差异检查通过。
