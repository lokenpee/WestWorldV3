## ADDED Requirements

### Requirement: P2-LOW 人物整理使用低档思考
系统 SHALL 在正式P2识别人物、整理人物资料及整理人物关系的请求中选择low思考级别，并保留原生思考采集。

#### Scenario: 第二三步发起与继续
- **WHEN** 启动或继续人物资料、关系整理，选择支持思考的DeepSeek模型
- **THEN** 最终请求为reasoning_effort=low且thinking启用，不能因逻辑medium被映射到high。
