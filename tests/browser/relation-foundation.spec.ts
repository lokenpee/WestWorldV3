import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync } from 'fflate'

async function readRows(page: Page, bookId: string, table: string) {
  return page.evaluate(async ({ bookId, table }) => {
    const request = indexedDB.open(`westworld_acceptance_stage1_book_${bookId}`)
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const request = db.transaction(table).objectStore(table).getAll()
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    db.close(); return rows
  }, { bookId, table })
}

test('身份关系按当前人物生成双向箭头，旧称呼按原值显示并保留原文，编辑刷新方向正确', async ({ page }) => {
  const support = '林黛玉是宝玉的妹妹，宝玉是她的兄长。'
  const clue = '黛玉凝了凝罥烟眉，清眸中却是不由浮现起那青衫少年的身影。'
  await page.goto('/?acceptance=stage1')
  await page.getByLabel('小说TXT文件').setInputFiles({ name: '关系身份.txt', mimeType: 'text/plain', buffer: Buffer.from(`第一章 关系\n${support}\n${clue}`) })
  await page.getByRole('button', { name: '仅导入', exact: true }).click()
  await expect(page.getByRole('heading', { name: '关系身份', exact: true })).toBeVisible()
  const bookId = await page.evaluate(async ({ clue }) => {
    const name = (await indexedDB.databases()).find(db => db.name?.startsWith('westworld_acceptance_stage1_book_'))!.name!
    const bookId = name.slice('westworld_acceptance_stage1_book_'.length)
    const request = indexedDB.open(name)
    const db = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result) })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['characters', 'characterRelations'], 'readwrite')
      for (const [id, name] of [['D', '林黛玉'], ['B', '宝玉']]) tx.objectStore('characters').put({ id, name, bookId, revision: 1, confidence: 1, createdBy: 'P1', aliases: [], chapterIndex: '1', sourceChapters: ['1'] })
      const now = new Date().toISOString()
      tx.objectStore('characterRelations').put({ id: 'R-ROLE', bookId, originCharacterId: 'D', sourceId: 'D', sourceName: '林黛玉', targetName: '宝玉', targetIds: ['B'], forwardLabel: '宝二哥', reverseLabel: '林妹妹', relationType: 'unknown', direction: 'unspecified', evidence: [{ chapterIndex: '1', quote: clue }], revision: 1, createdAt: now, updatedAt: now })
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
    })
    db.close(); return bookId
  }, { clue })
  await page.reload()
  await page.getByRole('button', { name: '编辑 林黛玉', exact: true }).click()
  const relations = page.getByRole('region', { name: '人物关系', exact: true })
  await expect(relations).toContainText('林黛玉--宝二哥-->宝玉')
  await expect(relations).toContainText('林黛玉<--林妹妹--宝玉')
  await relations.getByText('查看相关原文与原标签', { exact: true }).click()
  await expect(relations).toContainText(clue)
  await expect(relations).toContainText('原正向标签：宝二哥')
  expect((await readRows(page, bookId, 'characterRelations'))[0].forwardLabel).toBe('宝二哥')
  await relations.getByRole('button', { name: '编辑', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '编辑人物关系', exact: true })
  await expect(dialog.getByRole('group', { name: '林黛玉是宝玉的什么人' })).toBeVisible()
  await page.getByLabel('正向标签 1').fill('妹妹')
  await page.getByLabel('反向标签 1').fill('兄长')
  await dialog.getByRole('checkbox', { name: '关系身份待核对（不确定的一方填未知）' }).uncheck()
  await expect(dialog.getByLabel('关系预览')).toContainText('林黛玉--妹妹-->宝玉')
  await dialog.getByText('补填本次依据（可选）', { exact: true }).click()
  await page.getByLabel('依据原文').fill(support)
  await dialog.getByRole('button', { name: '保存关系', exact: true }).click()
  await expect(relations).toContainText('林黛玉<--兄长--宝玉')
  await page.reload()
  await page.getByRole('button', { name: '编辑 宝玉', exact: true }).click()
  await expect(relations).toContainText('宝玉--兄长-->林黛玉')
  await expect(relations).toContainText('宝玉<--妹妹--林黛玉')
})

test('旧资料打开修复，地点合并与节点移除可保存，备份副本保留编辑及修复记录', async ({ page }) => {
  await page.goto('/?acceptance=stage1')
  await page.getByLabel('小说TXT文件').setInputFiles({ name: '基础修复.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章 开始\n张三记得张蕾。') })
  await page.getByRole('button', { name: '仅导入', exact: true }).click()
  await expect(page.getByRole('heading', { name: '基础修复', exact: true })).toBeVisible()
  const bookId = await page.evaluate(async () => {
    const name = (await indexedDB.databases()).find(db => db.name?.startsWith('westworld_acceptance_stage1_book_'))!.name!, bookId = name.slice('westworld_acceptance_stage1_book_'.length)
    const request = indexedDB.open(name), db = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result) })
    const now = new Date().toISOString()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['characters', 'locations', 'nodes', 'characterRelations', 'characterRelationEdits'], 'readwrite')
      const person = { bookId, revision: 1, createdBy: 'P1', confidence: 1, chapterIndex: '1', chapterName: '第一章', sourceChapters: ['1'] }
      for (const [id, name] of [['P1', '张三'], ['P2', '张蕾'], ['P3', '张三']]) tx.objectStore('characters').put({ ...person, id, name })
      for (const [id, name] of [['L1', '码头'], ['L2', '渡口']]) tx.objectStore('locations').put({ ...person, id, name })
      tx.objectStore('nodes').put({ ...person, id: 'N1', name: '回忆', summary: '张三回忆', actors: ['张三'], actorIds: ['P1'], actorBindings: [{ mention: '张三', ids: ['P1'] }], legacyActorIds: ['P1'], order: 0, quote: '', eventLineIds: [] })
      tx.objectStore('characterRelations').put({ id: 'R1', bookId, originCharacterId: 'P1', sourceName: '张三', targetName: '张蕾', relationType: 'parent_child', forwardLabel: '父亲', reverseLabel: '父亲', direction: 'directed', sourceId: null, targetIds: [], evidence: [], revision: 2, createdAt: now, updatedAt: now, legacyPayload: { target: '张蕾', relation_type: 'parent_child', relation_label: '父亲', direction: 'directed' } })
      for (const [id, state] of [['P2', 'deleted'], ['P3', 'active']]) tx.objectStore('characterRelationEdits').put({ pairKey: JSON.stringify(['P1', id]), bookId, aId: 'P1', bId: id, state, aToBLabels: state === 'active' ? ['同事'] : [], bToALabels: [], directionUnclear: false, evidence: [], sourceRelationIds: ['R1'], revision: 2, updatedAt: now, updatedBy: state === 'active' ? 'agent' : 'manual', commitId: 'original-edit' })
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
    }); db.close(); return bookId
  })
  await page.reload()
  await page.getByRole('button', { name: '编辑 张三', exact: true }).filter({ hasText: 'P1' }).click()
  await expect(page.getByRole('region', { name: '人物关系', exact: true })).toContainText('同事')
  await expect(page.getByRole('region', { name: '人物关系', exact: true })).not.toContainText('父亲')
  const relation = (await readRows(page, bookId, 'characterRelations'))[0]
  expect(relation).toMatchObject({ sourceId: 'P1', targetIds: ['P2'], reverseLabel: '子女', revision: 3 })
  expect((await readRows(page, bookId, 'nodes'))[0]).toMatchObject({ actorIds: ['P1', 'P3'], revision: 2 })
  await page.getByRole('button', { name: /^地点 2$/ }).click()
  await page.getByRole('button', { name: '手动合并', exact: true }).click()
  for (const [name, id] of [['码头', 'L1'], ['渡口', 'L2']]) await page.getByRole('checkbox', { name: `选择合并 ${name} ${id}`, exact: true }).check()
  await page.getByRole('button', { name: '确定合并', exact: true }).click()
  await page.getByLabel('保留条目', { exact: true }).selectOption('L1')
  await page.getByLabel('合并后主名', { exact: true }).selectOption('码头')
  await page.getByRole('button', { name: '确认机械合并', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '合并完成' })).toBeVisible()
  expect((await readRows(page, bookId, 'characterRelations'))[0]).toEqual(relation)
  await page.getByRole('button', { name: /^事件节点 1$/ }).click()
  await page.getByRole('button', { name: '编辑 回忆', exact: true }).click()
  for (const id of ['P1', 'P3']) await page.getByRole('button', { name: `移除人物 张三 ${id}`, exact: true }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByLabel('已选人物')).toContainText('尚未选择人物')
  await page.getByRole('button', { name: '导出 基础修复', exact: true }).click()
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载备份', exact: true }).click()
  const bytes = await readFile((await (await downloaded).path())!)
  const savedRuns = JSON.parse(strFromU8(unzipSync(bytes)['data/pipelineRuns.json'])) as Record<string, unknown>[]
  expect(savedRuns.filter(row => row.recordType === 'asset_edit')).toHaveLength(1)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('选择备份文件（.wwv2）', { exact: true }).setInputFiles({ name: '基础修复.wwv2', mimeType: 'application/zip', buffer: bytes })
  await expect(page.getByText('备份校验通过', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '确认恢复为新书', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已恢复：基础修复（导入）' })).toBeVisible()
  await page.getByRole('button', { name: '资产', exact: true }).click()
  await expect(page.getByRole('heading', { name: '基础修复（导入）', exact: true })).toBeVisible()
  const restoredId = await page.evaluate(async original => (await indexedDB.databases()).find(row => row.name?.startsWith('westworld_acceptance_stage1_book_') && row.name !== `westworld_acceptance_stage1_book_${original}`)!.name!.slice('westworld_acceptance_stage1_book_'.length), bookId)
  expect((await readRows(page, restoredId, 'nodes'))[0]).toMatchObject({ actorIds: [], legacyActorIds: [] })
  expect((await readRows(page, restoredId, 'characterRelationEdits')).map(row => row.state).sort()).toEqual(['active', 'deleted'])
  expect((await readRows(page, restoredId, 'pipelineRuns')).filter(row => row.recordType === 'asset_edit')).toHaveLength(1)
})
