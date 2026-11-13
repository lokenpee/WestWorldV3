# 实施设计

对应[提案](proposal.md)及[任务4、5](tasks.md)。当前P3采用story_pages_v3，当前业务协议为六工具；历史story_lines_v2参数保留在legacyParameters，不发送给当前模型。重新开始见[复用设计](restart.md)。

## 模块与接口

reading/readingService负责分页、阶段和恢复；agents/tools、queries、commands与storyCommands负责工具读写。story/views集中定义模型业务视图，runtime和compaction复用该视图。参数与返回唯一正文在[工具契约](../../../docs/v2/11-AI工具返回与回放契约.md#p3-完整事件线工具)。

直接声明search_story_context、get_story_detail、save_story_lines、save_story_notes、navigate_story_pages、finish_story_batch。当前执行器不开放read_original、add_story_nodes或旧综合提交接口。查询只给节点编号、名称、完整概述和章节位置；详情增加详细经过，按正文字符分页。事件线只给编号、名称、概述、成员与状态。存储版本、指纹、证据和章节正文留在程序。

## 字段变化

| 对象及位置 | 改动及约束 | 赋值、读取及兼容 |
|---|---|---|
| eventLines.summary | 新增可选字符串，整条事件线概述；无字数或逐字校验 | 模型保存或人工编辑赋值，详情与编辑器读取；旧数据缺省时合并原起因、经过、结果供查询，原字段保留；备份Schema允许可选字段 |
| save_story_lines.operations | 当前模型输入为action、lineId、title、nodeIds、summary、reason、mergeLineIds | create需名称、成员及概述；append仅追加本次成员；update提供成员时为完整集合；merge合并引用的线。省略概述保留，提供时替换。旧接口参数在历史路由保留 |
| get_story_detail | 文本使用char_offset/maxChars，成员使用memberOffset/memberLimit | 返回nextCharOffset、nextMemberOffset；节点正文不切成JSON碎片；当前协议不再提供processSegment |
| pipelineRuns.storyReading | 继续保存分阶段pages/currentPageId/receipts，页包含fingerprint、checkedFingerprint和sourceFingerprints | 导航事务保存，恢复核验内容与关联章节；旧覆盖凭据核验后可迁入；备份保留。新增逐项复用凭据见restart.md |
| 资产修改记录和命令回执 | 沿用已有结构，记录summary实际前后值 | 保存事务生成，详情按对象显示；commitId表示命令已确认，changed表示确有改动，不代替页完成 |

节点和事件线仍是多对多；没有新表和数据库版本迁移。旧起因、经过、结果继续保存，编辑器将其放在可展开区域。原始链路日志保留；模型续跑和压缩只读取轻量视图，system使用当前版本。

## 数据流转

1. 首次启动读取节点，按章节顺序提供最多10项、约4000估算Token的业务目录；预算按投影后的资料计算。
2. 模型可直接按目录建立关联。实际提供的对象由程序登记读取指纹；无需再逐个调用详情。按需搜索旧线或读取节点详细经过。
3. 保存工具核对引用、实际读集、版本和执行权，同事务保存事件线、派生章节和时间范围、节点反向引用及真实修改记录。一项失败整批回滚。
4. 保存不翻页。next登记该页完成后返回后续页，previous仅回看。空修改也可翻页；重放相同导航回执不重复推进。
5. 全书复核依次提供孤立节点、每条线的成员段、整线概述及未解决或依据变化的线索。未解事项可保留，阶段完成不自动改变故事状态。

例如第1章N1创建L1：title“三河帮隐患”、nodeIds=[N1]、summary“传闻埋下帮派冲突伏笔”。第20章N2回应伏笔时，append只填lineId=L1、nodeIds=[N2]，可更新summary为“传闻中的帮派正式介入，早期冲突开始兑现”。保存后成员为[N1,N2]，旧编号和其他事件线归属保留。程序同步章节和时间位置，不要求模型填写派生字段。

## 触发逻辑

| 触发 | 前置与顺序 | 成功、取消及失败 |
|---|---|---|
| 首次启动 | 提取完成、模型配置有效、同书无活动租约；取得执行权后提供当前页 | running；不自动启动复核 |
| 继续 | 读取原轮当前位置与已提交成果，刷新后使用新版程序及Prompt | 未完成页继续；失败保留真实已保存结果 |
| 重新开始 | 用户选复用或全量；开新run，保留业务资产和历史 | 仅复用已完成且内容未变的同阶段结果，详见restart.md |
| 保存 | 对象已通过目录、搜索或详情实际提供 | 原子保存；不推进阅读位置 |
| 翻页 | 使用当前阅读状态 | next完成页，previous回看；重复调用不跳页 |
| 复核 | 当前初串阅读完成 | 独立Prompt及相同六工具；不自动关闭未完故事 |

## 验收与接手

使用固定响应、隔离IndexedDB和生产构建浏览器检查；不调用真实模型或修改正式书库。检查入口tests/story-tools.test.ts、story-reading.test.ts、story-reuse.test.ts、organization-reuse.test.ts、tests/browser/story.spec.ts与world.spec.ts。应覆盖目录直接保存、完整概述、正文分页、跨页续接、多线共享、旧字段保留、恢复使用当前提示词、原文工具不可调用、重启复用及全量选择、变化或疑点重新处理、备份换书籍身份。开发结果写入[验收记录](acceptance.md)，用户核对小说副本后再同步与归档。
