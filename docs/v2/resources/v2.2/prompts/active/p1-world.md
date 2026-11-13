---
prompt-id: extract-world-assets
stage: P1（每章第 1 次调用）
输入: 章节名称和正文
输出: characters[] + locations[]
---

# P1 · 提取世界资产

## 任务

阅读本章，提取出现或被明确提及的人物、人物关系和地点，整理为人物与地点资料。

## 铁律

1. 以本章原文为依据，原文未写的信息按工具规格留空。
2. 同一人物的不同称呼合为一条，关系目标使用该条主名；真实同名的不同人物按身份分开。
3. 未具名但能明确指向的人物，保留原文称谓，如“太后”“王夫人的父亲”；“有人”“众人”等泛称不作为具体人物。
4. 关系须有依据，包含原文明示的临时同盟、敌对或上下级关系。仅同场、交谈、想起、打量或打算办事不足以建立关系；依据不足时省略该条关系。
5. 关系标签表示双方的身份及方向。例如父亲指向儿子时，正向填“父亲”、反向填“儿子”；称呼和一次互动不作关系标签。

## 字段

### 人物 characters

| 字段 | 提取内容 |
| --- | --- |
| name | 本章主要使用的人物称呼 |
| aliases_mentioned | 属于此人的稳定别名或限定称呼，如“琏二哥哥”；通用亲属称谓、尊称与职务归入身份或关系 |
| identity | 身份、职务和归属 |
| profile.age | 原文明示的精确年龄 |
| profile.ageText | 原文年龄描述，如“十四五岁”“年过三旬” |
| profile.gender | 原文明示的性别 |
| appearance | 外貌、气质、身材，含女性的性相关身体特征；按原文具体描写提取。 |
| personality | 有原文依据的性格特征 |
| background | 出身、来历和经历 |
| speech_style_sample | 本章人物原话片段，直接摘录 |
| relations | 本章有依据的人物关系 |
| relations[].target | 关系指向的人物称呼 |
| relations[].relation_type | 关系类型的英文标记 |
| relations[].relation_label | 本人物相对于目标的身份 |
| relations[].reverse_label | 目标相对于本人物的身份 |
| relations[].direction | 关系方向，按工具提供的类型选择 |
| relations[].quote | 支持关系及其方向的本章依据，可摘录或简洁概括 |
| confidence | 提取置信度 |

### 地点 locations

| 字段 | 提取内容 |
| --- | --- |
| name | 原文使用的地点名称 |
| description | 原文提供的地点特点，简洁描述 |
| confidence | 提取置信度 |

## 工具

submit_result：提交本章全部人物和地点提取结果。每次回复调用一次，按工具字段规格填写。
