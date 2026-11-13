import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { storyResponse, storyTask } from '../support/story-protocol'
import { addEmptyBook } from '../support/browser-books'

const seed = JSON.parse(readFileSync(new URL('../fixtures/F-跨窗口叙事.json', import.meta.url), 'utf8')) as { tables: Record<string, Record<string, unknown>[]> }
async function prepare(page: Page, contextWindow?: string) {
  await page.goto('/')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('服务基础地址', { exact: true }).fill(`${new URL(page.url()).origin}/story-fixture/v1`)
  await page.getByLabel('API Key（密钥）', { exact: true }).fill('story-browser-fixture')
  if (contextWindow) { await page.getByText('高级设置（可选）', { exact: true }).click(); await page.getByLabel('整理模型上下文容量', { exact: true }).fill(contextWindow) }
  await page.getByRole('button', { name: '保存模型配置', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '模型配置已保存' })).toBeVisible()
  await page.getByRole('button', { name: '资产', exact: true }).click()
  const text = seed.tables.chapterTexts.map(row => row.text).join('')
  await page.getByLabel('小说TXT文件').setInputFiles({ name: '跨窗口信件样本.txt', mimeType: 'text/plain', buffer: Buffer.from(text) })
  await page.getByRole('button', { name: '仅导入', exact: true }).click()
  await expect(page.getByRole('heading', { name: '跨窗口信件样本', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '串联事件线', exact: true })).toBeDisabled()
  const tables = structuredClone(seed.tables)
  tables.nodes = Array.from({ length: 24 }, (_, index) => ({ ...seed.tables.nodes[index % seed.tables.nodes.length], id: `reading-node-${String(index + 1).padStart(3, '0')}`, name: `信件进展${index + 1}`, order: Math.floor(index / seed.tables.nodes.length) }))
  await page.evaluate(async tables => {
    const prefix = 'westworld_canon_'
    const name = (await indexedDB.databases()).find(row => row.name?.startsWith(prefix))?.name
    if (!name) throw new Error('样本书库未创建')
    const bookId = name.slice(prefix.length), request = indexedDB.open(name)
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(Object.keys(tables), 'readwrite')
      for (const [table, rows] of Object.entries(tables)) { const store = tx.objectStore(table); store.clear(); for (const row of rows) store.put({ ...row, bookId }) }
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
    }); db.close()
  }, tables)
  await page.reload()
  await expect(page.getByRole('button', { name: '串联事件线', exact: true })).toBeEnabled()
}

test('AI主动翻三页复用事件线，进度与实际修改刷新保留，窄屏操作可达', async ({ page }, testInfo) => {
  test.setTimeout(60000)
  const pages: number[] = []; let calls = 0
  const duplicateKeys: string[] = []
  page.on('console', message => { if (message.text().includes('same key')) duplicateKeys.push(message.text()) })
  await page.route('**/story-fixture/v1/chat/completions', async route => {
    calls++; const body = route.request().postDataJSON(); const { input } = storyTask(body)
    expect(input.contextHints.assigned.length).toBeLessThanOrEqual(10)
    expect(input.contextHints.assigned.every((row: Record<string, unknown>) => row.process === undefined && row.quote === undefined)).toBe(true)
    expect(body.tools.some((tool: { function: { name: string } }) => tool.function.name === 'search_story_context')).toBe(true)
    expect(body.tools.some((tool: { function: { name: string } }) => tool.function.name === 'navigate_story_pages')).toBe(true)
    pages.push(input.page.pageNumber)
    await route.fulfill({ contentType: 'text/event-stream', body: await storyResponse(body).text() })
  })
  await prepare(page)
  await page.getByRole('button', { name: '串联事件线', exact: true }).click()
  const panel = page.getByRole('region', { name: '事件线窗口串联', exact: true })
  await expect(panel).toContainText('串联完成 · 已检查 3/3 页', { timeout: 30000 })
  expect([...new Set(pages)]).toEqual([1, 2, 3])
  await panel.getByRole('button', { name: '整理详情', exact: true }).click()
  const trace = page.getByRole('dialog', { name: '整理详情', exact: true })
  await expect(trace).toContainText('API 请求')
  await expect(trace).toContainText('SYSTEM')
  await expect(trace).toContainText('USER')
  await expect(trace).toContainText('TOOL CALL')
  await expect(trace).toContainText('navigate_story_pages')
  await expect(trace.getByRole('tab', { name: /人物资料|人物关系/ })).toHaveCount(0)
  await expect(trace).toContainText('本次实际修改')
  await expect(trace).not.toContainText('本次没有实际写库修改')
  await expect(trace).toContainText('修改前')
  await expect(trace).toContainText('修改后')
  await trace.getByRole('button', { name: '关闭', exact: true }).click()
  await panel.getByText('阅读进度与串联依据', { exact: true }).click()
  await expect(panel).toContainText('第 1 页')
  await expect(panel).toContainText('第 3 页')
  await page.getByRole('button', { name: /^事件线 1$/ }).click()
  await expect(page.getByRole('button', { name: '编辑 信件流转', exact: true })).toHaveCount(1)
  await page.reload()
  await expect(panel).toContainText('串联完成 · 已检查 3/3 页', { timeout: 15000 })
  const previous = calls
  await page.getByRole('button', { name: '重新串联事件线', exact: true }).click()
  await expect(panel).toContainText('串联完成 · 已检查 3/3 页', { timeout: 15000 })
  expect(calls).toBe(previous)
  await expect(page.getByRole('button', { name: '重新串联事件线', exact: true })).toBeEnabled()
  expect(duplicateKeys).toEqual([])
  await page.setViewportSize({ width: 375, height: 812 })
  await panel.screenshot({ path: testInfo.outputPath('story-mobile.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('取消保留已提交线与阅读页，叙事编辑锁生效，继续从未完成页开始', async ({ page }) => {
  test.setTimeout(60000)
  let calls = 0; let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/story-fixture/v1/chat/completions', async route => {
    calls++
    if (calls === 4) { await gate; await route.abort().catch(() => undefined); return }
    await route.fulfill({ contentType: 'text/event-stream', body: await storyResponse(route.request().postDataJSON()).text() })
  })
  await prepare(page)
  await page.getByRole('button', { name: '串联事件线', exact: true }).click()
  await expect.poll(() => calls, { timeout: 15000 }).toBe(4)
  await page.getByRole('button', { name: /^事件节点 24$/ }).click()
  await expect(page.getByRole('button', { name: '新增事件节点', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '取消串联', exact: true }).click()
  const panel = page.getByRole('region', { name: '事件线窗口串联', exact: true })
  await expect(panel).toContainText('串联已取消 · 已检查 1/3 页')
  await expect(page.getByRole('button', { name: '新增事件节点', exact: true })).toBeEnabled()
  release()
  await page.getByRole('button', { name: '继续串联事件线', exact: true }).click()
  await expect(panel).toContainText('串联完成 · 已检查 3/3 页', { timeout: 30000 })
  await page.getByRole('button', { name: /^事件线 1$/ }).click()
  await expect(page.getByRole('button', { name: '编辑 信件流转', exact: true })).toHaveCount(1)
})

test('全书复核压缩长历史，刷新后保留原会话、完整历史与复核结论', async ({ page }, testInfo) => {
  test.setTimeout(90000)
  await page.route('**/story-fixture/v1/chat/completions', async route => {
    await route.fulfill({ contentType: 'text/event-stream', body: await storyResponse(route.request().postDataJSON()).text() })
  })
  await prepare(page, '65536')
  await page.getByRole('button', { name: '串联事件线', exact: true }).click()
  const panel = page.getByRole('region', { name: '事件线窗口串联', exact: true })
  await expect(panel).toContainText('串联完成', { timeout: 15000 })
  const sessionId = await page.evaluate(async () => {
    const name = (await indexedDB.databases()).find(row => row.name?.startsWith('westworld_canon_'))!.name!
    const request = indexedDB.open(name)
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const tx = db.transaction(['storySessions', 'storySessionEntries'], 'readwrite')
    const session = await new Promise<Record<string, unknown>>(resolve => { const get = tx.objectStore('storySessions').getAll(); get.onsuccess = () => resolve(get.result[0]) })
    const id = crypto.randomUUID(), now = new Date().toISOString()
    tx.objectStore('storySessionEntries').put({ id, sessionId: session.id, bookId: session.bookId, ordinal: session.nextOrdinal, parentId: session.leafId, type: 'message', message: { role: 'user', content: `浏览器旧历史标记：${'保留本书的原始工具依据。'.repeat(6000)}`, timestamp: Date.now() }, createdAt: now })
    tx.objectStore('storySessions').put({ ...session, leafId: id, nextOrdinal: Number(session.nextOrdinal) + 1, updatedAt: now })
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error) }); db.close()
    return String(session.id)
  })
  await page.getByRole('button', { name: '全书复核', exact: true }).click()
  await expect(panel).toContainText('全书复核完成', { timeout: 30000 })
  await expect(panel).toContainText('待检查 0 项')
  await expect(panel).toContainText(/已压缩 [1-9]\d* 次/)
  await page.reload()
  await expect(panel).toContainText('全书复核完成', { timeout: 15000 })
  await panel.getByRole('button', { name: '查看会话历史', exact: true }).click()
  await expect(panel).toContainText(sessionId)
  const history = panel.getByLabel('本书会话历史', { exact: true })
  await history.getByRole('button', { name: '下一页记录', exact: true }).click()
  await expect(history).toContainText(/21–/)
  for (let turn = 0; turn < 4 && !await history.locator('details').filter({ hasText: '浏览器旧历史标记' }).count(); turn++) {
    await history.getByRole('button', { name: '下一页记录', exact: true }).click()
    await expect(history).toContainText(new RegExp(`${41 + turn * 20}–`))
  }
  const longLabel = await history.locator('details').filter({ hasText: '浏览器旧历史标记' }).first().locator('summary').textContent()
  const longEntry = history.locator('details').filter({ has: page.locator('summary', { hasText: longLabel! }) })
  await longEntry.locator('summary').click()
  await longEntry.getByRole('button', { name: '下一段内容', exact: true }).click()
  await expect(longEntry).toContainText('12001–')
  await panel.getByText('工作记忆与待复核事项', { exact: true }).click()
  await panel.getByText('阅读进度与串联依据', { exact: true }).click()
  await page.setViewportSize({ width: 1366, height: 768 })
  await panel.screenshot({ path: testInfo.outputPath('story-review-desktop.png') })
  await page.setViewportSize({ width: 375, height: 812 })
  await panel.screenshot({ path: testInfo.outputPath('story-review-mobile.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await panel.evaluate(element => element.clientHeight <= innerHeight - 100)).toBe(true)
  expect(await history.locator('.story-details-body').evaluate(element => element.clientHeight <= innerHeight * 0.36 + 1)).toBe(true)
})

test('切到另一书后晚到的串联结果保持原书归属', async ({ page }) => {
  let release: () => void = () => undefined, calls = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/story-fixture/v1/chat/completions', async route => {
    if (++calls === 1) await gate
    await route.fulfill({ contentType: 'text/event-stream', body: await storyResponse(route.request().postDataJSON()).text() })
  })
  await prepare(page)
  await addEmptyBook(page, 'book-other', '另一书')
  await page.getByRole('button', { name: '串联事件线', exact: true }).click()
  await expect.poll(() => calls).toBe(1)
  await page.getByRole('button', { name: '进入 另一书', exact: true }).click()
  release()
  await expect(page.getByRole('heading', { name: '另一书', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^事件线 0$/ })).toBeVisible()
  await expect(page.getByRole('region', { name: '事件线窗口串联', exact: true })).not.toContainText('正在串联')
  await expect.poll(() => calls, { timeout: 20000 }).toBeGreaterThanOrEqual(11)
  await page.getByRole('button', { name: '进入 跨窗口信件样本', exact: true }).click()
  await expect(page.getByRole('region', { name: '事件线窗口串联', exact: true })).toContainText('已检查 3/3 页', { timeout: 15000 })
  await expect(page.getByRole('button', { name: /^事件线 1$/ })).toBeVisible()
})

test('失效标签的叙事执行权到期后，页面自动恢复启动入口', async ({ page }) => {
  await prepare(page)
  await page.evaluate(async () => {
    const name = (await indexedDB.databases()).find(row => row.name?.startsWith('westworld_canon_'))!.name!
    const request = indexedDB.open(name)
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('pipelineRuns', 'readwrite')
      tx.objectStore('pipelineRuns').put({ id: 'lease:narrative', bookId: name.slice('westworld_canon_'.length), recordType: 'lease', lockKey: 'narrative', runId: 'interrupted', owner: 'closed-tab', expiresAt: Date.now() + 10000 })
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
    }); db.close()
  })
  await page.reload()
  await expect(page.getByRole('button', { name: '串联事件线', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '串联事件线', exact: true })).toBeEnabled({ timeout: 20000 })
})
