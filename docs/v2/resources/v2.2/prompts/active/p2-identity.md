# P2 世界资产判同

## 一、任务与查询

识别当前书籍中重复的人物或地点，核实别名，只合并证据充分的同一实体。每个任务以一个分配资产为核心，可查询其他资产作为候选。

1. 使用 `query_characters` / `query_locations` 分页读取精简档案，根据名称、别名、身份、地点提示、来源章节、revision 和内容指标筛选候选。不默认读取完整描述。
    
2. 存在歧义时，按 ID 调用 `get_character_detail` / `get_location_detail`；需要原文时，使用 `read_original` 的 `asset_ids` 和 `chapter_indices` 定位，按 `segments` 引用章节，必要时使用 `nextCursor` 继续读取。
    
3. 跨页候选先查询后提交。分页使用 `after_id/nextAfterId` 稳定游标，合并删除期间禁止递增 offset。末页核对本任务工作项，未处理项交后续任务。
    

## 二、判同与证据

**准确性优先，证据不足不合并。**

- 同名、名称包含、描述相似或内容较多，均不能单独证明同一实体。
    
- 不同章节可能使用不同称呼，结合身份、关系、时间、场景及原文判断，不凭外部小说常识推断。
    
- 爸爸、姑父、娘娘、太后等通用称谓不作为单独的判同依据；仅有称谓的人物可以保留原主名。
    
- 地点整体、内部区域、相邻地点、同名异地应分别判断。
    
- 允许跨章节、多段证据共同证明身份对应，不要求单条引文包含所有称呼。
    

每组合并必须满足：

- `confidence >= 0.9`。
    
- `evidence` 每项包含 `chapterIndex`、`quote`、`memberIds`，证据成员并集覆盖全组。
    
- 提交前使用 `read_original` 核实来源章节的逐字引文，并确认对应关系。
    

缺少有效证据时保持分开，标记待复核。

## 三、合并提交

先读取合并成员详情及证据，再通过 `commit_asset_changes` 提交：

`{operationKey,payload:{groups}}`

每组包含 `kind`、`keepId`、`memberIds`、`canonicalName`、`reason`、`confidence`、`evidence`。

- `memberIds` 包含 `keepId`，至少两个本次已查询的同类型有效 ID；以 ID 而非名称确定成员。
    
- 保留人工指定的主名和目标；人工主名冲突时标记待选择。无指定时，按编号数字自然顺序保留最早记录。
    
- `canonicalName` 必须是已有称呼，不编造。
    
- 重叠合并组先统一，禁止自并或循环合并。
    
- 由代码执行机械融合，本阶段不压缩长文本。
    
- 只有持久化 `commitId` 才算成功；重试复用 `operationKey`，`alreadyApplied` 不重复提交。
    

没有确定合并时不发送空写命令。

## 四、别名与异常资产

同时核实当前资产的别名：

- `verifiedAliases` 为已有确认的稳定称呼；其他别名按需读取原文。
    
- `keep` 需要已读取的连续原文同时证明别名及主名或此前已核实的称呼；`remove` 需要误归属证据。证据不足不删除。
    
- 每项 `confidence >= 0.9`，填写 `reason` 和 `evidence`；确认指向其他实体时填写已读详情的 `referentId`。
    
- 合并后先重新读取详情，再校对别名。省略别名不代表删除。
    
- 别名确认影响出场统计，错误别名可能影响的事件节点列入待复核报告。
    

通过 `commit_asset_changes` 提交：

`{operationKey,payload:{groups:[],aliasChecks:[{kind,id,decisions:[{alias,decision,confidence,reason,evidence,referentId?}]}]}}`

其中 `decision` 为 `keep` 或 `remove`，证据项包含 `chapterIndex`、`quote`。

多人合称、提取错误、类型错误及无法确认的归属使用 `needs_review`，说明原文依据、涉及的实体 ID 和建议的拆分、删除或纠正动作。

## 五、进度与收尾

优先批量查询候选，避免重复读取。每个任务以 **3 分钟、8 轮模型请求** 为完成目标；收到收尾提醒后停止扩展调查，提交已确认结果，未处理项保留并使用 `partial`。

每个已检查的分配项在 `reviewedItems` 中记录：

- `workItemId`
    
- `outcome`：`changed` / `no_change` / `needs_review`
    
- `reason`
    

未处理项列入 `remainingWorkIds`，两者必须恰好覆盖本任务分配项。新发现的其他资产可查询、修改，但后续工作清单由应用决定。

最后单独调用 `submit_result`，遵循 `AgentTaskSummarySchema`，填写 `status`、`commitIds`、`summary`、`remainingWorkIds`、`reviewedItems`。

最终提交仅总结结果，不再次提交合并操作。`completed` 只表示当前任务完成，不代表整个 run 完成。自动更新的出场频次和层级不代表主动修改身份判断；未检查的资产不得宣称已完成。

工具与最终 Schema 错误遵循现有共用一次修正规则。

运行由 `pi-agent-core` 管理，模型调用使用 `pi-ai`，不读取 P3 持久故事记忆。
