import 'fake-indexeddb/auto'
import Dexie, { liveQuery } from 'dexie'
import { expect, it, vi } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createStoryService } from '../src/features/story/service'
import { createModelService } from '../src/features/models/service'
import { createAssetService } from '../src/features/assets/service'

it('2000人物6000关系的资产读取保持完整', async () => {
  const prefix = `extraction-perf-${crypto.randomUUID()}`
  const workspace = createWorkspace({ settingsName: `${prefix}-settings`, bookPrefix: `${prefix}-book-` })
  try {
    await workspace.settings.books.put({ id: 'a', title: '性能样本', sourceFileName: 'perf.txt', createdAt: new Date().toISOString() })
    const db = workspace.openBook('a')
    const characters = Array.from({ length: 2000 }, (_, index) => ({ id: `P${index}`, bookId: 'a', name: `人物${index}`, aliases: [], revision: 1, confidence: 1, createdBy: 'P1' }))
    await db.table('characters').bulkPut(characters)
    await db.table('characterRelations').bulkPut(Array.from({ length: 6000 }, (_, index) => {
      const from = index % 2000, to = (from + 1 + Math.floor(index / 2000)) % 2000
      return { id: `R${index}`, bookId: 'a', originCharacterId: `P${from}`, sourceName: `人物${from}`, sourceId: `P${from}`, targetName: `人物${to}`, targetIds: [`P${to}`], forwardLabel: '朋友', reverseLabel: '朋友', relationType: 'friendship', direction: 'bidirectional', evidence: [], revision: 1, createdAt: '2026-11-04', updatedAt: '2026-11-04' }
    }))
    const start = performance.now()
    const snapshot = await createAssetService(workspace).read('a')
    console.info(`资产读取2000人物/6000关系 ${(performance.now() - start).toFixed(1)}ms`)
    expect(snapshot.characters).toHaveLength(2000)
    expect(snapshot.pairs).toHaveLength(6000)
    expect(snapshot.relationEdges.P0).toHaveLength(12)
  } finally {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name.startsWith(prefix)) await Dexie.delete(name)
  }
}, 60000)

it('执行锁续期只更新锁订阅，资产内容变化仍触发投影', async () => {
  const prefix = `extract-observer-${crypto.randomUUID()}`
  const workspace = createWorkspace({ settingsName: `${prefix}-settings`, bookPrefix: `${prefix}-book-` })
  const service = createAssetService(workspace)
  let contentCount = 0, lockCount = 0
  const content = liveQuery(() => service.readContent('a')).subscribe(() => contentCount++)
  const locks = liveQuery(() => service.readLocks('a')).subscribe(() => lockCount++)
  try {
    await workspace.settings.books.put({ id: 'a', title: '订阅样本', sourceFileName: 'perf.txt', createdAt: new Date().toISOString() })
    await vi.waitFor(() => { expect(contentCount).toBeGreaterThan(0); expect(lockCount).toBeGreaterThan(0) })
    const before = contentCount
    const db = workspace.openBook('a')
    await db.table('pipelineRuns').put({ id: 'lease:world', recordType: 'lease', bookId: 'a', lockKey: 'world', owner: 'test', runId: 'test', expiresAt: Date.now() + 30000 })
    await vi.waitFor(() => expect(lockCount).toBeGreaterThan(1))
    const lockBefore = lockCount
    await db.table('pipelineRuns').update('lease:world', { expiresAt: Date.now() + 40000 })
    await vi.waitFor(() => expect(lockCount).toBeGreaterThan(lockBefore))
    expect(contentCount).toBe(before)
    await db.table('characters').put({ id: 'P1', bookId: 'a', name: '沈青', aliases: [], revision: 1, confidence: 1, createdBy: 'P1' })
    await vi.waitFor(() => expect(contentCount).toBeGreaterThan(before))
  } finally {
    content.unsubscribe(); locks.unsubscribe(); workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name.startsWith(prefix)) await Dexie.delete(name)
  }
})

it('旁边的P3面板读取执行权时不搬运P1原文历史', async () => {
  const prefix = `extract-story-observer-${crypto.randomUUID()}`
  const workspace = createWorkspace({ settingsName: `${prefix}-settings`, bookPrefix: `${prefix}-book-` })
  try {
    await workspace.settings.books.put({ id: 'a', title: '历史样本', sourceFileName: 'perf.txt', createdAt: new Date().toISOString() })
    const table = workspace.openBook('a').table('pipelineRuns')
    await table.put({ id: 'large-p1', bookId: 'a', recordType: 'run', stage: 'P1', tasks: [{ input: { text: '原'.repeat(1000000) } }] })
    const readAll = vi.spyOn(table, 'toArray')
    const service = createStoryService(workspace, createModelService(workspace))
    expect((await service.read('a')).locked).toBe(false)
    expect(readAll).not.toHaveBeenCalled()
    await table.put({ id: 'lease:extraction:worldAssets', bookId: 'a', recordType: 'lease', lockKey: 'extraction:worldAssets', extractionStep: 'worldAssets', owner: 'test', runId: 'test', expiresAt: Date.now() + 30000 })
    expect((await service.read('a')).locked).toBe(true)
    expect(readAll).not.toHaveBeenCalled()
  } finally {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name.startsWith(prefix)) await Dexie.delete(name)
  }
})
