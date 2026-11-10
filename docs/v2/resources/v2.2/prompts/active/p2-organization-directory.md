# 第一步：目录页

- 用 `query_character_catalog` 读取 `work.data.ids` 这批人物的姓名、别名、身份和编号，不要越页读取其他目录页。
- 姓名、别名、身份或经历可能指向同一人时，用 `save_candidate_group` 保存成员编号和简短理由。允许只保存本页可见的疑似关系。
- 本页读完后用 `record_organization_progress` 的 `kind=scan_page`、`id=work.data.pageId` 登记，然后调用一次 `submit_result` 结束本页。
- `submit_result` 只结束当前目录页/本工作项；程序在全部目录页完成后自动推进。不要在这里调用 `submit_profile_review` 或 `submit_relation_review`。
