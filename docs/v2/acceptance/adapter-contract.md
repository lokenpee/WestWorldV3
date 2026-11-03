# 独立验收适配器协议

> **2.1历史资源：** 本文记录变更前实现/验收。2.2阶段、锁、会话、人工合并和新增字段以主文档及resources/v2.2为准；此处旧条款不得覆盖新流程，也不证明新流程已实现。


执行：`node acceptance/suite.mjs --adapter /absolute/path/rebuilt-adapter.mjs`。Node24；suite仅使用Node内置模块和随包固定JSON，不导入原项目，不调用模型网络。

适配器须导出async `createHarness()`，返回：

```typescript
interface Harness {
  reset(): Promise<void>;
  load(seed: {bookId:string; books?:unknown[]; canon:Record<string,unknown[]>}): Promise<void>;
  execute(command:string, args:Record<string,unknown>): Promise<unknown>;
  snapshot(bookId:string): Promise<{books:unknown[];canon:Record<string,unknown[]>}>;
  close?(): Promise<void>;
}
```

reset只能清理测试隔离数据/重置配置；load为前置植入，不可执行被测业务来“修正”输入。snapshot返回实际持久数据的JSON值，去掉undefined；各表默认主键序，storySessions按createdAt升序（并列initial先于review），这是测试观察排序，不改变产品查询规则。

execute必须连接重建应用真实能力，不得为通过测试复制固定答案。所有返回采用JSON边界，顶层undefined保持undefined，其余对象中的undefined字段省略。load/snapshot可由专门测试适配器完成，不要求用户界面暴露任意数据库修改入口。

| command | args | 结果/适配义务 |
|---|---|---|
| split | text, regex? | ChapterDraft[]；有regex须按parse规则构造 |
| parseRegex | value | 正则字符串或原语义错误 |
| import | id,title,text,sourceFileName? | 完整导入结果并持久化 |
| runP1 | bookId,responses[],abortAfterResponse? | 调真实P1，concurrency1，按真实请求消耗responses；额外requests[]记录kind/world/narrative、role、system、messages、schema；指定第n次响应返回前abort |
| runLink | bookId,responses[] | 调真实串联P2，按真实请求消耗；结果附requests；不得直接写最终线/记忆 |
| updateCharacter | bookId,id,patch | 核心人物update，允许profile.ageText点路径 |
| updateNode | bookId,id,patch | 核心节点update |
| setRole | bookId,id,roleWeight | 即时manual层级写入 |
| mergeCharacter | bookId,keepId,mergeIds | 真实手动并入 |
| deleteNode/deleteLine/deleteBook | bookId,id? | 删除与传播边界实际执行 |
| publish | bookId | 入库结果及实际实体/引用变化 |
| resolveName | entries:[{id,names}],name | 实际名称解析，未命中返回undefined |
| saveKey/keyConfigured | key? | 仅保存测试Key并查询状态；不触真实用户凭据 |
| tool | bookId,name,args | story_editor工具集执行，默认sessionId=''；按实际工具JSON返回 |
| validateLink | bookId,proposal | 引用/引文错误数组，读当前节点/线 |
| backupRoundTrip | bookId | 调真实导出/预检/恢复，返回inspect/newTitle/originalStillExists/sameBookId/restoredCounts；新书不可覆盖原书 |
| inspectInvalid | kind:notZip/missingManifest/newer/missingStats | notZip=[0,1,2]；missingManifest为空ZIP；newer为formatVersion999有效manifest；missingStats为版本4但缺统计文件，保留异常拒绝分支；返回真实预检 |
| windows | count,splitChapter? | 按1..count构造order递增章节，指定原章换成.1/.2，再调用窗口函数 |
| groups | records,kind | 实际两轮聚组，地点禁包含；输出first/second分组 |
| frequency | entities,texts | 在传入实体上运行真实统计，返回实体数组 |
| newSession | bookId,newReview? | ensure结果{bookId,id} |
| sessionWithMessages | bookId,chars | ensure/取得租约/追加3条user消息（每条甲重复chars次，timestamp0/1/2）/释放，返回ref |
| compact | bookId,id,summary?/summaryFailure? | 8192窗口force压缩，summary替身返回固定摘要或失败；实际追加compaction，返回compactions/originalMessageCount/summary |
| agentHttp | bookId,script:[{tool,args}] | 测试Key，真实SDK/Agent，固定answer:string提交Schema，asset_editor；仅拦HTTP按script返回SSE；返回result/requestCount |

agentHttp系统为“核对测试样本后提交answer字符串。”，用户消息“核对当前节点。”timestamp0。每个SSE回合依次：assistant reasoning_content“核对测试样本。”、function tool_call、finish_reason tool_calls及usage input100/output30；最后[DONE]。tool-call-id可归一化。完整原始请求/脚本示例在resources/replays。

cases.json里的`$ref:[变量名,...路径]`读取先前saveAs结果，用于连接随机sessionId；checks支持equals/length/match/exists/includes。匹配预期只读固定JSON，不在验收时调用原算法计算答案。

本目录的51个场景包含13个工具成功/非法参数场景；成功返回预期一次性从参考应用录制后冻结。`evidence/baseline.adapter.ts`仅用于证明参考应用满足这些预期，**不属于重建实现或独立验收依赖**。第三方只提供自己的adapter即可运行suite；不能把baseline.adapter路径换成原应用再声称重建已验收。

验收范围为本目录的服务/数据/协议场景。浏览器像素、文件目录授权、真实外部模型质量、完整多标签竞争和未列出的异常需按文档另验；51个通过不能扩张为全部应用等价证明。

### 实际流水线HTTP适配

`pipelineHttp`参数为bookId、stage(p1/link)、script。使用真实P1或runLink/P2，不注入业务层call替身；仅在HTTP端按script返回与agentHttp同格式SSE。返回{result,requestCount}，实际数据库由snapshot独立读取。P33/P34/P35分别使用实际01/02、04和引用修正消息，输出回放在resources/replays。不得直接按script.args替换最终数据库。
