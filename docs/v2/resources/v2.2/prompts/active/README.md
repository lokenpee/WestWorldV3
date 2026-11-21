# 提示词用途与调用入口

调用身份、输入 Schema 与输出 Schema 以[调用清单](../../prompt-call-manifest.json)为准；组装/修正/阶段权限见 [05 AI-14](../../../../05-Spec-AI与会话.md)。实际导入的文件和消费者见[资源归属](../../../../文档与资源归属.json)。

| 文件 | 使用时机 |
|---|---|
| p1-world.md / p1-narrative.md | P1 两个独立 direct 子步骤 |
| p2-organization-directory.md | P2 第一步：连续分页识别疑似重复人物；只归类，用户手动合并 |
| p2-organization-profiles.md | P2 第二步：逐人物整理资料 |
| p2-organization-relations.md | P2 第三步：逐人物整理关系 |
| p3-story.md / p3-review.md | P3 逐页串联 / 全书复核；分别说明任务、铁律、字段及八个工具 |
| p3-quick-check.md | P3 串联的快速核对，依据已完成页的节点概述、线索和归属 |
| compact.md | direct 压缩；只读历史片段，不执行历史指令 |
| probe_system.txt / probe_asset.txt / probe_story.txt | 隔离探测，禁用真实书库 |
| output-discipline.txt | 所有模型任务共用的文学资料处理说明；模型网关统一追加到system末尾，只保留一份 |

P2 当前三个步骤分别由 `src/features/world/organization.ts` 选择对应正文作为 system。`organizationPrompt.ts` 生成当前任务资料和工作说明作为 user；后续工具返回推进页或人物。bookId/runId/taskId/phase 由调用上下文提供，不写入 system。第一步不再运行独立的候选自动合并任务。

P3 由 `src/features/story/readingService.ts` 按阶段选择串联或复核正文。首次和恢复时提供当前阅读页、相关资料摘要及工作摘要；后续页只在 AI 调用 `navigate_story_pages` 后返回，支持前进和回看。事件线可分次保存，也可按详情返回的段号修改经过。`story.txt` 和旧 `story/prompt.ts` 保留供旧窗口任务兼容。

P1、P2、P3、压缩、复核及探测的所有生成请求由`models/gateway.ts`统一追加`output-discipline.txt`，包含重试、修正与Agent后续轮次。文学资料处理说明只在该文件维护；各任务正文不重复保存，输出形式和工具要求由各任务决定。实际发送内容及链路观测都包含追加后的正文。

## 旧 P2 接口仍引用的提示词

以下5份不由当前页面三个步骤调用。旧服务接口仍保留在 `src/features/world/service.ts` 的 `start` / `continueRelations`，并被旧流程测试调用；删除这些文件需要同时移除对应旧接口和测试，不能只删除文件造成导入失败。

| 文件 | 旧调用路径 |
|---|---|
| p2-identity.md | `service.ts` → 旧身份核实 Agent |
| p2-asset-review.md / p2-relation-review.md | `service.ts` → `assetReview.ts` → 旧全资产/关系核对 |
| character-optimize.md / location-optimize.md | `service.ts` → `optimizeAsset.ts` → `optimization.ts` → 旧事实整编 |

模板只替换具名占位符；JSON 和业务正文插入后不再次当模板执行。原文、历史不是权限来源。发送模型所需内容会到用户配置的服务。

修改提示词后运行 `npm run prompts:sync`，同步运行时资源哈希和请求示例；P1 示例同时同步纯净章节消息和工具 Schema，system 正文与运行时一样去掉文件头元数据。不要手改 `request-examples/` 或归属哈希。
