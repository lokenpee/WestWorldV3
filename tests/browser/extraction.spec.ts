import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'
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
  await expect(page.getByRole('button', { name: '一起提取', exact: true })).toBeEnabled()
}
function response(value: unknown) {
  const frame = (delta: object, finish_reason: string | null) => ({ id: 'browser-extract', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason }] })
  return [frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'submit', type: 'function', function: { name: 'submit_result', arguments: JSON.stringify(value) } }] }, null), frame({}, 'tool_calls')].map(row => `data: ${JSON.stringify(row)}\n\n`).join('') + 'data: [DONE]\n\n'
}

const worldData = { characters: [{ name: '船夫沈青', confidence: 1 }], locations: [{ name: '青石客栈', confidence: 1 }] }
const narrativeData = { nodes: [{ name: '信件流转', summary: '转交信件', actors: ['船夫沈青'], quote: '', confidence: 1 }] }
const panelOf = (page: Page) => page.getByRole('region', { name: '逐章提取', exact: true })
async function expireLeases(page: Page) {
  await page.evaluate(async () => {
    const name = (await indexedDB.databases()).find(row => row.name?.startsWith('westworld_canon_'))?.name
    if (!name) throw new Error('样本书库不存在')
    const request = indexedDB.open(name)
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('pipelineRuns', 'readwrite'), store = tx.objectStore('pipelineRuns'), cursor = store.openCursor()
      cursor.onsuccess = () => { const row = cursor.result; if (!row) return; if (row.value.recordType === 'lease') row.update({ ...row.value, expiresAt: 0 }); row.continue() }
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
    }); db.close()
  })
}

test('一起并行提取可暂停继续，固定四按钮与手机布局', async ({ page }, testInfo) => {
  let calls = 0, holding = true, release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/extraction-fixture/v1/chat/completions', async route => {
    calls++
    if (holding) await gate
    const world = !!route.request().postDataJSON().tools[0].function.parameters.properties.characters
    await route.fulfill({ contentType: 'text/event-stream', body: response(world ? worldData : narrativeData) }).catch(() => undefined)
  })
  await prepare(page)
  const panel = panelOf(page)
  await expect(panel.locator('.extraction-actions > button')).toHaveCount(4)
  await page.getByRole('button', { name: '一起提取', exact: true }).click()
  await expect.poll(() => calls).toBe(2)
  await expect(page.getByRole('button', { name: '重新提取世界资产', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '重新提取叙事资产', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '暂停提取', exact: true }).click()
  await expect(page.getByRole('button', { name: '继续提取', exact: true })).toBeEnabled()
  holding = false; release()
  await page.getByRole('button', { name: '继续提取', exact: true }).click()
  await expect(panel).toContainText('提取完成 · 成功 4/4')
  expect(calls).toBe(10)
  await page.getByRole('button', { name: '查看章节结果', exact: true }).click()
  await expect(panel.getByRole('region', { name: '章节提取结果' }).locator('article')).toHaveCount(8)
  await page.setViewportSize({ width: 375, height: 812 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await panel.screenshot({ path: testInfo.outputPath('four-controls-mobile.png') })
  await page.reload()
  await expect(page.getByRole('button', { name: '提取完成', exact: true })).toBeDisabled()
})

test('每章待提取可单提，失败和成功复用同一个小按钮重提', async ({ page }) => {
  let calls = 0, fail = true
  await page.route('**/extraction-fixture/v1/chat/completions', async route => {
    calls++
    if (fail) await route.fulfill({ status: 401, json: { error: { message: 'invalid key' } } })
    else await route.fulfill({ contentType: 'text/event-stream', body: response(worldData) })
  })
  await prepare(page)
  const overview = page.getByRole('region', { name: '章节概览' })
  await overview.getByRole('button', { name: '提取第1章 世界资产', exact: true }).click()
  const retry = overview.getByRole('button', { name: '重新提取第1章 世界资产', exact: true })
  await expect(overview.getByLabel('第1章 世界资产：提取失败', { exact: true })).toBeVisible()
  await expect(retry).toBeEnabled()
  fail = false
  await retry.click()
  await expect(overview.getByLabel('第1章 世界资产：提取成功', { exact: true })).toBeVisible()
  await expect(retry).toBeEnabled()
  await retry.click()
  await expect(retry).toBeEnabled()
  await expect(panelOf(page)).toContainText('已保存 1/8 个子步骤')
  await expect.poll(() => calls).toBe(3)
  await expect(overview.getByLabel('第1章 叙事资产：待提取', { exact: true })).toBeVisible()
  await page.reload()
  await expect(retry).toBeEnabled()
})

test('两类重提各自暂停继续，确认即关闭弹窗，取消恢复名称', async ({ page }) => {
  let holding = false, worldCalls = 0, narrativeCalls = 0, release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/extraction-fixture/v1/chat/completions', async route => {
    const world = !!route.request().postDataJSON().tools[0].function.parameters.properties.characters
    const count = world ? ++worldCalls : ++narrativeCalls
    if (holding && count > 1) await gate
    await route.fulfill({ contentType: 'text/event-stream', body: response(world ? worldData : narrativeData) }).catch(() => undefined)
  })
  await prepare(page)
  await page.getByRole('button', { name: '一起提取', exact: true }).click()
  await expect(panelOf(page)).toContainText('提取完成 · 成功 4/4')
  await page.getByRole('button', { name: '取消提取', exact: true }).click()
  holding = true; worldCalls = 0; narrativeCalls = 0
  await page.getByRole('button', { name: '重新提取世界资产', exact: true }).click()
  await page.getByRole('button', { name: '清空并重新提取', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '确认重新提取' })).toHaveCount(0)
  await expect.poll(() => worldCalls).toBe(2)
  await expect(page.getByRole('button', { name: '重新提取叙事资产', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: '继续提取未完成章节', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '重新提取叙事资产', exact: true }).click()
  await page.getByRole('button', { name: '清空并重新提取', exact: true }).click()
  await expect.poll(() => narrativeCalls).toBe(2)
  await page.getByRole('button', { name: '暂停世界资产提取', exact: true }).click()
  await expect(page.getByRole('button', { name: '继续世界资产提取', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: '暂停叙事资产提取', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '暂停叙事资产提取', exact: true }).click()
  await expect(page.getByRole('button', { name: '继续叙事资产提取', exact: true })).toBeEnabled()
  holding = false; release()
  await page.getByRole('button', { name: '继续世界资产提取', exact: true }).click()
  await page.getByRole('button', { name: '继续叙事资产提取', exact: true }).click()
  await expect(panelOf(page)).toContainText('提取完成 · 成功 4/4')
  expect(worldCalls).toBe(5); expect(narrativeCalls).toBe(5)
  await page.getByRole('button', { name: '取消提取', exact: true }).click()
  await expect(page.getByRole('button', { name: '重新提取世界资产', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: '重新提取叙事资产', exact: true })).toBeEnabled()
  await expect(page.getByText('取消待继续重提', { exact: true })).toHaveCount(0)
})

test('取消后只补七个缺失步骤，已保存人工内容保留', async ({ page }) => {
  let holding = true, calls = 0, worldCalls = 0, release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/extraction-fixture/v1/chat/completions', async route => {
    calls++
    const world = !!route.request().postDataJSON().tools[0].function.parameters.properties.characters
    if (world) worldCalls++
    if (holding && (!world || worldCalls > 1)) await gate
    await route.fulfill({ contentType: 'text/event-stream', body: response(world ? worldData : narrativeData) }).catch(() => undefined)
  })
  await prepare(page)
  await page.getByRole('button', { name: '一起提取', exact: true }).click()
  await expect(panelOf(page)).toContainText('已保存 1/8 个子步骤')
  await expect.poll(() => calls).toBe(3)
  await page.getByRole('button', { name: '取消提取', exact: true }).click()
  await expect(page.getByRole('button', { name: '继续提取未完成章节', exact: true })).toBeEnabled()
  holding = false; release()
  await page.getByRole('button', { name: '编辑 船夫沈青', exact: true }).click()
  await page.getByLabel('身份', { exact: true }).fill('取消后人工确认')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已保存' }).last()).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: '继续提取未完成章节', exact: true }).click()
  await expect(panelOf(page)).toContainText('提取完成 · 成功 4/4')
  expect(calls).toBe(10)
  await page.getByRole('button', { name: '编辑 船夫沈青', exact: true }).filter({ hasText: '取消后人工确认' }).click()
  await expect(page.getByLabel('身份', { exact: true })).toHaveValue('取消后人工确认')
})

test('请求中刷新恢复暂停范围，恢复不自动请求', async ({ page }) => {
  let holding = true, calls = 0, release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/extraction-fixture/v1/chat/completions', async route => {
    calls++
    if (holding) await gate
    const world = !!route.request().postDataJSON().tools[0].function.parameters.properties.characters
    await route.fulfill({ contentType: 'text/event-stream', body: response(world ? worldData : narrativeData) }).catch(() => undefined)
  })
  await prepare(page)
  await page.getByRole('button', { name: '一起提取', exact: true }).click()
  await expect.poll(() => calls).toBe(2)
  await page.reload()
  await expect(page.getByRole('button', { name: '正在确认任务状态…', exact: true })).toBeDisabled()
  holding = false; release()
  await expireLeases(page)
  await expect(page.getByRole('button', { name: '继续提取', exact: true })).toBeEnabled()
  expect(calls).toBe(2)
  await page.getByRole('button', { name: '继续提取', exact: true }).click()
  await expect(panelOf(page)).toContainText('提取完成 · 成功 4/4')
  expect(calls).toBe(10)
})

test('同书第二标签不能接管仍运行的同类任务', async ({ page, context }) => {
  let holding = true, calls = 0, release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  await context.route('**/extraction-fixture/v1/chat/completions', async route => {
    calls++
    if (holding) await gate
    const world = !!route.request().postDataJSON().tools[0].function.parameters.properties.characters
    await route.fulfill({ contentType: 'text/event-stream', body: response(world ? worldData : narrativeData) }).catch(() => undefined)
  })
  await prepare(page)
  await page.getByRole('button', { name: '一起提取', exact: true }).click()
  await expect.poll(() => calls).toBe(2)
  const other = await context.newPage(); await other.goto('/')
  await expireLeases(other)
  await expect(other.getByRole('button', { name: '正在确认任务状态…', exact: true })).toBeDisabled()
  const available = await other.evaluate(async () => {
    const held = (await navigator.locks.query()).held?.filter(lock => lock.name?.startsWith('westworld-extraction:')) ?? []
    return Promise.all(held.map(lock => navigator.locks.request(lock.name!, { ifAvailable: true }, value => !!value)))
  })
  expect(available.length).toBeGreaterThanOrEqual(2)
  expect(available.every(value => !value)).toBe(true)
  expect(calls).toBe(2)
  await page.getByRole('button', { name: '取消提取', exact: true }).click()
  await expect(other.getByRole('button', { name: '一起提取', exact: true })).toBeEnabled()
  holding = false; release()
  await other.getByRole('button', { name: '一起提取', exact: true }).click()
  await expect(panelOf(other)).toContainText('提取完成 · 成功 4/4')
})

test('两类失败独立显示，章节重试成功后回收入口解锁', async ({ page }) => {
  let fail = true, calls = 0
  await page.route('**/extraction-fixture/v1/chat/completions', async route => {
    calls++
    const world = !!route.request().postDataJSON().tools[0].function.parameters.properties.characters
    await route.fulfill({ contentType: 'text/event-stream', body: response(fail && world ? {} : world ? worldData : narrativeData) })
  })
  await prepare(page)
  await page.getByRole('button', { name: '一起提取', exact: true }).click()
  await expect(panelOf(page)).toContainText('有失败步骤 · 成功 0/4', { timeout: 20000 })
  expect(calls).toBe(16)
  fail = false
  const retry = page.getByRole('button', { name: '重新提取第1章 世界资产', exact: true })
  await retry.click()
  await expect(retry).toBeEnabled()
  await expect(page.getByLabel('第1章 世界资产：提取成功', { exact: true })).toBeVisible()
  expect(calls).toBe(17)
})

test('2000人物6000关系下启动与暂停仍可响应', async ({ page }, testInfo) => {
  test.setTimeout(60000)
  let calls = 0, release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/extraction-fixture/v1/chat/completions', async route => {
    calls++; await gate
    await route.fulfill({ contentType: 'text/event-stream', body: response({ characters: [], locations: [] }) }).catch(() => undefined)
  })
  await prepare(page)
  await page.evaluate(async () => {
    const name = (await indexedDB.databases()).find(row => row.name?.startsWith('westworld_canon_'))!.name!
    const request = indexedDB.open(name)
    const db = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result) })
    const bookId = await new Promise<string>(resolve => { const request = db.transaction('chapters').objectStore('chapters').getAll(); request.onsuccess = () => resolve(request.result[0].bookId) })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['characters', 'characterRelations', 'pipelineRuns'], 'readwrite')
      for (let index = 0; index < 2000; index++) tx.objectStore('characters').put({ id: `P${index}`, bookId, name: `人物${index}`, aliases: [], revision: 1, confidence: 1, createdBy: 'P1' })
      for (let index = 0; index < 6000; index++) {
        const from = index % 2000, to = (from + 1 + Math.floor(index / 2000)) % 2000
        tx.objectStore('characterRelations').put({ id: `R${index}`, bookId, originCharacterId: `P${from}`, sourceName: `人物${from}`, sourceId: `P${from}`, targetName: `人物${to}`, targetIds: [`P${to}`], forwardLabel: '朋友', reverseLabel: '朋友', relationType: 'friendship', direction: 'bidirectional', evidence: [], revision: 1, createdAt: '2026-11-04', updatedAt: '2026-11-04' })
      }
      const timestamp = new Date().toISOString()
      tx.objectStore('pipelineRuns').put({ id: 'history-fixture', bookId, recordType: 'run', stage: 'P1', status: 'completed', startedAt: timestamp, planVersion: '2.2', tasks: Array.from({ length: 150 }, (_, index) => ({ taskId: `history-${index}`, ordinal: index, callId: `call-${index}`, phase: 'worldAssets', status: 'completed', workItemIds: ['P1:worldAssets:chapter:1'], input: { chapterIndex: '1', chapterName: '历史章节', text: '原'.repeat(10000) }, inputFingerprint: 'history', promptHash: 'history', attempt: 1, repairCount: 0, stepsUsed: 1, appliedCommitIds: [], reviewedItems: [], readSet: { records: [], queries: [] }, createdAt: timestamp, updatedAt: timestamp })) })
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
    }); db.close()
  })
  await page.reload()
  await expect(page.getByText('显示 2000 / 2000 条', { exact: false })).toBeVisible()
  await page.evaluate(() => {
    const sample = { startedAt: performance.now(), last: performance.now(), gaps: [] as number[], stopped: false }
    ;(window as unknown as { extractionPerf: typeof sample }).extractionPerf = sample
    const tick = (time: number) => { sample.gaps.push(time - sample.last); sample.last = time; if (!sample.stopped) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  })
  await page.getByRole('button', { name: '一起提取', exact: true }).click()
  await expect.poll(() => calls).toBe(2)
  await page.getByRole('button', { name: '暂停提取', exact: true }).click()
  await expect(page.getByRole('button', { name: '继续提取', exact: true })).toBeEnabled()
  const result = await page.evaluate(() => {
    const sample = (window as unknown as { extractionPerf: { gaps: number[]; stopped: boolean; startedAt: number } }).extractionPerf
    sample.stopped = true
    return { characters: 2000, relations: 6000, historyChars: 1500000, elapsedMs: performance.now() - sample.startedAt, maxFrameGapMs: Math.max(...sample.gaps), frames: sample.gaps.length }
  })
  const evidence = testInfo.outputPath('extraction-performance.json')
  await writeFile(evidence, JSON.stringify(result, null, 2))
  await testInfo.attach('extraction-performance.json', { path: evidence, contentType: 'application/json' })
  console.info(`提取浏览器性能 ${testInfo.project.name} ${JSON.stringify(result)}`)
  expect(result.maxFrameGapMs).toBeLessThan(1000)
  release()
})

test('另一标签点击取消立即释放提取执行权，单章入口恢复', async ({ page, context }) => {
  let holding = true, calls = 0, release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  await context.route('**/extraction-fixture/v1/chat/completions', async route => {
    calls++
    if (holding) await gate
    const world = !!route.request().postDataJSON().tools[0].function.parameters.properties.characters
    await route.fulfill({ contentType: 'text/event-stream', body: response(world ? worldData : narrativeData) }).catch(() => undefined)
  })
  await prepare(page)
  await page.getByRole('button', { name: '一起提取', exact: true }).click()
  await expect.poll(() => calls).toBe(2)
  const other = await context.newPage(); await other.goto('/')
  await expect(other.getByRole('button', { name: '正在确认任务状态…', exact: true })).toBeDisabled()
  await other.getByRole('button', { name: '取消提取', exact: true }).click()
  await expect(page.getByRole('button', { name: '一起提取', exact: true })).toBeEnabled()
  await expect(panelOf(other).getByText(/正在确认本书任务状态/)).toHaveCount(0)
  holding = false; release()
  await other.getByRole('button', { name: '提取第1章 世界资产', exact: true }).click()
  await expect(other.getByLabel('第1章 世界资产：提取成功', { exact: true })).toBeVisible()
  expect(calls).toBe(3)
})

test('刷新自动清理已暂停且没有任务的残留锁，保留成功章节', async ({ page }) => {
  let calls = 0
  await page.route('**/extraction-fixture/v1/chat/completions', async route => {
    calls++
    await route.fulfill({ contentType: 'text/event-stream', body: response(worldData) })
  })
  await prepare(page)
  const small = page.getByRole('button', { name: '提取第1章 世界资产', exact: true })
  await small.click()
  await expect(page.getByRole('button', { name: '重新提取第1章 世界资产', exact: true })).toBeEnabled()
  await page.evaluate(async () => {
    const name = (await indexedDB.databases()).find(row => row.name?.startsWith('westworld_canon_'))!.name!
    const request = indexedDB.open(name)
    const db = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result) })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['compileProgress', 'pipelineRuns'], 'readwrite')
      const read = tx.objectStore('compileProgress').get('P1')
      read.onsuccess = () => {
        const progress = read.result
        delete progress.extractionJobs; delete progress.reExtract
        tx.objectStore('compileProgress').put({ ...progress, status: 'paused' })
        const lease = { recordType: 'lease', bookId: progress.bookId, extractionStep: 'worldAssets', owner: 'orphan', runId: 'orphan', expiresAt: Date.now() + 30000 }
        tx.objectStore('pipelineRuns').put({ ...lease, id: 'lease:extraction:worldAssets', lockKey: 'extraction:worldAssets' })
        tx.objectStore('pipelineRuns').put({ ...lease, id: 'lease:world', lockKey: 'world' })
      }
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
    }); db.close()
  })
  await page.reload()
  await expect(page.getByRole('button', { name: '继续提取未完成章节', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: '重新提取第1章 世界资产', exact: true })).toBeEnabled()
  await expect(panelOf(page).getByText(/正在确认本书任务状态/)).toHaveCount(0)
  await expect(panelOf(page)).toContainText('已保存 1/8 个子步骤')
  expect(calls).toBe(1)
})
