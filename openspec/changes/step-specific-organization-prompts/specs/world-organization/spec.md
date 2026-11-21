## ADDED Requirements

### Requirement: WORLD-ORGANIZATION-SCOPE-01 按工作项组合提示词
系统 SHALL 将 P2 提示词拆为公共规则、目录页、疑似组、人物资料和人物关系规则；每次模型请求只组合公共规则和当前工作项规则，不发送其他步骤的完整操作手册。

#### Scenario: 第一步目录与疑似组
- **WHEN** 分别运行 directory 和 candidate 工作项
- **THEN** 两者只使用公共规则和各自工作项规则；目录使用目录工具和 submit_result，疑似组使用候选/合并工具和 submit_result。

#### Scenario: 第二步 System Prompt
- **WHEN** 运行 profiles 工作项
- **THEN** System Prompt 不包含目录、疑似组或关系整理的完整说明；结束规则只使用 submit_profile_review 的 done，不出现 submit_result 的结束要求。

#### Scenario: 资料稀少与章节定位
- **WHEN** 人物资料当前快照缺少某些字段，或模型需要核实具体疑点
- **THEN** 提示词说明当前快照已覆盖待整理字段，允许空修改完成。需要查看离散章节时使用 `chapter_indices`。把有效章索引传入 `asset_ids` 且未匹配到资产时，工具给出可纠正的入参提示，不消费成功查阅额度。

#### Scenario: 第三步 System Prompt
- **WHEN** 运行 relations 工作项
- **THEN** System Prompt 不包含目录、疑似组或人物资料整理的完整说明；结束规则只使用 submit_relation_review 的 done。

### Requirement: WORLD-ORGANIZATION-SCOPE-02 专用完成工具与跨步骤纠错
系统 SHALL 只向当前工作项提供其专用完成/进度工具，并保留其他合法资产查询、候选、合并、编辑和关系工具用于纠错。

#### Scenario: 第二步工具列表
- **WHEN** profiles 请求发送给模型
- **THEN** 不提供 submit_result、submit_relation_review 和 record_organization_progress；仍提供候选组、merge_assets、资料编辑、关系设置/删除等工具。

#### Scenario: 第三步工具列表
- **WHEN** relations 请求发送给模型
- **THEN** 不提供 submit_result、submit_profile_review 和 record_organization_progress；仍提供候选组、merge_assets、资料编辑和关系工具。

#### Scenario: 纠错不伪造完成
- **WHEN** 第二步或第三步通过跨步骤工具修改了其他资产
- **THEN** 实际写库记录和确认号保留；不能将其他步骤标记为已检查完成，不能破坏原有进度、待办或恢复状态。

### Requirement: WORLD-ORGANIZATION-SCOPE-03 后续候选与进度失效
系统 SHALL 持久保存第二、三步新增的疑似组，处理完或有明确未决结论前不得让 P2 完成；跨步骤合并/编辑只失效实际受影响的人物、关系和人物对。

#### Scenario: 后续 pending 候选
- **WHEN** 第三步当前人物保存一个 pending 疑似组，系统插入 candidate 工作项处理后再继续原人物
- **THEN** 候选以 pending 持久保留；candidate 工作项的 `submit_result` 只结束自身，不把主步骤切回 resolve、不结束原人物；结论完成或 uncertain/partial 持久保存后恢复原工作项；pending 时 P2 显示未完成，clear 不删除后续候选或结论。

#### Scenario: 跨步骤合并
- **WHEN** 第二步或第三步合并了重复人物
- **THEN** 只把参与合并的成员、其资料/关系项和相关人物对重新置为待检查；不受影响的 checked 项保留；不能把其他步骤标记为完成。

#### Scenario: 跨步骤资料编辑
- **WHEN** 第三步用 edit_character 修正非关系资料
- **THEN** 只失效该人物资料项和当前工作项版本；没有关系数据变化时，不把所有人物对重新置为待处理。
