# 世界资产整理的两个入口

## 背景

人物和地点需要按名称查找候选，也需要结合原文判断身份。用户可以自行确认候选，或调用模型核实。

## 选定方案

当前行为要求见[世界资产整理](../../openspec/specs/world-organization/spec.md)，对应条款 WORLD-ORGANIZATION-01、WORLD-ORGANIZATION-02、WORLD-ORGANIZATION-03、WORLD-ORGANIZATION-04、WORLD-ORGANIZATION-05、WORLD-ORGANIZATION-06、WORLD-ORGANIZATION-07、WORLD-ORGANIZATION-08、WORLD-ORGANIZATION-09、WORLD-ORGANIZATION-10、WORLD-ORGANIZATION-11、WORLD-ORGANIZATION-12、WORLD-ORGANIZATION-13、WORLD-ORGANIZATION-14、WORLD-ORGANIZATION-15、WORLD-ORGANIZATION-16、WORLD-ORGANIZATION-17。


## 替代方案

把代码步骤与AI步骤固定串联，会让只需要本地整理的用户进入模型调用。按别名、包含或相似称呼自动融合会混淆异名候选，因此这部分采用人工确认；完整主名相同按自动规则处理。单项长期循环会拖住后续资产，直接到点取消又可能丢失当前响应，因此采用提前收尾和持久待办。

## 后果

两类报告分别记录时间、前后数量、合并组、来源、冲突与用量。AI报告还能回查合并与别名证据、资料前后对照、独立复核结论及待复核稿件。没有变更时仍保留报告。
