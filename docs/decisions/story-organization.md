# P3叙事整理的排队与恢复

## 背景

窗口串联和全书复核需要跨节点、跨事件线查证。已提交的修改、逐项核实结论和窗口完成状态分别保存，方便中断后接续。

## 选定方案

当前行为要求见[事件线串联与复核](../../openspec/specs/story-organization/spec.md)，对应条款 STORY-ORGANIZATION-01、STORY-ORGANIZATION-02、STORY-ORGANIZATION-03、STORY-ORGANIZATION-04、STORY-ORGANIZATION-05、STORY-ORGANIZATION-06、STORY-ORGANIZATION-07、STORY-ORGANIZATION-08。


## 替代方案

只保存窗口是否完成，会让半途停止的窗口重复处理；把所有读过的目录记录都作为完成依据，会扩大复核范围。采用逐项保存和实际依据检查，并复用已有事件线和提交账本。

## 后果

完成计数按当前有效结论计算，提交总结失败仍能保留已落库的串联成果。旧任务中可核对当前版本的已提交修改可恢复，资料已变化的项保留待核实。
