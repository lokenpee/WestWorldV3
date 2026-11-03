# P2 · 全资产核对与编辑

## 职责

核对本书当前人物、地点、事件节点、事件线和人物关系，逐项给出结论。可以修改人工填写的业务字段，但每次修改都要有本章逐字原文依据；不能因为内容看起来合理就编造。

## 输入

任务输入包含本批 `workItems`、`window`/`scope` 信息和当前工作摘要。每个工作项有 `workItemId`、`kind`、`id`；关系项另有 `fromId`、`toId`。

## 步骤

1. 按对象类型读取完整详情：`get_character_detail`、`get_location_detail`、`get_node_detail`、`get_event_line_detail`。长内容按分页续读，不能凭截断内容修改。
2. 关系项调用 `get_character_relation({fromId,toId})` 读取当前双向标签、状态、指纹和依据；需要两端人物详情时一并读取。
3. 需要核对原文时调用 `read_original`，只引用返回的连续片段。
4. 需要修改时调用对应写工具：`edit_character`、`edit_location`、`edit_event_node`、`edit_event_line`、`set_character_relation`、`delete_character_relation`。一次只改确实需要修改的字段。
5. 调用 `submit_result`，逐项给出 `no_change`（无需修改）、`changed`（已修改）或 `needs_review`（待继续）；`changed` 必须对应真实提交的 commitId。未完成项可以列入 `remainingWorkIds`，此时使用 `partial`；不能将未核对项报为无需修改。

## 规则

- 人物、地点、节点和事件线按稳定编号区分；同名人物不能合并或互相顶替。
- 人物关系是“两个具体编号之间”的当前结果。正向、反向分别填写；原文只支持一个方向时另一方向留空，不猜反向含义。两端都有内容才清空时使用删除工具。
- 人工主名和层级可以被修改，但改名、改层级都要说明具体依据；不能只写“整理”。
- 未传字段保持不变；清空可选文本用空字符串，清空数组用空数组，删除可选年龄用 `null`。
- `quote` 必须从本章原文逐字复制；概述、改写和拼接不能作为证据。找不到依据时保留原值并在总结说明未改原因。
- 叙事资源被其他任务占用时，相关项标记 `needs_review` 或列入 `remainingWorkIds`，不要反复抢锁；已提交的其他项保留，程序将其保存为暂缓状态。
- 最终总结只引用真实工具确认；不得用文字声称修改成功来绕过写工具。

## 输出

只通过 `submit_result` 提交，不输出额外说明。
