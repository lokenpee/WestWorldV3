# 简化事件线保存（已确认）

## 用户原意

2026-11-13，用户已确认[节点输入与原文权限方案](lightweight-input-discussion.md)，进一步指出save_story_lines字段复杂、输出冗长、消耗大量token。希望本质上填写事件线包含的节点，再概述整条线，最多增加理由。本项沿用REQ-025，与已确认输入调整一起实施；本文件是待确认的输出接口建议。

## 当前实现

当前save_story_lines参数Schema的紧凑JSON约5590字符，create/append/update/merge四个分支重复声明相同字段。新建强制action、title、nodeIds、cause、process、result、lineStatus；另外声明reason、evidenceNodeIds、confidence、processAppend、processEdits。既扩大每次请求的工具定义，也引导模型重复撰写各段。

## 建议行为

- 核心内容收敛为title（名称）、nodeIds（节点）、summary（事件线概述），reason可选。概述用一小段交代共同事件、关键承接和当前进展，节点保留具体剧情；不重复复述每个节点，不设输出长度硬校验。
- 使用单份操作对象定义，action区分create/append/update/merge。lineId仅定位已有线，mergeLineIds仅合线时填写；不再重复四份字段Schema。
- create填写名称、节点、概述。append填写原lineId和本次新增节点，旧成员由程序保留；summary提供时替换为当前整线概述，省略保留。不重发完整成员，不拼成长篇累积日志。
- update允许修改名称、概述或提供修正后的完整成员；merge沿用原lineId并填写待合并的线编号，程序合并成员，模型可提供统一概述。一个节点仍可属于多条线。
- 模型工具去除cause/process/result、processAppend/processEdits、confidence、evidenceNodeIds及必填lineStatus。已有状态保留，新线沿用open默认值，不按页完成自动推断故事完结；若以后需要AI维护故事状态，再独立确认，不把阅读完成当作故事闭合。
- 返回保存后的事件线编号、实际新增/移除节点数量及简短结果，沿用程序真实提交回执，不回传整条大记录。

## 字段与兼容建议

eventLines增加可选summary:string，由新工具提交概述时赋值，省略保留旧值。模型读取优先使用summary；旧记录尚无summary时，以已有cause/process/result组成兼容说明，保留旧内容。用户界面优先展示概述，旧起因/经过/结果仍可查阅，备份兼容可选字段；不以字符串规则强行把概述拆回三段。排序、章节、时间范围、节点反向归属、版本和命令键继续由程序维护。

该数据/界面取舍已于2026-11-13获用户确认，已纳入正式设计、差异规格及任务4。

## 数据流、触发及验收

模型已读节点概述 → save_story_lines提交节点与简短概述 → 程序按动作新增或保留旧成员、排序及同步反向归属 → 保存概述 → 返回编号和简短回执 → 后页继续向同一lineId追加。全书复核同样围绕已有成员和概述修正归线及承接。

样例：第1章新建三河帮事件线，概述写明隐患；第20章只提交新出场节点与承接后的概述，原第1章节点仍在；第120章追加回收节点，不重复输出前三次全部经过。测量实际发送Schema体积并验证最小新建、增量追加、修改误接、合线、多线共享、旧记录/备份兼容和失败原子性。固定响应检查，不调用真实模型、不修改正式书库。

确认：2026-11-13用户回复“按你说的来”，批准本文件的简短工具、summary字段及旧记录/界面兼容。实施见任务4。
