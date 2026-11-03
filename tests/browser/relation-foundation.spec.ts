import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync } from 'fflate'

async function readRows(page: Page, bookId: string, table: string) {
  return page.evaluate(async ({ bookId, table }) => {
    const request = indexedDB.open(`westworld_canon_${bookId}`)
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const request = db.transaction(table).objectStore(table).getAll()
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    db.close(); return rows
  }, { bookId, table })
}

test('旧资料打开修复，地点合并与节点移除可保存，备份副本保留编辑及修复记录', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('小说TXT文件').setInputFiles({ name: '基础修复.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章 开始\n张三记得张蕾。') })
  await page.getByRole('button', { name: '仅导入', exact: true }).click()
  await expect(page.getByRole('heading', { name: '基础修复', exact: true })).toBeVisible()
  const bookId = await page.evaluate(async () => {
    const name = (await indexedDB.databases()).find(db => db.name?.startsWith('westworld_canon_'))!.name!, bookId = name.slice('westworld_canon_'.length)
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
  const restoredId = await page.evaluate(async original => (await indexedDB.databases()).find(row => row.name?.startsWith('westworld_canon_') && row.name !== `westworld_canon_${original}`)!.name!.slice('westworld_canon_'.length), bookId)
  expect((await readRows(page, restoredId, 'nodes'))[0]).toMatchObject({ actorIds: [], legacyActorIds: [] })
  expect((await readRows(page, restoredId, 'characterRelationEdits')).map(row => row.state).sort()).toEqual(['active', 'deleted'])
  expect((await readRows(page, restoredId, 'pipelineRuns')).filter(row => row.recordType === 'asset_edit')).toHaveLength(1)
})
