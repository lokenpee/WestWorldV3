## ADDED Requirements

### Requirement: ORGANIZATION-RELATION-CONTENT-FINGERPRINT 复用关系完成结果
系统 SHALL 在关系整理成功完成后保存提交后的内容指纹，以同一算法判断内容是否变化；写入冲突仍核对版本指纹。

#### Scenario: 完成后立即及重新加载复用
- **WHEN** 人物关系已成功整理且相关资料没有变化，用户选择复用已完成结果
- **THEN** 跳过已完成且无疑点的人物及人物对，重新加载后结论一致。

#### Scenario: 完成后关系或人物资料变化
- **WHEN** 完成记录依赖的关系或人物资料发生变化
- **THEN** 该记录重新待核查，旧错误或缺失指纹不被直接认定为可复用。
