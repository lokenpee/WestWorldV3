import { expect, test, type Page } from '@playwright/test'
import { addEmptyBook } from '../support/browser-books'
import { worldResponse, worldText } from '../support/world-streams'
import { organizationResponse } from '../support/organization-streams'

const contentOf = (content: unknown) => typeof content === 'string' ? content : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? '').join('') : ''
const parseContent = (content: unknown) => { try { return JSON.parse(contentOf(content)) as Record<string, unknown> } catch { return {} } }
const taskInputs = (body: { messages: { role: string; content: unknown }[] }) => body.messages.filter(message => message.role === 'user').map(message => parseContent(message.content)).filter(input => typeof input.step === 'string')

test.setTimeout(60000)

test('P2 三步可独立启动且不会自动串到下一步', async ({ page }) => {
  const steps: string[] = []
  await page.route('**/world-fixture/v1/chat/completions', async route => {
    const body = route.request().postDataJSON()
    const organization = organizationResponse(body)
    if (organization) steps.push(String(taskInputs(body).at(-1)?.step))
    await route.fulfill({ contentType: 'text/event-stream', body: await (organization ?? worldResponse(body)).text() })
  })
  await prepare(page)
  const first = page.getByRole('button', { name: '第一步：识别重复人物', exact: true })
  await first.click()
  await expect(first).toBeEnabled({ timeout: 60000 })
  expect(steps).not.toContain('profiles')
  const second = page.getByRole('button', { name: '第二步：优化人物资料', exact: true })
  await expect(second).toBeEnabled()
  await second.click()
  await expect(second).toBeEnabled({ timeout: 60000 })
  expect(steps).not.toContain('relations')
  const third = page.getByRole('button', { name: '第三步：整理人物关系', exact: true })
  await third.click()
  await expect(third).toBeEnabled({ timeout: 60000 })
})

test('第三步运行中可以暂停并继续，按钮不会被租约禁用', async ({ page }) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  let held = false
  await page.route('**/world-fixture/v1/chat/completions', async route => {
    const body = route.request().postDataJSON()
    const organization = organizationResponse(body)
    if (organization && !held && body.messages.some((message: { content?: unknown }) => String(message.content ?? '').includes('任务类型：relations'))) {
      held = true
      await gate
    }
    await route.fulfill({ contentType: 'text/event-stream', body: await (organization ?? worldResponse(body)).text() })
  })
  await prepare(page)
  const third = page.getByRole('button', { name: '第三步：整理人物关系', exact: true })
  await third.click()
  const pause = page.getByRole('button', { name: '暂停第三步', exact: true })
  await expect(pause).toBeEnabled({ timeout: 15000 })
  await pause.click()
  release()
  await expect(page.getByRole('button', { name: '继续第三步', exact: true })).toBeEnabled({ timeout: 45000 })
})

test('第二步整理详情按实际API请求展示，桌面与窄屏无重复日志', async ({ page }, testInfo) => {
  await page.route('**/world-fixture/v1/chat/completions', async route => {
    const body = route.request().postDataJSON()
    const organization = organizationResponse(body)
    await route.fulfill({ contentType: 'text/event-stream', body: await (organization ?? worldResponse(body)).text() })
  })
  await prepare(page)
  await expect(page.getByLabel('整理范围', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /人物关系核对/ })).toHaveCount(0)
  const second = page.getByRole('button', { name: '第二步：优化人物资料', exact: true })
  await second.click()
  await expect(second).toBeEnabled({ timeout: 45000 })
  await expect(page.getByRole('button', { name: '请求与用量', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '查看整理报告', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '整理详情', exact: true }).click()
  const trace = page.getByRole('dialog', { name: '整理详情', exact: true })
  await expect(trace.getByRole('tab', { name: /第一步：识别与合并/ })).toBeVisible()
  await expect(trace.getByRole('tab', { name: /第二步：整理人物资料/ })).toBeVisible()
  await expect(trace.getByRole('tab', { name: /第三步：整理人物关系/ })).toBeVisible()
  await trace.getByRole('tab', { name: /第二步：整理人物资料/ }).click()
  await expect(trace.getByRole('button', { name: /人物资料 · 沈青/ }).first()).toBeVisible({ timeout: 15000 })
  await trace.getByRole('button', { name: /人物资料 · 沈青/ }).first().click()
  await expect(trace).toContainText('API 请求')
  await expect(trace.locator('.execution-events')).toHaveCount(0)
  const conversation = trace.locator('.execution-conversation')
  const conversationPart = (selector: string) => conversation.locator(`:scope > ${selector}`)
  await expect(conversationPart('.run-role-system')).toHaveCount(1, { timeout: 15000 })
  await expect(conversationPart('.run-role-user')).toHaveCount(1)
  await expect(conversationPart('.run-role-tools')).not.toHaveAttribute('open', '')
  await expect(trace.getByText('原始请求 JSON', { exact: false })).toHaveCount(0)
  await expect(trace.getByText('历史记录', { exact: false })).toHaveCount(0)
  await expect(conversation.locator('.run-role-user').first()).toHaveAttribute('open', '')
  await conversation.locator('.run-role-user > summary').first().click()
  await expect(conversation.locator('.run-role-user').first()).not.toHaveAttribute('open', '')
  await conversation.locator('.run-role-user > summary').first().click()
  await trace.locator('.run-selected-object').screenshot({ path: testInfo.outputPath('agent-detail-desktop.png') })
  await expect(trace).toContainText('工具调用')
  await expect(trace).toContainText('SYSTEM')
  await expect(trace).toContainText('USER')
  await expect(trace.locator('.run-api')).toHaveCount(0)
  await trace.locator('.run-api-boundary > summary').first().click()
  await expect(trace).toContainText('ASSISTANT')
  await expect(trace).toContainText('TOOL RESULT')
  await expect(trace).toContainText('本次实际修改')
  await trace.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByRole('button', { name: '编辑 张三丰', exact: true })).toBeVisible()
  await page.setViewportSize({ width: 375, height: 812 })
  await page.getByRole('button', { name: '整理详情', exact: true }).click()
  await trace.getByRole('tab', { name: /第二步：整理人物资料/ }).click()
  await trace.getByRole('button', { name: /人物资料 · 沈青/ }).first().click()
  await expect(trace.locator('.run-api')).toHaveCount(0)
  await trace.locator('.run-api-boundary > summary').first().click()
  await expect(trace.locator('.run-api')).toHaveCount(1)
  await trace.locator('.run-assistant').scrollIntoViewIfNeeded()
  await trace.screenshot({ path: testInfo.outputPath('agent-detail-mobile.png') })
  expect(await page.getByRole('dialog', { name: '整理详情', exact: true }).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.getByRole('dialog', { name: '整理详情', exact: true }).getByRole('button', { name: '查看完整整理报告', exact: true }).click()
  const mobileReport = page.getByRole('dialog', { name: '世界资产整理报告', exact: true })
  await mobileReport.screenshot({ path: testInfo.outputPath('world-organization-mobile.png') })
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
  await page.getByRole('button', { name: '一起提取', exact: true }).click()
  await expect(page.getByRole('button', { name: '代码整理', exact: true })).toBeEnabled()
}

test('人物编辑页可单独启动资料整理并打开对应 P2 详情', async ({ page }) => {
  await page.route('**/world-fixture/v1/chat/completions', async route => {
    const body = route.request().postDataJSON()
    const organization = organizationResponse(body)
    await route.fulfill({ contentType: 'text/event-stream', body: await (organization ?? worldResponse(body)).text() })
  })
  await prepare(page)
  await page.getByRole('button', { name: '编辑 沈青', exact: true }).first().click()
  const profile = page.getByRole('button', { name: 'AI 整理人物资料', exact: true })
  const relations = page.getByRole('button', { name: 'AI 整理人物关系', exact: true })
  await expect(profile).toBeVisible()
  await expect(relations).toBeVisible()
  await profile.click()
  const trace = page.getByRole('dialog', { name: '整理详情', exact: true })
  await expect(trace.getByRole('tab', { name: /第二步：整理人物资料/ })).toBeVisible()
  await expect(trace.getByRole('button', { name: /人物资料 · 沈青/ }).first()).toBeVisible({ timeout: 20000 })
  await expect(trace).toContainText('API 请求')
  await trace.getByRole('button', { name: '关闭', exact: true }).click()
  await relations.click()
  const relationTrace = page.getByRole('dialog', { name: '整理详情', exact: true })
  await expect(relationTrace.getByRole('tab', { name: /第三步：整理人物关系/ })).toBeVisible()
  await expect(relationTrace.getByRole('button', { name: /人物关系 · 沈青/ }).first()).toBeVisible({ timeout: 20000 })
  await relationTrace.getByRole('button', { name: '关闭', exact: true }).click()
})

test('人物整理在同一会话优化人物资料，报告保留修改前后与依据', async ({ page }) => {
  await page.route('**/world-fixture/v1/chat/completions', async route => {
    const body = route.request().postDataJSON()
    const organization = organizationResponse(body, { onProfile: detail => detail.name === '沈青' && String(detail.identity ?? '').includes('船夫') ? [{ name: 'submit_profile_review', args: { patch: { personality: '性情沉稳，处事果断，精于谋略' }, done: true, reason: '合并重复的性格表述' } }] : [] })
    await route.fulfill({ contentType: 'text/event-stream', body: await (organization ?? worldResponse(body)).text() })
  })
  await prepare(page)
  await page.getByRole('button', { name: '编辑 沈青', exact: true }).first().click()
  await page.getByLabel('性格', { exact: true }).fill('性情沉稳，处事果断；为人沉稳，遇事果决；精于谋略')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已保存' }).last()).toBeVisible()
  await page.getByRole('button', { name: 'AI整理', exact: true }).click()
  const report = page.getByRole('dialog', { name: '世界资产整理报告', exact: true })
  await expect(report).toContainText('人物 7 → 5', { timeout: 20000 })
  await expect(report).toContainText('人物资料实际修改 1 人')
  await expect(report).toContainText('性格')
  await expect(report).toContainText('性情沉稳，处事果断，精于谋略')
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
  await page.getByRole('region', { name: '代码整理候选', exact: true }).getByRole('button', { name: /张三、张三丰/ }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByLabel('合并后主名', { exact: true }).selectOption('张三丰')
  await expect(page.getByRole('button', { name: '确认机械合并', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '确认机械合并', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已合并“张三丰”' })).toBeVisible()
  await expect(page.getByRole('region', { name: '代码整理候选', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '代码整理候选', exact: true }).getByRole('button', { name: /张三、张三丰/ })).toHaveCount(0)
  await expect(page.getByRole('region', { name: '代码整理候选', exact: true }).getByRole('button', { name: /沈青、老沈/ })).toBeVisible()
  const report = page.getByRole('dialog', { name: '世界资产整理报告', exact: true })
  await expect(report).toHaveCount(0)
  await page.getByRole('button', { name: '查看整理报告', exact: true }).click()
  await expect(report).toContainText('代码整理不调用模型')
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
  await page.getByRole('region', { name: '代码整理候选', exact: true }).getByRole('button', { name: /张三、张三丰/ }).click()
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
test('切书后原书人物整理继续保存，另一书不弹出原书报告', async ({ page }) => {
  let calls = 0, release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/world-fixture/v1/chat/completions', async route => {
    if (++calls === 3) await gate
    const body = route.request().postDataJSON()
    const organization = organizationResponse(body)
    await route.fulfill({ contentType: 'text/event-stream', body: await (organization ?? worldResponse(body)).text() })
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
  }), { timeout: 45000 }).toBe(true)
  await expect(page.getByRole('heading', { name: '另一书', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog', { name: '世界资产整理报告', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^人物 0$/ })).toBeVisible()
  await page.getByRole('button', { name: '进入 世界整理样本', exact: true }).click()
  await page.getByRole('button', { name: '整理详情', exact: true }).click()
  await page.getByRole('dialog', { name: '整理详情', exact: true }).getByRole('button', { name: '查看完整整理报告', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '世界资产整理报告', exact: true })).toContainText('人物 7 → 5')
})


test('不同名称可在候选栏选择主名直接确认，取消预览也不影响直接合并', async ({ page }) => {
  await page.route('**/world-fixture/v1/chat/completions', async route => { await route.fulfill({ contentType: 'text/event-stream', body: await worldResponse(route.request().postDataJSON()).text() }) })
  await prepare(page)
  await page.getByRole('button', { name: '代码整理', exact: true }).click()
  await page.getByRole('region', { name: '代码整理候选', exact: true }).getByRole('button', { name: /张三、张三丰/ }).click()
  await expect(page.getByRole('button', { name: '确认机械合并', exact: true })).toBeDisabled()
  await page.getByLabel('合并后主名', { exact: true }).selectOption('张三丰')
  await expect(page.getByRole('button', { name: '确认机械合并', exact: true })).toBeEnabled()
  await page.getByRole('region', { name: '代码整理候选', exact: true }).getByRole('button', { name: /张三、张三丰/ }).click()
  await page.getByRole('button', { name: '预览代码合并', exact: true }).click()
  await page.getByRole('button', { name: '取消预览', exact: true }).click()
  await page.getByRole('button', { name: '确认机械合并', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已合并“张三丰”' })).toBeVisible()
})

async function organizationSnapshot(page: Page) {
  return page.evaluate(async () => {
    const name = (await indexedDB.databases()).find(row => row.name?.startsWith('westworld_canon_'))!.name!
    const request = indexedDB.open(name)
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const runs = await new Promise<Record<string, unknown>[]>((resolve, reject) => { const read = db.transaction('pipelineRuns').objectStore('pipelineRuns').getAll(); read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error) })
    db.close()
    return runs.find(row => row.workflow === 'character_organization_v1') as { id: string; sessionId: string; status: string; organization: { step: string; revision: number }; report: { groups: unknown[]; organizationSummary?: { statistics: string } } }
  })
}

test('人物整理定时器延迟超过租期时仍完成同轮，报告统计已更新', async ({ page }) => {
  let clock = Date.now(), delayed = 0
  await page.clock.setFixedTime(clock)
  await page.route('**/world-fixture/v1/chat/completions', async route => {
    const body = route.request().postDataJSON()
    const organization = organizationResponse(body)
    if (organization) { clock += 31000; delayed++; await page.clock.setFixedTime(clock) }
    await route.fulfill({ contentType: 'text/event-stream', body: await (organization ?? worldResponse(body)).text() })
  })
  await prepare(page)
  await page.getByRole('button', { name: 'AI整理', exact: true }).click()
  const report = page.getByRole('dialog', { name: '世界资产整理报告', exact: true })
  await expect(report).toContainText('第三步：整理人物关系 · 已完成', { timeout: 45000 })
  await expect(report).toContainText('出场统计已更新')
  expect(delayed).toBeGreaterThan(10)
  expect((await organizationSnapshot(page)).status).toBe('completed')
})

for (const stop of ['取消', '刷新'] as const) test(`人物合并后${stop}再继续沿同轮会话，不重复合并`, async ({ page }) => {
  let held = false, release: () => void = () => undefined, organizationCalls = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/world-fixture/v1/chat/completions', async route => {
    const body = route.request().postDataJSON()
    const organization = organizationResponse(body)
    if (organization) {
      organizationCalls++
      const inputs = taskInputs(body)
      if (!held && inputs.at(-1)?.step === 'profiles') { held = true; await gate }
    }
    await route.fulfill({ contentType: 'text/event-stream', body: await (organization ?? worldResponse(body)).text() }).catch(() => undefined)
  })
  try {
    await prepare(page)
    await page.getByRole('button', { name: 'AI整理', exact: true }).click()
    await expect.poll(() => held).toBe(true)
    const before = await organizationSnapshot(page)
    expect(before.report.groups).toHaveLength(2)
    expect(before.organization.step).toBe('profiles')
    const calls = organizationCalls
    if (stop === '取消') {
      await page.getByRole('button', { name: '取消AI整理', exact: true }).click()
      const report = page.getByRole('dialog', { name: '世界资产整理报告', exact: true })
      await expect(report).toContainText('出场统计待更新')
      await report.getByRole('button', { name: '关闭报告', exact: true }).click()
    } else await page.reload()
    release()
    // 取消后立即继续；刷新后只移动日期，模拟旧租约已到期。
    if (stop === '刷新') await page.clock.setFixedTime(Date.now() + 31000)
    await expect(page.getByRole('button', { name: '继续AI整理', exact: true })).toBeEnabled()
    expect(organizationCalls).toBe(calls)
    await page.getByRole('button', { name: '继续AI整理', exact: true }).click()
    await expect.poll(async () => (await organizationSnapshot(page)).status, { timeout: 45000 }).toBe('completed')
    const report = page.getByRole('dialog', { name: '世界资产整理报告', exact: true })
    if (!await report.count()) {
      await page.getByRole('button', { name: '整理详情', exact: true }).click()
      await page.getByRole('dialog', { name: '整理详情', exact: true }).getByRole('button', { name: '查看完整整理报告', exact: true }).click()
    }
    await expect(report).toContainText('第三步：整理人物关系 · 已完成', { timeout: 45000 })
    await expect(report).toContainText('出场统计已更新')
    const after = await organizationSnapshot(page)
    expect(after).toMatchObject({ id: before.id, sessionId: before.sessionId, status: 'completed' })
    expect(after.report.groups).toHaveLength(2)
  } finally { release() }
})

test('清空疑似组后技术批次尚未结束，界面已实时显示第二步及第三步未开始', async ({ page }) => {
  let held = false, release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/world-fixture/v1/chat/completions', async route => {
    const body = route.request().postDataJSON()
    const organization = organizationResponse(body)
    if (!held && organization) {
      const input = taskInputs(body).at(-1) as { work?: { kind?: string } } | undefined
      if (input?.work?.kind === 'profile') { held = true; await gate }
    }
    await route.fulfill({ contentType: 'text/event-stream', body: await (organization ?? worldResponse(body)).text() })
  })
  try {
    await prepare(page)
    await page.getByRole('button', { name: 'AI整理', exact: true }).click()
    await expect.poll(() => held).toBe(true)
    const panel = page.getByRole('region', { name: '世界资产整理', exact: true })
    await expect(panel.getByRole('region', { name: '第一步识别与合并', exact: true })).toContainText('已完成')
    await expect(panel.getByRole('region', { name: '第二步人物资料', exact: true })).toContainText('进行中')
    await expect(panel.getByRole('region', { name: '第二步人物资料', exact: true })).toContainText('已检查 0/5 人 · 实际修改 0 人')
    await expect(panel.getByRole('region', { name: '第三步人物关系', exact: true })).toContainText('未开始')
    await expect(panel).toContainText('疑似组工作存储已清空')
    release()
    await expect(page.getByRole('dialog', { name: '世界资产整理报告', exact: true })).toContainText('三步整理及出场统计已完成', { timeout: 45000 })
  } finally { release() }
})

test('旧版完成标记只重查资料及关系，保留原轮会话和合并成果', async ({ page }) => {
  let repair = false
  const repairSteps: string[] = []
  await page.route('**/world-fixture/v1/chat/completions', async route => {
    const body = route.request().postDataJSON(), organization = organizationResponse(body)
    if (repair && organization) {
      const inputs = taskInputs(body)
      repairSteps.push(String(inputs.at(-1)?.step))
    }
    await route.fulfill({ contentType: 'text/event-stream', body: await (organization ?? worldResponse(body)).text() })
  })
  await prepare(page)
  await page.getByRole('button', { name: 'AI整理', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '世界资产整理报告', exact: true })
  await expect(dialog).toContainText('三步整理及出场统计已完成', { timeout: 45000 })
  const before = await organizationSnapshot(page)
  await page.evaluate(async runId => {
    const name = (await indexedDB.databases()).find(row => row.name?.startsWith('westworld_canon_'))!.name!
    const request = indexedDB.open(name)
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('pipelineRuns', 'readwrite'), store = tx.objectStore('pipelineRuns'), read = store.get(runId)
      read.onsuccess = () => { const row = read.result; delete row.organization.reviewVersion; store.put(row) }
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
    })
    db.close()
  }, before.id)
  repair = true
  await page.reload()
  await expect(page.getByRole('region', { name: '第二步人物资料', exact: true })).toContainText('需重新检查')
  await page.getByRole('button', { name: '继续AI整理', exact: true }).click()
  await expect(dialog).toContainText('三步整理及出场统计已完成', { timeout: 45000 })
  const after = await organizationSnapshot(page)
  expect(after).toMatchObject({ id: before.id, sessionId: before.sessionId, status: 'completed' })
  expect(after.report.groups).toHaveLength(2)
  expect(repairSteps).not.toContain('scan')
  expect(repairSteps).toContain('profiles')
  expect(repairSteps).toContain('relations')
})

test('第三步查原文删除误连关系，双端只修改一次并展示前后与依据', async ({ page }) => {
  let readOriginal = false, deletes = 0
  await page.route('**/world-fixture/v1/chat/completions', async route => {
    const body = route.request().postDataJSON()
    const organization = organizationResponse(body, { onRelation: pair => {
      if (!readOriginal) { readOriginal = true; return [{ name: 'read_original', args: { chapter_indices: ['1'] } }] }
      deletes++
      return [{ name: 'submit_relation_review', args: { changes: [{ targetId: pair.toId, action: 'delete', reason: '原文明确药师陆川与镖师陆川彼此并不认识，删除误连的朋友关系', basis: [{ summary: '第一章明确这两个人彼此并不认识', source: { kind: 'chapter', chapterIndex: '1' } }] }], done: true, reason: '删除误连关系' } }]
    } })
    await route.fulfill({ contentType: 'text/event-stream', body: await (organization ?? worldResponse(body)).text() })
  })
  await prepare(page)
  await page.evaluate(async () => {
    const name = (await indexedDB.databases()).find(row => row.name?.startsWith('westworld_canon_'))!.name!
    const request = indexedDB.open(name)
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['characters', 'characterRelationEdits'], 'readwrite'), read = tx.objectStore('characters').get('C1-P004')
      read.onsuccess = () => tx.objectStore('characterRelationEdits').put({ pairKey: JSON.stringify(['C1-P004', 'C1-P005']), bookId: read.result.bookId, aId: 'C1-P004', bId: 'C1-P005', state: 'active', aToBLabels: ['朋友'], bToALabels: ['朋友'], directionUnclear: false, evidence: [], sourceRelationIds: [], legacyRecordIds: [], revision: 1, updatedAt: new Date().toISOString(), updatedBy: 'manual', commitId: 'fixture-false-friend' })
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
    })
    db.close()
  })
  const third = page.getByRole('button', { name: '第三步：整理人物关系', exact: true })
  await third.click()
  await expect(third).toBeEnabled({ timeout: 45000 })
  await page.getByRole('button', { name: '整理详情', exact: true }).click()
  await page.getByRole('button', { name: '查看完整整理报告', exact: true }).click()
  const report = page.getByRole('dialog', { name: '世界资产整理报告', exact: true })
  const relations = report.getByRole('region', { name: '第三步人物关系', exact: true })
  await expect(relations).toContainText('实际修改 1 对')
  await expect(relations).toContainText('人物对共 1 对')
  await expect(relations).toContainText('已修改 1 对')
  await expect(relations).toContainText('修改前：朋友')
  await expect(relations).toContainText('修改后：空')
  await expect(relations).toContainText('依据：第一章明确这两个人彼此并不认识')
  expect(deletes).toBe(1)
})


test('P2性能隔离样本：历史日志下三个步骤和详情响应', async ({ page }, testInfo) => {
  test.setTimeout(180000)
  await page.route('**/world-fixture/v1/chat/completions', async route => {
    const body = route.request().postDataJSON()
    const response = organizationResponse(body) ?? worldResponse(body)
    await route.fulfill({ contentType: 'text/event-stream', body: await response.text() })
  })
  await prepare(page)
  await page.evaluate(async () => {
    const name = (await indexedDB.databases()).find(row => row.name?.startsWith('westworld_canon_'))!.name!
    const request = indexedDB.open(name)
    const db = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result) })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('storySessionEntries', 'readwrite')
      for (let i = 0; i < 400; i++) tx.objectStore('storySessionEntries').put({ id: `historical-${i}`, bookId: name.slice('westworld_canon_'.length), sessionId: 'historical', runId: 'historical', type: 'request_trace', input: { messages: [{ role: 'user', content: '历史记录'.repeat(7500) }] }, ordinal: i, parentId: null, createdAt: '2026-01-01T00:00:00Z' })
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
    })
    db.close()
    const metrics = { longTasks: [] as number[], fullLogReads: 0 }
    Object.assign(window, { p2Metrics: metrics })
    new PerformanceObserver(list => { metrics.longTasks.push(...list.getEntries().map(entry => entry.duration)) }).observe({ type: 'longtask', buffered: false })
    const original = IDBObjectStore.prototype.getAll
    IDBObjectStore.prototype.getAll = function (...args: Parameters<typeof original>) {
      if (this.name === 'storySessionEntries') metrics.fullLogReads++
      return original.apply(this, args)
    }
  })
  const timings: Record<string, number> = {}
  for (const name of ['第一步：识别重复人物', '第二步：优化人物资料', '第三步：整理人物关系']) {
    const started = Date.now()
    const button = page.getByRole('button', { name, exact: true })
    await button.click()
    await expect.poll(() => page.evaluate(async step => {
      const name = (await indexedDB.databases()).find(row => row.name?.startsWith('westworld_canon_'))!.name!
      const request = indexedDB.open(name)
      const db = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result) })
      const runs = await new Promise<Record<string, unknown>[]>(resolve => { const req = db.transaction('pipelineRuns').objectStore('pipelineRuns').getAll(); req.onsuccess = () => resolve(req.result) })
      db.close()
      return runs.some(run => (run.organization as { runStep?: string } | undefined)?.runStep === step && run.status === 'completed')
    }, name.startsWith('第一') ? 'scan' : name.startsWith('第二') ? 'profiles' : 'relations'), { timeout: 90000 }).toBe(true)
    await expect(button).toBeEnabled({ timeout: 90000 })
    timings[name] = Date.now() - started
  }
  await page.getByRole('button', { name: '整理详情', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '整理详情', exact: true })
  await dialog.getByRole('tab', { name: /第二步：整理人物资料/ }).click()
  await dialog.getByRole('button', { name: /人物资料 · 沈青/ }).first().click({ timeout: 30000 })
  await dialog.locator('.run-api-boundary > summary').first().click()
  await expect(dialog.locator('.run-api').first()).toBeVisible({ timeout: 30000 })
  const metrics = await page.evaluate(() => (window as unknown as { p2Metrics: { longTasks: number[]; fullLogReads: number } }).p2Metrics)
  const result = { timings, fullLogReads: metrics.fullLogReads, longTaskCount: metrics.longTasks.length, maxLongTaskMs: Math.max(0, ...metrics.longTasks), totalLongTaskMs: metrics.longTasks.reduce((a, b) => a + b, 0) }
  console.log('P2_PERFORMANCE', JSON.stringify(result))
  await testInfo.attach('p2-performance.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
  await dialog.locator('.run-api-boundary > summary').first().click()
  await expect(dialog.locator('.run-api')).toHaveCount(0)
  await dialog.locator('.run-api-boundary > summary').first().click()
  await expect(dialog.locator('.run-api').first()).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('p2-details-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('p2-details-mobile.png') })
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
})
