# 2026-11-11 暂停与单条会话时间线

## 本轮改动

- 修复 P2 步骤按钮在运行中被 `ready=false` 禁用的问题；运行/暂停状态下按钮始终可点。
- 将 `shouldPause` 接入当前 Agent 的 `beforeToolCall` 和 `finishTurn`，暂停在下一次工具调用或当前回合结束时生效，保留当前人物和 `activeWork`。
- 会话记录补写 `taskId`；P2 工作项恢复只读取当前任务的消息，避免旧任务的工具结果混入新任务。
- 整理详情改为单条会话时间线：System Prompt、程序注入、Assistant、Tool Call、Tool Result 按发生顺序各显示一次；每次 API 仅显示本次新增内容，完整请求体收进 API 分隔行。
- P2 模型输入拆分为持久化 `input` 与结构化任务简报；运行编号、fingerprint、operationKey、恢复状态不再进入模型消息。
- 关系提示词明确关系概览已提供、证据查询必须带 `targetIds`、只有缺少工具时才调用 `get_tools`。
- 模型声明继续隐藏 `submit_profile_review` / `submit_relation_review` 的 `operationKey` 和关系顶层 `basis`；内部旧调用仍兼容。

## 检查

- `npx tsc -b`：通过
- `npx tsc -p tsconfig.tests.json --noEmit`：通过
- `npm run test:unit`：58 个文件，556 通过，1 跳过
- `npm run build`：通过
- `npm run governance:check`：通过
- `npm run openspec -- validate --all --strict`：27 项通过
- 开发浏览器定向检查：
  - 第三步运行中暂停/继续：通过
  - 第二步整理详情按实际请求显示、桌面与窄屏无重复：通过

## 未完成

- 未调用真实模型，未修改正式书库或备份。
- 世界资产浏览器全量用例中 7 个旧用例仍查找已移除的“AI整理”按钮，属于既有测试入口未更新；本轮改动相关用例已通过。
- 等待用户自测和观感确认；Git 提交需另行授权。
