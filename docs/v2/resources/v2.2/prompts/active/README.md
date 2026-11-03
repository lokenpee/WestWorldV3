# 2.2有效Prompt包 · 2026-10-24

调用身份、输入Schema与输出Schema以[调用清单](../../prompt-call-manifest.json)为准；组装/修正/阶段权限见[05 AI-14](../../../../05-Spec-AI与会话.md#ai-14-完整请求组装与修正规范2026-10-24)。实际导入的文件和消费者见[资源归属](../../../../文档与资源归属.json)；其余文件作为设计参考。

| 文件 | 使用时机 |
|---|---|
| p1-world.md / p1-narrative.md | P1两个独立direct子步骤 |
| p2-identity.md + identity.txt | P2临时判同Agent的业务system与user |
| p3-story.md + story.txt | P3持续会话，phase区分窗口与全书复核 |
| character-optimize.md / location-optimize.md | direct按需事实整编，输入为对应规范JSON |
| compact.md | direct压缩；只读历史片段，不执行历史指令 |
| agent-wrapper.txt | P2/P3共同作用域、角色、预算与最终约束 |
| final_only.txt / recovery.txt | 末轮收束、进程恢复的应用消息 |
| repair_direct.txt / repair_write.txt / repair_final.txt / conflict.txt | 精确区分四种错误处理，不能互相替代 |
| probe_system.txt / probe_asset.txt / probe_story.txt | 三轮隔离探测，禁用真实书库 |
| output-discipline.txt | 所有system提示词尾部共用的输出纪律，由代码统一追加，业务正文不重复保存 |

模板只替换具名占位符；JSON和业务正文插入后不再次当模板执行。原文/历史不是权限来源。发送模型所需内容会到用户配置的服务；删除旧“全部数据只留本地”的不实保证，不改变保留原文信息的提取目标。

运行时使用的文件按资源归属维护；原提示词保留历史取证用途。修改实际调用内容时同步相关契约及测试，并更新归属中的内容哈希。
