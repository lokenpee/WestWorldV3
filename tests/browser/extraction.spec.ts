import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

async function prepare(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('服务基础地址', { exact: true }).fill(`${new URL(page.url()).origin}/extraction-fixture/v1`)
  await page.getByLabel('API Key（密钥）', { exact: true }).fill('extraction-browser-fixture')
  await page.getByRole('button', { name: '保存模型配置', exact: true }).click()
  await expect(page.getByText(/当前服务 deepseek：密钥已配置/)).toBeVisible()
  await page.getByRole('button', { name: '资产', exact: true }).click()
  await page.getByLabel('小说TXT文件').setInputFiles(fileURLToPath(new URL('../fixtures/A-三章短篇.txt', import.meta.url)))
  await page.getByRole('button', { name: '仅导入', exact: true }).click()
  await expect(page.getByRole('button', { name: '开始提取', exact: true })).toBeEnabled()
}
function response(value: unknown) {
  const frame = (delta: object, finish_reason: string | null) => ({ id: 'browser-extract', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason }] })
  return [frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'submit', type: 'function', function: { name: 'submit_result', arguments: JSON.stringify(value) } }] }, null), frame({}, 'tool_calls')].map(row => `data: ${JSON.stringify(row)}\n\n`).join('') + 'data: [DONE]\n\n'
}

test('真实SDK逐章提取即时显示、运行中编辑、刷新保留与手机布局', async ({ page }, testInfo) => {
  let count = 0; let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/extraction-fixture/v1/chat/completions', async route => {
    const body = route.request().postDataJSON(); count++
    expect(body.messages.filter((row: { role: string }) => row.role === 'user')).toHaveLength(1)
    if (count === 2) await gate
    const world = !!body.tools[0].function.parameters.properties.characters
    await route.fulfill({ contentType: 'text/event-stream', body: response(world ? { characters: [{ name: '船夫沈青', confidence: 1 }], locations: [{ name: '青石客栈', confidence: 1 }] } : { nodes: [{ name: '信件流转', summary: '转交信件', actors: ['船夫沈青'], quote: '', confidence: 1 }] }) })
  })
  await prepare(page)
  await page.getByRole('button', { name: '开始提取', exact: true }).click()
  const results = page.getByRole('region', { name: '章节提取结果', exact: true })
  await expect(results).toContainText('人物与地点 · 成功')
  await expect(page.getByRole('region', { name: '逐章提取', exact: true })).toContainText('正在提取')
  await expect(page.getByText('船夫沈青', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: '编辑 船夫沈青', exact: true }).click()
  await page.getByLabel('身份', { exact: true }).fill('人工确认的送信人')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已保存' }).last()).toBeVisible()
  release()
  await expect(page.getByRole('region', { name: '逐章提取', exact: true })).toContainText('提取完成 · 成功 4/4')
  expect(count).toBe(8)
  await expect(results).toHaveCount(0)
  await page.getByRole('button', { name: '查看章节结果', exact: true }).click()
  await expect(results.locator('article')).toHaveCount(8)
  await page.getByRole('button', { name: '收起章节结果', exact: true }).click()
  await expect(results).toHaveCount(0)
  await page.setViewportSize({ width: 375, height: 812 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('region', { name: '逐章提取', exact: true }).screenshot({ path: testInfo.outputPath('extraction-mobile.png') })
  await page.reload()
  await expect(page.getByRole('button', { name: '已完成提取', exact: true })).toBeDisabled()
  await expect(page.getByText('船夫沈青', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: '编辑 船夫沈青', exact: true }).first().click()
  await expect(page.getByLabel('身份', { exact: true })).toHaveValue('人工确认的送信人')
})

test('世界失败与叙事成功分别显示，取消终止后续章节', async ({ page }) => {
  let count = 0
  await page.route('**/extraction-fixture/v1/chat/completions', async route => {
    count++
    const world = !!route.request().postDataJSON().tools[0].function.parameters.properties.characters
    if (world) await route.fulfill({ status: 401, json: { error: { message: 'invalid key' } } })
    else await route.fulfill({ contentType: 'text/event-stream', body: response({ nodes: [] }) })
  })
  await prepare(page)
  await page.getByRole('button', { name: '开始提取', exact: true }).click()
  const panel = page.getByRole('region', { name: '逐章提取', exact: true })
  await expect(panel).toContainText('有失败步骤 · 成功 0/4')
  await expect(panel).toContainText('子步骤：成功 4 项 · 失败 4 项')
  await page.getByRole('button', { name: '查看章节结果', exact: true }).click()
  await expect(panel).toContainText('人物与地点 · 失败')
  await expect(panel).toContainText('事件节点 · 成功')
  expect(count).toBe(8)
  await page.unroute('**/extraction-fixture/v1/chat/completions')
  await page.route('**/extraction-fixture/v1/chat/completions', route => { count++; return route.fulfill({ status: 429, headers: { 'Retry-After': '30' }, json: { error: { message: 'rate limit' } } }) })
  await page.getByRole('button', { name: '继续提取', exact: true }).click()
  await expect(panel).toContainText('等待重试')
  await page.getByRole('button', { name: '取消提取', exact: true }).click()
  await expect(panel).toContainText('提取已取消')
  expect(count).toBe(9)
})


async function expireExtractionLease(page: Page) {
  await page.evaluate(async () => {
    const names = (await indexedDB.databases()).map(row => row.name).filter((name): name is string => !!name?.startsWith('westworld_canon_'))
    if (names.length !== 1) throw new Error('验收需要唯一的样本书库')
    const request = indexedDB.open(names[0])
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('pipelineRuns', 'readwrite'); const store = tx.objectStore('pipelineRuns'); const read = store.get('lease:extraction')
      read.onsuccess = () => { if (!read.result) { tx.abort(); return }; store.put({ ...read.result, expiresAt: 0 }) }
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(new Error('租约不存在'))
    }); db.close()
  })
}

const extractedWorld = { characters: [{ name: '船夫沈青', confidence: 1 }], locations: [{ name: '青石客栈', confidence: 1 }] }
const extractedNarrative = { nodes: [{ name: '信件流转', summary: '转交信件', actors: ['船夫沈青'], quote: '', confidence: 1 }] }

test('取消后编辑并刷新，只继续七个缺失步骤，保存的人工资料保持有效', async ({ page }) => {
  const calls: boolean[] = []; let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/extraction-fixture/v1/chat/completions', async route => {
    const world = !!route.request().postDataJSON().tools[0].function.parameters.properties.characters
    calls.push(world)
    if (calls.length === 2) { await gate; await route.abort().catch(() => undefined); return }
    await route.fulfill({ contentType: 'text/event-stream', body: response(world ? extractedWorld : extractedNarrative) })
  })
  await prepare(page)
  await page.getByRole('button', { name: '开始提取', exact: true }).click()
  await expect.poll(() => calls.length).toBe(2)
  await page.getByRole('button', { name: '取消提取', exact: true }).click()
  await expect(page.getByRole('button', { name: '继续提取', exact: true })).toBeEnabled(); release()
  await page.getByRole('button', { name: '编辑 船夫沈青', exact: true }).click()
  await page.getByLabel('身份', { exact: true }).fill('中断后人工确认的身份')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已保存' }).last()).toBeVisible()
  await page.reload()
  const panel = page.getByRole('region', { name: '逐章提取', exact: true })
  await expect(panel).toContainText('已保存 1/8 个子步骤')
  await page.getByRole('button', { name: '继续提取', exact: true }).click()
  await expect(panel).toContainText('提取完成 · 成功 4/4')
  expect(calls).toHaveLength(9)
  expect(calls[2]).toBe(false)
  await page.getByRole('button', { name: '编辑 船夫沈青', exact: true }).filter({ hasText: '中断后人工确认的身份' }).click()
  await expect(page.getByLabel('身份', { exact: true })).toHaveValue('中断后人工确认的身份')
})

test('请求中刷新后等待执行权到期，恢复进度不自动请求，点击继续后补缺', async ({ page }, testInfo) => {
  const calls: boolean[] = []; let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/extraction-fixture/v1/chat/completions', async route => {
    const world = !!route.request().postDataJSON().tools[0].function.parameters.properties.characters
    calls.push(world)
    if (calls.length === 2) { await gate; await route.abort().catch(() => undefined); return }
    await route.fulfill({ contentType: 'text/event-stream', body: response(world ? extractedWorld : extractedNarrative) })
  })
  await prepare(page)
  await page.getByRole('button', { name: '开始提取', exact: true }).click()
  await expect.poll(() => calls.length).toBe(2)
  await page.reload(); release()
  await expect(page.getByRole('button', { name: '正在确认任务状态…', exact: true })).toBeDisabled()
  expect(calls).toHaveLength(2)
  await expireExtractionLease(page)
  await expect(page.getByRole('button', { name: '继续提取', exact: true })).toBeEnabled()
  const panel = page.getByRole('region', { name: '逐章提取', exact: true })
  await expect(panel).toContainText('已暂停')
  await expect(panel).toContainText('已保存 1/8 个子步骤')
  expect(calls).toHaveLength(2)
  await page.setViewportSize({ width: 375, height: 812 })
  await panel.screenshot({ path: testInfo.outputPath('extraction-recovery-mobile.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: '继续提取', exact: true }).click()
  await expect(panel).toContainText('提取完成 · 成功 4/4')
  expect(calls).toHaveLength(9)
  expect(calls[2]).toBe(false)
})

test('同书第二标签不能接管仍运行的任务，即使租约过期也保持单一执行者', async ({ page, context }) => {
  let calls = 0; let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  await context.route('**/extraction-fixture/v1/chat/completions', async route => {
    const world = !!route.request().postDataJSON().tools[0].function.parameters.properties.characters
    calls++
    if (calls === 2) { await gate; await route.abort().catch(() => undefined); return }
    await route.fulfill({ contentType: 'text/event-stream', body: response(world ? extractedWorld : extractedNarrative) })
  })
  await prepare(page)
  await page.getByRole('button', { name: '开始提取', exact: true }).click()
  await expect.poll(() => calls).toBe(2)
  const other = await context.newPage(); await other.goto('/')
  await expect(other.getByRole('button', { name: '正在确认任务状态…', exact: true })).toBeDisabled()
  await expireExtractionLease(other)
  const acquired = await other.evaluate(async () => {
    const held = (await navigator.locks.query()).held?.find(lock => lock.name?.startsWith('westworld-extraction:'))
    if (!held?.name) throw new Error('运行任务没有持有执行权')
    return navigator.locks.request(held.name, { ifAvailable: true }, lock => !!lock)
  })
  expect(acquired).toBe(false)
  expect(calls).toBe(2)
  await page.getByRole('button', { name: '取消提取', exact: true }).click()
  await expect(other.getByRole('button', { name: '继续提取', exact: true })).toBeEnabled(); release()
  await other.getByRole('button', { name: '继续提取', exact: true }).click()
  await expect(other.getByRole('region', { name: '逐章提取', exact: true })).toContainText('提取完成 · 成功 4/4', { timeout: 20000 })
  expect(calls).toBe(9)
})
