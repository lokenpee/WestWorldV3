import { expect, test, type Page } from '@playwright/test'
import { largeNetworkRows } from '../support/character-network'

const cachePrefix = 'wwv3:character-network:v1:'
async function prepare(page: Page, large = false) {
  await page.goto('/')
  await page.getByLabel('小说TXT文件').setInputFiles({ name: '人物网络验收.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章 开始\n样本正文。') })
  await page.getByRole('button', { name: '仅导入', exact: true }).click()
  await expect(page.getByRole('heading', { name: '人物网络验收', exact: true })).toBeVisible()
  const rows = largeNetworkRows('fixture')
  const characters = large ? rows.characters : rows.characters.slice(0, 4).map((row, i) => ({ ...row, name: ['甲', '乙', '丙', '丁'][i] }))
  const edits = large ? rows.characterRelationEdits : [
    { ...rows.characterRelationEdits[0], aToBLabels: ['师父'], bToALabels: ['徒弟'] },
    { ...rows.characterRelationEdits[1], aToBLabels: ['朋友'], bToALabels: [] },
  ]
  const bookId = await page.evaluate(async ({ characters, edits, prefix, large }) => {
    const name = (await indexedDB.databases()).find(db => db.name?.startsWith('westworld_canon_'))!.name!
    const bookId = name.slice('westworld_canon_'.length), request = indexedDB.open(name)
    const db = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result) })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['characters', 'characterRelationEdits'], 'readwrite')
      for (const row of characters) tx.objectStore('characters').put({ ...row, bookId })
      for (const row of edits) tx.objectStore('characterRelationEdits').put({ ...row, bookId })
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
    }); db.close()
    if (!large) localStorage.setItem(prefix + bookId, JSON.stringify({ version: 1, positions: Object.fromEntries(characters.map((row, i) => [row.id, { x: i % 2 ? 420 : 180, y: i < 2 ? 180 : 420 }])), view: { x: 0, y: 0, zoom: 1 } }))
    return bookId
  }, { characters, edits, prefix: cachePrefix, large })
  await page.reload()
  await expect(page.getByRole('button', { name: '人物网络', exact: true })).toBeVisible()
  return bookId
}

test('逐线悬停、拖动避碰及取消重布保留旧坐标', async ({ page }) => {
  const bookId = await prepare(page)
  await page.getByRole('button', { name: '人物网络', exact: true }).click()
  const canvas = page.locator('.character-network canvas'), box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + 300, box.y + 180)
  await expect(page.getByRole('tooltip')).toContainText('甲 → 乙：师父')
  await expect(page.getByRole('tooltip')).toContainText('乙 → 甲：徒弟')
  await page.mouse.move(box.x + 180, box.y + 300)
  await expect(page.getByRole('tooltip')).toContainText('甲 → 丙：朋友')
  await expect(page.getByRole('tooltip')).not.toContainText('师父')
  await expect(page.getByRole('tooltip')).not.toContainText('丙 → 甲')
  const before = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).positions, cachePrefix + bookId)
  await page.mouse.move(box.x + 180, box.y + 180); await page.mouse.down()
  await page.mouse.move(box.x + 420, box.y + 180, { steps: 8 }); await page.mouse.up()
  await page.waitForFunction(({ key, before }) => JSON.stringify(JSON.parse(localStorage.getItem(key)!).positions) !== JSON.stringify(before), { key: cachePrefix + bookId, before })
  const after = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).positions as Record<string, { x: number; y: number }>, cachePrefix + bookId)
  const [id, ...others] = Object.keys(before)
  for (const other of others) { expect(after[other]).toEqual(before[other]); expect(Math.hypot(after[id].x - after[other].x, after[id].y - after[other].y)).toBeGreaterThanOrEqual(76) }
  await expect(page.getByText('请选择人物查看或编辑')).toBeVisible()
  await page.route('**/*layout.worker*', async route => { await new Promise(resolve => setTimeout(resolve, 1200)); await route.continue() })
  await page.getByRole('button', { name: '重新布局', exact: true }).click()
  await page.getByRole('button', { name: '取消布局', exact: true }).click()
  await expect(page.locator('.character-network')).toHaveAttribute('data-layout-running', 'false')
  // 等待原Worker加载/晚到消息窗口，确认取消后不会替换坐标。
  await page.waitForTimeout(1500)
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).positions, cachePrefix + bookId)).toEqual(after)
  await page.getByRole('button', { name: '删除整书 人物网络验收', exact: true }).click()
  await page.getByRole('button', { name: '确认删除整书', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已删除：人物网络验收' })).toBeVisible()
  await expect(page.getByRole('button', { name: '进入 人物网络验收', exact: true })).toHaveCount(0)
  expect(await page.evaluate(key => localStorage.getItem(key), cachePrefix + bookId)).toBeNull()
})

test('2000人物10000人物对布局与交互性能', { tag: '@performance' }, async ({ page }, testInfo) => {
  test.setTimeout(120000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const bookId = await prepare(page, true)
  const start = Date.now()
  await page.getByRole('button', { name: '人物网络', exact: true }).click()
  const network = page.locator('.character-network')
  await page.waitForFunction(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.character-network canvas')
    if (!canvas?.width || !canvas.height) return false
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] === 242 && pixels[i + 1] === 193 && pixels[i + 2] === 78) return true
    return false
  })
  const visibleMs = Date.now() - start
  const layoutCount = await network.getAttribute('data-layout-count')
  expect(Number(layoutCount)).toBeGreaterThan(0)
  await expect(network).toHaveAttribute('data-layout-running', 'false', { timeout: 15000 })
  const layoutMs = Date.now() - start
  // 等待交互缓存的300ms防抖，读取最终布局而非首次临时坐标。
  await page.waitForTimeout(350)
  await page.waitForFunction(key => !!localStorage.getItem(key), cachePrefix + bookId)
  const minimum = await page.evaluate(key => {
    const positions = Object.values(JSON.parse(localStorage.getItem(key)!).positions) as { x: number; y: number }[]
    let min = Infinity
    for (let a = 0; a < positions.length; a++) for (let b = a + 1; b < positions.length; b++) min = Math.min(min, Math.hypot(positions[a].x - positions[b].x, positions[a].y - positions[b].y))
    return min
  }, cachePrefix + bookId)
  const selectionMs: number[] = []
  for (const i of [0, 1, 2, 3, 4, 99, 100, 250, 500, 950, 1200, 1500, 1800, 1900, 1950, 1999, 1100, 1700, 1960, 1980]) {
    const name = i < 100 ? `同名${i}` : `人物${i}`
    await page.getByLabel('搜索人物网络').fill(name)
    const button = page.locator('.character-network-search button').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) }).first()
    const began = Date.now()
    await button.evaluate((element: HTMLButtonElement) => element.click())
    await expect(page.getByLabel('名称', { exact: true })).toHaveValue(name)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    selectionMs.push(Date.now() - began)
  }
  const frames = await page.evaluate(async () => {
    const canvas = document.querySelector('.character-network canvas')!
    const times: number[] = []
    let previous = performance.now()
    for (let i = 0; i < 90; i++) {
      await new Promise<void>(resolve => requestAnimationFrame(now => { times.push(now - previous); previous = now; resolve() }))
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: i % 2 ? 1 : -1, clientX: 500, clientY: 400, bubbles: true, cancelable: true }))
    }
    return 1000 / times.sort((a, b) => a - b)[Math.floor(times.length / 2)]
  })
  const p95 = selectionMs.sort((a, b) => a - b)[Math.ceil(selectionMs.length * 0.95) - 1]
  const environment = await page.evaluate(() => ({ browser: navigator.userAgent, logicalCpus: navigator.hardwareConcurrency, memoryGiB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory }))
  const metrics = { project: testInfo.project.name, visibleMs, layoutMs, selectionP95Ms: p95, medianFps: frames, minimumDistance: minimum, viewport: '1440x900', ...environment }
  console.log('人物网络性能', JSON.stringify(metrics))
  await testInfo.attach('character-network-performance', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' })
  await network.screenshot({ path: testInfo.outputPath('character-network-large.png') })
  expect(visibleMs).toBeLessThanOrEqual(2000); expect(layoutMs).toBeLessThanOrEqual(10000)
  expect(p95).toBeLessThanOrEqual(200); expect(frames).toBeGreaterThanOrEqual(30); expect(minimum).toBeGreaterThanOrEqual(76)
  await expect(network).toHaveAttribute('data-layout-count', layoutCount!)
})
