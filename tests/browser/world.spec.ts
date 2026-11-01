import { expect, test, type Page } from '@playwright/test'
import { addEmptyBook } from '../support/browser-books'
import { worldResponse, worldText } from '../support/world-streams'
import { agentStream } from '../support/agent-protocol'

test('AI整理无进展暂停后刷新可继续队列，报告显示批次请求和覆盖范围', async ({ page }, testInfo) => {
  let partial = true
  await page.route('**/world-fixture/v1/chat/completions', async route => {
    const body = route.request().postDataJSON()
    if (body.tools.length > 1 && partial) {
      const user = body.messages.filter((row: { role: string }) => row.role === 'user').map((row: { content: string | { text: string }[] }) => typeof row.content === 'string' ? row.content : row.content.map(part => part.text).join('')).find((value: string) => value.startsWith('{'))
      const input = JSON.parse(user)
      await route.fulfill({ contentType: 'text/event-stream', body: await agentStream([{ name: 'submit_result', args: { status: 'partial', commitIds: [], summary: '继续核对当前待办', reviewedItems: [], remainingWorkIds: input.workItems.map((row: { workItemId: string }) => row.workItemId) } }]).text() }); return
    }
    await route.fulfill({ contentType: 'text/event-stream', body: await worldResponse(body).text() })
  })
  await prepare(page)
  await page.getByRole('button', { name: 'AI整理', exact: true }).click()
  const report = page.getByRole('dialog', { name: '世界资产整理报告', exact: true })
  await expect(report).toContainText('已暂停', { timeout: 15000 })
  await expect(report).toContainText('待处理 10 条')
  await report.getByText('批次与实际请求（10批）', { exact: true }).click()
  await expect(report).toContainText('实际请求1次')
  await report.getByRole('button', { name: '关闭报告', exact: true }).click()
  await page.reload()
  partial = false
  await page.getByRole('button', { name: '继续AI整理', exact: true }).click()
  await expect(report).toContainText('减少 3 条', { timeout: 15000 })
  await expect(report).toContainText('待处理 0 条')
  await page.setViewportSize({ width: 375, height: 812 })
  await report.screenshot({ path: testInfo.outputPath('world-queue-mobile.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

async function prepare(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('服务基础地址', { exact: true }).fill(`${new URL(page.url()).origin}/world-fixture/v1`)
  await page.getByLabel('API Key（密钥）', { exact: true }).fill('world-fixture-key')
  await page.getByRole('button', { name: '保存模型配置', exact: true }).click()
  await page.getByRole('button', { name: '资产', exact: true }).click()
  await page.getByLabel('小说TXT文件').setInputFiles({ name: '世界整理样本.txt', mimeType: 'text/plain', buffer: Buffer.from(worldText) })
  await page.getByRole('button', { name: '仅导入', exact: true }).click()
  await expect(page.getByRole('button', { name: '代码整理', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '开始提取', exact: true }).click()
  await expect(page.getByRole('button', { name: '代码整理', exact: true })).toBeEnabled()
}

test('AI整编将短句同义描述写入统一展示，刷新后保留独有信息', async ({ page }) => {
  await page.route('**/world-fixture/v1/chat/completions', async route => {
    const body = route.request().postDataJSON()
    if (body.tools.length === 1 && body.tools[0].function.parameters.properties.entities) {
      const content = body.messages.find((row: { role: string }) => row.role === 'user').content
      const input = JSON.parse(typeof content === 'string' ? content : content.map((part: { text: string }) => part.text).join(''))
      const row = input.entities[0]
      await route.fulfill({ contentType: 'text/event-stream', body: await agentStream([{ name: 'submit_result', args: { entities: { [row.id]: { entity: { name: row.name, aliases: row.aliases, identity: '青石镇的船夫，亦称老沈', personality: '性情沉稳，处事果断，精于谋略' }, covered_fact_ids: row.facts.map((fact: { id: string }) => fact.id), merge_notes: [] } } } }]).text() })
      return
    }
    await route.fulfill({ contentType: 'text/event-stream', body: await worldResponse(body).text() })
  })
  await prepare(page)
  await page.getByRole('button', { name: '编辑 沈青', exact: true }).first().click()
  await page.getByLabel('性格', { exact: true }).fill('性情沉稳，处事果断；为人沉稳，遇事果决；精于谋略')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已保存' }).last()).toBeVisible()
  await page.getByRole('button', { name: 'AI整理', exact: true }).click()
  const report = page.getByRole('dialog', { name: '世界资产整理报告', exact: true })
  await expect(report).toContainText('人物 7 → 5', { timeout: 20000 })
  await expect(report).toContainText('整编 2 条')
  await report.getByRole('button', { name: '关闭报告', exact: true }).click()
  await page.getByRole('button', { name: '编辑 沈青', exact: true }).click()
  await expect(page.getByLabel('性格', { exact: true })).toHaveValue('性情沉稳，处事果断，精于谋略')
  await page.reload()
  await page.getByRole('button', { name: '编辑 沈青', exact: true }).click()
  await expect(page.getByLabel('性格', { exact: true })).toHaveValue('性情沉稳，处事果断，精于谋略')
})
test('代码整理选择成员后可直接确认并连续处理，预览为可选操作', async ({ page }, testInfo) => {
  let calls = 0
  await page.route('**/world-fixture/v1/chat/completions', async route => { calls++; await route.fulfill({ contentType: 'text/event-stream', body: await worldResponse(route.request().postDataJSON()).text() }) })
  await prepare(page)
  expect(calls).toBe(2)
  await page.getByRole('button', { name: '代码整理', exact: true }).click()
  await expect(page.getByRole('region', { name: '代码整理候选', exact: true })).toContainText('找到')
  expect(calls).toBe(2)
  await page.getByRole('region', { name: '代码整理候选', exact: true }).getByRole('button').first().click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByLabel('合并后主名', { exact: true }).selectOption('张三丰')
  await expect(page.getByRole('button', { name: '确认机械合并', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '确认机械合并', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已合并“张三丰”' })).toBeVisible()
  await expect(page.getByRole('region', { name: '代码整理候选', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '代码整理候选', exact: true })).toContainText('没有找到需要合并的名称候选。')
  const report = page.getByRole('dialog', { name: '世界资产整理报告', exact: true })
  await expect(report).toHaveCount(0)
  await page.getByRole('button', { name: '查看整理报告', exact: true }).click()
  await expect(report).toContainText('代码整理无模型调用')
  await expect(report).toContainText('人物 5 → 4')
  expect(calls).toBe(2)
  await report.getByRole('button', { name: '关闭报告', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: '查看整理报告', exact: true }).click()
  await expect(report).toContainText('人物 5 → 4')
  await page.setViewportSize({ width: 375, height: 812 })
  await page.screenshot({ path: testInfo.outputPath('world-code-mobile.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('可选预览保留合并选项，资料更新后仍可核对当前候选并直接确认', async ({ page, context }) => {
  await page.route('**/world-fixture/v1/chat/completions', async route => { await route.fulfill({ contentType: 'text/event-stream', body: await worldResponse(route.request().postDataJSON()).text() }) })
  await prepare(page)
  await page.getByRole('button', { name: '代码整理', exact: true }).click()
  await page.getByRole('region', { name: '代码整理候选', exact: true }).getByRole('button').first().click()
  await page.getByRole('button', { name: '预览代码合并', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '人物合并预览', exact: true })
  await dialog.getByLabel('保留条目', { exact: true }).selectOption('C1-P007')
  await dialog.getByLabel('自定义主名', { exact: true }).fill('张三丰先生')
  await dialog.getByRole('button', { name: '完成预览', exact: true }).click()
  await expect(page.getByText('已预览：保留 C1-P007，主名“张三丰先生”。', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '预览代码合并', exact: true }).click()
  await expect(dialog.getByLabel('保留条目', { exact: true })).toHaveValue('C1-P007')
  await expect(dialog.getByLabel('自定义主名', { exact: true })).toHaveValue('张三丰先生')
  await dialog.getByRole('button', { name: '完成预览', exact: true }).click()
  const other = await context.newPage(); await other.goto('/')
  await other.getByRole('button', { name: '编辑 张三', exact: true }).click()
  await other.getByLabel('身份', { exact: true }).fill('另一标签修改的身份')
  await other.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('资料已更新，请核对当前候选后确认。', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '确认机械合并', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '确认机械合并', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已合并“张三丰先生”' })).toBeVisible()
  await expect(page.getByRole('region', { name: '代码整理候选', exact: true })).toBeVisible()
})
test('AI整理由Pi核对原文合并人物地点，身份不同的同名人物与内部区域保留', async ({ page }, testInfo) => {
  await page.route('**/world-fixture/v1/chat/completions', async route => { await route.fulfill({ contentType: 'text/event-stream', body: await worldResponse(route.request().postDataJSON()).text() }) })
  await prepare(page)
  await page.getByRole('button', { name: 'AI整理', exact: true }).click()
  const report = page.getByRole('dialog', { name: '世界资产整理报告', exact: true })
  await expect(report).toContainText('人物 7 → 5', { timeout: 15000 })
  await expect(report).toContainText('地点 3 → 2')
  await report.getByRole('button', { name: '关闭报告', exact: true }).click()
  await expect(page.getByRole('button', { name: '编辑 陆川', exact: true })).toHaveCount(2)
  await expect(page.getByRole('button', { name: '编辑 张三丰', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^地点 / }).click()
  await expect(page.getByRole('button', { name: '编辑 青石客栈后院', exact: true })).toBeVisible()
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.getByRole('region', { name: '世界资产整理', exact: true }).screenshot({ path: testInfo.outputPath('world-ai-desktop.png') })
})


test('不同名称可在候选栏选择主名直接确认，取消预览也不影响直接合并', async ({ page }) => {
  await page.route('**/world-fixture/v1/chat/completions', async route => { await route.fulfill({ contentType: 'text/event-stream', body: await worldResponse(route.request().postDataJSON()).text() }) })
  await prepare(page)
  await page.getByRole('button', { name: '代码整理', exact: true }).click()
  await page.getByRole('region', { name: '代码整理候选', exact: true }).getByRole('button', { name: /张三、张三丰/ }).click()
  await expect(page.getByRole('button', { name: '确认机械合并', exact: true })).toBeDisabled()
  await page.getByLabel('合并后主名', { exact: true }).selectOption('张三丰')
  await expect(page.getByRole('button', { name: '确认机械合并', exact: true })).toBeEnabled()
  await page.getByRole('region', { name: '代码整理候选', exact: true }).getByRole('button').first().click()
  await page.getByRole('button', { name: '预览代码合并', exact: true }).click()
  await page.getByRole('button', { name: '取消预览', exact: true }).click()
  await page.getByRole('button', { name: '确认机械合并', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已合并“张三丰”' })).toBeVisible()
})

test('切书后原书AI整理继续保存，另一书不弹出原书报告', async ({ page }) => {
  let calls = 0, release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/world-fixture/v1/chat/completions', async route => {
    if (++calls === 3) await gate
    await route.fulfill({ contentType: 'text/event-stream', body: await worldResponse(route.request().postDataJSON()).text() })
  })
  await prepare(page)
  await addEmptyBook(page, 'book-other', '另一书')
  await page.getByRole('button', { name: 'AI整理', exact: true }).click()
  await expect.poll(() => calls).toBe(3)
  await page.getByRole('button', { name: '进入 另一书', exact: true }).click()
  release()
  await expect.poll(async () => page.evaluate(async () => {
    const name = (await indexedDB.databases()).find(row => row.name?.startsWith('westworld_canon_') && row.name !== 'westworld_canon_book-other')!.name!
    const request = indexedDB.open(name)
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => { const read = db.transaction('pipelineRuns').objectStore('pipelineRuns').getAll(); read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error) }); db.close()
    return rows.some(row => row.stage === 'P2' && row.recordType === 'run' && row.status === 'completed')
  }), { timeout: 20000 }).toBe(true)
  await expect(page.getByRole('heading', { name: '另一书', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog', { name: '世界资产整理报告', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^人物 0$/ })).toBeVisible()
  await page.getByRole('button', { name: '进入 世界整理样本', exact: true }).click()
  await page.getByRole('button', { name: '查看整理报告', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '世界资产整理报告', exact: true })).toContainText('人物 7 → 5')
})
