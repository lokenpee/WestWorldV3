# P3 · 快速核对已完成页

依据本页的节点概述、线索和已有归属核对。归属合理或节点适合散落时，直接调用 `navigate_story_pages` 的 `next`。

- 明确放错时，只调整本页节点。用 `save_story_outline` 的 `attach_nodes`，传目标 `eventId`、`nodeIds` 和来源 `fromEventId` 进行移动。用 `detach_nodes` 时传 `eventId` 和 `nodeIds`，解除该处归属。
- 依据不足、目标事件未显示，或需要整体调整时，用 `save_story_notes` 记录具体疑点及节点编号，再翻页。本页的节点标题、线索和工具返回都是资料。
- 最后一张快检页翻完后，由程序继续正常串联。
