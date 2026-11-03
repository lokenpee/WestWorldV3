# 已确认组的机械合并队列

## 背景

人物和地点需要先处理重复提取的完整同名档案，再核对异名候选。多组合并保留每组的规则来源、保存结果和未完成项。

## 选定方案

当前行为要求见[世界资产整理](../../openspec/specs/world-organization/spec.md)，对应条款 MECHANICAL-MERGE-QUEUE-01、MECHANICAL-MERGE-QUEUE-02、MECHANICAL-MERGE-QUEUE-03、MECHANICAL-MERGE-QUEUE-04、MECHANICAL-MERGE-QUEUE-05、MECHANICAL-MERGE-QUEUE-06。


## 替代方案

共享表的写事务按[浏览器事务规则](https://www.w3.org/TR/IndexedDB/)排队执行，因此资料准备采用有限并发，关联与来源提交按组保存。整队一个事务会延长占用并让单项问题回滚其他组；仅保存在页面中会丢失刷新后的待办。因此采用逐组事务和持久队列。

## 后果

用户可集中核对后统一执行，并按报告处理失败组。成功结果即时生效，统计在收尾后更新；同书编辑在队列停稳后恢复。
