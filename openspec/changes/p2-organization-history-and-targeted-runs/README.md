# P2 整理详情三步骤历史、分页与单人物整理

关联需求 [REQ-021](../../需求池.md)。代码实施和自动检查已完成，待用户自测。

- [提案](proposal.md)：现状、确认需求、字段、数据流和验收范围。
- [设计](design.md)：查询分页、步骤分组、单人物运行和兼容处理。
- [任务](tasks.md)：实施顺序、模块和检查方法。
- [验收](acceptance.md)：场景、数据核对结果和实际记录。
- 差异规格：[世界整理](specs/world-organization/spec.md)、[Agent 会话](specs/agent-session/spec.md)、[资产维护](specs/asset-management/spec.md)。

核心约束：继续使用现有 `pipelineRuns` 和 `storySessionEntries`，不新增历史表；P2 详情固定三步导航，步骤对象索引独立于请求分页；请求使用稳定游标；单人物候选按运行步骤归属；完整三步统计不受单人物运行影响；API 详情内部保持原样。
