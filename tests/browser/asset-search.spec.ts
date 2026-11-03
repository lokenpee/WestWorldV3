import { expect, test, type Page } from '@playwright/test'

async function prepare(page: Page) {
  await page.goto('/')
  await page.getByLabel('小说TXT文件').setInputFiles({ name: '搜索样本.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章 开始\n薛蟠案起。\n第二章 后续\n宝钗探问。') })
  await page.getByRole('button', { name: '仅导入', exact: true }).click()
  await expect(page.getByRole('heading', { name: '搜索样本', exact: true })).toBeVisible()
  await page.evaluate(async () => {
    const name = (await indexedDB.databases()).find(row => row.name?.startsWith('westworld_canon_'))!.name!
    const bookId = name.slice('westworld_canon_'.length), request = indexedDB.open(name)
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const common = { bookId, revision: 1, createdBy: 'P1', confidence: 1, chapterIndex: '1', chapterName: '第一章 开始' }
    const rows = {
      characters: [
        { ...common, id: 'C2-P003', name: '薛蟠', chapterIndex: '2', chapterName: '第二章 后续', roleWeight: 'NPC' },
        { ...common, id: 'C1-P003', name: '薛蟠', roleWeight: '主要人物' },
        { ...common, id: 'A1', name: '薛文龙', aliases: ['薛蟠'], roleWeight: 'NPC' },
        { ...common, id: 'B1', name: '宝钗', identity: '薛蟠之妹', roleWeight: '主要人物' },
        { ...common, id: 'D1', name: '薛蟠旧档', roleWeight: 'NPC' },
        { ...common, id: 'other', name: '晴雯', identity: '侍女', roleWeight: 'NPC' },
      ],
      locations: [{ ...common, id: 'L1', name: '东院', description: '宁国府内的院子' }, { ...common, id: 'L2', name: '宁国府' }, { ...common, id: 'L3', name: '宁府', aliases: ['宁国府'] }],
      nodes: [{ ...common, id: 'N1', name: '薛蟠案', summary: '案件开始', order: 0, actors: [], quote: '', eventLineIds: ['E1'] }, { ...common, id: 'N2', name: '宝钗探问', summary: '询问薛蟠案经过', order: 1, actors: [], quote: '', eventLineIds: ['E2'] }],
      eventLines: [{ id: 'E1', bookId, title: '薛蟠案', nodeIds: ['N1'], chapters: ['1'], cause: '', process: '', result: '', lineStatus: 'open', revision: 1, createdBy: 'P3', updatedAt: new Date().toISOString() }, { id: 'E2', bookId, title: '宝钗探问', nodeIds: ['N2'], chapters: ['1'], cause: '薛蟠案牵动亲族', process: '询问审讯情况', result: '等待结案', lineStatus: 'open', revision: 1, createdBy: 'P3', updatedAt: new Date().toISOString() }],
    }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(Object.keys(rows), 'readwrite')
      for (const [table, values] of Object.entries(rows)) for (const row of values) tx.objectStore(table).put(row)
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
    }); db.close()
  })
  await page.reload()
  await expect(page.getByRole('button', { name: /^人物 6$/ })).toBeVisible()
}

test('姓名排在别名和正文之前，同名按章序，层级筛选与合并选择保留', async ({ page }, testInfo) => {
  await prepare(page)
  const panel = page.getByRole('region', { name: '资产管理', exact: true })
  await page.getByLabel('搜索资产', { exact: true }).fill('薛蟠')
  await expect(panel.locator('.result-count')).toHaveText('显示 4 / 6 条 · 按相关度排列')
  await expect(panel.locator('.asset-list code')).toHaveText(['C1-P003', 'C2-P003', 'A1', 'D1'])
  await page.getByLabel('筛选人物层级', { exact: true }).selectOption('主要人物')
  await expect(panel.locator('.asset-list code')).toHaveText(['C1-P003'])
  await page.getByLabel('筛选人物层级', { exact: true }).selectOption('')
  await page.getByLabel('搜索资产', { exact: true }).fill('c1-p003')
  await expect(panel.locator('.asset-list code')).toHaveCount(0)
  await page.getByLabel('搜索资产', { exact: true }).fill('薛文龙')
  await expect(panel.locator('.asset-list code')).toHaveText(['A1'])
  await page.getByLabel('搜索资产', { exact: true }).fill('薛蟠')
  await page.getByRole('button', { name: '手动合并', exact: true }).click()
  await page.getByRole('checkbox', { name: '选择合并 薛蟠 C1-P003', exact: true }).check()
  await page.getByLabel('搜索资产', { exact: true }).fill('宝钗')
  await expect(panel).toContainText('已选 1 项（含隐藏 1 项）')
  await page.getByRole('checkbox', { name: '选择合并 宝钗 B1', exact: true }).check()
  await page.getByLabel('搜索资产', { exact: true }).fill('薛蟠')
  await expect(page.getByRole('checkbox', { name: '选择合并 薛蟠 C1-P003', exact: true })).toBeChecked()
  await expect(panel).toContainText('已选 2 项（含隐藏 1 项）')
  await page.getByLabel('搜索资产', { exact: true }).fill('宝钗')
  await expect(page.getByRole('checkbox', { name: '选择合并 宝钗 B1', exact: true })).toBeChecked()
  await page.getByRole('button', { name: '退出合并', exact: true }).click()
  await page.setViewportSize({ width: 375, height: 812 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await panel.screenshot({ path: testInfo.outputPath('search-relevance-mobile.png') })
  await page.getByLabel('搜索资产', { exact: true }).fill('')
  await expect(panel.locator('.result-count')).toHaveText('显示 6 / 6 条 · 按层级与姓名排列')
})

test('地点别名、事件概述和事件线正文均可搜，标题匹配优先且搜索保持资料原样', async ({ page }) => {
  await prepare(page)
  const panel = page.getByRole('region', { name: '资产管理', exact: true })
  await page.getByRole('button', { name: /^地点 3$/ }).click()
  await page.getByLabel('搜索资产', { exact: true }).fill('宁国府')
  await expect(panel.locator('.asset-list code')).toHaveText(['L2', 'L3', 'L1'])
  await page.getByRole('button', { name: /^事件节点 2$/ }).click()
  await page.getByLabel('搜索资产', { exact: true }).fill('薛蟠案')
  await expect(panel.locator('.asset-list code')).toHaveText(['N1', 'N2'])
  await page.getByRole('button', { name: /^事件线 2$/ }).click()
  await page.getByLabel('搜索资产', { exact: true }).fill('薛蟠案')
  await expect(panel.locator('.asset-list code')).toHaveText(['E1', 'E2'])
  for (const query of ['亲族', '审讯', '结案']) {
    await page.getByLabel('搜索资产', { exact: true }).fill(query)
    await expect(panel.locator('.asset-list code')).toHaveText(['E2'])
  }
  const revisions = await page.evaluate(async () => {
    const name = (await indexedDB.databases()).find(row => row.name?.startsWith('westworld_canon_'))!.name!, request = indexedDB.open(name)
    const db = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result) })
    const result: number[] = []
    for (const table of ['characters', 'locations', 'nodes', 'eventLines']) result.push(...await new Promise<number[]>(resolve => { const read = db.transaction(table).objectStore(table).getAll(); read.onsuccess = () => resolve(read.result.map(row => row.revision)) }))
    db.close(); return result
  })
  expect(revisions.every(value => value === 1)).toBe(true)
})
