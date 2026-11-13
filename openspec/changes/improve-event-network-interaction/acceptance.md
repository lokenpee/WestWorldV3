# 验收记录

## 样本与步骤
浏览器固定样本：N1/N2 属于调查主线 L1，N2/N3 属于人物支线 L2，N4 为孤立节点。
1. 进入事件节点 → 事件网络，鼠标指向节点滚动；指向位置保持，页面不滚动。拖动、加减键和手机按钮仍可用。
2. 点击 N1 编辑节点并突出 L1；点 N2 沿用 L1。取消聚焦后点击 N2，只列 L1/L2，可切换突出 L2。
3. 切换事件线栏目，点击 N3 编辑 L2；共享节点无聚焦时选择 L1 再编辑 L1；点 N4 显示尚未归线。
4. 编辑器改名但未保存，点击其他节点；取消提醒保留原内容和聚焦，放弃后才切换。
5. 搜索、章节、孤点筛选及列表切换仍可用；视图操作不改变资产 revision。
6. 固定模型响应生成 P2/P3 详情；首次无展开框，逐层展开可查看内容，新增消息不重置已展开项；关闭重开恢复折叠。

## 开发检查
2026-11-13：
- `npm run test:unit -- tests/network.test.ts tests/execution-chain.test.ts tests/trace.test.ts`：3文件、16项通过。
- `npm run typecheck`：应用和测试类型检查通过。
- `npx playwright test network.spec.ts story.spec.ts world.spec.ts --config=playwright.workspace.config.ts --project=production --grep='网络|事件线栏目|未保存编辑|P3链路默认|AI主动翻三页|第二步整理详情'`：9项通过，包含6项网络操作、P2详情、P3串联与P3实时折叠状态。
- `npx playwright test network.spec.ts --config=playwright.workspace.config.ts --project=production`：6项事件网络操作及1项人物网络回归通过；首次锚点检查发现边框尺寸与真实SVG尺寸不同，改为测量SVG；测试鼠标坐标改为浏览器输入使用的整像素坐标。
- `npx playwright test network.spec.ts --config=playwright.workspace.config.ts --project=production --grep='滑轮'`：最终锚点专项通过，覆盖初始画布及筛选恢复、坐标不漂移、页面不滚动。事件网络7个场景均通过。
- Playwright 每轮通过 `npm run build` 启动生产预览，构建成功。保留既有分包及依赖浏览器兼容提示，本次没有新增构建错误。
- `npm run governance:check`、`npm run openspec -- validate improve-event-network-interaction --strict`、`git diff --check` 通过。
- 已查看生成的所属线聚焦及手机网络截图：节点与连线变淡、局部所属线选择、手机控件换行正常。

P3实时检查用固定响应暂挂第二次API，在等待时展开第一条assistant及工具调用、第一张API请求；后续请求完成后这些内容仍展开，新消息收起，关闭详情重开全部收起。P2检查首层及首个API中的嵌套内容默认收起。

测试仅使用隔离浏览器书库与固定API响应；未调用真实模型、未修改正式书库，未提交或推送Git。

## 用户验收
待用户在书库副本按上述操作确认，尚未同步或归档。
