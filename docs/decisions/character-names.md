# 人物别名与通用称谓

## 背景

亲属称谓、职务和尊称依赖说话者、时间及场景。把这些称谓用于全书名称匹配，会将不同人物的记录和事件错误关联。

## 选定方案

当前行为要求见[资产维护](../../openspec/specs/asset-management/spec.md)，对应条款 CHARACTER-NAMES-01、CHARACTER-NAMES-02、CHARACTER-NAMES-03、CHARACTER-NAMES-04、CHARACTER-NAMES-05、CHARACTER-NAMES-06、CHARACTER-NAMES-07。


## 替代方案

只修改提示词无法处理旧数据和偶发错误输出；删除全部称谓会丢失只以职务或亲属身份出现的人物。因此同时规范提取、保存与匹配，保留人物及原文信息。

## 后果

通用称谓留下上下文信息，稳定别名用于检索和候选发现。精确词表负责常见情况，提示词处理语境判断；新增语境和称谓通过样本验收完善。
