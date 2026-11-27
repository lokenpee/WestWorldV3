# 导演、写手与历史摘要的请求、提示词和交付结果

[PRD 总导航](proposal.md)　｜　[术语与字段对照](proposal.md#terms)　｜　[界面与流程](ui.md)　｜　[工具目录](proposal.md#tools)　｜　[提示词目录](proposal.md#prompts)　｜　[存档与表](storage.md)　｜　[代码运行](design.md)　｜　[验收](tasks.md)

本附件说明 REQ-039 拟实施的四项任务。每次请求只加载本任务的提示词全文、工具参数和角色可见资料。四份提示词确认后分别存入 `docs/v2/resources/v2.2/prompts/active/` 下的同名文件。文中的官厅对话为方案样例，模型实测在实施后验收。[资料装载与分次读取](context-loader.md) · [独立保留的编剧原案](planner-deferred.md)

## 一、谁调用谁

玩家只操作游玩窗口。`App` 传入当前书籍和启动时创建的游玩服务。游玩服务接收新建、发送、申诉、取消、改写或恢复操作。程序在玩家点击按钮时记下书籍编号 `bookId`、存档编号 `saveId`、本次请求编号 `attemptId`、执行编号 `runId`、任务 `task` 和模式 `mode`。切书只改变页面正在显示的存档。程序还记录计算本轮所用的版本 `baseVersionId`，以及提交前应核对的当前版本 `expectedHeadId`。普通行动两者相同。改写时读取旧行动发生前的版本，确认旧行动仍是最后一轮后才替换。开局时尚无已结算版本，这两个值均可为空。这些编号由程序填写。

建档时，程序把允许游戏使用的书中资料保存在 `playSaves.assetBaseline`，同时记下资料格式版本和用于校验内容的 SHA-256 值。以后每次请求从该副本取书中资料，从 `baseVersionId` 对应的游戏版本取本局状态和历史。玩家在资产工作台编辑资料后，此后新建的存档才会采用新资料。已有存档继续用自己的副本生成请求、恢复进度。

| 任务与程序入口 | 何时运行、如何结束 | 允许工具 |
|---|---|---|
| `play-opening` 导演确定开局 | 新档先按节点顺序取可用资产。导演从最早能建立场景的节点判断原著主角、场地和接手时刻，交出有资产依据的推荐项。准备页显示推荐。有可信歧义时列出其他成立的候选。玩家选好点“开始”进入聊天。 | `browse_play_sources`、`read_play_source`、`submit_result` |
| `play-direct` 导演裁定本轮 | 每次新行动、申诉、末轮改写单独调用。驳回时交可公开的理由，允许时交本轮能写的剧情动作链、停笔位置和拟改状态。 | 同开局导演，资料范围按本次版本确定 |
| `play-write` 写手写正文 | 开场或获准的每次行动独立调用，按本轮可展示的场景、知情范围和最近正文写作。 | 仅 `submit_result`（正文） |
| `play-compact` 整理存档的历史摘要 | 程序按本次模型可用空间估算，若相关已结算历史放不下，可取一段连续的有效版本生成带来源的摘要。失败时仍可逐页读原记录。 | 仅 `submit_result`（摘要） |

新档准备页显示导演推荐。玩家选卡点“开始”后进入聊天窗口，写手按这张卡的现场写开场，程序把起点、现场状态和开场正文一起保存为第 0 版（V0），随后开放输入。继续已有开场的存档时直接读取 `headVersionId` 指向的版本。尚未选卡的草稿回到已存卡组，已选卡但尚未完成开场的草稿显示生成进度或手动重试入口。玩家发送一句话后，导演判定能否尝试并决定结果。驳回时程序把原消息标为“已撤回”，保留原输入，显示公开理由和申诉入口。允许时把能公开的剧情动作链交写手。完整正文可先标为“待结算”，新版本提交成功后才开放下一轮。

## 二、模型收到什么

每次请求包含本任务的固定指令 `systemPrompt`（系统提示词）、随本局进度提供的材料，以及模型可以调用的工具名称和参数。玩家输入、申诉说明、资产字段、局内状态与局内历史单独装载。源资产可包含人物、关系、地点、节点、事件和故事线。游玩程序只挑出当前任务允许读取的字段。小说原文只供人在资产界面的节点详情中点击“查看原文”。这一操作不生成游戏请求、引用、记忆或游戏版本。字段类型 `Ref` 表示一条资料在本次角色请求中的临时编号，用非空字符串表示，例如 `w-b1` 让写手指明某句话依据导演裁定的哪一步。存档按书中资料编号或局内对象编号长期保存依据。

| 请求 | 动态输入（标 `?` 的字段可省，其余必填） | `submit_result` 的参数 |
|---|---|---|
| 开局 | `orderedNodes[]` 依次按章序数值、章内顺序 `order` 和节点编号排序的可读资料。`protagonistCandidates[]` 具书内 ID 的原著主角候选。`placeCandidates[]` 带依据的地点候选。`sourceCatalog[]` 供查人物、地点、关系等资产 | `status` 为单一推荐 `ready`、需选择 `choose` 或资料不足 `insufficient`，并附候选列表 `candidates`、原因 `reason`、依据编号 `evidenceRefs`。每项含候选编号 `id`、主角编号 `protagonistId`、节点编号 `nodeId`、其修订号 `nodeRevision`、介入时刻 `phase:"after"`（节点结束后）、地点编号 `locationId`、卡片名称 `label`、依据编号 `evidenceRefs`、开局状态变化 `initialStateChanges`、剧情步骤 `beats`、留给玩家接话的位置 `stopAt`。地点有严格归属的本书资产用现存编号。只有节点地点名时，声明本候选的局内地点临时 ID 与 `place/create`。玩家确认后，程序保存这张卡选定的起点与依据。 |
| 行动导演 | `mode`（新行动 `action`、申诉 `appeal`、改写 `rewrite`）、`action` 玩家最初输入的全文、`appeal?` 上次展示的驳回理由和本次解释、`rewrite?` 玩家对上一版的改写方向、`scene` 当前场景、`state` 本局状态、`knowledge` 人物已知或相信的事、`relevantHistory[]` 相关历史、`sourceCatalog[]` 可查资料目录 | `decision`（允许 `allow` 或驳回 `reject`）、`interpretedAction` 实际采用的行动、`reason` 内部理由、`refusal?` 公开驳回依据、`outcome` 成功 `success`／部分成功 `partial`／已尝试但失败 `failed`／未发起 `null`、`beats[]` 有序剧情动作、`stateChanges[]` 拟改状态、`stopAt` 停笔位置、`evidenceRefs[]` 依据。驳回时必须给 `refusal`，`outcome=null`、`beats=[]`、`stateChanges=[]`、`stopAt=""`。 |
| 写手 | `mode: opening / turn`（开场或行动回复）、有序剧情步骤 `beats[]`、何处停下 `stopAt`、`voices[]` 人物可用口吻、可公开事实 `visibleFacts[]`、`recentProse[]` 上文小说段落、`writingRequest?` 本轮写作偏好、`evidenceRefs[]` | `paragraphs:[{beatIds:string[],text:string,evidenceRefs:Ref[]}], evidenceRefs:Ref[]`，按数组原顺序拼接段落展示。每段有段落正文 `text`、至少一个有效的剧情步骤编号 `beatIds` 和依据编号 `evidenceRefs`，合起来覆盖全部必写步骤。 |
| 摘要 | 首尾版本编号 `fromVersionId,throughVersionId`、`entries[]` 含各有效行动、已提交正文和结果引用、已有摘要 `previousSummary?`、依据编号 `evidenceRefs[]` | 已发生的事 `facts[]`、人物各自的看法 `beliefs[]`、未解决的事 `openThreads[]` 和依据编号 `evidenceRefs[]`。每条包含说明文字 `text` 和依据编号，人物看法还注明人物编号 `actorId`。服务记录这段摘要覆盖的版本和输入内容的校验值。改写后须核对这些版本仍属于当前历史，内容和依据仍相符，才可再用。 |

工具收到一个 JSON 对象，表中所列输出字段均必填，带 `?` 的按相应分支提供。编号与正文为字符串，节点修订号为整数，`[]` 表示按顺序排列的列表。各项状态改动的前后值按对应字段的类型填写，新增记录时前值为 `null`。工具不按推荐字数截断文本。

<a id="dramatic-chain"></a>

### 导演给写手的剧情动作链

在官厅里，玩家说“我留在这里，问云光方才为什么改口”。云光先前已改称贾珩为恩主，官厅里随后谈过翠华山匪情。开场停在匪情已经谈完、两人仍在厅里的时候。导演需要裁定这次追问能得到什么，也要交代从那个画面怎样写到这次结果。一句“贾珩追问，云光搪塞”缺了两人如何把话接下去。下面每行就是交给写手的一个动作。

| 顺序 | 导演定下的可见经过 | 写手可以怎样演 |
|---|---|---|
| `b1` | 翠华山的事谈完，贾珩把话转回先前那声“恩主”，当面问云光改口的缘故。 | 用这句问话从已经谈完的匪情转到先前的称呼。玩家已指定要问，具体措辞交给写手。 |
| `b2` | 云光听见追问，先欠身，把称呼的变化说成自己方才失礼。 | 写他如何开口、在哪个词上停一停。贾珩听见的是一番解释，原因仍待查明。 |
| `b3` | 话说到“失礼”，云光没有往下解释。他抬眼候着，厅中一时无人接话。 | 用停顿把发言机会还给贾珩。玩家下一句可以继续问、换个话题或离开。 |

**玩家读到的正文**

> 贾珩却提起了先前的话：“你方才怎么改称我恩主？”
>
> 云光欠了欠身。“是下官方才失礼。”说到“失礼”二字，他住了口，抬眼望着贾珩。

`beats` 是这个**按发生先后排列的剧情动作链**。每项的 `id` 是本轮唯一的步骤编号，`actorIds` 是有动作、发言或直接承接反应的人物编号列表，`text` 写谁因为什么做了什么、对面看见或听见什么，`revealRefs` 列出本次允许公开的依据编号。`stopAt` 是这一轮写到哪里就该让玩家作决定。一步可以只有一个人做事，情形简单可以只有一步。不为凑数强加反应。导演定关键动作、回应与结果，写手安排台词、语气、动作之间的停顿和现场质感。已裁定要等待玩家答话时，正文在此收住。

`stateChanges` 列出导演建议本轮改变的字段。每项注明对象类别 `kind`、对象编号 `subjectId`、字段名 `field`、原值 `before`、新值 `after` 和依据编号 `evidenceRefs`。`kind` 可取场景 `scene`、人物 `person`、地点 `place`、物品 `item`、关系 `relation`、人物所知 `knowledge`、承诺 `promise`、事件 `event`。`field` 从[存档字段](storage.md)中选该类对象允许修改的字段。增加完整记录使用 `field="create",before=null,after=完整对象`，更新取对应字段的合法类型。对新建实体，导演可声明本次请求内唯一的临时 ID。程序检查临时编号有无重复，以及各项改动引用的对象是否存在，核对后分配可长期使用的局内编号。`create` 只在新增有效。时间/地点更新须保持同一场景一致，物品归还或转交只改同一物品的持有人。程序逐项核对前值、目标引用、时间顺序、角色获知途径。未持有却转交、只凭玩家陈述就判定其他人物已知情、同批互相冲突的改动均退回。导演按需单列 `knowledge`、`promise` 等变更。导演在裁定的 `stopAt` 字段统一写明何处留给玩家接话，程序按存储契约生成场景字段的修改记录。每个参与者不会因为同列 `actorIds`（本步骤参与者）就知晓旁人的想法或幕后的通报。程序在有效版本保留本轮 `beats` 的已发生经过（或可回读的事件记录）。

**程序如何把导演裁定交给写手。** 程序先按步骤验证动作、参与者、在场关系和允许展示的引用，筛出玩家能看见或听见的经过。步骤编号（如 `b2`）保留，引用换成写手这一次能使用的编号（如 `w-b2`），并把这些编号与本次 `runId`、导演步骤、可读内容绑定。写手另收可公开的现场事实、口吻和最近正文。导演的私下判断、查询记录、角色未对玩家透露的动机仅保存在各自允许的范围。模型需在写手请求里就能读到关键动作的经过。该轮取消或改写后收回未提交步骤的临时引用，结算时把采用的依据映射到正式版本。[同一轮的请求](#sample-requests) · [裁定原件](#turn-result) · [写手交稿](#turn-prose)

<a id="submit-result"></a>

### 三个工具怎样定位和执行

| 工具 | 用途与登记位置 |
|---|---|
| `browse_play_sources({query,kind?,cursor?,limit?})` | 列当前角色可见的资产与局内候选，返回 `items:[{ref,kind,title,summary,reason}],nextCursor`。[参数、类型与分页](context-loader.md#tool-browse) |
| `read_play_source({ref,offset?,limit?})` | 凭本任务的资料编号读取可见字段，返回 `ref,resolvedRef?,text,offset,nextOffset,evidenceRefs`。位置始终以本任务可见的文本为准。[字段范围与错误](context-loader.md#tool-read) |
| `submit_result(payload)` | 工具名表示“交付本任务的结果”。程序只声明“模型收到什么”一节中当前任务对应的参数。开局导演交候选卡，行动导演交裁定、剧情动作和状态变更，写手交段落，摘要任务交按来源分类的记录。各次声明均校验自己的必填项、字段类型和引用，其他任务的参数不占用本次模型上下文。校验通过返回 `{"ok":true,"accepted":true}` 并结束本角色任务，随后按版本规则结算。若返回途中丢失，读取同次运行已保存的接收结果。 |

读工具拒绝未声明字段并返回 `INVALID_ARGS`。候选结构不符回 `{ok:false,code:"INVALID_RESULT",path,detail}`。引用过期或越权回 `SOURCE_UNAVAILABLE`、建档时保存的资料与记录的来源版本有冲突回 `SOURCE_CHANGED`、运行已失效回 `STALE_RUN`。任何资料不足由角色指出缺哪种资产，程序不向模型开放小说原文或带引文的资料字段。

如果写手提交的第一段指向不存在的 `b9`，该执行只收到 `{"ok":false,"code":"INVALID_RESULT","path":"paragraphs[0].beatIds[0]","detail":"本轮没有步骤 b9"}`。程序保留导演已收到的裁定，允许写手在原有效执行内修正关联后重交。只有 `accepted:true` 才表示成功收下，保存失败或执行过期按[任务恢复](design.md)处理。

**驳回理由怎样展示。** 导演的 `reason` 完整保存在执行记录中。驳回另须提交 `refusal:{code,publicReasonRefs}`。允许时省略。公开原因码为 `missing_item`（缺少所需物品）、`out_of_reach`（行动对象不在可接触范围）、`unsupported_ability`（能力缺乏依据）、`conflicting_intent`（行动描述相互冲突）、`insufficient_public_basis`（当前条件不足）。程序逐条核对引用的事实是否已为主角所知，仅可从已核实的公开状态填入预设句式。例如主角已经离开官厅，回显“你已离开官厅，目前无法与云光当面说话”。若原因依赖隐藏信息、引用缺失或公开状态无法支持该句式，只显示“按你目前掌握的情况，还不能这样行动。你可以补充做法或理由”。不向玩家展示原始诊断理由。申诉页面回放当时保存的公开理由。日志中保留内部判断便于复查。验收时可用“资产里记录后续有人招供，主角此刻尚未听过这番话”作为反例。撤回提示、列表、历史和申诉界面均不得透露供述者或内容。单独设置 `reject_action`（附理由的驳回工具）仍待产品决定，本版样例按行动导演的 `submit_result` 声明验收。

## 三、四份拟用提示词全文

<a id="prompt-opening"></a>

### `play-opening.md`　导演确定原著主角的开局

> 你负责让玩家在当前这份小说资产中接手原著主角。按程序给出的节点顺序读资产目录，选最早能说明主角、地点和当前行动的一项。需要补充证据时用 `browse_play_sources` 找候选，再用 `read_play_source` 打开可读节点、相关人物、地点或关系资产的详情，检查名称、过程、参与方式和已经成立的结果。给出开局节点与资产修订号，从该节点结束后的局面生成场景。某人被节点提及，不足以认定他目睹每件事或知道他人的打算。只将依据确实支持的在场情况或个人所知写入候选。同名地点无法可靠匹配时沿用节点里的地点名，交给程序建局内地点。
>
> 开场的起笔处就是候选节点结束时主角看见的最后一幕。按时间顺序写谁留下怎样的动作、现场哪一处变化能让主角接手。比如节点先写云光改称贾珩为恩主，随后写贾珩问过翠华山匪情。这里应写匪情已经谈完，两人仍在官厅，停在贾珩可以接话之处。先前的称呼是主角亲历的事，开场可以提及。只写能由材料支持的在场和已发生的结果。把“接下来由主角决定什么”落实为 `stopAt` 中可接话的画面。开场不替玩家追问、离席或作承诺。
>
> 一个候选成立时返回 `ready`。有多个确有依据的主角或起点时返回 `choose`，用玩家看得见的处境说明差异。资料不足时返回 `insufficient`，指出缺哪种资料。每张候选卡分别交节点及修订号、资产依据、初始状态改动、可公开的 `beats` 和 `stopAt`。通过 `submit_result` 提交。

<a id="prompt-direct"></a>

### `play-direct.md`　导演处理现场、申诉与改写

> 你执导本轮场景。读清玩家试图做什么、希望谁怎样反应以及哪些话仅是设想。以当前存档已经发生的事、参与者各自知道的事和实际条件为依据。遇到“还是之前那个人”“按上次的约定”等指代，先找本局有效历史，再用 `browse_play_sources` 找本任务可见的候选，用 `read_play_source` 查节点、人物或关系的详情。仅凭原著后面的剧情、旧方案或玩家对结果的预测，不能认定该事发生过。
>
> 先判断能否尝试。缺物品、角色不在场或条件相互冲突使行动无法发起，写出玩家现在能理解的原因。能着手尝试时，由你判定成功、失败或部分成功，保留非玩家角色自己的动机与选择。申诉时重读玩家最初输入的全文、当时显示的驳回理由，以及此次申诉的解释，说明你纳入了哪条新解释。改写时以传入的行动前状态重新裁定。上版文字仅帮助理解改写要求，其中的事需在本次重新成立。
>
> 从场景的停笔位置和玩家刚做的事起笔。允许行动时，先决定尝试带来成功、部分成功还是失败，再排出能把这个结果演出来的动作。把第一步接在玩家要做的事上。让下一步的人看见、听见或受到上一步的影响，再写他具体说了什么或做了什么。遇到转折，给写手一个玩家能觉察到的动作或话头。比如问改口的缘由，可以让对方先欠身，拿“先前失礼”来应答，答到这里便止住，不交代真正原因。不要仅给“发生对峙”“展现疑惑”等概况。场面简单时一句具体动作也够用。
>
> 每步按先后交 `id,actorIds,text,revealRefs`。分清主角听见的说辞、已经证实的事实和他人的内心。同一场戏可有各自不同的所知，旁人未听见的消息不能进其所知。按当前状态列出拟改的字段、前值、新值和依据。`stopAt` 写一个可接话的动作或画面，停在玩家作下一次选择之前。
>
> 驳回时给出内部理由，以及供程序公开的原因码和主角已知的依据。公开材料不足时用 `insufficient_public_basis`。按本次工具声明用 `submit_result` 一次交完整裁定，交付后结束。

<a id="prompt-write"></a>

### `play-write.md`　写手写开场与回合正文

> 你为正在游玩的读者写一段可以接下去的小说。开场就从选定卡的画面起笔。回合承接最近正文收笔时的人物位置和话头，把导演给的第一步写成眼下发生的事。后续逐步写出谁做了什么、在场的谁看见或听见、对方因此怎样回应。对话让下一人有话可接，动作让读者能认出场面发生了什么变化。人物的称呼、口气和态度照可用的角色资料与眼前处境来。若有本轮写作偏好 `writingRequest`，可用于调整详略和笔调。
>
> 导演若交来“谈完匪情后回问先前那声恩主 → 云光欠身，只说方才失礼 → 说完抬眼等答”，可以用垂眼、停顿和回答的措辞演出他的应对。玩家听到“方才失礼”便能判断他没有解释原因。正文写到他抬眼就够了。真正缘由以及贾珩要不要继续逼问仍留在这一笔之后。有多个可见动作可以衔接时，用自己的句式和节奏写，允许一个段落覆盖连续几步，也允许同一步在相邻段落展开。
>
> 按 `beats` 的顺序覆盖关键动作及已定结果，把细小动作、对白、感官描写放在它们之间。只写 `visibleFacts` 和各步允许展示的内容。不要替其他人物获得消息、凭空增加证人或新线索，也不要替玩家做下一件事。在 `stopAt` 的可见画面停笔。用 `submit_result` 交按阅读顺序排列的 `paragraphs`，每段附 `beatIds` 和所用资料编号 `evidenceRefs`，末尾列全篇依据。只把小说文字写进 `text`。

<a id="prompt-compact"></a>

### `play-compact.md`　按有效版本整理历史

> 你为下一次主持这本书整理已经提交的游玩历史。按材料来源区分已经发生的事、某人相信或误解的事，以及尚未兑现的承诺和问题。有人怀疑管家拿了钥匙，应记为这个人的怀疑。后来发现新的持有人时，分开记录新证据和谁实际获知。保留之后能识别旧约、物品或指代的人名、地点和关键条件。每条都带回到原始记录的引用。
>
> 只整理给定起止版本之间、属于这局当前历史的已结算回合。引用须来自本次输入，不能补猜缺失环节。返回 `submit_result`。摘要供检索和主持查阅，新的事件、知情和状态须由后续游玩回合另行产生。

### 两份提示词从哪里借鉴

参考版本为本机 `D:/mic/StoryWeaver` 的 `d494781`。该项目的导演请求把近期对话、当前剧情位置和本轮收束条件组装给模型，返回的 JSON 里 `direction_script.action_chain` 用箭头串起局部可见动作和即时反应。随后扩展把起点、动作链和终点填入演员模板，将它注入宿主即将生成回复的消息，演员据此写出台词和动作。默认导演正文见 `txtToWorldbook/core/constants.js:308`，动作链规则在第 347–353 行。默认演员正文始于第 372 行。装配入口为 `txtToWorldbook/services/directorService.js:1759`、`:1984` 与 `:2177`，导演 API 入口为 `txtToWorldbook/services/apiService.js:803`。

本方案沿用“从上句起笔，每一步引出下一人的动作，在本轮终点交回选择”的写法。起点从已选开场或已结算场景和上文取得，`beats` 用现有的有序对象逐步写经过与公开依据，`stopAt` 给终点。步数随本轮行动而定。写手只接本轮可见材料，书中后续节点和原文不会随动作链传给它。

<a id="sample-requests"></a>

## 官厅样本的逐任务请求

以下是方案预期请求。每一项由所链接的系统提示词全文、列出的模型可调用的工具及其参数，以及以 JSON 表示的本次输入组成。工具参数及返回字段见[工具目录](#submit-result)。各任务最后调用 `submit_result`，程序收下结果时返回 `{"ok":true,"accepted":true}`。模型用本次输入或工具提供的资料编号标明依据。玩家确认开局或程序提交新版本时，保存依据在本档可长期查询的位置。开局样例从空场景初始化，已知资产人物使用原编号创建局内状态。场景字段首次赋值的 before 为 null。

### 开局导演提出选项

系统提示词见 [play-opening.md 全文](#prompt-opening)。本次工具为 browse_play_sources、read_play_source、submit_result。

```json
{
  "orderedNodes": [
    {
      "id": "C15-N001",
      "revision": 32,
      "chapterIndex": "15",
      "chapterName": "第一百三十三章 剿匪翠华山",
      "order": 0,
      "actorIds": ["C1-P001", "C13-P011", "C14-P003", "C6-P006", "C11-P004", "C11-P005"],
      "locationNames": ["长安节度使府官厅"],
      "summary": "贾珩当面问责，云光改称贾珩为恩主。",
      "process": "贾珩随后询问翠华山匪情，在厅内听到答复。",
      "ref": "o1"
    }
  ],
  "protagonistCandidates": [{"id": "C1-P001", "name": "贾珩", "evidenceRefs": ["o1"]}],
  "placeCandidates": [{"name": "长安节度使府官厅", "evidenceRefs": ["o1"]}],
  "sourceCatalog": [{"ref": "o1", "kind": "node", "title": "贾珩闯云光官厅问罪"}]
}
```

本例追加调用 `browse_play_sources({"query":"官厅","kind":"node"})`，返回 `{"items":[{"ref":"o1","kind":"node","title":"贾珩闯云光官厅问罪","summary":"贾珩当面问责，云光改称贾珩为恩主。","reason":"与主角和地点相关"}],"nextCursor":null}`。随后调用 `read_play_source({"ref":"o1"})`，返回 `{"ref":"o1","text":"长安节度使府官厅。概述：贾珩当面问责，云光改称贾珩为恩主。经过：贾珩随后询问翠华山匪情，在厅内听到答复。","offset":0,"nextOffset":null,"evidenceRefs":["o1"]}`。程序从同一节点的概述和经过核对先后顺序，给这张卡选定节点结束后的时刻，等待玩家选择。`o1` 指向允许使用的结构化字段。

`submit_result` 的参数如下。

```json
{
  "status": "ready",
  "candidates": [
    {
      "id": "opt-hall",
      "protagonistId": "C1-P001",
      "nodeId": "C15-N001",
      "nodeRevision": 32,
      "phase": "after",
      "locationId": "new:hall",
      "label": "官厅谈完翠华山匪情后接手贾珩",
      "evidenceRefs": ["o1"],
      "initialStateChanges": [
        {
          "kind": "place",
          "subjectId": "new:hall",
          "field": "create",
          "before": null,
          "after": {"name": "长安节度使府官厅", "evidenceRefs": ["o1"]},
          "evidenceRefs": ["o1"]
        },
        {
          "kind": "scene",
          "subjectId": "scene",
          "field": "locationId",
          "before": null,
          "after": "new:hall",
          "evidenceRefs": ["o1"]
        },
        {
          "kind": "scene",
          "subjectId": "scene",
          "field": "presentIds",
          "before": null,
          "after": ["C1-P001", "C13-P011"],
          "evidenceRefs": ["o1"]
        },
        {
          "kind": "scene",
          "subjectId": "scene",
          "field": "timeText",
          "before": null,
          "after": "官厅谈完翠华山匪情后",
          "evidenceRefs": ["o1"]
        },
        {
          "kind": "person",
          "subjectId": "C1-P001",
          "field": "create",
          "before": null,
          "after": {"name": "贾珩", "life": "alive", "locationId": "new:hall", "condition": null, "evidenceRefs": ["o1"]},
          "evidenceRefs": ["o1"]
        },
        {
          "kind": "person",
          "subjectId": "C13-P011",
          "field": "create",
          "before": null,
          "after": {"name": "云光", "life": "alive", "locationId": "new:hall", "condition": null, "evidenceRefs": ["o1"]},
          "evidenceRefs": ["o1"]
        },
        {"kind":"knowledge","subjectId":"new:know-address","field":"create","before":null,"after":{"holderId":"C1-P001","proposition":"云光先前当面改称我为恩主","stance":"knows","sourceRefs":["o1"]},"evidenceRefs":["o1"]},
        {"kind":"knowledge","subjectId":"new:know-report","field":"create","before":null,"after":{"holderId":"C1-P001","proposition":"我随后已在官厅问过翠华山匪情并听到了答复","stance":"knows","sourceRefs":["o1"]},"evidenceRefs":["o1"]}
      ],
      "beats": [{"id": "o-b1", "actorIds": ["C1-P001", "C13-P011"], "text": "翠华山的匪情已经谈完，两人仍在官厅。云光先前曾改称贾珩为恩主，这时留在厅内等他开口。", "revealRefs": ["o1"]}],
      "stopAt": "官厅已经谈过翠华山匪情，两人仍在厅里，等贾珩开口。"
    }
  ],
  "reason": "节点结束时主角仍可决定下一步。",
  "evidenceRefs": ["o1"]
}
```

### 开场写手交正文

系统提示词见 [play-write.md 全文](#prompt-write)。本次工具为 submit_result。

```json
{
  "mode": "opening",
  "beats": [{"id": "o-b1", "actorIds": ["C1-P001", "C13-P011"], "text": "翠华山的匪情已经谈完，两人仍在官厅。云光先前曾改称贾珩为恩主，这时留在厅内等他开口。", "revealRefs": ["w-address", "w-report", "w-room"]}],
  "stopAt": "官厅已经谈过翠华山匪情，两人仍在厅里，等贾珩开口。",
  "voices": [{"actorId": "C13-P011", "text": "此刻向贾珩说话时恭敬"}],
  "visibleFacts": [{"ref": "w-address", "text": "贾珩先前亲耳听到云光改称他为恩主。"}, {"ref": "w-report", "text": "此后贾珩在官厅问过翠华山匪情，已经听到答复。"}, {"ref": "w-room", "text": "贾珩和云光仍在官厅。"}],
  "recentProse": [],
  "evidenceRefs": ["w-address", "w-report", "w-room"]
}
```

程序把选定候选中允许公开的依据分别编号：`w-address` 对应概述中的称呼，`w-report` 对应经过末尾已谈完的匪情，`w-room` 对应场景地点和在场关系。写手交付完整开场，程序在同一次提交中保存这段正文和初始现场，开场版本记作 V0。

`submit_result` 的参数如下。

```json
{
  "paragraphs": [{"beatIds": ["o-b1"], "text": "翠华山的匪情已经谈完。先前改称贾珩“恩主”的云光还在厅里，等他开口。", "evidenceRefs": ["w-address", "w-report", "w-room"]}],
  "evidenceRefs": ["w-address", "w-report", "w-room"]
}
```

### 行动导演裁定追问

系统提示词见 [play-direct.md 全文](#prompt-direct)。本次工具为 browse_play_sources、read_play_source、submit_result。

```json
{
  "mode": "action",
  "action": "我留在这里，问云光方才为什么改口",
  "scene": {
    "timeText": "官厅谈完翠华山匪情后",
    "locationId": "A-place-1",
    "presentIds": ["C1-P001", "C13-P011"],
    "stopAt": "官厅已经谈过翠华山匪情，两人仍在厅里，等贾珩开口。"
  },
  "state": {
    "people": [{"id": "C1-P001", "locationId": "A-place-1"}, {"id": "C13-P011", "locationId": "A-place-1"}],
    "places": [{"id": "A-place-1", "name": "长安节度使府官厅"}]
  },
  "knowledge": [
    {"id":"A-know-address","holderId":"C1-P001","proposition":"云光先前当面改称我为恩主","stance":"knows","sourceRefs":["f2"]},
    {"id":"A-know-report","holderId":"C1-P001","proposition":"我随后已在官厅问过翠华山匪情并听到了答复","stance":"knows","sourceRefs":["f3"]}
  ],
  "relevantHistory": [{"ref": "f2", "text": "云光先前当面改称贾珩为恩主。"}, {"ref": "f3", "text": "此后贾珩在官厅问过翠华山匪情，已经听到答复。"}],
  "sourceCatalog": [
    {"ref": "f1", "text": "贾珩和云光仍在官厅。"},
    {"ref": "f2", "text": "云光先前当面改称贾珩为恩主。"},
    {"ref": "f3", "text": "此后贾珩在官厅问过翠华山匪情，已经听到答复。"},
    {"ref": "a1", "text": "我留在这里，问云光方才为什么改口"}
  ]
}
```

从 V0 读取场景，`a1` 指向玩家这次说的话，`f2` 表明他先前听见云光叫他恩主，`f3` 表明此后官厅里已经谈过匪情。现场与两段经过都有出处，示例直接调用 `submit_result`。[导演提交的完整参数](#turn-result)

### 回合写手续写

系统提示词见 [play-write.md 全文](#prompt-write)。本次工具为 submit_result。

```json
{
  "mode": "turn",
  "beats": [
    {"id":"b1","actorIds":["C1-P001","C13-P011"],"text":"匪情已经谈完，贾珩把话转回先前那声恩主，当面问云光为什么改口。","revealRefs":["w-b1"]},
    {"id":"b2","actorIds":["C13-P011","C1-P001"],"text":"听见追问，云光欠身，只说方才是自己失礼。","revealRefs":["w-b2"]},
    {"id":"b3","actorIds":["C13-P011","C1-P001"],"text":"云光说到失礼便住口，抬眼等贾珩回应。","revealRefs":["w-b3"]}
  ],
  "stopAt": "云光等贾珩接话。",
  "voices": [{"actorId": "C13-P011", "text": "此刻向贾珩说话时恭敬"}],
  "visibleFacts": [{"ref": "w-hall", "text": "贾珩和云光仍在官厅。"}],
  "recentProse": ["翠华山的匪情已经谈完。先前改称贾珩“恩主”的云光还在厅里，等他开口。"],
  "evidenceRefs": ["w-b1", "w-b2", "w-b3", "w-hall"]
}
```

写手交稿见[分段正文](#turn-prose)。程序核对正文是否覆盖 `b1` 到 `b3`，按结算规则提交 V1。之后恢复聊天与准备下一轮都取这一版，停在“云光等贾珩接话”。

### 历史摘要整理这次交谈

系统提示词见 [play-compact.md 全文](#prompt-compact)。本次工具为 submit_result。

```json
{
  "fromVersionId": "V0",
  "throughVersionId": "V1",
  "entries": [
    {
      "versionId": "V0",
      "action": null,
      "prose": "翠华山的匪情已经谈完。先前改称贾珩“恩主”的云光还在厅里，等他开口。",
      "result": "官厅已经谈过翠华山匪情，两人仍在厅里，等贾珩开口。",
      "ref": "h0"
    },
    {
      "versionId": "V1",
      "action": "我留在这里，问云光方才为什么改口",
      "prose": "贾珩却提起了先前的话：“你方才怎么改称我恩主？”\n\n云光欠了欠身。“是下官方才失礼。”说到“失礼”二字，他住了口，抬眼望着贾珩。",
      "result": "云光等贾珩接话。",
      "ref": "h1"
    }
  ],
  "evidenceRefs": ["h0", "h1"]
}
```

测试时缩小一次请求能放入的历史长度，让程序生成摘要。程序只从 V0 和 V1 的已结算记录分配依据编号 `h0`、`h1`。后续查找这段历史时，可直接读取已保存的摘要。

`submit_result` 的参数如下。

```json
{
  "facts": [{"text": "云光先前在官厅改称贾珩为恩主。谈完翠华山匪情后，贾珩回问称呼的缘故，云光只说方才失礼。", "evidenceRefs": ["h0", "h1"]}],
  "beliefs": [],
  "openThreads": [{"text": "云光改口的真实原因尚未查明。", "evidenceRefs": ["h1"]}],
  "evidenceRefs": ["h0", "h1"]
}
```

## 四、走一遍“贾珩留厅追问云光”

固定样本是[《红楼之挽天倾》赖家线仅第 15 至 25 章节点包](../../../红楼之挽天倾-赖家线-仅第15至25章节点.wwv2)。新档保存允许使用的书中字段，按顺序找到包内最早节点 `C15-N001`（`order=0,revision=32`，贾珩闯云光官厅问罪）。章名《第一百三十三章 剿匪翠华山》只用于认出节点在书里的位置。节点概述记录云光改称贾珩为恩主，经过的末尾则记载贾珩随后询问翠华山匪情并听到答复。玩家从谈完匪情后的官厅接手贾珩。下一节点 `C15-N002` 的后续经过和 `C16-N002` 的黄泰供述均尚未成为这局的经历。

1. **玩家点“开始”。** 开局导演已从包内最早可用的节点取得主角贾珩 `C1-P001` 和云光 `C13-P011`。地点库里无法确认是否为同一处，候选卡取节点中的“长安节度使府官厅”，以临时编号 `new:hall` 建本局地点。玩家点“开始”后，程序把获选的卡交给写手，生成开场并保存 V0。文中提到云光先前的称呼，停在匪情已谈完、两人仍在厅内，玩家从这里决定下一句。已有存档点“继续”则打开上次停下的地方。

<a id="turn-result"></a>

2. **当面追问。** 玩家输入“我留在这里，问云光方才为什么改口”。导演将 `f1` 解析为两人仍在厅内，`f2` 为贾珩亲耳听见云光改称恩主，`f3` 为此后已谈过匪情，`a1` 为玩家本次行动。下面云光如何回答都是游玩裁定。这些话没有写回书中的节点。

```json
{
  "decision":"allow","interpretedAction":"留在官厅，当面追问云光改口的原因","reason":"官厅谈完翠华山匪情，两人仍在厅内。贾珩可以当面回问先前亲耳听见的称呼。","outcome":"partial",
  "beats":[
    {"id":"b1","actorIds":["C1-P001","C13-P011"],"text":"匪情已经谈完，贾珩把话转回先前那声恩主，当面问云光为什么改口。","revealRefs":["a1","f1","f2","f3"]},
    {"id":"b2","actorIds":["C13-P011","C1-P001"],"text":"听见追问，云光欠身，只说方才是自己失礼。","revealRefs":["a1","f1"]},
    {"id":"b3","actorIds":["C13-P011","C1-P001"],"text":"云光说到失礼便住口，抬眼等贾珩回应。","revealRefs":["f1"]}
  ],
  "stateChanges":[
    {"kind":"knowledge","subjectId":"new:jia-heard-answer","field":"create","before":null,"after":{"holderId":"C1-P001","proposition":"云光自称方才失礼","stance":"knows","sourceRefs":["beat:b2"]},"evidenceRefs":["beat:b2"]},
    {"kind":"knowledge","subjectId":"new:yun-heard-question","field":"create","before":null,"after":{"holderId":"C13-P011","proposition":"贾珩刚才当面问我为何改口","stance":"knows","sourceRefs":["beat:b1"]},"evidenceRefs":["beat:b1"]}
  ],
  "stopAt":"云光等贾珩接话。","evidenceRefs":["a1","f1","f2","f3"]
}
```

<a id="turn-prose"></a>

写手拿到的 `w-b1,w-b2,w-b3` 分别指向导演定下的追问、欠身辩称、住口候答。它可以把连续两步接成一个段落。此处在云光抬眼时停笔，把接话机会交给玩家。

```json
{
  "paragraphs": [
    {
      "beatIds": [
        "b1"
      ],
      "text": "贾珩却提起了先前的话：“你方才怎么改称我恩主？”",
      "evidenceRefs": [
        "w-b1"
      ]
    },
    {
      "beatIds": [
        "b2",
        "b3"
      ],
      "text": "云光欠了欠身。“是下官方才失礼。”说到“失礼”二字，他住了口，抬眼望着贾珩。",
      "evidenceRefs": [
        "w-b2",
        "w-b3"
      ]
    }
  ],
  "evidenceRefs": [
    "w-b1",
    "w-b2",
    "w-b3"
  ]
}
```

程序校验段落关联的剧情步骤、顺序、写手可见引用、拟改字段和原值后，把正文、动作链与状态一起提交 V1。`beat:b1` 和 `beat:b2` 是导演在同一次裁定里引用步骤的写法，结算时分别保存为 V1 中的来源。本轮新增两条人物所知：云光听见贾珩问缘故。贾珩听见云光自称失礼。真正原因仍未查明。验收时通读正文，检查对话确实接上上一句，也检查引用正确的段落有没有擅自写出供述或替玩家追问第二次。

3. **玩家把最后一轮改成离厅。** 玩家要求“我不再追问，告辞离开官厅”。导演从追问前的 V0 重新裁定。写手收到的新动作链是“贾珩向云光告辞 → 贾珩跨出厅门，云光仍在厅内 → 贾珩在厅外停下”。`stopAt` 留在厅外，下一步去向由玩家决定。程序核对地点是否存在，必要时建局内地点，随新版保存贾珩和场景的位置、在场人、正文和依据。

新版本成功才替换上一轮。之后再次进档，原版里“云光自称失礼”及两条由追问产生的知情记录都不进入当前历史。可回读共同起点里云光改称恩主、其后谈过翠华山匪情的事实。同书另一存档可以继续留厅，拥有自己的交谈、知情和位置。

**驳回与申诉。** 离厅后，玩家输入“我站在原地低声当面问厅里的云光”。若场景不支持双方听见，导演交下列结果。该结果只更新尝试记录，时间和位置均不推进。

```json
{"decision":"reject","interpretedAction":"从厅外低声当面问云光","reason":"贾珩在厅外，云光在厅内，当前无可用传话途径。","refusal":{"code":"out_of_reach","publicReasonRefs":["own-exit"]},"outcome":null,"beats":[],"stateChanges":[],"stopAt":"","evidenceRefs":["own-exit"]}
```

玩家申诉“我是要先回厅再问”。程序沿用被驳回的那条请求的编号，分配新的执行编号，再把玩家最初输入的全文、当时显示的驳回理由、本次解释和该版状态交给导演。若可行，再判定返回是否成功。被拒的原输入不能直接变成一次交谈。

**历史摘要。** 假设当前有效的 V0 为开场、V1 为留厅追问、V2 为玩家表示暂不追究。给摘要任务 V0～V2 的已结算记录，并分配专用资料编号 `h0,h1,h2`。

```json
{"facts":[{"text":"云光先前当面改称贾珩为恩主。谈完翠华山匪情后，贾珩回问称呼的缘故，云光辩称失礼。","evidenceRefs":["h0","h1"]}],"beliefs":[],"openThreads":[{"text":"贾珩表示暂不追究，云光改口的真实原因仍未核实。","evidenceRefs":["h1","h2"]}],"evidenceRefs":["h0","h1","h2"]}
```

成功改写 V2 后，当前可继续的历史由 V0、V1 和新版第 2 轮组成。程序排除概括了旧 V2 的整条摘要，仍可查 V0、V1。摘要不可用时，逐页读取相应回合的原始记录。

## 五、代码怎样运行、怎样验证

`play-compact` 为存档整理已经结算的连续回合。它按模型可用空间和本轮需要的资料选择历史区间，输出带出处的摘要，供跨回合查找。执行记录的 `stage=play-compact`、`role=null`（程序发起，无角色），只写自身摘要和覆盖范围，游戏可继续。Pi 的 `PreCompact`（单次 Agent 执行在压缩前处理消息的扩展点）涉及同次执行中累积的模型消息和工具结果。现有整理任务显式检查容量、压缩消息。游玩的存档摘要须按有效版本、来源和人物知情筛选，改写后重新核对覆盖范围。选择 Pi 并不会自动生成这种存档记录。[现有整理任务](../../../src/features/agents/runtime.ts) · [压缩处理](../../../src/features/agents/compaction.ts) · [最初的记忆设计](../../../docs/WestWorld-游戏三Agent-MVP与实现优先级.md#52-记忆上下文与工具返回)

| 现有接口和缺口 | 实施与验证入口 |
|---|---|
| `src/main.tsx` 在启动时创建 `workspace` 与模型服务。`src/App.tsx` 的游玩页仍为禁用输入框 | 注册 `createPlayService(workspace,models)`，把服务注入新的 `src/features/play/` 界面。打开存档订阅持久状态，界面显示当前角色正在做什么。关闭、切书或重载用原版本读取结果。一次点击只分配一个业务尝试。 |
| `models.agent(input,options)` 已通过 Pi 在聚合模型上执行。`models.generate({role:'aggregation',context,validate,...})` 可检查结构化的单次输出 | 开局导演、行动导演走 `agent`，`finishTurn/validateFinal` 检查角色已提交本任务的最终结果。写手、摘要走 `generate`，原生工具只声明本任务的 `submit_result`，检查一次完整工具调用及参数。四种任务首版共用现有聚合模型配置。`AbortSignal`、网关限流与请求预算沿用现有机制。参数残缺或超预算返回错误，不执行截断结果。[服务](../../../src/features/models/service.ts) · [Pi 执行和校验](../../../src/features/models/gateway.ts) |
| 当前网关在每次发给模型的请求前无条件追加适用于资料整理的公共说明，限制叙事创作 | 在内部调用选项明确任务用途。整理继续使用原有说明，游玩从专属业务正文及其工具声明组装实际系统消息。准备历史材料时去掉整理任务原先使用的系统说明。实测各任务首次请求、读取工具返回值后的后续调用、修复及恢复后的最终系统消息。程序不能只在界面预览中跳过原说明。[网关调用](../../../src/features/models/gateway.ts) · [装载实现](../../../src/features/agents/output-discipline.ts) |
| 现有 P3 用 `?raw` 读取每项独立 Markdown，收到的动态资料和原生工具各自组装。现有工具注册权限属于资料整理 | 按四种任务登记允许的工具并读取完整 Markdown。新处理器复用 TypeBox 类型校验。执行每个读工具前检查书、存档、运行有效性和本任务专用的资料编号。`submit_result` 仅保存该角色提交的结果和工具接收结果，每个模型结果还需通过业务校验。禁止暴露 `asset_editor`、`story_editor` 的写入或全书工具。[提示词映射](../../../src/features/story/narrativePrompts.ts) · [参数与结果校验](../../../src/features/agents/contracts.ts) · [既有权限处理](../../../src/features/agents/tools.ts) |
| 写手先交稿时，玩家可在整轮结算前预览正文 | `playRuns` 记录本角色的只读材料、候选或失败。`playAttempts` 统筹本轮导演与写手的完成情况。提交前在同一事务核对 `runId` 仍有效、所有必要任务通过、`playSaves` 记录的当前生效版本仍是 `expectedHeadId`，之后生成 `playVersions` 并把新版本设为本档的当前生效版本。重复收到同一角色已交付的结果时，读回原先保存的工具接收结果。旧标签页或已取消的结果按过期拒收。程序在一次失败、取消或刷新时按设计约定恢复。错误原因和玩家输入可查。尚未结算的预览正文不能混入下一轮输入。 |
| 现有执行跟踪提供请求开始、真实模型请求、模型结束、耗时、模型处理的文本单位数（Token）、结束原因 `stopReason`、重试与故障分类等记录入口 | `runId` 下记录角色、模式、提示词及工具声明的内容校验值、输入材料及来源版本、当时实际使用的模型信息、请求及返回结果和 `attemptId`、`expectedHeadId`、`baseVersionId`。不记录 API 密钥。玩家界面只展示对玩家可见的审核与正文。诊断视图另读记录。角色结果保存失败或执行权失效不向界面显示完成。[跟踪接口](../../../src/features/models/types.ts) · [已有执行跟踪](../../../src/features/agents/trace.ts) |
| 现有同步脚本只给特定 P3 调用重算清单中的哈希，并迭代已有请求示例 | 登记四个任务的 `prompt-call-manifest.json`、输入及输出结构、`tool-contracts.json`、`tool-results.schema.json`、归属清单、独立请求示例及索引。同步脚本覆盖四个游玩调用的哈希和真实组装路径，运行 `npm run prompts:sync`。核对样例时捕获模型实际收到的正文、工具和消息，一并测试旧整理用途。[同步脚本](../../../scripts/sync-prompt-resources.mjs) · [项目技术说明](../../../docs/v2/项目技术说明.md) |

开发检查覆盖允许尝试但失败、驳回与申诉、非法引用、工具反馈丢失、重复提交、旧结果迟到和刷新。真实模型验收用指定官厅样本，核对四份提示词和各任务实际请求、开场与行动版本里的地点、人物所知及正文。另读写手输出，检查第一步是否接住玩家输入、前一人的动作是否引出下一人的回应、人物是否泄露未知消息、最后一句是否停在玩家应接手的地方。核对实际请求、工具返回和执行记录中可见的资料。
