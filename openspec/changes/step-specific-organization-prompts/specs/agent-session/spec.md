## ADDED Requirements

### Requirement: AGENT-SCOPE-01 工作项提示词与工具快照
系统 SHALL 在每次 P2 模型运行开始时按当前工作项快照选择 System Prompt、默认工具集和消息上下文；提示词和工具集不得把其他步骤的完整操作手册或专用完成工具带入当前请求。

#### Scenario: 同一人物多轮
- **WHEN** 同一人物的第二步需要多次 API 调用
- **THEN** 每次请求沿用同一 contextId/unitId 和已有消息；不重复创建上下文，不重新装入其他人物或其他步骤的历史。

#### Scenario: 切换人物或步骤
- **WHEN** 当前人物完成或从第二步切换到第三步
- **THEN** 当前运行结束；下一次运行读取持久 step/activeWork，使用新工作项的提示词、工具集和消息；旧工具调用和旧提示词不进入新上下文。

#### Scenario: 最终请求
- **WHEN** 检查某个 P2 请求的最终 streamFunction 输入
- **THEN** 能看到实际 System Prompt、消息和工具 Schema；人物任务 JSON 只有一份；不出现配置层未发现的重复或其他工作项残留。

#### Scenario: 工作项版本
- **WHEN** 同一人物先 submit_profile_review(done=false)，随后补查、编辑或合并，再提交 done=true；或另一个操作把人物版本从 156 改为 157
- **THEN** 本次工作项自己的成功写库会更新 dataVersion/targetId 且不重排当前项；外部修改或真实冲突必须先重读并核对旧修改，不能只更新版本后重放旧 patch；数据库真实版本仍由提交校验。

#### Scenario: 非 P2 Agent
- **WHEN** 运行 P3 或其他 Agent
- **THEN** P2 的分步提示词、结束规则和默认工具集不外溢；其原有提交、总结和错误恢复行为不变。

### Requirement: AGENT-SCOPE-02 默认工具与跨步骤纠错
系统 SHALL 按当前工作项精简专用完成/进度工具，同时保留跨步骤查询、候选组、合并、资料编辑和关系编辑能力；不能用“默认工具”名义做事实上的硬禁用。

#### Scenario: 第二步发现遗漏
- **WHEN** 第二步处理人物资料时发现其他人物疑似同人、资料错误或关系错误
- **THEN** 仍可使用候选组、merge_assets、资料编辑或关系编辑工具处理；这些操作不能冒充第二步资料提交或其他步骤完成。

#### Scenario: 第三步修正资料
- **WHEN** 第三步整理关系时发现人物资料错误
- **THEN** 仍可查询和修正资料；不得通过跨步骤编辑伪造第二步完成状态，进度和待办保持真实。

### Requirement: AGENT-SCOPE-03 候选工作项
系统 SHALL 允许第二、三步保存的新疑似组以 candidate 工作项在当前轮次继续处理；候选提示词和工具由工作项类型选择，而不是只由 organization.step 决定。

#### Scenario: 后续候选
- **WHEN** 第三步当前人物保存了一个 pending 候选组，系统插入 candidate 工作项并提交结论
- **THEN** `submit_result` 只结束 candidate 工作项，不推进主步骤或结束原人物；候选工作项完成后回到原第三步人物/上下文，原进度和待办保留。
