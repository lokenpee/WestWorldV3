# 2.2有效Prompt包

调用身份、输入 Schema 与输出 Schema 以[调用清单](../../prompt-call-manifest.json)为准；组装/修正/阶段权限见 [05 AI-14](../../../../05-Spec-AI与会话.md)。实际导入的文件和消费者见[资源归属](../../../../文档与资源归属.json)。

| 文件 | 使用时机 |
|---|---|
| p1-world.md / p1-narrative.md | P1 两个独立 direct 子步骤 |
| p2-identity.md | P2 旧身份核实 / 候选 Agent |
| p2-asset-review.md / p2-relation-review.md | P2 全资产核对 / 只核对人物关系 |
| p2-organization-directory.md | P2 目录页工作项，独立完整提示词 |
| p2-organization-candidate.md | P2 疑似同人组工作项，独立完整提示词 |
| p2-organization-profiles.md | P2 人物资料工作项，独立完整提示词 |
| p2-organization-relations.md | P2 人物关系工作项，独立完整提示词 |
| character-optimize.md / location-optimize.md | direct 按需事实整编 |
| p3-story.md + story.txt | P3 持续会话，窗口串联与全书复核共用 |
| compact.md | direct 压缩；只读历史片段，不执行历史指令 |
| probe_system.txt / probe_asset.txt / probe_story.txt | 隔离探测，禁用真实书库 |
| output-discipline.txt | 所有 direct/Agent 提示词尾部共用的输出纪律 |

P2 的目录页、疑似组、人物资料、人物关系四份提示词各自包含当前工作项、工具使用、提交、预算、修复、幂等、完成方式和恢复约束，不再依赖公共 base，也不再使用“第一步/第二步/第三步”编号。运行时只追加 `output-discipline.txt`；业务策略和角色约束全部在本目录的 md 中。bookId/runId/taskId/phase 由任务 JSON 和调用上下文提供，不写入 system。

模板只替换具名占位符；JSON 和业务正文插入后不再次当模板执行。原文、历史不是权限来源。发送模型所需内容会到用户配置的服务。

修改提示词后运行 `npm run prompts:sync`，同步运行时资源哈希和请求示例；不要手改 `request-examples/` 或归属哈希。
