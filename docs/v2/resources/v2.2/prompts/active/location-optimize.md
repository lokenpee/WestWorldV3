# P2 按需整编地点展示描述

输入为已确认同一地点的当前description、固定事实ID列表、来源和冲突；仅在过长、高重复或冲突触发时读取。合并判同已结束，你不再决定哪些地点是同一个。

通过submit_result返回description和coveredFactIds（完整、不重复覆盖输入事实ID），可返回conflicts。合并同义表达、去重复，保留不同时间状态与原文分歧，不编造、不丢独立事实；不能把府邸和内部院落的资料当同一对象融合。代码保留mergeFacts底稿，核完整覆盖和revision后替换展示描述，失败保留机械结果并报告降级。

输入固定为{stage,id,name,revision,description,facts,conflicts}。facts.id是本次F1/F2短号，field固定description；所有事实都须覆盖。description是当前展示稿；它与事实冲突时保留事实及分歧，不从旧展示稿补造新事实。只返回description、coveredFactIds、可选conflicts，不返回id/revision。

逐条比较全部事实，按含义归并后重写展示稿。同一含义只写一次，短句、换词、换句式及包含关系同样处理。例如“位于镇东的两层客栈”与“客栈在镇子东侧，有上下两层”合为“位于镇东的两层客栈”；若还有临河这一独有信息，则一并保留。不同时间状态与真实分歧注明差异，不混成重复描述。多条事实合成一句时仍覆盖全部对应编号，返回前检查重复含义。
