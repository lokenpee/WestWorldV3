import { expect, test, type Page } from '@playwright/test'
import { addEmptyBook } from '../support/browser-books'
import { worldResponse, worldText } from '../support/world-streams'
import { organizationResponse } from '../support/organization-streams'

test.setTimeout(60000)

test('AI人物整理单入口完成目录扫描、合并、资料与关系，报告显示进度和疑似组结论', async ({ page }, testInfo) => {
  await page.route('**/world-fixture/v1/chat/completions', async route => {
    const body = route.request().postDataJSON()
    const organization = organizationResponse(body)
    await route.fulfill({ contentType: 'text/event-stream', body: await (organization ?? worldResponse(body)).text() })
  })
  await prepare(page)
  await expect(page.getByLabel('整理范围', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /人物关系核对/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'AI整理', exact: true }).click()
  const report = page.getByRole('dialog', { name: '世界资产整理报告', exact: true })
  await expect(report).toContainText('人物 7 → 5', { timeout: 20000 })
  await expect(report).toContainText('地点 3 → 2')
  await expect(report).toContainText('人物整理进度')
  await expect(report).toContainText('目录扫描 1/1 页')
  await expect(report).toContainText('疑似同人结论（1）')
  await expect(report).toContainText('已合并：沈青、沈青、老沈')
  await expect(report).toContainText('第二步：整理人物资料 · 已完成')
  await expect(report).toContainText('第三步：整理人物关系 · 已完成')
  await report.getByRole('button', { name: '关闭报告', exact: true }).click()
  await expect(page.getByRole('button', { name: '请求与用量', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '查看整理报告', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '整理详情', exact: true }).click()
  const trace = page.getByRole('dialog', { name: '整理详情', exact: true })
  await expect(trace).toContainText('运行过程')
  await expect(trace).toContainText('修改结果')
  await expect(trace).toContainText('用量')
  await expect(trace).toContainText('工作请求')
  await expect(trace).toContainText('工具')
  await expect(trace.getByRole('tab', { name: /目录扫描/ }).first()).toBeVisible()
  await expect(trace.getByRole('tab', { name: /沈青/ }).first()).toBeVisible()
  await trace.getByRole('tab', { name: /沈青/ }).first().click()
  await expect(trace.getByRole('tab', { name: /人物资料/ }).first()).toBeVisible()
  await trace.getByText(/窗口提示词与工具定义/).first().click()
  await expect(trace).toContainText('系统提示词')
  await expect(trace).toContainText('工具定义')
  await trace.getByRole('tab', { name: '修改结果', exact: true }).click()
  await expect(trace).toContainText('实际写库修改')
  await trace.getByRole('tab', { name: '用量', exact: true }).click()
  await expect(trace).toContainText('实际请求')
  await trace.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByRole('button', { name: '编辑 沈青', exact: true })).toHaveCount(1)
  await expect(page.getByRole('button', { name: '编辑 张三丰', exact: true })).toBeVisible()
  await page.setViewportSize({ width: 375, height: 812 })
  await page.getByRole('button', { name: '整理详情', exact: true }).click()
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
  await page.getByRole('button', { name: '查看整理报告', exact: true }).click()
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
      const inputs = body.messages.filter((message: { role: string; content: unknown }) => message.role === 'user').flatMap((message: { content: unknown }) => {
        try { return [JSON.parse(String(message.content))] } catch { return [] }
      })
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
    if (!await report.count()) await page.getByRole('button', { name: '查看整理报告', exact: true }).click()
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
      const input = body.messages.filter((message: { role: string; content: unknown }) => message.role === 'user').flatMap((message: { content: unknown }) => { try { return [JSON.parse(String(message.content))] } catch { return [] } }).at(-1)
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
      const inputs = body.messages.filter((message: { role: string }) => message.role === 'user').flatMap((message: { content: unknown }) => { try { return [JSON.parse(String(message.content))] } catch { return [] } })
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
      return [{ name: 'submit_relation_review', args: { changes: [{ targetId: pair.toId, action: 'delete', reason: '原文明确药师陆川与镖师陆川彼此并不认识，删除误连的朋友关系' }], done: true, reason: '删除误连关系', basis: [{ summary: '第一章明确这两个人彼此并不认识', source: { kind: 'chapter', chapterIndex: '1' } }] } }]
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
  await page.getByRole('button', { name: 'AI整理', exact: true }).click()
  const report = page.getByRole('dialog', { name: '世界资产整理报告', exact: true })
  await expect(report).toContainText('三步整理及出场统计已完成', { timeout: 45000 })
  const relations = report.getByRole('region', { name: '第三步人物关系', exact: true })
  await expect(relations).toContainText('实际修改 1 对')
  await expect(relations).toContainText('人物对已核对 1/1 对')
  await expect(relations).toContainText('修改前：朋友')
  await expect(relations).toContainText('修改后：空')
  await expect(relations).toContainText('依据：第一章明确这两个人彼此并不认识')
  expect(deletes).toBe(1)
})
