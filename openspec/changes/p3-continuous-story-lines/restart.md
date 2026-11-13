# REQ-026 P2/P3重新开始与完成结果复用

## 用户原意与确认

用户关心暂停期间更新程序是否生效，以及取消后重新开始能否跳过已经处理的资产。2026-11-13用户明确确认：“按这个规则做”：弹出“复用已完成结果 / 全部重新整理”，默认选择复用；只跳过同一步骤完成且内容未变的对象，新增、变更、失败和待核对项继续处理；查重新人物仍比较旧目录。范围为当前P2三步和P3串联/复核入口，沿用REQ-019、REQ-025成果；大型需求，任务见[5](tasks.md)。

## 实施方法与影响

| 需求 | 当前→目标 | 模块与任务 | 验收 |
|---|---|---|---|
| REQ-026 | P2重新开始全部待处理→可复用逐人成果 | world/organization、reuse、identityCandidates；5.1 | 同一步骤、业务指纹匹配才复用 |
| REQ-026 | P3重新开始沿用原轮→显式新轮及范围选择 | story/readingService、reading、reuse；5.1 | 取消后选范围，新run保留已存线；全量重查 |
| REQ-026 | UI无范围选择→共用选择弹窗 | WorldPanel、StoryPanel、RestartDialog；5.2 | 默认聚焦复用，取消不启动；继续不弹窗 |
| REQ-026 | 暂停更新后可能携带旧上下文→当前system与模型业务投影 | agents/runtime、compaction；5.2 | 刷新加载新版后继续，旧原文不再投给模型 |

当前P2三步处理人物；地点的既有机械整理及旧优化内容指纹保持原入口含义，不新增地点AI步骤。

## 字段变化

- P2 pipelineRuns.organization：可选identityChecks数组，每项{id:string,fingerprint:string}；next完成页后记录逐人业务指纹。复用时保存仍有效凭据，候选待人工核对成员不跳过。旧无凭据扫描重新检查。
- P2 profileItems/relationItems：沿用status/outcome/contentFingerprint/uncertainFields/lastError及pairChecks；复用增加可选reused:boolean。只复制checked且changed/no_change、无失败和疑点且指纹一致的记录。organization.reusedCount可选非负整数，启动计算供UI显示。
- P3 pipelineRuns.storyReading[phase]：新增可选checks和reusedChecks数组，元素{type,id,fingerprint}。node_page逐节点，line_summary逐整线；分段和事项页不提前标为整线完成。checks由next完成时保存，reusedChecks是新轮复用来源；页面构建过滤仍有效的复用项。
- 指纹覆盖业务内容及相关原章；P3整线包含成员节点内容，忽略revision、updatedAt及备份书籍/会话身份。活动疑点关联对象不复用。历史已完成页先用已有完整页指纹与原章指纹核验，才能生成逐项凭据。
- 上述字段默认缺省；旧书无需迁移，无新表；整书备份随pipelineRuns保存，Schema允许P2新增字段。资产与已保存事件线不删除。

## 数据流转

启动服务读同书历史运行→按步骤选择最新逐项结果→核对完成/疑点/内容指纹→新轮保存复用结果与剩余队列→模型仅收到剩余工作对象，但可检索全库→实际完成后更新凭据。最新失败或未完成结果优先，不能复活更早成功。

例：资料步骤A已完成、B存疑、C失败；重启前A内容未变，新加D。选择复用后跳过A，处理B/C/D。关系步骤的A不会因为资料步骤完成而跳过。查重时D仍能搜索A并形成待人工合并组。P3前页N1/N2已完成，N2概述改变，则只复用N1，N2继续处理；加入事件线但尚未翻页的N3仍待处理。

## 触发逻辑

- 暂停后的继续：保留原run，不询问范围，不自动启动后续阶段。程序更新需刷新页面加载新bundle；恢复使用当前Prompt/工具，保留进度。
- 有历史的重新开始：先弹窗；取消不改状态。选择后取得既有租约并开新run，复用作为推荐选项。全量指重新检查当前阶段，保留业务成果和人工合并结论。
- 无历史首次启动：直接启动。运行中阻止重复启动，失败保留已成功提交及完成位置。
- 全书复核仍以前序串联完成为前置；重新复核只重建复核阶段，不重置串联成果。

## 接手与验收

入口[提案](proposal.md)、[设计](design.md)、[Agent差异规格](specs/agent-session/spec.md)，技术契约为docs/v2/05与11。运行npm run test:unit、typecheck、build及治理检查。固定样本覆盖三个人物+新增人物、11节点部分完成、单项变更、疑点、全量、旧页、备份换书籍、取消与恢复；生产浏览器点击两个选项并核对请求次数。结果写入acceptance.md，用户验收前保持活动变更。
