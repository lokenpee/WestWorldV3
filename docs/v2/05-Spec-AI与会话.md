# WestWorld V2 · 详细规格：AI、工具与会话

> **阶段0修订（2026-10-24）：** P2持有world域锁时禁止同书人物/地点人工写入，P3持有narrative域锁时禁止节点/事件线人工写入；UI与命令事务均校验，拒绝返回`ASSET_DOMAIN_LOCKED`。取消须等在途提交停止并释放锁才恢复编辑。P1人工编辑、跨书编辑、只读和备份不受此域锁限制。P2/P3仍可并行，保留跨域实际读依赖校验。direct首次、网络重发与修正共用最多3次实际请求；P1修正规则见逐章提取决策；P2身份核实按[世界资产整理决策](../decisions/world-organization.md)收尾；P3预算见[叙事整理的排队与恢复](../decisions/story-organization.md)。详见[阶段0决策](../decisions/stage-edit-lock-and-request-budget.md)及当前机器契约。历史证据不代表新规则已在业务应用执行。

| 文档控制项 | 内容 |
|---|---|
| 文档编号 | WW-AI |
| 文档版本 | 2.2 |
| 产品 / 应用包版本 | WestWorld V2 / 1.0.0 |
| 复现基线 | WWV2-WORKTREE-20261021；实际工作区快照，含未提交文件 |
| 文档状态 | 2.2 目标规格待评审；本次只改文档，未宣称应用已实现 |
| 编写 / 维护 | Codex 编写；后续维护责任人待指定 |
| 产品决策 / 审核 | 用户；本文尚未标记为已审核通过 |
| 创建 / 更新 | 2026-10-21 / 2026-10-24（Asia/Shanghai） |
| 共同术语 / 文档导航 | [统一入口](00-阅读入口与术语.md) |
| 缺陷策略 | 已知缺陷优先修复，禁止复现旧错误；07修复条款优先 |

### 修订记录

| 版本 | 日期 | 变更 | 影响 |
|---|---|---|---|
| 2.0 | 2026-10-21 | 建立正式重建规格、机器契约、交互与兼容验收 | 确立2.0规格基线与忠实复现范围；不修改应用 |
| 2.1 | 2026-10-21 | 补17张实际表、60组UI动作、14字段流、完整工具返回及独立验收 | 保留应用与兼容行为 |
| 2.2 | 2026-10-21 | 全书P1先行；P2世界资产整理与P3事件组织解耦；补实时编辑、批量合并和同书持续会话 | 目标设计变更；旧实现证据不作新验收结论 |
| 2.2 | 2026-10-22 | 用户澄清：提取直接存实体，后续直接CRUD/合并；删除草稿/入库双层 | 单书15表，无发布按钮或重编号 |
| 2.2 | 2026-10-22 | AI统一Pi：direct/agent共用模型层、校验与错误；Agent受控工具读写，应用持久化长期记忆 | 目标规格澄清；未改应用代码 |
| 2.2 | 2026-10-23 | 补18表完整字段与样例、16业务工具契约、Pi迁移/coding取舍与禁用能力 | 明确当前实现与目标补充；专项验收待应用执行 |
| 2.2 | 2026-10-24 | 明确任务身份、命令意图、逐项覆盖、完整Prompt组装和隔离探测；补接口与验收夹具 | 目标需求补全；应用及独立重建仍待执行 |
| 2.2 | 2026-10-24 | 用户明确要求规划时修复已知缺陷，撤销错误行为兼容义务 | 修复后结果作为重建验收；旧失败只作历史证据 |

> **版本边界：** 本文为2.2目标规格。2.1源码取证、旧机器契约、截图和51项历史验收只证明旧实现；新流程的权威机器补充见[2.2契约](resources/v2.2/pipeline-contract.json)，变更对照见[13](13-流程变更与冲突对照.md)。未涉及的字段与算法沿用旧定义；不得把旧资源的流程、锁、会话和按钮规则用于覆盖2.2。

## AI-00 统一Pi架构与两种执行模式

**AI统一基于Pi架构。使用pi-ai作为统一模型调用层，使用pi-agent-core作为Agent执行与运行状态管理层。提供直接模型调用和Agent两种执行模式，共用模型配置、统一的数据校验和错误处理。Agent的长期记忆与业务状态由应用自身持久化，并通过工具向Agent提供读写能力。**

本包所用发布名为`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`，基线版本均1.0.2；这里的pi-ai/pi-agent-core指其架构职责，不要求把依赖替换成其他同名包。当前机器约束见[统一AI运行契约](resources/v2.2/ai-runtime-contract.json)。

| 模式 | 模型与执行 | 工具/记忆 | 当前用途 |
|---|---|---|---|
| direct：直接模型调用 | Prompt/上下文→pi-ai Models.complete/completeSimple或stream/streamSimple→Pi消息/用量 | 无自主工具循环、无AgentState；结构化submit_result仅为返回约束，不写库 | P1两类提取、P2人物/地点详细整编、会话压缩、提取模型探测 |
| agent：Agent | pi-agent-core Agent管理循环/状态/工具执行，其streamFn接同一个pi-ai Models.streamSimple | 受控读写AgentTool；P3按书恢复应用持久消息与工作记忆 | P2精简查询判同、P3窗口串联与全书复核、归并Agent探测 |

extractionModel/aggregationModel是“用哪个模型”的角色配置，direct/agent是“怎样执行”的模式，两者分开；Agent不要求另配一套独立Provider。更换设置中的地址、模型或受支持Provider，只改变统一解析出的Pi Model，业务流程仍只使用Pi接口。

运行中AgentState的消息、工具集、pending tool calls、循环事件由Pi管理；应用负责会话消息、长期摘要/判断、业务资产、检查点和运行记录的持久化。Pi内存状态不等于持久存档，数据库也不是只供Agent读取的静态背景。

## AI-01 统一模型边界、配置与探测

所有推理请求必须经过同一pi-ai模型调用边界，包括生成、流式响应、结果修正、会话摘要和设置页生成测试。界面、业务流水线和Agent工具不得各自发送chat-completions/其他Provider生成HTTP请求或维护另一套消息协议。

已保存配置由统一resolveModel解析为Pi描述快照：providerId/api/baseUrl/modelId/modelRole/contextWindow/capabilities/credentialRef。direct和agent复用同一解析器、Provider注册表、凭据存储及用量/错误适配；每个run固定本次快照，后续配置变化在下一任务生效，P3继续原sessionId但追加配置变化记录，不篡改旧消息。

deepseek和当前模型名仍为默认值，不是所有自定义地址都必须冒用deepseek身份。使用Pi内置Provider或注册的兼容适配器转换协议；未知模型可用已配置ID与该适配器可声明的元数据，缺省/估算须标明，不能直接继承目录第一模型的能力和价格。无法适配或缺必要工具/结构化能力时返回unsupported_provider/unsupported_capability，不绕过Pi再走raw HTTP兜底。

| 请求 | 入口与结果 |
|---|---|
| 拉取模型目录 | 配置/目录适配器可GET /models；它属于发现接口，不是模型推理，不表示生成成功 |
| 提取模型快速测试 | 与正式direct相同的Pi解析/调用/错误处理，发送“回复一个字：好”；须Pi正常结束且有非空文本，HTTP 2xx本身不算通过 |
| 归并工具探测 | 同一Pi解析→pi-agent-core Agent，每套maxSteps3/timeout30000/maxTokens1024；隔离探针工具与真实声明校验，不写真实书库 |
| P1/直接整编/摘要 | pi-ai direct模式，结构化与业务校验见AI-03/05 |
| P2判同/P3 | pi-agent-core Agent，streamFn绑定同一pi-ai实例；工具参数/结果与业务写入同样校验 |

原OpenAI兼容chat-completions协议可继续作为Pi适配器内部实现；Provider特有字段、tool_choice和thinking设置也只放在该边界内，不向业务层暴露。探测读取保存配置，不读取未保存输入；消息/用量/stream事件对外统一为Pi形状，不输出原生Provider对象给业务判断。

## AI-02 有效Prompt与输入组装

2026-10-24起所有有效Prompt使用resources/v2.2/prompts/active的目标版本，完整组装见AI-14。旧Prompt只用于历史回放，不得覆盖2.2阶段分工。`03-merge-world-assets`为旧资源，不属于当前有效人物处理步骤；不得因名称相似把它接入替代现有分层/整编。

| 调用 | 随包Prompt | 常驻输入与输出 |
|---|---|---|
| P1世界资产 | [01](resources/v2.2/prompts/active/p1-world.md) | 章节消息；WorldAssetsExtractionSchema |
| P1叙事资产 | [02](resources/v2.2/prompts/active/p1-narrative.md) | 独立同章消息；NarrativeAssetsExtractionSchema |
| 事件串联/复核 | [P3](resources/v2.2/prompts/active/p3-story.md) | 本批ID、范围、已有线摘要、工作记忆；commit_story_changes.payload用LinkEventLinesResultSchema；最终submit_result仅用AgentTaskSummarySchema |
| 别名补充识别 | [P2](resources/v2.2/prompts/active/p2-identity.md) | 人物/地点类型与精简工具查询，按ID分组提交 |
| 地点整编 | [地点整编](resources/v2.2/prompts/active/location-optimize.md) | 按需详细事实、事实ID；须覆盖全部事实 |
| 会话压缩 | [07](resources/v2.2/prompts/active/compact.md) | 旧摘要与待压缩历史；SessionCompactionResultSchema |
| 人物整编 | [08](resources/v2.2/prompts/active/character-optimize.md) | JSON `{stage,entities:items}`，固定人物键和事实枚举 |

P1用户消息必须为下列格式，换行保留；timestamp为当前毫秒：

```text
章节标识：{chapterIndex}
章节名：{chapterName}

--- 正文开始 ---
{完整章节text}
--- 正文结束 ---
```

串联/复核用户消息按AI-14的StoryTask规范JSON和story.txt模板组装，明确阶段、分配项、窗口或队列、精简目录、相关旧资料、最多6条事件线提示、工作摘要和恢复信息。

P2初始消息只含任务/类型/范围和分页提示，AI调用精简查询自主找候选；不常驻完整人物性格/背景/外貌或地点描述。摘要提示最多160字符，指标不携带详细底稿。分组按已查询的ID提交，跨页可查询后入本次读集；没有确定变更时groups=[]，地点整体与内部区域分开。temperature0。长内容仅在核实候选或整编阶段按需get_*_detail读取，工具参数/返回见11。

## AI-03 直接提交与修正

direct模式由pi-ai执行，无pi-agent-core循环。有Schema时可注册唯一返回约束`submit_result`，parameters为当前Schema，`constrainedSampling:{type:'json_schema',strict:'prefer'}`。模型必须调用该工具；普通文本不当作结构化成功。

返回usage每次尝试均累计。stopReason为error/aborted时按AI-05处理；没有Schema时把text块换行拼接返回。否则找首个submit_result调用，递归normalize可选null，TypeBox验证，再调用共用validateData业务引用/原文等校验。通过后由调用方调用共用命令服务直接提交当前实体；本模式不执行Agent查询或写工具。

提交缺失、结构错或业务校验错默认最多修正一次，P1提取最多修正两次。direct首次、网络重发和修正共用最多3次实际请求预算。修正带回完整assistant原始响应、每个工具调用的配对错误反馈及修正指令。P1失败隔离、主动续期和单项补提取以[逐章提取决策](../decisions/extraction-queue.md)为准。

直接请求总硬上限=`max(各服务错误maxAttempts)+1`。可选字段null仅在非必填且原属性不允许null时移除；递归数组、对象和union分支，不改原响应、不强制类型、不删除必填。

## AI-04 Pi Agent执行、读写工具与最终结果

必须使用pi-agent-core的Agent类管理状态/工具循环，通过streamFn绑定统一pi-ai Models.streamSimple。应用包装runAgent用于配置、预算、租约、校验、持久化和事件投影；不得另写一套模型→工具→模型的业务循环替代Pi。使用Agent类的awaited事件订阅与prepareRequest保证原始assistant消息先持久化，再进入工具执行。

| 职责 | 只读工具 | 写工具 | 记忆范围 |
|---|---|---|---|
| asset_editor | 原9个资产/原文查询工具 | commit_asset_changes | P2临时Pi Agent，不读取故事会话/长期记忆 |
| story_editor | 原14个资产/原文/故事记忆查询工具 | commit_story_changes | P3固定复用本书持久sessionId |

共有14种读工具、2种受控写工具；两角色分别10/15个业务工具。另注册submit_result作为无写副作用的最终结果收集器，不计入业务工具数。白名单按bookId/profile/phase绑定；模型不能通过参数切换书或绕过阶段约束。

write工具的AgentTool.execute实际调用与direct共用的命令服务，按Schema、引用/引文、事实覆盖、读集revision和租约校验后提交当前实体。事务提交成功才返回commitId确认；模型可以根据工具结果继续查询/思考，不必等整个Agent循环结束才写业务数据。失败返回可解释工具错误，不伪装成功。

Agent设置toolExecution=sequential，写工具也声明executionMode=sequential。submit_result必须独占本批调用，混合写入+最终提交的批在首次副作用前拒绝。最终使用AgentTaskSummarySchema（status/commitIds/summary/remainingWorkIds/reviewedItems）报告当前子任务结果；不再用最终submit_result重复执行已生效的资产增量。completed还须代码核覆盖，不能仅信模型声明。

P2身份核实按[世界资产整理决策](../decisions/world-organization.md)收尾；P3按[叙事整理的排队与恢复](../decisions/story-organization.md)执行预算；通过Pi subscribe、prepareRequest、beforeToolCall/afterToolCall和finishTurn管理日志/预算/终止。最后一轮只允许submit_result总结已提交结果和未完成游标，未做的写操作留待下一子任务，不强迫提交未查证业务内容。Provider特有末轮强制参数在Pi适配边界处理。

工具入参及声明返回Schema均按统一校验策略处理，超过65536字节返回TOO_LARGE。业务CONFLICT需要重读相关资料，不当作网络重试；结构/业务无效最多一次定向修正。提交意图和结果收集器不持有原始DB句柄。

P3取得会话租约，加载应用保存的原始消息投影/摘要，通过Pi恢复运行上下文；每个message_end追加原始Pi消息，写服务原子保存业务commit确认，工具反馈再以Pi toolResult进入会话。事务已成功而toolResult未持久化时，下次同operationKey返回原确认，不重写；finally释放自己的租约。P2临时Pi运行不伪造故事消息链。

无持久会话仍用其预算策略；P3持久会话按AI-08压缩。统一模型/校验/错误层不要求两种模式拥有相同记忆与上下文预算。

## AI-05 错误分类、退避与用量

direct和agent共用同一错误归一器。signal取消或Pi stopReason=aborted归cancelled；适配/能力不支持分别归unsupported_provider/unsupported_capability；其余服务error按下列规则分类。错误字符串小写，顺序：空→network；401/403/auth/invalid key→auth；429/rate limit/quota→rate_limit；5xx/internal/bad gateway/unavailable→server；context length/tokens→context_length；content policy/filter/safety/blocked→content_policy；network/fetch/timeout/econnreset等→network；其余unknown。

| 类型 | 服务失败最大尝试 | 退避 |
|---|---|---|
| network / server | 3 | base1000ms，指数与抖动 |
| rate_limit | 3 | 解析Retry-After整数秒优先，否则指数 |
| auth/content_policy/context_length/validation/cancelled/unsupported_provider/unsupported_capability/unknown | 1 | 普通服务重试禁用；结构修正至多一次且消耗剩余总请求预算 |

delay=`round(base*2^attempt*(0.5+Math.random()))`，attempt从0。Retry-After仅按字符串正则提取整数，不增加HTTP日期支持。direct每逻辑调用最多3次实际Provider请求，P2身份核实按世界资产整理决策收尾；P3按叙事整理的排队与恢复决策执行预算，章节层不另套重试。两模式由同一服务重试策略处理可重试错误/Retry-After，不在Pi Agent外再叠加一套独立网络重试循环。退避等待必须响应signal；取消在下一事件循环结束等待并阻止下一请求，清理timer/listener；已提交确认保留。

有session的Agent遇context_length可额外强制压缩恢复一次，再按服务策略；不能无限压缩。模型调用失败对象统一含ok=false、原Pi stopReason、errorKind/errorMessage、attempts/attemptsUsage、mode/modelRole/bookId/runId；保留无凭据的Provider诊断。工具业务错误独立记录，写成功后末轮失败/取消不得回滚已提交实体、记忆和确认，状态与报告必须列出已应用commitIds。费用为每次返回usage.cost.input+output的总和，摘要费用也计入；不按UI货币符号自行换算。

## AI-06 查询工具完整行为

完整参数、必填、范围、描述和返回约束在[2.2 tool-contracts.json](resources/v2.2/tool-contracts.json)，返回Schema见resources/v2.2/tool-results.schema.json。所有分页输出为`{data,totalCount,truncated,nextOffset}`；通常offset0/limit100，再受工具maxResults限制。单行>64512字节改为`{id,fields_omitted:['oversized_detail'],hint}`；累计返回逼近64512停止，外层65536字节再限制。参数limit Schema最大200，不等于每工具均能返回200。

| 工具 | 过滤/排序/输出与限额 |
|---|---|
| query_nodes | chapter_range闭区间、actor精确匹配actors或targets、event_line_id按真实线成员；章/order排序；summary前240；最多200 |
| get_node_detail | ids1–20；短详情完整返回，长详情返回最多6000字符的JSON片段，按char_offset与nextCharOffset续读 |
| query_event_lines | status/name_like子串/章节任一相交；character先查人物资产扩充全部同组称呼，再用成员actors/targets匹配；cause/result前160；最多50 |
| get_event_line_detail | 参数ids最多20，实际最多10条 |
| query_characters | 主名和别名包含name_like；返回id/name/aliases/identityHint/sourceChapters/revision/指标；无详细字段；最多100 |
| get_character_detail | 按ID取详细档案；默认排除优化缓存，include_facts=true仅P2整编显式取底稿；最多20 |
| get_location_detail | 按ids1–20取完整地点；include_facts语义同上；最多20 |
| query_locations | 主名别名包含过滤，精简行id/name/aliases/descriptionHint/sourceChapters/revision/指标；不返回完整description；最多100 |
| read_original | 按资产来源、离散章节或连续范围选择原文；多个条件取交集。返回章节片段及续读游标，按游标从指定章节的章内位置继续；每次最多20段、20000字，并受字节限制。合并校验实际返回过的引文片段 |
| get_editor_memory | 当前或指定同书会话；摘要、dataChanged、pending/stale数、最多10条active笔记摘要、最近5个批次；statement前240、引用各前5，truncated提示 |
| query_editor_notes | kind/key/status/node_id/line_id，stale匹配validity而非status；最新更新在前；最多50 |
| get_editor_note_detail | 同会话指定ids完整笔记；最多20 |
| list_editor_sessions | 当前书创建时间倒序，摘要含parentSessionId和entryCount；最多50 |
| query_editor_session_history | 当前或指定会话；summary预览前800/最多50，full最多20；entry_id模式按JSON字符char_offset/maxChars（默认8000/最大20000）分段，越权/不存在返回NOT_FOUND |

取消参数查询返回ABORTED；参数错误INVALID_ARGS；超大TOO_LARGE；工具返回结构错误INTERNAL。这里只读“其他同书历史会话”不能扩张到其他书。

## AI-07 工作记忆、依据和检查点

工作记忆结构和字段见DATA。校验要求非空trim摘要和statement/key、批内key唯一、至少一个node/line/evidence依据，节点线引用有效；新增临时节点允许在本批先声明。evidence.quote必须在指定章逐字存在；错误时回查所有章给实际所在章提示。resolved不能用于此前不存在的事项，同主题kind不能变。

2.2不再把全库assetFingerprint作为P3批提交或检查点失效条件。叙事事实指纹包含节点/线事实、相关章原文与策略版本；节点actorIds与targetCharacterIds属于持久人物关联并参与依赖比较，事件线characterIds由成员节点派生。世界依赖按实际查询返回的kind/id/resolvedId/revision及查询页参数/结果指纹记录；提交前重读这些依赖。可另计算全库统计指纹作诊断，但不得用于阻断无关P2/P3并行。

笔记依据指纹含实际世界依赖列表（kind/id/revision或resolvedId）、引用节点/线事实、原文章段指纹与evidence/present布尔；不再纳入全库assetFingerprint。与当前计算不等则validity=stale；不直接写坏原笔记状态。dataChanged比较本会话已记录的实际依赖和叙事事实指纹；pendingCount只计kind review/status active，和staleCount独立。

checkpoint key按sessionId+P3 phase+窗口/队列单元+策略版本哈希；sourceFingerprint含相关章原文、读写集节点/线事实和实际读取的世界资料revision。恢复需checkpoint completed且指纹匹配；link还核对当前实际线成员与保存memberships相等。无关世界资产变化不使整书P3失效；实际引用资料/原文变化只使相关批次和笔记过期并入复核队列。未引用的人物地点不能经全库assetFingerprint间接使全部提交失败。

commit_story_changes调用的prepareEditorCommit先校验增量，按会话+主题key更新或创建notes；memory.revision从预期+1；checkpoint completed与memberships随提交生成。在事务中再核memory revision、叙事读写集revision及本批实际世界依赖revision，最后写入并追加commit摘要前1800字符。失败/取消checkpoint不能替代之前已完成批次结果。

## AI-08 持久消息、投影与压缩

### 原始记录

每书仅一个active story_editor。首次P3创建UUID会话；窗口切换、全书复核、继续、失败恢复和“重新串联与复核”均ensure当前sessionId，追加新任务消息，不归档或新建会话。新书/重复导入为新bookId和新Agent，不允许跨书查询或复用摘要。2.1已有多个历史会话时保留其只读记录，选择当前active作为2.2持续会话，不拼接伪造消息历史；parentSessionId只作旧数据兼容。追加条目在session/entries事务中取nextOrdinal、parentId旧leaf，更新leaf与nextOrdinal；持租约写入须owner一致，无owner提交不得占用活租约。

这里的会话是持久消息与摘要；Pi 运行实例是使用这些记录执行任务的内存对象。页面刷新后，应用可以新建运行实例并恢复原会话。具体生命周期见AI-16。

NativeMessage保存标准PI形状，允许额外字段包含模型/用量/推理和toolCall；不是只存role/content文本。messages、toolResult、system toolsAdded/Removed的SDK具体结构使用锁定pi-ai标准类型。

### 投影

从leaf沿parent到根形成消息路径，发现循环/缺父抛错；反转为正序。最新compaction存在时，取其自身+其前firstKeptEntryId起的非system消息+其后条目；omit标记的id从投影移除。commit投影为user `[代码提交确认] ...`，但若此前assistant尚有待配对toolCall，则暂缓该应用确认，直到该批toolResult（或明确的中断占位结果）配齐后再投影，不能插入原生toolCall与其toolResult之间；compaction投影为保存systemMessage和user摘要提示；omit不投影。

若assistant发toolCall但原始历史缺结果，投影补一个isError toolResult，明确“会话中断，工具结果未保存；写操作可能已提交，请按原operationKey核实/幂等重试。此标记不是实际工具结果。”，不得写入原始存档；无对应pending调用的孤立toolResult不投影。

### Token估算与阈值

文本按code point：CJK/Kana/Hangul范围1.5，其他非ASCII1，ASCII0.25，最后ceil；message=16+JSON（去usage）的估算。有效最近assistant usage存在且在最后compaction/omit之后时，用其totalTokens（或input/output/cache之和）加后续消息估算；错误/aborted和压缩前usage不能当当前大小。

默认reserve32768/keepRecent150000。实际reserve=min(配置或32768,max(128,floor(window/4)))；keep=min(配置或150000,max(64,floor((window-reserve)/3)))。启用且tokens>window-reserve触发压缩；强制恢复亦可触发。

### 压缩过程

压缩处理较早的完整对话与工具结果，产生摘要后供模型上下文使用。窗口历史、原文章节和原始工具结果继续保留；后续输入由有效系统要求、本次任务、摘要和近期完整对话组成，需要的原文通过本书工具读取。以下规则是预算与投影的权威定义。

从末尾累加消息预算选择user/assistant切点，不从toolResult切入；第一次无可用切点改keep64，再尝试在可容纳尾部的后续任务边界切；仍超窗可保留零旧条目，firstKeptEntryId指压缩条目自身。

前缀剔除system与compaction序列化为带“原始条目ID、角色”的JSON文本；沿用上次摘要。每块最大预算=max(256,floor(window*0.45)-Prompt估算)，逐块调用归并角色摘要，maxTokens=min(16384,max(128,floor(window/8)))、temperature0；摘要字符上限=min(64000,max(64,floor(maxTokens/2)))，绑定到输出结构和系统提示，格式或长度错误允许修正一次；每次实际请求的usage计入。

有效系统设置与工具集合通过Pi原生接口从消息链取得。压缩记录保存当前职责要求、系统段落和生效工具，后续请求继续使用原生工具声明。

空摘要、结构错、取消、after>=before或after>window-reserve均失败，不提交compaction，不删除原记录。成功追加含summary/firstKeptEntryId/tokensBefore/tokensAfter/systemMessage/usage的条目。后续仍需保持当前任务精确输入，若压缩投影已不含当前opts.messages则重新追加，不能仅用概括摘要代替本批ID与要求。

## AI-09 补齐输出与回放

16种目标业务工具（14读+2写，最终收集器另计）的成功/空/错误/截断返回形状、目标变更和2.1历史响应分别见[11](11-AI工具返回与回放契约.md)。原2.1 tool-contracts仅为历史声明；2.2新增/变更工具执行当前入参和返回校验，未变只读投影的历史校验边界按各工具说明，不允许以旧“只读”限制取消新写能力。

具名模板、变量绑定和组装表在11；原始ai-message-templates仅精确字面补充。6份完整HTTP录制与服务级失败/恢复用例共同覆盖本包实际验证范围；独立验收入口与未覆盖时序见12。

## AI-10 P3置信度、自由查询与覆盖证明

window_link只接受confidence>=0.85且引用有效的event_line_ops，附reason/evidenceNodeIds；低置信关联记录review事项。global_review也不凭空造因果，允许明确结论“独立节点/暂不归线/尚无足够证据”。补点参考引文采用可选定位提示；结构与领域提交仍按统一修正规则处理。

P2身份核实按世界资产整理决策分配预算；P3子任务按叙事整理决策分配预算；Agent可自由选择本书工具，未完成时拆分/续同会话处理下一页。步数预算仅限制单次调用，不能截断整书覆盖。任务上下文标明已看范围、未看游标和当前阶段，不得将压缩摘要当作新原文证据。

世界详情工具返回revision/当前redirect目标，代码记录实际读集。P2并行更新命中读集时，本批拒绝并同会话重查；不命中则正常提交。任务结束前再核全书覆盖清单和依赖有效性，未覆盖不能标completed。

## 精简资产遍历的稳定游标

query_characters/query_locations新增可选after_id。按当前ID的Unicode码点字典序返回，设置after_id时必须省略offset；nextAfterId返回下一页所用最后ID，末页为null。totalCount仍为名称条件匹配的当前全量数，nextOffset仅供无after_id的普通读取兼容。处理边合并边删除时用稳定游标，不能让offset偏移跳过未读行；最终重枚举清单补人工新插入或变更项。

P2每次分配一个资产，其他候选可通过最多100条的分页查询读取。字段白名单、after_id和nextAfterId以当前工具机器契约为准。详情单行超过字节/上下文上限且无法完整读取时明确降级并保留底稿，不能宣称用截断事实完成整编。

## AI-11 应用长期记忆与业务写工具

| 写工具 | 输入 | 事务与确认 |
|---|---|---|
| commit_asset_changes | operationKey + IdentityGroupsSchema payload | 绑定P2读集，机械融合当前characters/locations、来源映射、报告和命令凭据；返回commitId/alreadyApplied |
| commit_story_changes | operationKey + 2.2 LinkEventLinesResultSchema payload | 节点/线、memory_update、事项、检查点、覆盖、命令凭据及代码确认同事务；空资产操作可只更新工作记忆 |

读长期记忆使用现有5个故事查询工具；写记忆通过commit_story_changes，而非让模型直改数据库或只更新Pi内存。工作记忆需证据/引用校验，模型判断不自动变成原著事实。不同bookId的消息/摘要/笔记/工具作用域不共享。

pipelineRuns.appliedCommands记录(runId,operationKey)、payloadFingerprint、commitId、committedAt和resultSummary，与业务修改同事务。相同键相同payload返回原确认；相同键不同payload返回IDEMPOTENCY_CONFLICT。中断恢复沿用原runId/operationKey并更换租约owner；用户明确新一轮重查才创建新runId，P3逻辑sessionId仍不变。断线、重试、页面关闭或“DB已提交但工具反馈丢失”不得造成二次合并、重复补点或记忆revision重复增长。人工CRUD、direct和Agent写服务共用相同领域校验与事务，不引入新草稿或待发布层。

Pi只管理当前进程AgentState与循环。应用持久化会话、工作记忆、业务状态和命令凭据，恢复时重新创建Pi Agent运行对象并装入该书规范上下文；长时记忆不是SDK自动落盘，也不靠服务商保存对话实现。

鉴权需求由Pi适配描述声明：需要Key的Provider缺凭据报auth；明确无鉴权的受支持端点可无Key探测，不注入虚构anonymous Key。SDK和适配器能力范围之外返回统一不支持错误。

幂等检查顺序为：参数结构/当前书角色作用域校验→在事务中检查(runId,operationKey)账本→同payload已应用则直接返回原凭据→仅新命令继续核当前记录、实际读集/revision、引文和写事务。不能先因旧成员已被合并/删除而拒绝已成功命令的重放。原凭据只确认此前提交，不保证当前实体未被后续人工更改；返回后仍按需重查当前数据。

原始Pi消息顺序和原始会话条目都保留。应用commit注释仅在模型上下文投影时移到相应toolResult批之后；中断时的占位结果明确isError且非实际执行结果，再展示真实持久commit注释并要求原键核实，不能伪造服务商或工具原始响应。

一个写命令的全部payload（包括多个groups）及对应命令凭据必须同一事务全成或全败；不得在同operationKey下先提交部分组再补记账本。跨命令/机械单组的已提交结果可保留，单命令失败不回滚此前其他命令。

## AI-12 工具实现与Pi迁移的权威入口

Pi包取舍、coding层不接入的具体能力、浏览器限制和逐模块迁移顺序见[02 AR-12](02-架构与技术规格.md#ar-12-pi接入coding包取舍与迁移顺序)。16种业务工具的完整参数、结果形状、执行与错误恢复见[11第6节](11-AI工具返回与回放契约.md#6-可直接实现的工具定义)；当前表字段见03第8–9节。

业务工具不是Pi自带工具。AgentTool必须以应用闭包绑定书籍/职责/阶段/运行，输入与成功输出分别验证，失败设置isError；outputSchema的structuredContent供程序，模型仍需content中的JSON文本。只有Pi Agent类/循环可复用，不接coding默认工具集、编码Prompt、文件会话或CLI。

当前optimize是direct模式：应用按asset_editor/optimize权限预读完整事实并组装请求，不在direct里执行自主get_*_detail循环。P2 ai_identity仍可按需读不带底稿的详情；P3禁止include_facts=true。这避免把“可预读的工具服务”误写成“所有模式都有自主工具”。

## AI-13 提示词调用清单与重建缺口审查

> 以下保留2026-10-23审查时的缺口记录；其中“缺失/未交付”不是当前状态。2026-10-24的完整定义与当前状态以AI-14/15、03第10节和12闭合表为准。

**2026-10-23历史审查结论：当时不是完整的2.2 Prompt调用包。** 存在Prompt文件只说明静态正文已提供；实际请求还包括调用入口、角色/阶段包装、动态变量、输出Schema、工具声明、历史、末轮收束和错误修正。逐调用审查清单见[prompt-call-manifest.json](resources/v2.2/prompt-call-manifest.json)，所有未确定部分显式记为missing，不由开发者猜成统一字符串。

### AI-13.1 十种有效调用

| 调用编号 | 触发/模式/模型角色 | 消息与Schema | 审查状态 |
|---|---|---|---|
| PROMPT-P1-WORLD | P1世界子步骤或单章试跑；direct/extraction | 01世界Prompt+完整ChapterTask；唯一submit_result=WorldAssetsExtractionSchema；不包含前次叙事/世界响应 | 静态定义可追踪；未独立重建 |
| PROMPT-P1-NARRATIVE | P1叙事子步骤或单章试跑；direct/extraction | 02叙事Prompt+独立同一ChapterTask；唯一submit_result=NarrativeAssetsExtractionSchema | 静态定义可追踪；未独立重建 |
| PROMPT-P2-IDENTITY | P2 ai_identity人物或地点；agent/aggregation | P2目标Prompt+asset_editor包装+IdentityTask；写工具IdentityGroupsSchema，最终AgentTaskSummarySchema | 缺目标完整包装、任务绑定/恢复上下文，RQ-01/03 |
| PROMPT-P2-CHARACTER | P2按需人物整编；direct/aggregation | 08人物整编Prompt+JSON CharacterOptimizationTask；动态固定人物键及事实枚举 | 输入字段/动态Schema可追踪；未独立重建 |
| PROMPT-P2-LOCATION | P2按需地点整编；direct/aggregation | 新地点整编Prompt；LocationOptimizationSchema返回description/coveredFactIds/conflicts | 缺精确输入对象和事实映射，RQ-01 |
| PROMPT-P3-WINDOW | P3窗口子任务；agent/aggregation | P3 Prompt+story_editor包装+phase=window_link任务+同书历史；写Link payload，最终Summary | 缺目标任务消息/覆盖单元/完整请求回放，RQ-01/03/04 |
| PROMPT-P3-GLOBAL | P3全书复核子任务；agent/aggregation | 同一P3 Prompt及session，phase=global_review；输入孤点/线/事项当前页 | 缺队列绑定/继续选择规则及完整回放，RQ-01/03/04 |
| PROMPT-COMPACT | 超预算或一次强制恢复；direct/aggregation | 07压缩Prompt+旧摘要+指定历史；SessionCompactionResultSchema；不调用Agent业务工具 | 静态定义可追踪；目标写后中断投影未执行 |
| PROMPT-PROBE-DIRECT | 设置生成测试；direct/选定模型角色 | user“回复一个字：好”，maxTokens=8；无Schema；要求有效Pi文本 | 当前代码仍raw HTTP；目标已要求Pi但未实现 |
| PROMPT-PROBE-AGENT | 设置工具测试；独立probe Agent/aggregation | 当前旧实现要求submit_result({ok:true})；目标要求真实工具声明/隔离写入验证 | 不能把旧探针当新finalizer；目标探针流程缺定义，RQ-05 |

旧merge-world、旧按名称分组、旧地点snapshots融合和旧P2/P3串联Prompt用于旧回放。试跑复用P1契约；导入、图布局、文件导出和机械融合按本地流程执行。游玩接入时单独定义任务提示词与工具清单，使用AI-16的按书会话机制。

### AI-13.2 已能独立描述的动态绑定

**ChapterTask**：chapterIndex来自chapters主键，chapterName来自该行，text来自对应chapterTexts完整正文/切块；均必填string。使用AI-02逐字模板与LF换行，不能悄悄截断。用户消息timestamp为本次Unix毫秒。世界与叙事请求独立；temperature/maxTokens未指定时保留省略，由锁定Pi/模型默认处理，不能写成temperature=0的既有事实。

**CharacterOptimizationTask**：JSON对象`{stage:"P2",entities:[...]}`，每项含id、name、aliases、previous、facts、conflicts。id和name来自当前人物，aliases缺省为空列表。previous是当前identity、appearance、personality、background展示稿；facts读取完整事实底稿，每项包含本次短号、字段、文字和来源章节，按本人物本次顺序编号。conflicts取mergeNotes或空列表。多条同义事实可以合成一句，仍完整返回对应编号。调用方保留短号与持久事实的对应，模型生成展示文字。

动态输出Schema的entities键必须等于本批人物ID且全部必填；各人物name及aliases元素限定在去重后的`[name,...aliases]`枚举；covered_fact_ids枚举只含本人物本次短号，minItems=maxItems=事实数且uniqueItems=true；各层additionalProperties=false。通过Schema仍要验证文本没有把已知字段清空；“列全事实ID”不证明模型语义上没有漏事实。

**CompactionTask**：user文本为`【旧摘要】\n{previousSummary或“无”}\n【需要压缩的原始会话数据】\n{transcript}`。transcript逐条采用`[原始条目 {entryId}，角色 {role}]\n{JSON.stringify(message)}`，条目间两个LF；剔除system消息和compaction条目正文。每块使用上一块已产生摘要继续；选取/预算/压缩失败行为见AI-08。不能把整本小说或任意历史范围代入transcript。

### AI-13.3 Agent最终Prompt不等于一个md文件

当前旧实现的有效system顺序是：会话作用域文字（只有持久故事会话）→职责label/instruction→调用者业务Prompt→maxSteps/唯一修正次数/最后一轮约束。初次工具声明通过Pi初始system消息进入历史；后续prepareRequest计算toolsAdded/toolsRemoved。仅修改context.tools不足以保证旧历史中的工具声明撤回。

目标2.2必须保留这些层的职责，但**不能直接照搬旧包装文字**：旧末轮要求提交groups或Link业务增量，新末轮只能总结commitIds；旧story_editor职责包含P2/P3，新P2不进入故事会话。当前目标业务Prompt虽已改对，目标职责包装、末轮模板和错误模板还未交付一套可直接渲染的完整版本。此项仍为RQ-01阻断，不能用“按Pi处理”跳过。

完整请求必须按如下顺序可追踪：解析配置快照→确定callId/phase/profile→确定业务Prompt及hash→装配system/工具Schema→装配当前任务变量→恢复同书消息投影并压缩→追加本次任务→Pi发起请求→assistant原始消息持久化→工具参数/领域校验和execute→toolResult→下一轮或唯一finalizer。重建验收须冻结这个边界上的实际Pi Context，不能只检查Prompt文件存在。

**修正也有两种协议。** direct把原始assistant和每个toolCall对应的错误toolResult加回messages，再追加“唯一一次修正机会”用户消息；非submit工具不执行。Agent写命令报CONFLICT须重读，不得用末轮summary冒充修复成功；参数/领域错误的修正权限与最终summary错误必须分别定义。当前“最多一次修正”没有完整界定这三种分支的工具集/步数消耗，列为RQ-01的一部分。

仅文字对齐无法证明效果一致。模型名称、服务版本、采样、工具返回和上下文都会影响输出；应验收请求结构、引用/事实约束、持久状态与恢复规则，不能承诺逐字相同的模型回复。

## AI-14 完整请求组装与修正规范（2026-10-24）

本节取代AI-13中标为缺失的目标定义；AI-13保留为审查历史。有效正文统一位于[active Prompt目录](resources/v2.2/prompts/active/README.md)，调用映射见[prompt-call-manifest](resources/v2.2/prompt-call-manifest.json)，输入结构见[prompt-inputs.schema.json](resources/v2.2/prompt-inputs.schema.json)。未变提取语义复用，但已去掉与实际联网边界矛盾的旧尾注；旧resources/prompts仅作历史取证，不能覆盖active版本。

### 输入绑定和默认值

所有对象按Schema逐字段校验，不允许额外键；未注明可省略的字段均必填。null仅用于明确“没有”的游标/window/目标引用，不以空串混用。JSON请求正文统一递归对象键按码点排序、数组保持给定顺序、UTF-8无额外空白；文本模板按LF换行，Prompt正文原样读入，不trim正文段落。字符串替换只处理模板的具名占位符，不递归执行替换后的正文，也不eval模型/用户内容。

| 输入对象 | 确定来源、排序与缺省 |
|---|---|
| TaskIdentity | bookId/runId/taskId来自应用绑定；planVersion=2.2；remainingCount为当前phase未有效覆盖项数，不能信模型计数；resume四字段均必填，初始reason=initial、appliedCommitIds=[]、remainingWorkIds=本task分配ID，nextOperationKey建议taskId加命令序号 |
| IdentityTask | stage=P2、phase=ai_identity、kind=当前人物或地点队列、scope=fullBook；workItems为ALG-12.4分配的1项；afterId为本次扫描起点，无则null；pageLimit=100。输入仅ID/版本/hash，不常驻人物背景等长字段。主名、别名、完整资料用工具读取 |
| StoryTask | stage=P3；phase与queue对应：window_link→window_nodes且window必为对象，global_review→orphans/event_lines/review_notes且window=null；sessionId来自本书active会话；workItems上限100，event_lines实际最多30；afterWorkItemId无起点为null |
| Window | start/end按原章零基半开范围，end>start；chapterIndices为该窗口所有实际切块主键，按Chapter.order排列；不得用“章号字符串的大小”替代原章顺序 |
| StoryTask.existingLines | 最多6条事件线提示，优先相关线；长成员与章节列表标注截短，完整内容通过详情工具读取 |
| StoryTask.contextHints | assigned为分配项精简目录，按版本核验登记读取；related为本书相关旧节点、事件线和未解决事项候选，更多结果通过search_story_context分页检索 |
| StoryTask.memory | 当前session的T13完整记录；无存储时使用03虚拟空记录；不混入另一书或P2记忆。事项、检查点及原始历史由对应工具按需读，不在该字段塞入未声明对象 |
| CharacterOptimizationTask | 原AI-13绑定加每个人物revision；必须等于读取版本。事实field限四个文本字段；每个id局部F1/F2，附带独立输入短号→持久事实ID映射供调用方校验，映射不让模型生成。previous为上次有效整理稿，无则{} |
| LocationOptimizationTask | stage=P2；id/name/revision来自当前地点；description缺省空串；facts为本地点**全部**description事实，按持久事实ID排序后改成本次F1/F2；conflicts=mergeNotes或[]。不使用人物的增量事实/previous机制；全事实为空则代码跳过，不发模型 |
| CompactionTask | 按AI-13精确模板，previousSummary空串渲染为“无”；transcript只含此次选中历史片段，不掺原文全集；预算见AI-08 |
| DirectProbeTask / AgentProbeTask | 文本探测输入{}；模型角色由设置调用上下文选择，默认extraction。Agent探测输入suite=asset或story、taskId和operationKey，由应用创建；无真实书籍输入 |

WorkRef中revision和factFingerprint是服务读取快照，禁止模型改写；chapter类型revision=0并用全文hash。输入Schema的integer/string约束之外还必须核phase/queue、callId、书籍归属、唯一workItemId和实际分配集合。仅Schema通过不能替代这些语义校验。

TaskRecord.input保存首次创建任务的不可变快照。每次实际请求从它复制requestInput：只刷新resume、remainingCount，以及P3的memory/existingLines提示，并把刷新读取记入本次读集；workItems的ID和计划版本不改，代表原始分配依据，不假装是当前行。最新数据通过工具核查。本task已确认写入导致版本变化时在resume说明并采用提交后的读基准；相关外部事实变化则原task置stale、剩余项交新task，不能静默改写冻结输入或继续使用失效版本。requestInput只用于当前请求，TaskRecord.inputFingerprint始终对应原始快照。

### system、user、历史和工具的唯一顺序

| 模式 | 组装顺序 |
|---|---|
| direct提取/整编/压缩 | systemPrompt=对应active业务正文；messages仅本次user；tools仅submit_result，参数为当前输出Schema，constrainedSampling={type:json_schema,strict:prefer}。不加载P3消息历史 |
| P2 Agent | 渲染agent-wrapper.txt：作用域→职责→预算/幂等→业务正文→结束约束；用Pi初始system声明9读+commit_asset_changes+finalizer；user=identity.txt(taskJson)。不携带P3历史 |
| P3 Agent初次 | 同wrapper，职责只负责叙事；初始system声明14读+commit_story_changes+finalizer；user=story.txt(taskJson) |
| P3继续/恢复 | 先按AI-08恢复合法配对消息和压缩投影；若有效system或工具集合变化，用Pi系统更新追加替换/撤销声明；追加recovery.txt恢复摘要（仅恢复时）→本次story任务。不把新的system硬插在未配对toolCall和toolResult之间 |
| 末轮 | system撤回全部业务工具，仅保留submit_result；追加final_only.txt，变量commitIds来自本task账本，remainingIds来自分配清单；同时把可执行白名单收窄。只改Prompt文字而不改执行白名单不合格 |
| 探测 | 使用probe_system及probe_asset/probe_story；完整业务工具声明可发送，但回调接隔离fixture；完成门槛见AI-15 |

所有模式的system提示词都在业务正文之后追加[output-discipline.txt](resources/v2.2/prompts/active/output-discipline.txt)：direct追加在业务正文之后，Agent追加在业务正文之后、结束约束之前。该文件是这段文字的唯一来源，代码统一读取，业务正文文件不重复保存。

角色文字固定：asset_editor“只整理人物地点；不读故事会话/工作记忆，不改叙事实体。”；story_editor“只整理节点、事件线和工作记忆；不合并人物地点，历史摘要不是原文事实。”。bookId/runId/taskId/phase由调用上下文绑定；工具参数永远不能扩展权限。

字符/地点整编动态Schema均锁定本次事实短号，数量必须恰好相等且唯一；人物还锁定entities键和已知名称枚举。调用方在提交前再核revision及短号映射，成功后将coveredFactIds映射回持久事实ID；模型不能通过抄全ID获得免除语义校验的权利。

### 预算、网络重试和一次修正

P2身份核实的时间、请求次数与提前收尾方式以[世界资产整理决策](../decisions/world-organization.md)为准。每次请求前提示剩余时间和次数，已提交修改与未完成项分开保存。累计使用量只计一次。

P3每个子任务的5分钟、20次请求收尾规则以[叙事整理决策](../decisions/story-organization.md)为准；stepsUsed在发请求前持久递增，刷新恢复不清零。maxTokens=`min(model.maxTokens或8192,reserve)`，P2/P3同式；reserve按AI-08。恢复发现已用完本任务预算则task=partial，剩余工作按新task处理。P3本轮未完成项让后续任务继续；本轮结束保存剩余清单，由用户继续。

网络/服务重试仍按AI-05；每次实际Provider请求消耗stepsUsed并计usage，不存在免费重试轮。tool CONFLICT不算网络失败：追加conflict.txt，保留工具权限供重读，消耗正常余下轮数；预算不足则partial。任务attempt统计实际Provider请求次数，与stepsUsed同时递增；启动/恢复本身不加1。P2在响应结束后收尾；其他任务到期中断时保留已提交确认。

| 错误类型 | 本task唯一修正机会怎么用 | 工具权限与终止 |
|---|---|---|
| direct输出结构/语义错误 | 原assistant与每个toolCall配对错误结果入上下文，再repair_direct.txt；最多一次 | 仍仅submit_result；第二次错返回validation |
| Agent写参数/领域错误 | 错误toolResult后追加repair_write.txt；repairCount从0变1；修改payload必须新key | 保留本角色工具；按本任务剩余预算修正，未完成项保存为partial |
| Agent最终总结错误 | 追加repair_final.txt；若repairCount仍0可变1，并额外允许第7轮仅修最终总结 | 第7轮只允许submit_result；已用过修正机会或再次失败就partial/validation |
| CONFLICT | 不消耗repairCount；必须重读相关依据；新判断用新key | 只消耗普通请求预算；不能无限续轮 |

write修正与final修正共享一次机会，不能各自多给一次。运行器不得因最终总结错误重新执行已经成功的写命令。代码生成错误诊断与配对toolResult，不接受模型自己声称“验证通过”。模板变量error来自无凭据的校验诊断；operationKey/nextOperationKey/commitIds都来自当前任务状态。

### 完整请求样例及等价标准

[request-examples/index.json](resources/v2.2/request-examples/index.json)包含十种调用（Agent探测两套）、direct修正、写修正、末轮和恢复的完整Context/工具声明/模型元数据/选项。它们是契约样例，非真实模型录制。生成器只读本规格包，不能导入原业务源码计算请求。

timestamp、UUID、真实模型名称配置按夹具替换规则比较；system/user文本、变量取值、tools名称/参数Schema、消息顺序和配对必须一致。Provider原生HTTP格式由锁定Pi适配器生成，不要求业务自己复制。样例指纹以fixture前缀标示的值只用于结构示例，运行有效性须用真实输入计算。

## AI-15 隔离模型与工具探测（2026-10-24）

文本探测走正式DirectExecutor/ModelGateway，user固定“回复一个字：好”，maxTokens=8，temperature省略；stopReason error/aborted、空文本均失败，HTTP 2xx不单独表示成功。只用已保存配置，未保存输入不参与。界面显示耗时及无密钥的错误/回复片段。

归并工具探测依次运行asset、story两套，每套新建内存仓储及任务上下文，不调用getCanonDb、不创建书架项或真实会话。每套最多3轮、30000ms、maxTokens=1024、temperature=0；取消立即终止余下套，测试结束无论成功失败都释放引用销毁fixture。它不覆盖生产大书性能/全部业务分支。

| 套件 | 固定前置 | 必须发生的调用与结果 |
|---|---|---|
| asset | 隔离book、task；C1-P001与C2-P001两个人物均name=沈青、revision=1、confidence=1、createdBy=P1、aliases=[]；有效world租约；初始无命令 | 第1轮get_character_detail两ID并记录版本；第2轮commit_asset_changes按probe_asset模板合并；确认目标revision=2、另一行删除、映射已并入且账本一条；第3轮仅submit_result，commitIds必须为本次真实确认，reviewedItems/remainingWorkIds均[] |
| story | 隔离book、task/session；无节点线，虚拟memory revision=0；有效narrative/会话租约 | 第1轮get_editor_memory({})；第2轮commit_story_changes空资产操作、workingSummary=隔离探针摘要、notes=[]；确认memory revision=1且业务节点/线仍空；第3轮总结本task确认，reviewedItems/remainingWorkIds均[] |

两套均注册所属角色的完整工具参数/输出声明，以检测服务商对这些声明的接受性；未要求的工具不得访问真实数据，返回INVALID_ARGS及“探针仅允许指定调用”。写服务使用与生产相同校验/幂等/事务接口，但Repository实现为一次性内存fixture。探针分配项为空是显式probe特例，生产Agent不能用空分配项绕过覆盖校验。

通过条件必须同时满足：模型接受声明、实际执行规定读取、实际隔离写入及持久确认语义正确、最终总结正确。仅回`{ok:true}`不能通过。任意环节失败返回哪一套/哪一步及错误，保留临时诊断供当前UI展示；不持久化完整真实Key或复制真实书籍用于测试。

## AI-16 按书运行与会话生命周期

Pi 负责模型协议、智能体循环、消息和工具事件。应用通过公开接口接入已保存配置、书籍范围、会话存储、上下文投影、预算和业务提交；这些接入点同时供整理和游玩使用。基本职责见[AR-11](02-架构与技术规格.md#ar-11-ai统一pi边界与状态归属)，持久字段见03第5节，压缩规则见AI-08。

| 场景 | 处理要求 |
|---|---|
| 首次打开书籍会话 | 按书籍和职责确定逻辑会话，创建本书独立 Pi Agent，装入系统要求与本书工具集合 |
| 再次打开 | 读取该书消息链、有效摘要和提交记录；已有独立实例可继续使用，实例重建后加载原会话 |
| 书A切到书B | 窗口展示B的历史，使用B的独立实例和工具范围；A的运行保持绑定A，后续事件仍写回A |
| 切换顶层页面 | 卸载窗口组件后，持久会话保留；运行与取消按各自任务身份处理 |
| 页面刷新或重新打开 | 从本地数据库恢复原会话；中断任务展示可继续状态，继续前核对工具提交记录和依赖 |
| 模型请求和工具调用 | 使用创建时绑定的书籍、职责、逻辑会话和运行编号；工具参数按已绑定范围校验 |
| 取消 | 中断模型请求和退避，等待在途工作停稳，保存已有消息与提交确认，释放当前任务持有的资源 |
| 上下文接近容量 | 按AI-08生成有效摘要并追加记录；后续请求使用摘要与近期完整对话，历史视图仍读取完整存档 |
| 书籍备份恢复 | 保留会话与确认，重写新书归属；新运行使用新书自己的实例和工具范围 |

不同书籍可以复用服务地址、模型和凭据，各自持有独立的消息、摘要、工具集合和运行对象。只设置运行会话编号时，仍须按上述范围加载上下文和工具。

P2按现有职责使用临时实例；P3沿用本书当前整理会话。游玩按书提供独立会话窗口，使用自己的职责、对话和工具，复用同一套保存、恢复与压缩能力。

运行事件通过 Pi 原生事件接口订阅并按原顺序处理。工具调用与结果保持配对，业务写入完成后以持久提交确认核对成功；消息追加和工具确认的事务边界按03与AI-11执行。正式任务保留 Pi 的多轮工具循环，连接探测的结束条件由探测入口提供。
