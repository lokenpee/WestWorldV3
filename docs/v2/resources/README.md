# 资源版本与使用顺序

当前目标规格为2.2。先读[资源权威映射](v2.2/resource-authority.json)和[流程契约](v2.2/pipeline-contract.json)。

本目录原JSON、contracts.d.ts、旧Prompt、回放和截图保留为2.1冻结资料；它们的阶段、锁、会话、人工编辑和按钮规则已被2.2替代，不能直接生成新工作流。当前完整存储Schema在v2.2/storage.schema.json，目标数据含2026-10-24任务/命令/覆盖定义。未变基础DTO、分章/相似度/频次/图算法和运行依赖可以复用；有效Prompt统一使用v2.2/prompts/active，不能混入历史末轮规则。

2.2是待实现设计。旧51项通过记录不能证明新流程通过；原30项验收仍是声明式步骤。2026-10-24新增6项固定恢复/覆盖用例及独立runner，尚未接入重建应用adapter；另有16份完整请求结构夹具。文档/契约检查与实际应用执行分开记录。

AI当前边界见[v2.2/ai-runtime-contract.json](v2.2/ai-runtime-contract.json)：direct和Pi Agent共用pi-ai，Agent由pi-agent-core执行，应用通过14读+2写工具提供长期记忆及当前业务数据。旧read-only和raw生成探测条款已替换。
