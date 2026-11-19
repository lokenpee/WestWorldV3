## ADDED Requirements

### Requirement: LOCAL-KEY-01 本机凭据保存
系统 SHALL 在本机加密保存服务商密钥，重新启动后可继续使用；书籍导出及日志 SHALL 排除密钥。

#### Scenario: 密钥跨启动保留
- **WHEN** 保存模型配置及密钥后关闭浏览器并重启服务
- **THEN** 配置仍为已配置状态，可解析原服务商凭据，书籍导出不包含密钥。
