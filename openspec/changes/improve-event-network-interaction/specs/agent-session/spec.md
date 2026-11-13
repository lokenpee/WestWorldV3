## ADDED Requirements

### Requirement: TRACE-COLLAPSE-01 整理链路默认折叠
系统 SHALL 在 P2/P3 整理详情中默认收起每条消息、API 请求及嵌套折叠内容；展开 assistant 可查看回复及工具调用。折叠不改变实际消息记录及投影。

#### Scenario: 初次打开与重新打开
- **WHEN** 打开整理详情或展开请求中的下一级折叠框
- **THEN** 新出现的折叠框默认收起，用户可逐项展开查看正文；关闭详情重开恢复默认。

#### Scenario: 实时刷新
- **WHEN** 已手动展开消息后新消息或用量到达
- **THEN** 保留原消息的展开状态，新消息默认收起。
