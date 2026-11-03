> **仅限2.1历史字典。** 草稿/入库、双份人物地点表、P001/L001重编均已撤销；2.2当前结构以03为准。此处仅供未变业务字段的类型说明回查。

# WestWorld V2 · 逐库逐表数据与生命周期

| 文档控制项 | 内容 |
|---|---|
| 文档编号 | WW-DATA |
| 文档版本 | 2.1 |
| 产品 / 应用包版本 | WestWorld V2 / 1.0.0 |
| 复现基线 | WWV2-WORKTREE-20261021；实际工作区含未提交文件 |
| 文档状态 | 待评审；用户已确认忠实保留行为与缺陷 |
| 编写 / 维护 | Codex；后续维护负责人待指定 |
| 创建 / 更新 | 2026-10-21 / 2026-10-21（Asia/Shanghai） |
| 适用范围 | 当前工作区可达应用；不包含未来游玩功能 |
| 共同术语 / 关联 | [统一入口](../00-阅读入口与术语.md)、[PRD](../01-PRD.md)、[覆盖矩阵](../12-验收执行与覆盖矩阵.md) |

### 修订记录

| 版本 | 日期 | 内容 | 影响 |
|---|---|---|---|
| 2.0 | 2026-10-21 | 建立正式规格包 | 保留历史约束 |
| 2.1 | 2026-10-21 | 按17种实际表、操作链、字段流及独立验收补全 | 不改变应用行为；校正覆盖结论 |

## 1. 库表数量与计数口径

系统有 **2种数据库定义**：全局设置库1个，单书资产库按书复制。全局库 **3张表**，每书库 **14张表**，共 **17种实际表定义**。持有N本书时通常有`1+N`个业务数据库和`3+14N`张表实例；空书架仅设置库。创建顺序/失败可能留下空单书库或孤立书架项，实例数以实际存在为准。

52个Schema包含持久实体、模型DTO、操作联合及视图，**不等于52张表**。本文件按17张物理表组织；完整机器结构在schemas.json，模型DTO不再冒充存储表。

| 表编号 | 数据库                      | 表                        | 中文用途    | 行的粒度                             | 结构                            |
| --- | ------------------------ | ------------------------ | ------- | -------------------------------- | ----------------------------- |
| T01 | westworld_settings       | `credentials`            | 模型凭据    | 凭据的一条provider记录                  | 按SDK/设置键判别                    |
| T02 | westworld_settings       | `appSettings`            | 全局配置    | 一个设置键及其值                         | 按SDK/设置键判别                    |
| T03 | westworld_settings       | `books`                  | 书架      | 一次导入的一本书                         | BookSchema                    |
| T04 | westworld_canon_{bookId} | `chapters`               | 章节元信息   | 一个章/切块                           | ChapterSchema                 |
| T05 | westworld_canon_{bookId} | `chapterTexts`           | 分章原文    | 一个章/切块的正文                        | ChapterTextSchema             |
| T06 | westworld_canon_{bookId} | `characterSnapshots`     | 人物草稿    | 一份当前保留的人物档案；初始逐章快照               | StoredCharacterSnapshotSchema |
| T07 | westworld_canon_{bookId} | `locationSnapshots`      | 地点草稿    | 一份当前保留的地点档案                      | StoredLocationSnapshotSchema  |
| T08 | westworld_canon_{bookId} | `nodes`                  | 事件节点    | 一个原章事件；P1或检查补点                   | StoredNodeSchema              |
| T09 | westworld_canon_{bookId} | `eventLines`             | 事件线     | 一条有序事件成员集合                       | EventLineSchema               |
| T10 | westworld_canon_{bookId} | `characters`             | 当前人物实体  | 本次入库的一个人物实体                      | CharacterSchema               |
| T11 | westworld_canon_{bookId} | `locations`              | 当前地点实体  | 本次入库的一个地点实体                      | StoredLocationSchema          |
| T12 | westworld_canon_{bookId} | `compileProgress`        | 编译进度    | 一个P1/P2/P3阶段记录                   | CompileProgressSchema         |
| T13 | westworld_canon_{bookId} | `storyEditorMemory`      | 工作摘要    | 一条会话的最新摘要                        | StoryEditorMemorySchema       |
| T14 | westworld_canon_{bookId} | `storyEditorNotes`       | 判断与复核事项 | 会话内一个稳定key的工作主题                  | StoryEditorNoteSchema         |
| T15 | westworld_canon_{bookId} | `storyEditorCheckpoints` | 检查批次恢复点 | 会话/阶段/phase/scope的一次检查           | StoryEditorCheckpointSchema   |
| T16 | westworld_canon_{bookId} | `storySessions`          | 故事会话头   | 一个初次/完整复核会话                      | StorySessionSchema            |
| T17 | westworld_canon_{bookId} | `storySessionEntries`    | 追加会话条目  | 一条message/compaction/omit/commit | StorySessionEntrySchema       |

## 2. 配置键、内存状态与非表结构

| 容器 | 内容/键 | 值与更新 |
|---|---|---|
| appSettings | llm.config | baseUrl（空读回官方）、extractionModel、aggregationModel、可选aggregationContextWindow；模型保存按trim；窗口UI校验整数≥8192 |
| appSettings | compile.concurrency | 默认3；Math.round后clamp1–16；不存在自动返回默认，非法NaN仍按原算式结果，不额外补验证 |
| appSettings | assets.exportDirectory | FileSystem目录句柄，不是JSON路径；读写权限在实际保存时检查 |
| ui-store内存 | activeView/bookId/assetTab/selectedAssetId | 资产/空/人物/空初值；刷新重置；工作台实际详情还用局部selected |
| compile-store内存 | status/stage/total/completed/failed/cost/logs/abortController | 事件驱动；无独立日志表，最近2000行；刷新不恢复cost/logs |
| 局部组件内存 | 预览bytes/表单/弹窗/选中详情/分页/高亮/游玩消息 | 按挂载卸载重置；不能用数据库持久化偷偷增强 |
| 文件 | .wwv2 ZIP/章节txt/manifest | 备份为独立文件，不是另一个数据库或游戏存档 |

字段必填是结构契约，**不是宣称所有写入入口都执行该校验**。模型提交走Schema+业务规则；人工编辑可写undefined，普通Node/EventLine更新不执行完整Schema。JS undefined在JSON导出被省略。

## 3. 逐表字段、生命周期与消费关系

示例均为脱敏人工结构样本；含example-fingerprint的指纹只是合法字段示意，不代表该样本已通过真实恢复检查。可运行测试使用scenarios与acceptance中的确定性前后值。

### T01 · credentials（模型凭据）

| 项目 | 规定 |
|---|---|
| 所属库/版本 | westworld_settings / v2 |
| 记录粒度/范围 | 凭据的一条provider记录；本机浏览器来源全局 |
| 主键及索引 | `providerId`；首项主键、&唯一、[a+b]复合，无额外外键 |
| 创建与更新 | 设置保存/清除；CredentialStore.modify事务更新 |
| 读取者 | 模型、拉取/测试；页面仅状态和掩码 |
| 删除/保留/关联 | 明文、每provider覆盖；不随删书删；不进入单书备份 |
| 备份 | 配置与凭据不导出；books作为book.json元数据 |
| 示例 | [人工记录](../resources/table-examples/credentials.json) |

| 字段路径 | 中文含义/单位 | 类型/枚举 | 必填/缺省/null | 限制 | 来源/生成 | 更新/引用与消费 |
|---|---|---|---|---|---|---|
| providerId | 模型提供者标识 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 保存Key写deepseek/api_key，实际Key trim；SDK CredentialStore可携带其他凭据 | modify在credentials事务内读改写；UI清除delete |
| credential | 凭据对象 | object / SDK/按键判别 | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 保存Key写deepseek/api_key，实际Key trim；SDK CredentialStore可携带其他凭据 | modify在credentials事务内读改写；UI清除delete |
| credential<分支1>.type | 条目/结构类型 | "api_key" | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 保存Key写deepseek/api_key，实际Key trim；SDK CredentialStore可携带其他凭据 | modify在credentials事务内读改写；UI清除delete |
| credential<分支1>.key | 稳定主题键 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 保存Key写deepseek/api_key，实际Key trim；SDK CredentialStore可携带其他凭据 | modify在credentials事务内读改写；UI清除delete |

### T02 · appSettings（全局配置）

| 项目 | 规定 |
|---|---|
| 所属库/版本 | westworld_settings / v2 |
| 记录粒度/范围 | 一个设置键及其值；本机浏览器来源全局 |
| 主键及索引 | `key`；首项主键、&唯一、[a+b]复合，无额外外键 |
| 创建与更新 | 保存模型/并发/目录句柄；updatedAt更新 |
| 读取者 | 配置读取、模型适配、书架目录提示 |
| 删除/保留/关联 | 除Key外配置及目录句柄；不备份；无业务级默认迁移 |
| 备份 | 配置与凭据不导出；books作为book.json元数据 |
| 示例 | [人工记录](../resources/table-examples/appSettings.json) |

| 字段路径 | 中文含义/单位 | 类型/枚举 | 必填/缺省/null | 限制 | 来源/生成 | 更新/引用与消费 |
|---|---|---|---|---|---|---|
| key | 稳定主题键 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 由key判定具体value；配置键字典逐项定义 | setAppSetting put覆盖value/updatedAt；无全量设置校验 |
| value | 按配置键判别的值 | SDK/按键判别 | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 由key判定具体value；配置键字典逐项定义 | setAppSetting put覆盖value/updatedAt；无全量设置校验 |
| updatedAt | 更新时间 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 由key判定具体value；配置键字典逐项定义 | setAppSetting put覆盖value/updatedAt；无全量设置校验 |

### T03 · books（书架）

| 项目 | 规定 |
|---|---|
| 所属库/版本 | westworld_settings / v2 |
| 记录粒度/范围 | 一次导入的一本书；本机浏览器来源全局 |
| 主键及索引 | `id, createdAt`；首项主键、&唯一、[a+b]复合，无额外外键 |
| 创建与更新 | 小说/备份导入createBook；整书删除移除 |
| 读取者 | useBooks倒序、export读取标题；无改书名UI |
| 删除/保留/关联 | 与单书库不跨库原子；同名书不去重 |
| 备份 | 配置与凭据不导出；books作为book.json元数据 |
| 示例 | [人工记录](../resources/table-examples/books.json) |

| 字段路径 | 中文含义/单位 | 类型/枚举 | 必填/缺省/null | 限制 | 来源/生成 | 更新/引用与消费 |
|---|---|---|---|---|---|---|
| id | 记录编号 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 小说bk_UUID；备份bk_时间36进制_随机4字符 | 创建后作为本表主键；覆盖/重编/恢复的例外按本表生命周期执行 |
| title | 标题 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 小说文件去最后扩展名；备份原title+（导入） | 没有UI改书名；同名可多条 |
| author | 作者 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 创建书籍参数或备份元数据对应字段 | 创建时复制；author/sourceFileName未提供则省略，无UI改写 |
| sourceFileName | 源文件名 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 创建书籍参数或备份元数据对应字段 | 创建时复制；author/sourceFileName未提供则省略，无UI改写 |
| createdAt | 创建时间 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 创建时new Date().toISOString() | 除恢复既有条目外不更新 |

### T04 · chapters（章节元信息）

| 项目 | 规定 |
|---|---|
| 所属库/版本 | westworld_canon_{bookId} / v4 |
| 记录粒度/范围 | 一个章/切块；本书物理库 |
| 主键及索引 | `chapterIndex, order`；首项主键、&唯一、[a+b]复合，无额外外键 |
| 创建与更新 | importBook/saveChapters与正文同事务；备份恢复 |
| 读取者 | 预览后的章数、窗口、工具范围与章序 |
| 删除/保留/关联 | 整书删除；无单章手动增删UI；顺序order为权威 |
| 备份 | 同名data/chapters.json；chapterTexts另为chapters/*.txt |
| 示例 | [人工记录](../resources/table-examples/chapters.json) |

| 字段路径 | 中文含义/单位 | 类型/枚举 | 必填/缺省/null | 限制 | 来源/生成 | 更新/引用与消费 |
|---|---|---|---|---|---|---|
| bookId | 书籍归属 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前书ID；备份恢复换newBookId | 归属冗余字段；选库仍按bookId |
| chapterIndex | 章节标识 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 分章序号/切块字符串；快照来自当前章 | 节点和快照创建后不随并入重新编号 |
| chapterName | 章节名称 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 切章标题；P1复制当前章 | 非自动从原文件名推断 |
| charCount | 字符数 | number | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | text.length，UTF-16单位 | 分章时一次生成；无token换算 |
| order | 章内/全书顺序 | number | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | Chapter全书序0起；Node章内序0起 | 补点可按引文位置重排Node.order |

### T05 · chapterTexts（分章原文）

| 项目 | 规定 |
|---|---|
| 所属库/版本 | westworld_canon_{bookId} / v4 |
| 记录粒度/范围 | 一个章/切块的正文；本书物理库 |
| 主键及索引 | `chapterIndex`；首项主键、&唯一、[a+b]复合，无额外外键 |
| 创建与更新 | 导入与chapters同事务；备份恢复 |
| 读取者 | P1、单章试跑、频次、read_original、引文校验 |
| 删除/保留/关联 | 不保存原始完整字节；首标题前丢弃；不直接UI编辑 |
| 备份 | 同名data/chapterTexts.json；chapterTexts另为chapters/*.txt |
| 示例 | [人工记录](../resources/table-examples/chapterTexts.json) |

| 字段路径 | 中文含义/单位 | 类型/枚举 | 必填/缺省/null | 限制 | 来源/生成 | 更新/引用与消费 |
|---|---|---|---|---|---|---|
| bookId | 书籍归属 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前书ID；备份恢复换newBookId | 归属冗余字段；选库仍按bookId |
| chapterIndex | 章节标识 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 分章序号/切块字符串；快照来自当前章 | 节点和快照创建后不随并入重新编号 |
| text | 正文 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 已解码章节片段 | 不包含首标题前丢弃片段；不保存完整原始bytes |

### T06 · characterSnapshots（人物草稿）

| 项目 | 规定 |
|---|---|
| 所属库/版本 | westworld_canon_{bookId} / v4 |
| 记录粒度/范围 | 一份当前保留的人物档案；初始逐章快照；本书物理库 |
| 主键及索引 | `id, chapterIndex, name`；首项主键、&唯一、[a+b]复合，无额外外键 |
| 创建与更新 | P1 bulkPut；归并替换选中集合；编辑/手动合并/删除 |
| 读取者 | 人物列表详情、资产工具、频次、故事依据、入库 |
| 删除/保留/关联 | 草稿可改，入库不删；删除不立即修改固定实体 |
| 备份 | 同名data/characterSnapshots.json；chapterTexts另为chapters/*.txt |
| 示例 | [人工记录](../resources/table-examples/characterSnapshots.json) |

| 字段路径 | 中文含义/单位 | 类型/枚举 | 必填/缺省/null | 限制 | 来源/生成 | 更新/引用与消费 |
|---|---|---|---|---|---|---|
| name | 名称/主名 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1主称呼/归并保留或人工输入 | 草稿表单允许空写undefined，不自动强制Schema |
| aliases_mentioned | 本章提及别名 | array<string> | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 world.characters[i].aliases_mentioned；合并按字段融合保留 | 合并更新aliases_mentioned；无直接UI编辑入口；备份恢复可携带 |
| identity | 身份 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 world.characters[i].identity；合并按字段融合保留 | 合并更新identity；UI对应字段保存覆盖，profile仅ageText |
| profile | 基础资料 | object | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 模型精确年龄/原文描述/性别；合并冲突保留说明 | ageText点路径更新；保留age/gender |
| profile.age | 精确年龄 | number | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 模型精确年龄/原文描述/性别；合并冲突保留说明 | ageText点路径更新；保留age/gender |
| profile.ageText | 原文年龄描述 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 模型精确年龄/原文描述/性别；合并冲突保留说明 | ageText点路径更新；保留age/gender |
| profile.gender | 性别 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 模型精确年龄/原文描述/性别；合并冲突保留说明 | ageText点路径更新；保留age/gender |
| appearance | 外貌 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 world.characters[i].appearance；合并按字段融合保留 | 合并更新appearance；UI对应字段保存覆盖，profile仅ageText |
| personality | 性格 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 world.characters[i].personality；合并按字段融合保留 | 合并更新personality；UI对应字段保存覆盖，profile仅ageText |
| background | 背景 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 world.characters[i].background；合并按字段融合保留 | 合并更新background；UI对应字段保存覆盖，profile仅ageText |
| speech_style_sample | 原话片段（草稿字段） | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 world.characters[i].speech_style_sample；合并按字段融合保留 | 合并更新speech_style_sample；UI对应字段保存覆盖，profile仅ageText |
| relations | 人物关系 | array<object> | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 原文人物关系；按target/type/direction融合 | target始终称呼；无自动全量实体ID转换 |
| relations[].target | 关系目标称呼 | string | 父存在则必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 world.characters[i].relations[]；合并按字段融合保留 | 合并更新relations[]；无直接UI编辑入口；备份恢复可携带 |
| relations[].relation_type | 关系类型 | string | 父存在则必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 world.characters[i].relations[]；合并按字段融合保留 | 合并更新relations[]；无直接UI编辑入口；备份恢复可携带 |
| relations[].relation_label | 关系文案 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 world.characters[i].relations[]；合并按字段融合保留 | 合并更新relations[]；无直接UI编辑入口；备份恢复可携带 |
| relations[].direction | 关系方向 | "bidirectional" / "directed" | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 world.characters[i].relations[]；合并按字段融合保留 | 合并更新relations[]；无直接UI编辑入口；备份恢复可携带 |
| confidence | 置信度 | number | 必填；非null（人工弱校验另见操作）；无Schema默认 | minimum=0；maximum=1 | P1模型0–1；补点固定0.6；实体复制 | 无confidence<0.6自动阻止入库 |
| frequency | 出场统计 | object | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 代码扫描最终主名正文命中 | 合并末重算；chapters原章去重，mentions非重叠匹配 |
| frequency.chapters | 涉及/覆盖章节 | integer | 父存在则必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 代码扫描最终主名正文命中 | 合并末重算；chapters原章去重，mentions非重叠匹配 |
| frequency.mentions | 主名提及次数 | integer | 父存在则必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 代码扫描最终主名正文命中 | 合并末重算；chapters原章去重，mentions非重叠匹配 |
| frequency.scopeChapters | 统计原章总数 | integer | 父存在则必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 代码扫描最终主名正文命中 | 合并末重算；chapters原章去重，mentions非重叠匹配 |
| frequency.percentile | 相对分位 | number | 父存在则必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 代码扫描最终主名正文命中 | 合并末重算；chapters原章去重，mentions非重叠匹配 |
| sourceChapters | 来源章集合 | array<string> | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 合并来源chapterIndex并集numeric排序 | 范围选择同时检查它；不拿来源章冒充真实主名出场 |
| mergeNotes | 冲突与复核信息 | array<string> | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 本地冲突或AI merge_notes并集 | 可在详情查看，无单独解决按钮 |
| mergeFacts | 合并事实底稿 | array<object> | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 四文本拆分去重及稳定事实ID | 改四文本时替换对应事实、清退休优化ID |
| mergeFacts[].id | 记录编号 | string | 父存在则必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 world.characters[i].mergeFacts[]；合并按字段融合保留 | 合并更新mergeFacts[]；无直接UI编辑入口；备份恢复可携带 |
| mergeFacts[].field | 事实所属字段 | string | 父存在则必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 world.characters[i].mergeFacts[]；合并按字段融合保留 | 合并更新mergeFacts[]；无直接UI编辑入口；备份恢复可携带 |
| mergeFacts[].text | 正文 | string | 父存在则必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 world.characters[i].mergeFacts[]；合并按字段融合保留 | 合并更新mergeFacts[]；无直接UI编辑入口；备份恢复可携带 |
| mergeFacts[].chapters | 涉及/覆盖章节 | array<string> | 父存在则必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 world.characters[i].mergeFacts[]；合并按字段融合保留 | 合并更新mergeFacts[]；无直接UI编辑入口；备份恢复可携带 |
| optimizedFactIds | 已整编事实编号 | array<string> | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 人物整编成功后当前底稿事实ID全集 | 人工改字段移除退休ID；非模型直接写长哈希 |
| optimizationFingerprint | 整编资料指纹 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | names/facts/notes JSON签名 | 资料变则失效；不是全库指纹 |
| roleWeightSource | 层级来源 | "frequency" / "manual" | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 自动frequency / 人工manual | manual更新后自动归并不得覆盖层级 |
| id | 记录编号 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | C{chapterIndex}-P{去重后序号至少3位} | 创建后作为本表主键；覆盖/重编/恢复的例外按本表生命周期执行 |
| bookId | 书籍归属 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前书ID；备份恢复换newBookId | 归属冗余字段；选库仍按bookId |
| chapterIndex | 章节标识 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 分章序号/切块字符串；快照来自当前章 | 节点和快照创建后不随并入重新编号 |
| chapterName | 章节名称 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 切章标题；P1复制当前章 | 非自动从原文件名推断 |
| aliases | 累计别名 | array<string> | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 合并所有称呼去主名，或CSV人工输入 | 数组并集/人工替换；缺省不自动视为[]，实体构造有明确默认 |
| roleWeight | 人物层级 | "主要人物" / "重要配角" / "NPC" / "路人" | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 频次分位或人工Select；实体缺省NPC | manual优先，非manual重算；不是模型因果重要性 |
| updatedAt | 更新时间 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 相应写入当前ISO时间 | 并非所有编辑都会更新：节点/事件线普通更新不统一加时间 |

### T07 · locationSnapshots（地点草稿）

| 项目 | 规定 |
|---|---|
| 所属库/版本 | westworld_canon_{bookId} / v4 |
| 记录粒度/范围 | 一份当前保留的地点档案；本书物理库 |
| 主键及索引 | `id, chapterIndex, name`；首项主键、&唯一、[a+b]复合，无额外外键 |
| 创建与更新 | P1、归并、手动更新并入删除 |
| 读取者 | 地点列表详情、工具、入库、记忆资料指纹 |
| 删除/保留/关联 | 原始提取无aliases；归并/人工补；不与人物规则混用 |
| 备份 | 同名data/locationSnapshots.json；chapterTexts另为chapters/*.txt |
| 示例 | [人工记录](../resources/table-examples/locationSnapshots.json) |

| 字段路径 | 中文含义/单位 | 类型/枚举 | 必填/缺省/null | 限制 | 来源/生成 | 更新/引用与消费 |
|---|---|---|---|---|---|---|
| name | 名称/主名 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1主称呼/归并保留或人工输入 | 草稿表单允许空写undefined，不自动强制Schema |
| description | 描述 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 world.locations[i].description；合并按字段融合保留 | 合并更新description；UI对应字段保存覆盖，profile仅ageText |
| confidence | 置信度 | number | 必填；非null（人工弱校验另见操作）；无Schema默认 | minimum=0；maximum=1 | P1模型0–1；补点固定0.6；实体复制 | 无confidence<0.6自动阻止入库 |
| frequency | 出场统计 | object | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 代码扫描最终主名正文命中 | 合并末重算；chapters原章去重，mentions非重叠匹配 |
| frequency.chapters | 涉及/覆盖章节 | integer | 父存在则必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 代码扫描最终主名正文命中 | 合并末重算；chapters原章去重，mentions非重叠匹配 |
| frequency.mentions | 主名提及次数 | integer | 父存在则必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 代码扫描最终主名正文命中 | 合并末重算；chapters原章去重，mentions非重叠匹配 |
| frequency.scopeChapters | 统计原章总数 | integer | 父存在则必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 代码扫描最终主名正文命中 | 合并末重算；chapters原章去重，mentions非重叠匹配 |
| frequency.percentile | 相对分位 | number | 父存在则必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 代码扫描最终主名正文命中 | 合并末重算；chapters原章去重，mentions非重叠匹配 |
| sourceChapters | 来源章集合 | array<string> | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 合并来源chapterIndex并集numeric排序 | 范围选择同时检查它；不拿来源章冒充真实主名出场 |
| mergeNotes | 冲突与复核信息 | array<string> | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 本地冲突或AI merge_notes并集 | 可在详情查看，无单独解决按钮 |
| aliases | 累计别名 | array<string> | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 合并所有称呼去主名，或CSV人工输入 | 数组并集/人工替换；缺省不自动视为[]，实体构造有明确默认 |
| id | 记录编号 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | C{chapterIndex}-L{去重后序号至少3位} | 创建后作为本表主键；覆盖/重编/恢复的例外按本表生命周期执行 |
| bookId | 书籍归属 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前书ID；备份恢复换newBookId | 归属冗余字段；选库仍按bookId |
| chapterIndex | 章节标识 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 分章序号/切块字符串；快照来自当前章 | 节点和快照创建后不随并入重新编号 |
| chapterName | 章节名称 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 切章标题；P1复制当前章 | 非自动从原文件名推断 |
| updatedAt | 更新时间 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 相应写入当前ISO时间 | 并非所有编辑都会更新：节点/事件线普通更新不统一加时间 |

### T08 · nodes（事件节点）

| 项目 | 规定 |
|---|---|
| 所属库/版本 | westworld_canon_{bookId} / v4 |
| 记录粒度/范围 | 一个原章事件；P1或检查补点；本书物理库 |
| 主键及索引 | `id, chapterIndex, order`；首项主键、&唯一、[a+b]复合，无额外外键 |
| 创建与更新 | P1、runLink补点/反向归属、updateNode、deleteNode、入库actorIds |
| 读取者 | 节点列表、图、事件工具、线派生、记忆依据 |
| 删除/保留/关联 | 唯一当前表；没有独立冻结节点副本；timeCoord等无自动推断写入 |
| 备份 | 同名data/nodes.json；chapterTexts另为chapters/*.txt |
| 示例 | [人工记录](../resources/table-examples/nodes.json) |

| 字段路径 | 中文含义/单位 | 类型/枚举 | 必填/缺省/null | 限制 | 来源/生成 | 更新/引用与消费 |
|---|---|---|---|---|---|---|
| name | 名称/主名 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1主称呼/归并保留或人工输入 | 草稿表单允许空写undefined，不自动强制Schema |
| summary | 摘要 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 narrative.nodes[i].summary；检查new_nodes[i].summary | 普通编辑summary按表单patch替换；相关派生按DF-03/09执行 |
| process | 详细经过 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 narrative.nodes[i].process；检查new_nodes[i].process | 普通编辑process按表单patch替换；相关派生按DF-03/09执行 |
| actors | 行动者称呼 | array<string> | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 narrative.nodes[i].actors；检查new_nodes[i].actors | 普通编辑actors按表单patch替换；相关派生按DF-03/09执行 |
| targets | 对象称呼 | array<string> | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 narrative.nodes[i].targets；检查new_nodes[i].targets | 普通编辑targets按表单patch替换；相关派生按DF-03/09执行 |
| world_delta | 状态变化描述 | array<string> | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 narrative.nodes[i].world_delta；检查new_nodes[i].world_delta | 普通编辑world_delta按表单patch替换；相关派生按DF-03/09执行 |
| new_facts | 新出现事实 | array<string> | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 narrative.nodes[i].new_facts；检查new_nodes[i].new_facts | 普通编辑new_facts按表单patch替换；相关派生按DF-03/09执行 |
| started_actions | 开始的行动 | array<string> | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 narrative.nodes[i].started_actions；检查new_nodes[i].started_actions | 普通编辑started_actions按表单patch替换；相关派生按DF-03/09执行 |
| time_text | 明确时间原文 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 narrative.nodes[i].time_text；检查new_nodes[i].time_text | 普通编辑time_text按表单patch替换；相关派生按DF-03/09执行 |
| time_hint | 相对时间原文 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 narrative.nodes[i].time_hint；检查new_nodes[i].time_hint | 普通编辑time_hint按表单patch替换；相关派生按DF-03/09执行 |
| quote | 逐字引文 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 narrative.nodes[i].quote；检查new_nodes[i].quote | 普通编辑quote无直接UI编辑；补点时从已验证提取结果复制；相关派生按DF-03/09执行 |
| offset | 字符偏移 | number | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 narrative.nodes[i].offset；检查new_nodes[i].offset | 普通编辑offset无直接UI编辑；补点时从已验证提取结果复制；相关派生按DF-03/09执行 |
| confidence | 置信度 | number | 必填；非null（人工弱校验另见操作）；无Schema默认 | minimum=0；maximum=1 | P1模型0–1；补点固定0.6；实体复制 | 无confidence<0.6自动阻止入库 |
| id | 记录编号 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | C{chapterIndex}-N{序号至少3位}；补点取本章已有最大序号+1 | 创建后作为本表主键；覆盖/重编/恢复的例外按本表生命周期执行 |
| bookId | 书籍归属 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前书ID；备份恢复换newBookId | 归属冗余字段；选库仍按bookId |
| chapterIndex | 章节标识 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 分章序号/切块字符串；快照来自当前章 | 节点和快照创建后不随并入重新编号 |
| chapterName | 章节名称 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 切章标题；P1复制当前章 | 非自动从原文件名推断 |
| order | 章内/全书顺序 | number | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | Chapter全书序0起；Node章内序0起 | 补点可按引文位置重排Node.order |
| createdBy | 节点创建阶段 | "P1" / "P2" / "P3" | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1 narrative.nodes[i].createdBy；检查new_nodes[i].createdBy | 普通编辑createdBy无直接UI编辑；补点时从已验证提取结果复制；相关派生按DF-03/09执行 |
| eventLineIds | 所属线编号 | array<string> | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | runLink/deleteNode/deleteEventLine根据线成员反算 | 无归属明确[]；P1/导入可能省略 |
| actorIds | 映射人物编号 | array<string> | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 入库匹配actors+targets所得人物ID并集 | 仅入库重算，不随普通actors编辑立即同步 |
| timeCoord | 已有时间坐标 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 只保留导入/已有值；没有自动生成流程 | 可参与时间范围和记忆指纹 |
| timePrecision | 时间精度标记 | "explicit" / "inferred_hour" / "inferred_day" / "order_only" | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 已有或导入值；不由本基线自动推断 | 枚举存在不增加世界时钟 |
| canonicalId | 去重主节点编号 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 兼容可携带字段 | 无当前自动节点去重流程 |

### T09 · eventLines（事件线）

| 项目 | 规定 |
|---|---|
| 所属库/版本 | westworld_canon_{bookId} / v4 |
| 记录粒度/范围 | 一条有序事件成员集合；本书物理库 |
| 主键及索引 | `id`；首项主键、&唯一、[a+b]复合，无额外外键 |
| 创建与更新 | runLink create/append/update/merge；人工四字段/状态；删点/入库派生 |
| 读取者 | 线列表、图、工具、记忆依据 |
| 删除/保留/关联 | 成员多对多；删线清节点归属，删点清空线 |
| 备份 | 同名data/eventLines.json；chapterTexts另为chapters/*.txt |
| 示例 | [人工记录](../resources/table-examples/eventLines.json) |

| 字段路径 | 中文含义/单位 | 类型/枚举 | 必填/缺省/null | 限制 | 来源/生成 | 更新/引用与消费 |
|---|---|---|---|---|---|---|
| id | 记录编号 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | L{现有L数字最大+1，至少2位} | 创建后作为本表主键；覆盖/重编/恢复的例外按本表生命周期执行 |
| bookId | 书籍归属 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前书ID；备份恢复换newBookId | 归属冗余字段；选库仍按bookId |
| title | 标题 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | create.title（其他操作保留旧title） | 人工title表单/状态可覆盖；普通update不重算成员和更新时间 |
| nodeIds | 成员/依据节点 | array<string> | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | AI线操作的成员，临时补点ID映射后排序 | append并集/update替换/merge多线并集 |
| chapters | 涉及/覆盖章节 | array<string> | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 线成员节点chapterIndex去重排序 | runLink和删点重算；不是章节表正文副本 |
| timeRange | 已有时间范围 | array<string> | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前事件线操作对应字段 | 人工timeRange表单/状态可覆盖；普通update不重算成员和更新时间 |
| cause | 起因 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | op.cause | 人工cause表单/状态可覆盖；普通update不重算成员和更新时间 |
| process | 详细经过 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | op.process | 人工process表单/状态可覆盖；普通update不重算成员和更新时间 |
| result | 结果 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | op.result | 人工result表单/状态可覆盖；普通update不重算成员和更新时间 |
| lineStatus | 事件线状态 | "open" / "closed" | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | op.line_status | 人工lineStatus表单/状态可覆盖；普通update不重算成员和更新时间 |
| characterIds | 人物实体编号 | array<string> | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 线成员节点actorIds有序并集 | runLink/删点/入库重算，普通线表单不重算 |
| updatedAt | 更新时间 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 相应写入当前ISO时间 | 并非所有编辑都会更新：节点/事件线普通更新不统一加时间 |

### T10 · characters（当前人物实体）

| 项目 | 规定 |
|---|---|
| 所属库/版本 | westworld_canon_{bookId} / v4 |
| 记录粒度/范围 | 本次入库的一个人物实体；本书物理库 |
| 主键及索引 | `id, name`；首项主键、&唯一、[a+b]复合，无额外外键 |
| 创建与更新 | publishCanon清表重建；备份恢复 |
| 读取者 | 资产包状态、actorIds映射；没有独立固定实体编辑UI |
| 删除/保留/关联 | 草稿改后不会自动同步；重复入库编号可变；relations.target仍称呼 |
| 备份 | 同名data/characters.json；chapterTexts另为chapters/*.txt |
| 示例 | [人工记录](../resources/table-examples/characters.json) |

| 字段路径 | 中文含义/单位 | 类型/枚举 | 必填/缺省/null | 限制 | 来源/生成 | 更新/引用与消费 |
|---|---|---|---|---|---|---|
| id | 记录编号 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 每次入库按来源ID排序从P001重编 | 创建后作为本表主键；覆盖/重编/恢复的例外按本表生命周期执行 |
| bookId | 书籍归属 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前书ID；备份恢复换newBookId | 归属冗余字段；选库仍按bookId |
| chapterIndex | 章节标识 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 分章序号/切块字符串；快照来自当前章 | 节点和快照创建后不随并入重新编号 |
| name | 名称/主名 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1主称呼/归并保留或人工输入 | 草稿表单允许空写undefined，不自动强制Schema |
| aliases | 累计别名 | array<string> | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 合并所有称呼去主名，或CSV人工输入 | 数组并集/人工替换；缺省不自动视为[]，实体构造有明确默认 |
| roleWeight | 人物层级 | "主要人物" / "重要配角" / "NPC" / "路人" | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 频次分位或人工Select；实体缺省NPC | manual优先，非manual重算；不是模型因果重要性 |
| identity | 身份 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 入库读取characterSnapshots.identity | 每次入库清表后重新复制identity；草稿修改不即时同步；备份恢复可携带 |
| profile | 基础资料 | object | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 模型精确年龄/原文描述/性别；合并冲突保留说明 | ageText点路径更新；保留age/gender |
| profile.age | 精确年龄 | number | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 模型精确年龄/原文描述/性别；合并冲突保留说明 | ageText点路径更新；保留age/gender |
| profile.ageText | 原文年龄描述 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 模型精确年龄/原文描述/性别；合并冲突保留说明 | ageText点路径更新；保留age/gender |
| profile.gender | 性别 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 模型精确年龄/原文描述/性别；合并冲突保留说明 | ageText点路径更新；保留age/gender |
| appearance | 外貌 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 入库读取characterSnapshots.appearance | 每次入库清表后重新复制appearance；草稿修改不即时同步；备份恢复可携带 |
| personality | 性格 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 入库读取characterSnapshots.personality | 每次入库清表后重新复制personality；草稿修改不即时同步；备份恢复可携带 |
| background | 背景 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 入库读取characterSnapshots.background | 每次入库清表后重新复制background；草稿修改不即时同步；备份恢复可携带 |
| speechStyleSample | 原话片段（实体字段） | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 入库读取characterSnapshots.speech_style_sample | 每次入库清表后重新复制speechStyleSample；草稿修改不即时同步；备份恢复可携带 |
| relations | 人物关系 | array<object> | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 原文人物关系；按target/type/direction融合 | target始终称呼；无自动全量实体ID转换 |
| relations[].target | 关系目标称呼 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 入库读取characterSnapshots.relations[] | 每次入库清表后重新复制relations[]；草稿修改不即时同步；备份恢复可携带 |
| relations[].relation_type | 关系类型 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 入库读取characterSnapshots.relations[] | 每次入库清表后重新复制relations[]；草稿修改不即时同步；备份恢复可携带 |
| relations[].relation_label | 关系文案 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 入库读取characterSnapshots.relations[] | 每次入库清表后重新复制relations[]；草稿修改不即时同步；备份恢复可携带 |
| relations[].direction | 关系方向 | "bidirectional" / "directed" | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 入库读取characterSnapshots.relations[] | 每次入库清表后重新复制relations[]；草稿修改不即时同步；备份恢复可携带 |
| confidence | 置信度 | number | 必填；非null（人工弱校验另见操作）；无Schema默认 | minimum=0；maximum=1 | P1模型0–1；补点固定0.6；实体复制 | 无confidence<0.6自动阻止入库 |
| updatedAt | 更新时间 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 相应写入当前ISO时间 | 并非所有编辑都会更新：节点/事件线普通更新不统一加时间 |

### T11 · locations（当前地点实体）

| 项目 | 规定 |
|---|---|
| 所属库/版本 | westworld_canon_{bookId} / v4 |
| 记录粒度/范围 | 本次入库的一个地点实体；本书物理库 |
| 主键及索引 | `id, name`；首项主键、&唯一、[a+b]复合，无额外外键 |
| 创建与更新 | publishCanon清表重建；备份恢复 |
| 读取者 | 备份和已预留读取；无实际游玩消费 |
| 删除/保留/关联 | 不生成节点地点ID映射；只有地点时书架可能未入库 |
| 备份 | 同名data/locations.json；chapterTexts另为chapters/*.txt |
| 示例 | [人工记录](../resources/table-examples/locations.json) |

| 字段路径 | 中文含义/单位 | 类型/枚举 | 必填/缺省/null | 限制 | 来源/生成 | 更新/引用与消费 |
|---|---|---|---|---|---|---|
| name | 名称/主名 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1主称呼/归并保留或人工输入 | 草稿表单允许空写undefined，不自动强制Schema |
| description | 描述 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 入库读取locationSnapshots.description | 每次入库清表后重新复制description；草稿修改不即时同步；备份恢复可携带 |
| confidence | 置信度 | number | 必填；非null（人工弱校验另见操作）；无Schema默认 | minimum=0；maximum=1 | P1模型0–1；补点固定0.6；实体复制 | 无confidence<0.6自动阻止入库 |
| id | 记录编号 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 每次入库按来源ID排序从L001重编 | 创建后作为本表主键；覆盖/重编/恢复的例外按本表生命周期执行 |
| aliases | 累计别名 | array<string> | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 合并所有称呼去主名，或CSV人工输入 | 数组并集/人工替换；缺省不自动视为[]，实体构造有明确默认 |
| bookId | 书籍归属 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前书ID；备份恢复换newBookId | 归属冗余字段；选库仍按bookId |
| chapterIndex | 章节标识 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 分章序号/切块字符串；快照来自当前章 | 节点和快照创建后不随并入重新编号 |
| updatedAt | 更新时间 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 相应写入当前ISO时间 | 并非所有编辑都会更新：节点/事件线普通更新不统一加时间 |

### T12 · compileProgress（编译进度）

| 项目 | 规定 |
|---|---|
| 所属库/版本 | westworld_canon_{bookId} / v4 |
| 记录粒度/范围 | 一个P1/P2/P3阶段记录；本书物理库 |
| 主键及索引 | `stage`；首项主键、&唯一、[a+b]复合，无额外外键 |
| 创建与更新 | 导入P1 idle；各任务写；阶段重跑删旧P3/P2 |
| 读取者 | 继续任务、CompilePanel、入库UI门槛 |
| 删除/保留/关联 | 成功失败数组的单元意义随stage/模式变；不是只有章号 |
| 备份 | 同名data/compileProgress.json；chapterTexts另为chapters/*.txt |
| 示例 | [人工记录](../resources/table-examples/compileProgress.json) |

| 字段路径 | 中文含义/单位 | 类型/枚举 | 必填/缺省/null | 限制 | 来源/生成 | 更新/引用与消费 |
|---|---|---|---|---|---|---|
| bookId | 书籍归属 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前书ID；备份恢复换newBookId | 归属冗余字段；选库仍按bookId |
| stage | 编译阶段 | "P1" / "P2" / "P3" | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 见本表创建源与对象语义；从提交/表单对应字段复制 | 本表生命周期规定覆盖、合并或追加方式 |
| status | 状态 | "idle" / "running" / "paused" / "cancelling" / "cancelled" / "failed" / "completed" | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 按对象/流程转移表赋值 | 不能从同名status推断同一业务语义 |
| totalChapters | 阶段总单元数 | number | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 见本表创建源与对象语义；从提交/表单对应字段复制 | 本表生命周期规定覆盖、合并或追加方式 |
| completedChapters | 完成单元标识 | array<string> | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1章块ID；P2窗口序号字符串；P3 assets/lines | 代码Set/数组更新，样本模式按当前步骤 |
| failedChapters | 失败单元标识 | array<string> | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P1失败章块；P2失败窗口；P3失败步骤 | 成功恢复清对应失败，P3另计上游失败 |
| lastWindowIndex | 连续完成窗口索引 | number | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | P2连续成功窗索引，初-1 | 失败后不越过空洞 |
| planKey | 编排计划签名 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 完整JSON{version:4,windows,useAi}；样本JSON{mode,scope} | 不匹配重置窗口恢复 |
| editorSessionId | 编排所用会话 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 编排ensure得到的active session.id | 不匹配时恢复点失效 |
| testScope | 样本章块范围 | array<string> | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 阶段测试P1完成章/块集合 | 完整流程不使用其完成标记跳过剩余章 |
| partialChapters | 缺失子步骤 | object | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | key为失败章块ID，value缺worldAssets/narrativeAssets | 恢复只请求缺子步骤；全部成功delete键 |
| partialChapters{key} | partialChapters{key} | array<"worldAssets" / "narrativeAssets"> | 父存在则必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 见本表创建源与对象语义；从提交/表单对应字段复制 | 本表生命周期规定覆盖、合并或追加方式 |
| updatedAt | 更新时间 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 相应写入当前ISO时间 | 并非所有编辑都会更新：节点/事件线普通更新不统一加时间 |

### T13 · storyEditorMemory（工作摘要）

| 项目 | 规定 |
|---|---|
| 所属库/版本 | westworld_canon_{bookId} / v4 |
| 记录粒度/范围 | 一条会话的最新摘要；本书物理库 |
| 主键及索引 | `id, sessionId`；首项主键、&唯一、[a+b]复合，无额外外键 |
| 创建与更新 | ensure迁旧记忆；runLink与资产/检查点事务提交 |
| 读取者 | 下一批模型输入、记忆面板、get_editor_memory |
| 删除/保留/关联 | id通常sessionId；旧id story_editor兼容；revision及指纹 |
| 备份 | 同名data/storyEditorMemory.json；chapterTexts另为chapters/*.txt |
| 示例 | [人工记录](../resources/table-examples/storyEditorMemory.json) |

| 字段路径 | 中文含义/单位 | 类型/枚举 | 必填/缺省/null | 限制 | 来源/生成 | 更新/引用与消费 |
|---|---|---|---|---|---|---|
| id | 记录编号 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前sessionId，旧无会话id兼容story_editor | 创建后作为本表主键；覆盖/重编/恢复的例外按本表生命周期执行 |
| bookId | 书籍归属 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前书ID；备份恢复换newBookId | 归属冗余字段；选库仍按bookId |
| sessionId | 会话归属 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前/历史故事会话ID；旧数据缺省空串 | 会话归属过滤；不能查另一书 |
| revision | 修订号 | integer | 必填；非null（人工弱校验另见操作）；无Schema默认 | minimum=0 | 记忆预期版本+1；note引用本次revision | 提交前校验memory.revision防冲突 |
| workingSummary | 工作摘要 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | maxLength=2000 | memory_update.workingSummary（由代码补元数据） | 同批事件/记忆事务覆盖当前会话记录 |
| dataFingerprint | 全局资料指纹 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 全库选定事实与assetFingerprint SHA256 | 读记忆时计算dataChanged；不保存派生显示布尔 |
| updatedAt | 更新时间 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 相应写入当前ISO时间 | 并非所有编辑都会更新：节点/事件线普通更新不统一加时间 |

### T14 · storyEditorNotes（判断与复核事项）

| 项目 | 规定 |
|---|---|
| 所属库/版本 | westworld_canon_{bookId} / v4 |
| 记录粒度/范围 | 会话内一个稳定key的工作主题；本书物理库 |
| 主键及索引 | `id, &[sessionId+key], sessionId, kind, status, updatedAt`；首项主键、&唯一、[a+b]复合，无额外外键 |
| 创建与更新 | runLink提交新增/更新/解决；初次会话迁旧空sessionId |
| 读取者 | 面板筛选、工具、依据validity计算 |
| 删除/保留/关联 | 唯一sessionId+key，resolved保留；stale为读取视图不是持久status |
| 备份 | 同名data/storyEditorNotes.json；chapterTexts另为chapters/*.txt |
| 示例 | [人工记录](../resources/table-examples/storyEditorNotes.json) |

| 字段路径 | 中文含义/单位 | 类型/枚举 | 必填/缺省/null | 限制 | 来源/生成 | 更新/引用与消费 |
|---|---|---|---|---|---|---|
| key | 稳定主题键 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | minLength=1；maxLength=120 | memory_update.notes[i].key；元数据来自当前work | 按sessionId+key更新；原kind不允许改变；stale为读取派生 |
| kind | 类型 | "decision" / "review" | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | memory_update.notes[i].kind；元数据来自当前work | 按sessionId+key更新；原kind不允许改变；stale为读取派生 |
| status | 状态 | "active" / "resolved" | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 按对象/流程转移表赋值 | 不能从同名status推断同一业务语义 |
| statement | 判断/事项说明 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | minLength=1；maxLength=1000 | memory_update.notes[i].statement；元数据来自当前work | 按sessionId+key更新；原kind不允许改变；stale为读取派生 |
| nodeIds | 成员/依据节点 | array<string> | 必填；非null（人工弱校验另见操作）；无Schema默认 | maxItems=20 | AI线操作的成员，临时补点ID映射后排序 | append并集/update替换/merge多线并集 |
| lineIds | 依据线编号 | array<string> | 必填；非null（人工弱校验另见操作）；无Schema默认 | maxItems=20 | memory_update.notes[i].lineIds；元数据来自当前work | 按sessionId+key更新；原kind不允许改变；stale为读取派生 |
| evidence | 原文证据 | array<object> | 必填；非null（人工弱校验另见操作）；无Schema默认 | maxItems=5 | memory_update.notes[i].evidence；元数据来自当前work | 按sessionId+key更新；原kind不允许改变；stale为读取派生 |
| evidence[].chapterIndex | 章节标识 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | memory_update.notes[i].evidence[]；元数据来自当前work | 按sessionId+key更新；原kind不允许改变；stale为读取派生 |
| evidence[].quote | 逐字引文 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | minLength=1；maxLength=1000 | memory_update.notes[i].evidence[]；元数据来自当前work | 按sessionId+key更新；原kind不允许改变；stale为读取派生 |
| id | 记录编号 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 同会话key沿用旧id；新增取本书SN数字最大+1，至少6位 | 创建后作为本表主键；覆盖/重编/恢复的例外按本表生命周期执行 |
| bookId | 书籍归属 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前书ID；备份恢复换newBookId | 归属冗余字段；选库仍按bookId |
| revision | 修订号 | integer | 必填；非null（人工弱校验另见操作）；无Schema默认 | minimum=1 | 记忆预期版本+1；note引用本次revision | 提交前校验memory.revision防冲突 |
| sessionId | 会话归属 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前/历史故事会话ID；旧数据缺省空串 | 会话归属过滤；不能查另一书 |
| stage | 编译阶段 | "P2" / "P3" | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | memory_update.notes[i].stage；元数据来自当前work | 按sessionId+key更新；原kind不允许改变；stale为读取派生 |
| basisFingerprint | 引用依据指纹 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 本note引用事实/原文与资产指纹 | 读取时比对得到current/stale，不改note.status |
| createdAt | 创建时间 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 创建时new Date().toISOString() | 除恢复既有条目外不更新 |
| updatedAt | 更新时间 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 相应写入当前ISO时间 | 并非所有编辑都会更新：节点/事件线普通更新不统一加时间 |

### T15 · storyEditorCheckpoints（检查批次恢复点）

| 项目 | 规定 |
|---|---|
| 所属库/版本 | westworld_canon_{bookId} / v4 |
| 记录粒度/范围 | 会话/阶段/phase/scope的一次检查；本书物理库 |
| 主键及索引 | `id, sessionId, stage, phase, status, updatedAt`；首项主键、&唯一、[a+b]复合，无额外外键 |
| 创建与更新 | 成功随资产事务；失败或取消单独recordEditorFailure |
| 读取者 | 恢复跳批、面板最近5条 |
| 删除/保留/关联 | 检查点不是游戏存档；保留失败/取消标记；指纹变化重做 |
| 备份 | 同名data/storyEditorCheckpoints.json；chapterTexts另为chapters/*.txt |
| 示例 | [人工记录](../resources/table-examples/storyEditorCheckpoints.json) |

| 字段路径 | 中文含义/单位 | 类型/枚举 | 必填/缺省/null | 限制 | 来源/生成 | 更新/引用与消费 |
|---|---|---|---|---|---|---|
| id | 记录编号 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | work含sessionId及排序去重scopeIds JSON的SHA256 hex | 创建后作为本表主键；覆盖/重编/恢复的例外按本表生命周期执行 |
| bookId | 书籍归属 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前书ID；备份恢复换newBookId | 归属冗余字段；选库仍按bookId |
| stage | 编译阶段 | "P2" / "P3" | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前work.stage或该批执行结果 | 成功同批事务/失败取消单写；恢复时核指纹和成员 |
| sessionId | 会话归属 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前/历史故事会话ID；旧数据缺省空串 | 会话归属过滤；不能查另一书 |
| phase | 检查阶段类型 | "link" / "review" | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前work.phase或该批执行结果 | 成功同批事务/失败取消单写；恢复时核指纹和成员 |
| scopeIds | 批次对象范围 | array<string> | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前work.scopeIds或该批执行结果 | 成功同批事务/失败取消单写；恢复时核指纹和成员 |
| sourceFingerprint | 检查输入指纹 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 该批范围的原文/节点或线/资产指纹 | 相同completed且归属未变才跳过 |
| status | 状态 | "completed" / "failed" / "cancelled" | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 按对象/流程转移表赋值 | 不能从同名status推断同一业务语义 |
| memberships | 节点归线快照 | object | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 该link批每节点的线ID快照 | 恢复比较当前归属，review通常空映射 |
| memberships{key} | memberships{key} | array<string> | 父存在则必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前work.memberships{key}或该批执行结果 | 成功同批事务/失败取消单写；恢复时核指纹和成员 |
| updatedAt | 更新时间 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 相应写入当前ISO时间 | 并非所有编辑都会更新：节点/事件线普通更新不统一加时间 |

### T16 · storySessions（故事会话头）

| 项目 | 规定 |
|---|---|
| 所属库/版本 | westworld_canon_{bookId} / v4 |
| 记录粒度/范围 | 一个初次/完整复核会话；本书物理库 |
| 主键及索引 | `id, status, createdAt, parentSessionId`；首项主键、&唯一、[a+b]复合，无额外外键 |
| 创建与更新 | ensure建/归档；acquire/release租约；append更新末端 |
| 读取者 | 会话选择、恢复、工具历史 |
| 删除/保留/关联 | 仅一个active由服务控制，非唯一索引；旧会话只读 |
| 备份 | 同名data/storySessions.json；chapterTexts另为chapters/*.txt |
| 示例 | [人工记录](../resources/table-examples/storySessions.json) |

| 字段路径 | 中文含义/单位 | 类型/枚举 | 必填/缺省/null | 限制 | 来源/生成 | 更新/引用与消费 |
|---|---|---|---|---|---|---|
| id | 记录编号 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | crypto.randomUUID() | 创建后作为本表主键；覆盖/重编/恢复的例外按本表生命周期执行 |
| bookId | 书籍归属 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前书ID；备份恢复换newBookId | 归属冗余字段；选库仍按bookId |
| profile | 基础资料 | "story_editor" | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 模型精确年龄/原文描述/性别；合并冲突保留说明 | ageText点路径更新；保留age/gender |
| kind | 类型 | "initial" / "review" | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | newReview?review:initial | 会话头服务按对应生命周期更新，UI不能直接编辑 |
| title | 标题 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 初次故事编辑或全书复核n | 会话头服务按对应生命周期更新，UI不能直接编辑 |
| status | 状态 | "active" / "archived" | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 按对象/流程转移表赋值 | 不能从同名status推断同一业务语义 |
| parentSessionId | 父复核会话 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 归档旧active.id | 会话头服务按对应生命周期更新，UI不能直接编辑 |
| leafId | 消息链末端 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 最新追加条目ID | 投影从末端追父链；恢复校验所属会话 |
| nextOrdinal | 下一消息序号 | integer | 必填；非null（人工弱校验另见操作）；无Schema默认 | minimum=0 | 新会话0；每次append+1 | 与条目新增和leafId同事务 |
| createdAt | 创建时间 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 创建时new Date().toISOString() | 除恢复既有条目外不更新 |
| updatedAt | 更新时间 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 相应写入当前ISO时间 | 并非所有编辑都会更新：节点/事件线普通更新不统一加时间 |
| leaseOwner | 当前租约持有者 | string | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | acquire生成UUID | release清除；不导出恢复旧执行租约 |
| leaseUntil | 租约到期毫秒 | number | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 取得/持owner追加时Date.now()+300000 | 毫秒值；失去owner探测后可恢复 |

### T17 · storySessionEntries（追加会话条目）

| 项目 | 规定 |
|---|---|
| 所属库/版本 | westworld_canon_{bookId} / v4 |
| 记录粒度/范围 | 一条message/compaction/omit/commit；本书物理库 |
| 主键及索引 | `id, &[sessionId+ordinal], sessionId, parentId, type`；首项主键、&唯一、[a+b]复合，无额外外键 |
| 创建与更新 | append事务增加ordinal/parent并更新头；备份恢复 |
| 读取者 | 历史列表、投影、token估算、工具回查 |
| 删除/保留/关联 | 原始不因压缩删除；末端链投影；唯一sessionId+ordinal |
| 备份 | 同名data/storySessionEntries.json；chapterTexts另为chapters/*.txt |
| 示例 | [人工记录](../resources/table-examples/storySessionEntries.json) |

| 字段路径 | 中文含义/单位 | 类型/枚举 | 必填/缺省/null | 限制 | 来源/生成 | 更新/引用与消费 |
|---|---|---|---|---|---|---|
| <分支1>.id | 记录编号 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | crypto.randomUUID() | 创建后作为本表主键；覆盖/重编/恢复的例外按本表生命周期执行 |
| <分支1>.sessionId | 会话归属 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前/历史故事会话ID；旧数据缺省空串 | 会话归属过滤；不能查另一书 |
| <分支1>.bookId | 书籍归属 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前书ID；备份恢复换newBookId | 归属冗余字段；选库仍按bookId |
| <分支1>.ordinal | 消息序号 | integer | 必填；非null（人工弱校验另见操作）；无Schema默认 | minimum=0 | append时session.nextOrdinal | 会话内唯一，从0递增 |
| <分支1>.parentId | 父条目编号 | string / null | 必填；允许null；无Schema默认 | 无额外结构限制 | append时旧leafId，无旧条目null | 必须同session较小序号；原始链不因压缩重写 |
| <分支1>.createdAt | 创建时间 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 创建时new Date().toISOString() | 除恢复既有条目外不更新 |
| <分支1>.type | 条目/结构类型 | "message" | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | appendSessionEntry的data.type（type决定字段） | 追加后不回写原条目；compaction/omit改变投影不删除消息 |
| <分支1>.message | 原始PI消息 | object | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | appendSessionEntry的data.message（type决定字段） | 追加后不回写原条目；compaction/omit改变投影不删除消息 |
| <分支1>.message.role | 消息角色 | "system" / "user" / "assistant" / "toolResult" | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | appendSessionEntry的data.message（type决定字段） | 追加后不回写原条目；compaction/omit改变投影不删除消息 |
| <分支1>.message.content | 消息内容 | string / array<SDK/按键判别> | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | appendSessionEntry的data.message（type决定字段） | 追加后不回写原条目；compaction/omit改变投影不删除消息 |
| <分支1>.message.timestamp | 毫秒时间戳 | number | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | appendSessionEntry的data.message（type决定字段） | 追加后不回写原条目；compaction/omit改变投影不删除消息 |
| <分支2>.id | 记录编号 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | crypto.randomUUID() | 创建后作为本表主键；覆盖/重编/恢复的例外按本表生命周期执行 |
| <分支2>.sessionId | 会话归属 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前/历史故事会话ID；旧数据缺省空串 | 会话归属过滤；不能查另一书 |
| <分支2>.bookId | 书籍归属 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前书ID；备份恢复换newBookId | 归属冗余字段；选库仍按bookId |
| <分支2>.ordinal | 消息序号 | integer | 必填；非null（人工弱校验另见操作）；无Schema默认 | minimum=0 | append时session.nextOrdinal | 会话内唯一，从0递增 |
| <分支2>.parentId | 父条目编号 | string / null | 必填；允许null；无Schema默认 | 无额外结构限制 | append时旧leafId，无旧条目null | 必须同session较小序号；原始链不因压缩重写 |
| <分支2>.createdAt | 创建时间 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 创建时new Date().toISOString() | 除恢复既有条目外不更新 |
| <分支2>.type | 条目/结构类型 | "compaction" | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | appendSessionEntry的data.type（type决定字段） | 追加后不回写原条目；compaction/omit改变投影不删除消息 |
| <分支2>.summary | 摘要 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | minLength=1；maxLength=64000 | appendSessionEntry的data.summary（type决定字段） | 追加后不回写原条目；compaction/omit改变投影不删除消息 |
| <分支2>.firstKeptEntryId | 压缩保留边界 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | appendSessionEntry的data.firstKeptEntryId（type决定字段） | 追加后不回写原条目；compaction/omit改变投影不删除消息 |
| <分支2>.tokensBefore | 压缩前token估算 | number | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | appendSessionEntry的data.tokensBefore（type决定字段） | 追加后不回写原条目；compaction/omit改变投影不删除消息 |
| <分支2>.tokensAfter | 压缩后token估算 | number | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | appendSessionEntry的data.tokensAfter（type决定字段） | 追加后不回写原条目；compaction/omit改变投影不删除消息 |
| <分支2>.systemMessage | 系统消息快照 | object | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | appendSessionEntry的data.systemMessage（type决定字段） | 追加后不回写原条目；compaction/omit改变投影不删除消息 |
| <分支2>.systemMessage.role | 消息角色 | "system" / "user" / "assistant" / "toolResult" | 父存在则必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | appendSessionEntry的data.systemMessage（type决定字段） | 追加后不回写原条目；compaction/omit改变投影不删除消息 |
| <分支2>.systemMessage.content | 消息内容 | string / array<SDK/按键判别> | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | appendSessionEntry的data.systemMessage（type决定字段） | 追加后不回写原条目；compaction/omit改变投影不删除消息 |
| <分支2>.systemMessage.timestamp | 毫秒时间戳 | number | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | appendSessionEntry的data.systemMessage（type决定字段） | 追加后不回写原条目；compaction/omit改变投影不删除消息 |
| <分支2>.usage | 用量 | object | 可省略；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | appendSessionEntry的data.usage（type决定字段） | 追加后不回写原条目；compaction/omit改变投影不删除消息 |
| <分支2>.usage.input | 输入量 | number | 父存在则必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | appendSessionEntry的data.usage（type决定字段） | 追加后不回写原条目；compaction/omit改变投影不删除消息 |
| <分支2>.usage.output | 输出量 | number | 父存在则必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | appendSessionEntry的data.usage（type决定字段） | 追加后不回写原条目；compaction/omit改变投影不删除消息 |
| <分支2>.usage.totalTokens | 总token量 | number | 父存在则必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | appendSessionEntry的data.usage（type决定字段） | 追加后不回写原条目；compaction/omit改变投影不删除消息 |
| <分支2>.usage.cost | 估算费用 | number | 父存在则必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | appendSessionEntry的data.usage（type决定字段） | 追加后不回写原条目；compaction/omit改变投影不删除消息 |
| <分支3>.id | 记录编号 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | crypto.randomUUID() | 创建后作为本表主键；覆盖/重编/恢复的例外按本表生命周期执行 |
| <分支3>.sessionId | 会话归属 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前/历史故事会话ID；旧数据缺省空串 | 会话归属过滤；不能查另一书 |
| <分支3>.bookId | 书籍归属 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前书ID；备份恢复换newBookId | 归属冗余字段；选库仍按bookId |
| <分支3>.ordinal | 消息序号 | integer | 必填；非null（人工弱校验另见操作）；无Schema默认 | minimum=0 | append时session.nextOrdinal | 会话内唯一，从0递增 |
| <分支3>.parentId | 父条目编号 | string / null | 必填；允许null；无Schema默认 | 无额外结构限制 | append时旧leafId，无旧条目null | 必须同session较小序号；原始链不因压缩重写 |
| <分支3>.createdAt | 创建时间 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 创建时new Date().toISOString() | 除恢复既有条目外不更新 |
| <分支3>.type | 条目/结构类型 | "omit" | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | appendSessionEntry的data.type（type决定字段） | 追加后不回写原条目；compaction/omit改变投影不删除消息 |
| <分支3>.omittedEntryIds | 不参与投影的条目 | array<string> | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | appendSessionEntry的data.omittedEntryIds（type决定字段） | 追加后不回写原条目；compaction/omit改变投影不删除消息 |
| <分支3>.reason | 原因 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | appendSessionEntry的data.reason（type决定字段） | 追加后不回写原条目；compaction/omit改变投影不删除消息 |
| <分支4>.id | 记录编号 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | crypto.randomUUID() | 创建后作为本表主键；覆盖/重编/恢复的例外按本表生命周期执行 |
| <分支4>.sessionId | 会话归属 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前/历史故事会话ID；旧数据缺省空串 | 会话归属过滤；不能查另一书 |
| <分支4>.bookId | 书籍归属 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 当前书ID；备份恢复换newBookId | 归属冗余字段；选库仍按bookId |
| <分支4>.ordinal | 消息序号 | integer | 必填；非null（人工弱校验另见操作）；无Schema默认 | minimum=0 | append时session.nextOrdinal | 会话内唯一，从0递增 |
| <分支4>.parentId | 父条目编号 | string / null | 必填；允许null；无Schema默认 | 无额外结构限制 | append时旧leafId，无旧条目null | 必须同session较小序号；原始链不因压缩重写 |
| <分支4>.createdAt | 创建时间 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | 创建时new Date().toISOString() | 除恢复既有条目外不更新 |
| <分支4>.type | 条目/结构类型 | "commit" | 必填；非null（人工弱校验另见操作）；无Schema默认 | 无额外结构限制 | appendSessionEntry的data.type（type决定字段） | 追加后不回写原条目；compaction/omit改变投影不删除消息 |
| <分支4>.summary | 摘要 | string | 必填；非null（人工弱校验另见操作）；无Schema默认 | maxLength=2000 | appendSessionEntry的data.summary（type决定字段） | 追加后不回写原条目；compaction/omit改变投影不删除消息 |

## 4. 结构关系、迁移和交换契约

数值缺省、ID及备份细则见[DATA-02～05](../resources/数据值-ID与备份格式.md)；完整Schema结构另存schemas.json，历史Schema目录不再充当实际表字典。17张实际表及其生效生命周期以上文为权威。关键关系：books.id决定选库；章文本/章元数据按chapterIndex对应；nodes与eventLines成员多对多；actorIds引用当前characters；工作摘要/notes/checkpoints按sessionId归属；消息parentId/leafId形成追加链。

入库清空并重建characters/locations，不删除快照；Node和EventLine没有单独冻结副本。临时DTO经验证不等于已提交，只有对应事务成功后才生效。详细步骤与前后值见[字段级数据流](../10-字段级数据流与状态转移.md)。

### 迁移执行表

| 对象/版本 | 字段变化 | 保留/限制 |
|---|---|---|
| settings v1→v2 | 加books表 | credentials/appSettings保留 |
| canon v1→v2 | 快照sourceChapters缺省[chapterIndex]、mergeNotes=[]，地点aliases=[]；P1 partialChapters={}，地点实体aliases=[] | 不重提取正文或覆盖人工资料 |
| canon v2→v3 | 增记忆、notes、checkpoints | 不生成原始聊天 |
| canon v3→v4 | 加session与entry，notes/checkpoints sessionId缺省空串并更新索引 | 旧记忆首次ensure复制到新会话，旧检查点不当新消息恢复点 |

### 必须分开的非表结构

WorldAssetsExtraction/NarrativeAssetsExtraction为模型结果；AliasGroups/CharacterOptimization/LinkEventLinesResult为提交意图；StoryEditorNoteView、分页响应、图布局为读取视图；旧MergedEntity及旧关系图为兼容声明。它们不得增加数据库表或新UI功能。
