# 数据值、ID与备份格式（2.2规范附件）

当前权威结构见[03](../03-Spec-数据与存储.md)，机器结构见[v2.2/data-contract.json](v2.2/data-contract.json)。人物地点没有草稿/固定副本；提取和后续操作直接写当前实体。

## DATA-02 值与校验

模型提交执行结构/引用校验；人工新增/保存执行必要字段/引文/引用及revision比较。可选字段缺省省略，JSON不导出undefined。人物地点人工无章来源时填写manualSourceNote；节点必须本书章及有效quote。

createdBy=P1/P3/manual，旧P2仅历史。阶段completed/current只表示整理完成，stale只表示需要重查，均不控制实体生效。人物/地点confidence沿用模型值，人工默认0.5不当成已验证；补点confidence0.6与关联confidence>=0.85是不同含义。

## DATA-03 ID与时间

| 对象 | 规则 |
|---|---|
| 新书 | bk_UUID；重复导入不同bookId、不同Agent |
| P1人物/地点/节点 | C{chapterIndex}-P/L/N{序号至少3位}，创建后稳定 |
| 人工四类实体 | U-UUID |
| 线 | 当前最大L数字+1，不覆盖既有ID |
| 合并 | 保留keepId，来源redirect；不重新编P001/L001 |
| 删除 | 当前实体删除、来源墓碑；P1成功凭证保留 |
| 凭证 | key=章:worldAssets或章:narrativeAssets |
| 会话/条目/run | UUID；同书P3持续sessionId，条目ordinal递增 |
| 时间 | 业务ISO；租约毫秒；展示按客户端时区 |

## DATA-04 v4→v5迁移

旧characters/locations曾为发布副本；优先把旧characterSnapshots/locationSnapshots最新可编辑记录迁成当前实体，同表存在且为空也以空为准；仅源表确实不存在才回退旧副本。不相加、不复活用户删除、不重编号。验证迁移后移除旧两张表，新增凭证/生命周期/run三表；每书最终15表。

节点已有编号能对应当前人物时保留，其他称呼按当前人物和别名重新解析，同名时选择身份。事件线人物集合由节点派生。旧P1可证实成功部分迁legacy凭证；旧P2/P3完成作为历史记录，当前整理依据标为待重查。会话原记录保留，租约清空。

## DATA-05 备份v5

manifest format=westworld-v2、formatVersion=5，appVersion仍1.0.0，不宣称已发布新应用。data/characters.json及locations.json直接含当前实体和来源/底稿；不导出两张旧snapshot表。其他单书数据含章节、nodes、eventLines、进度、记忆、会话、extractionReceipts、assetLifecycle、pipelineRuns；原文章节仍chapters/*.txt。

单书15表一致快照，manifest为所列文件提供SHA-256；排除API Key/全局设置、活lease，running导出paused，报告保留。可在P1/P2/P3进行中导出，不要求另点入库。

恢复总是新书，重写bookId/清owner；v4保守迁移，v5校验新增字段/凭证唯一/redirect同类无环/会话链，不能用旧宽松Schema略过。原文ZIP命名、UTF8 JSON、压缩和文件权限协议未变部分沿用旧资源；旧应用拒绝过新版本。
