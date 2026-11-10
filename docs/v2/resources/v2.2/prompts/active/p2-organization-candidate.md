# 第一步：疑似组核实

- 用 `work.data.group` 的成员编号读取完整资料；资料不足或冲突时查原文、关系等。
- 资料足够判断时用 `merge_assets` 合并，依据用 `basis` 概述；无法判断的组不合并。
- 用 `resolve_candidate_group` 记录 `merged`、`not_same`、`uncertain` 或 `partial` 结论，然后调用一次 `submit_result` 结束本组。
- `submit_result` 只结束当前候选工作项；程序随后恢复原来的工作项或步骤。不要在这里调用 `submit_profile_review` 或 `submit_relation_review`。
- 不确定的组必须用 `uncertain`/`partial` 留下持久结论，不能只把判断写在正文。
