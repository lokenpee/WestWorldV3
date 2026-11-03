import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createImportService } from '../src/lib/storage/importService'
import { createAssetService } from '../src/features/assets/service'
import { createBackupService } from '../src/features/backup/service'
import { checksumOf, inspectBackup } from '../src/features/backup/codec'
import { emptyTables, pauseBookData, tableNames, validateBookData, type BookData, type Row } from '../src/features/backup/data'
import { DEFAULT_CHAPTER_PATTERN, splitChapters } from '../src/features/import/text'

const opened: ReturnType<typeof createWorkspace>[] = []
const importers: ReturnType<typeof createImportService>[] = []
const text = '序文\n第一章 书信\n沈青收到信。\n第二章 归还\n顾衡收到信。'
async function setup(checkpoint?: (point: string) => Promise<void>) {
  const prefix = `backup-${crypto.randomUUID()}`
  const workspace = createWorkspace({ settingsName: `${prefix}-settings`, bookPrefix: `${prefix}-book-` }); opened.push(workspace)
  const importer = createImportService(workspace, { checkpoint, ownerAlive: async () => false }); importers.push(importer)
  const book = await importer.importNovel({ fileName: '书信.txt', byteLength: new TextEncoder().encode(text).length, text, encoding: 'UTF-8', pattern: DEFAULT_CHAPTER_PATTERN, chapters: splitChapters(text, DEFAULT_CHAPTER_PATTERN) })
  const service = createBackupService(workspace, importer)
  const assets = createAssetService(workspace)
  return { workspace, importer, book, service, assets, db: workspace.openBook(book.id) }
}
async function tamper(bytes: Uint8Array, path: string, change: (value: unknown) => unknown) {
  const files = unzipSync(bytes)
  files[path] = strToU8(JSON.stringify(change(JSON.parse(strFromU8(files[path])))))
  const manifest = JSON.parse(strFromU8(files['manifest.json']))
  manifest.checksums[path] = await checksumOf(files[path])
  files['manifest.json'] = strToU8(JSON.stringify(manifest))
  return zipSync(files)
}
afterEach(async () => {
  importers.splice(0).forEach(service => service.close())
  for (const workspace of opened.splice(0)) {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name)
  }
})

describe('完整书籍备份与恢复', () => {
  it('全表快照导回独立书，原文、稳定关联、来源和合并报告完整，凭据与目录排除', async () => {
    const { workspace, service, assets, book, db } = await setup()
    const first = await assets.create(book.id, 'character', { name: '沈青', chapterIndex: '1' })
    const other = await assets.create(book.id, 'character', { name: '老沈', chapterIndex: '1' })
    const node = await assets.create(book.id, 'node', { name: '收信', summary: '沈青收信', chapterIndex: '1', participantIds: [first.id, other.id] })
    const line = await assets.create(book.id, 'eventLine', { title: '书信传递', nodeIds: [node.id] })
    const preview = await assets.previewMerge(book.id, 'character', { memberIds: [first.id, other.id], keepId: first.id, canonicalName: '沈青' })
    await assets.confirmMerge(book.id, 'character', preview.request)
    const timestamp = new Date().toISOString()
    await db.table('storySessions').put({ id: 'session', bookId: book.id, profile: 'story_editor', kind: 'initial', title: '书信会话', status: 'active', nextOrdinal: 2, leafId: 'entry-2', createdAt: timestamp, updatedAt: timestamp })
    await db.table('storySessionEntries').bulkPut([
      { id: 'entry-1', sessionId: 'session', bookId: book.id, ordinal: 0, parentId: null, type: 'message', createdAt: timestamp, message: { role: 'user', content: '请核对书信事件。' } },
      { id: 'entry-2', sessionId: 'session', bookId: book.id, ordinal: 1, parentId: 'entry-1', type: 'message', createdAt: timestamp, message: { role: 'assistant', content: [{ type: 'text', text: '已读取节点。' }] } },
    ])
    await db.table('storyEditorMemory').put({ id: 'memory', sessionId: 'session', bookId: book.id, revision: 1, workingSummary: '信件由沈青接收。', dataFingerprint: 'facts', updatedAt: timestamp })
    await db.table('storyEditorNotes').put({ id: 'SN000001', sessionId: 'session', bookId: book.id, key: 'letter', kind: 'review', status: 'active', statement: '核对送信顺序', nodeIds: [node.id], lineIds: [line.id], evidence: [], revision: 1, stage: 'P3', basisFingerprint: 'facts', createdAt: timestamp, updatedAt: timestamp })
    await db.table('storyEditorCheckpoints').put({ id: 'checkpoint', sessionId: 'session', bookId: book.id, stage: 'P3', phase: 'window_link', scopeIds: [node.id], sourceFingerprint: 'facts', status: 'completed', memberships: { [line.id]: [node.id] }, updatedAt: timestamp })
    await db.table('extractionReceipts').put({ key: '1:narrativeAssets', bookId: book.id, chapterIndex: '1', substep: 'narrativeAssets', inputFingerprint: 'chapter-facts', originIds: [node.id], committedAt: timestamp, runId: 'original-extraction' })
    await workspace.settings.table('credentials').put({ providerId: 'test', key: 'never-export-this-secret' })
    await workspace.settings.appSettings.put({ key: 'assets.exportDirectory', value: { name: 'private-directory' } })
    const backup = await service.exportBook(book.id)
    const files = unzipSync(backup.bytes)
    expect(backup.manifest.formatVersion).toBe(7)
    expect(Object.keys(files)).not.toContain('data/credentials.json')
    expect(Object.values(files).map(value => strFromU8(value)).join('')).not.toMatch(/never-export-this-secret|private-directory/)
    const inspected = await service.inspectBackup(backup.bytes)
    expect(inspected.errors).toEqual([])
    expect(inspected.stats).toEqual({ chapters: 3, characters: 1, locations: 0, nodes: 1, eventLines: 1 })
    const imported = await service.importBackup(backup.bytes)
    expect(imported.id).not.toBe(book.id)
    expect((await workspace.listBooks())).toHaveLength(2)
    const restored = workspace.openBook(imported.id)
    expect((await restored.table<{ text: string }>('chapterTexts').toArray()).map(row => row.text).join('')).toBe(text)
    for (const name of tableNames) expect(await restored.table(name).toArray()).toEqual((await db.table(name).toArray()).map(row => ({ ...row, bookId: imported.id })))
    expect((await assets.read(imported.id)).lineCharacterIds[line.id]).toEqual([first.id])
    expect((await assets.read(imported.id)).manualMerges).toHaveLength(1)
    const second = await service.importBackup(backup.bytes)
    expect(second.title).toBe('书信（导入）（1）')
    expect((await service.inspectBackup((await service.exportBook(imported.id)).bytes)).ok).toBe(true)
  })

  it('处理期间可导出，只序列化暂停状态与运行报告，不修改原书或复制租约', async () => {
    const { book, db, service } = await setup()
    const report = { beforeCounts: { characters: 0, locations: 0 }, afterCounts: { characters: 0, locations: 0 }, groups: [], optimizedIds: [], skipped: [], failed: [], conflicted: [], status: 'running', cost: 0, usage: { input: 0, output: 0, totalTokens: 0, cost: 0 }, externalChanges: [] }
    await db.table('pipelineRuns').bulkPut([
      { id: 'lock', bookId: book.id, recordType: 'lease', resource: 'world', lockKey: 'world', expiresAt: Date.now() + 300000 },
      { id: 'run', bookId: book.id, recordType: 'run', stage: 'P2', status: 'running', startedAt: new Date().toISOString(), planVersion: '2.2', report },
    ])
    await db.table('compileProgress').update('P1', { status: 'running' })
    const backup = await service.exportBook(book.id)
    expect(backup.processing).toBe(true)
    const inspected = await inspectBackup(backup.bytes)
    expect(inspected.errors).toEqual([])
    expect(inspected.data?.tables.pipelineRuns).toMatchObject([{ id: 'run', status: 'paused', report }])
    expect(inspected.data?.tables.compileProgress[0].status).toBe('paused')
    expect((await db.table('pipelineRuns').get('run')).status).toBe('running')
    expect(await db.table('pipelineRuns').get('lock')).toBeDefined()
  })

  it('损坏ZIP、缺文件、hash错误、畸形数据、重复编号、跨书归属和过新版本均拒绝且不建库', async () => {
    const { workspace, service, book } = await setup()
    const backup = await service.exportBook(book.id)
    const missing = unzipSync(backup.bytes); delete missing['chapters/0001.txt']
    const corrupted = unzipSync(backup.bytes); corrupted['chapters/0001.txt'] = strToU8('被改写')
    const variants = [
      strToU8('invalid zip'), zipSync(missing), zipSync(corrupted),
      await tamper(backup.bytes, 'data/chapters.json', () => ({})),
      await tamper(backup.bytes, 'data/chapters.json', value => [...value as Row[], (value as Row[])[0]]),
      await tamper(backup.bytes, 'data/chapters.json', value => (value as Row[]).map(row => ({ ...row, bookId: 'another-book' }))),
      await tamper(backup.bytes, 'manifest.json', value => ({ ...value as Row, formatVersion: 99 })),
    ]
    for (const bytes of variants) {
      const result = await service.inspectBackup(bytes)
      expect(result.ok).toBe(false)
      expect(result.errors.length).toBeGreaterThan(0)
      await expect(service.importBackup(bytes)).rejects.toThrow()
    }
    expect((await workspace.listBooks()).map(row => row.id)).toEqual([book.id])
    expect((await Dexie.getDatabaseNames()).filter(name => name.startsWith(workspace.scope.bookPrefix))).toEqual([workspace.scope.bookPrefix + book.id])
  })

  it('校验人物、节点双向关联、来源循环和会话链，错误含具体位置', async () => {
    const { service, assets, book } = await setup()
    const character = await assets.create(book.id, 'character', { name: '沈青', chapterIndex: '1' })
    const node = await assets.create(book.id, 'node', { name: '收信', summary: '收信', chapterIndex: '1', participantIds: [character.id] })
    await assets.create(book.id, 'eventLine', { title: '书信', nodeIds: [node.id] })
    const backup = await service.exportBook(book.id)
    const badPerson = await tamper(backup.bytes, 'data/nodes.json', value => (value as Row[]).map(row => ({ ...row, actorIds: ['missing'] })))
    expect((await inspectBackup(badPerson)).errors.some(error => error.path.startsWith('nodes/'))).toBe(true)
    const badLine = await tamper(backup.bytes, 'data/nodes.json', value => (value as Row[]).map(row => ({ ...row, eventLineIds: [] })))
    expect((await inspectBackup(badLine)).errors.some(error => error.path.startsWith('eventLines/'))).toBe(true)
    const cycle = await tamper(backup.bytes, 'data/assetLifecycle.json', value => (value as Row[]).map(row => row.kind === 'character' ? { ...row, currentId: 'old', state: 'merged' } : row).concat([{ key: 'character:old', bookId: book.id, kind: 'character', originId: 'old', currentId: character.id, state: 'merged', revision: 1, updatedAt: new Date().toISOString() }]))
    // 目标人物存在时映射已经有效；删除实体后才形成实际的重定向循环。
    const realCycle = await tamper(cycle, 'data/characters.json', () => [])
    expect((await inspectBackup(realCycle)).ok).toBe(false)
    const inspected = (await inspectBackup(backup.bytes)).data!
    inspected.tables.storySessionEntries.push({ id: 'e', sessionId: 'missing', bookId: book.id, ordinal: 0, parentId: null, type: 'message', createdAt: new Date().toISOString(), message: { role: 'user', content: '原始内容' } })
    expect((await validateBookData(inspected)).some(error => error.path === 'storySessionEntries/e')).toBe(true)
  })

  it('v4优先使用可编辑资料，空列表保持为空，原始文件通过真实迁移后校验', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('../docs/v2/resources/fixtures/人工资产样本.wwv2', import.meta.url)))
    const inspected = await inspectBackup(bytes)
    expect(inspected.errors).toEqual([])
    expect(inspected.stats).toMatchObject({ characters: 3, locations: 2, nodes: 4, eventLines: 2 })
    expect(inspected.data?.tables.characters.every(row => row.revision === 1)).toBe(true)
    expect(inspected.data?.tables.compileProgress.find(row => row.stage === 'P3')?.validity).toBe('stale')
    const withoutPeople = await tamper(bytes, 'data/characterSnapshots.json', () => [])
    const result = await inspectBackup(withoutPeople)
    expect(result.errors).toEqual([])
    expect(result.stats?.characters).toBe(0)
  })

  it.each(['after-book-write', 'before-publish'])('恢复在%s失败时清理副本，既有书与设置保留', async point => {
    let enabled = false
    const { workspace, importer, book, service } = await setup(async current => { if (enabled && current === point) throw new Error('模拟恢复失败') })
    const backup = await service.exportBook(book.id)
    enabled = true
    await expect(service.importBackup(backup.bytes)).rejects.toThrow('模拟恢复失败')
    expect((await workspace.listBooks()).map(row => row.id)).toEqual([book.id])
    expect(await importer.pendingOperationsCount()).toBe(0)
  })

  it('清除租约与未执行命令权限，同时保留原始消息和已提交凭据', () => {
    const data = { book: { id: 'b', title: '书', sourceFileName: '', createdAt: '' }, tables: emptyTables() } as BookData
    data.tables.storySessions.push({ id: 's', leaseOwner: 'owner', leaseUntil: 123 })
    data.tables.pipelineRuns.push({ recordType: 'lease' }, { recordType: 'run', status: 'running', tasks: [{ status: 'running' }], commandIntents: [{ state: 'prepared' }, { state: 'applied' }], appliedCommands: [{ operationKey: 'k' }] })
    const paused = pauseBookData(data)
    expect(paused.tables.storySessions[0]).not.toHaveProperty('leaseOwner')
    expect(paused.tables.pipelineRuns).toMatchObject([{ status: 'paused', tasks: [{ status: 'partial' }], commandIntents: [{ state: 'abandoned' }, { state: 'applied' }], appliedCommands: [{ operationKey: 'k' }] }])
    expect(data.tables.pipelineRuns).toHaveLength(2)
  })
})

describe('整书删除与恢复', () => {
  it('删除只影响目标书；活租约阻止删除，但可以导出处理中快照', async () => {
    const { workspace, importer, book, service, db } = await setup()
    const backup = await service.exportBook(book.id)
    const other = await service.importBackup(backup.bytes)
    await workspace.settings.appSettings.put({ key: 'my-setting', value: 'keep' })
    await db.table('pipelineRuns').put({ id: 'lease:world', recordType: 'lease', bookId: book.id, lockKey: 'world', expiresAt: Date.now() + 300000 })
    await expect(service.deleteBook(book.id)).rejects.toThrow('正在处理')
    expect(await importer.pendingOperationsCount()).toBe(0)
    expect((await service.exportBook(book.id)).processing).toBe(true)
    await service.deleteBook(other.id)
    expect((await workspace.listBooks()).map(row => row.id)).toEqual([book.id])
    expect(await Dexie.exists(workspace.scope.bookPrefix + other.id)).toBe(false)
    expect((await workspace.settings.appSettings.get('my-setting'))?.value).toBe('keep')
  })

  it('登记删除后失败保持隐藏和日志，重启后幂等完成，不恢复为可用书', async () => {
    const { workspace, importer, book, service } = await setup(async point => { if (point === 'after-delete-hide') throw new Error('模拟删除失败') })
    await expect(service.deleteBook(book.id)).rejects.toThrow('删除待完成')
    expect(await workspace.listBooks()).toEqual([])
    expect(await importer.pendingOperationsCount()).toBe(1)
    expect(await Dexie.exists(workspace.scope.bookPrefix + book.id)).toBe(true)
    const next = createImportService(workspace, { ownerAlive: async () => false }); importers.push(next)
    expect(await next.recoverPending()).toMatchObject({ deleted: 1, pending: 0 })
    expect(await Dexie.exists(workspace.scope.bookPrefix + book.id)).toBe(false)
    expect(await next.recoverPending()).toMatchObject({ deleted: 0, pending: 0 })
  })

  it('原生连接阻塞删库时保留日志；关闭占用后重试完成', async () => {
    const { workspace, importer, book, service } = await setup()
    const blocker = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(workspace.scope.bookPrefix + book.id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    try { await expect(service.deleteBook(book.id)).rejects.toThrow('删除待完成'); expect(await importer.pendingOperationsCount()).toBe(1) }
    finally { blocker.close() }
    expect(await importer.recoverPending()).toMatchObject({ deleted: 1, pending: 0 })
  })
})

describe('格式7人物对编辑结果', () => {
  it('导出有效关系与删除状态，恢复到新书后保持一致', async () => {
    const { book, service, assets, db } = await setup()
    const a = await assets.create(book.id, 'character', { name: '张三', chapterIndex: '1' })
    const b = await assets.create(book.id, 'character', { name: '张蕾', chapterIndex: '1' })
    const c = await assets.create(book.id, 'character', { name: '李沁', chapterIndex: '1' })
    const pair = await assets.getRelationPair(book.id, a.id, b.id)
    await assets.saveRelationPair(book.id, { fromId: a.id, toId: b.id, forwardLabels: ['师父'], reverseLabels: ['徒弟'], directionUnclear: false, reason: '人工确认师徒', expectedFingerprint: pair.fingerprint })
    const absent = await assets.getRelationPair(book.id, a.id, c.id)
    await assets.saveRelationPair(book.id, { fromId: a.id, toId: c.id, forwardLabels: ['朋友'], reverseLabels: ['朋友'], reason: '先建立', expectedFingerprint: absent.fingerprint })
    const active = await assets.getRelationPair(book.id, a.id, c.id)
    await assets.deleteRelationPair(book.id, { fromId: a.id, toId: c.id, forwardLabels: [], reverseLabels: [], reason: '原文不支持', expectedFingerprint: active.fingerprint })
    expect(await db.table('characterRelationEdits').count()).toBe(2)
    const exported = await service.exportBook(book.id)
    expect(exported.manifest.formatVersion).toBe(7)
    const inspected = await service.inspectBackup(exported.bytes)
    expect(inspected.errors).toEqual([])
    expect(inspected.data?.tables.characterRelationEdits).toHaveLength(2)
    const restored = await service.importBackup(exported.bytes)
    expect(await assets.getRelationPair(restored.id, a.id, b.id)).toMatchObject({ state: 'active', forwardLabels: ['师父'], reverseLabels: ['徒弟'] })
    expect(await assets.getRelationPair(restored.id, a.id, c.id)).toMatchObject({ state: 'deleted' })
    expect((await assets.read(restored.id)).relationEdges[a.id].some(edge => edge.toId === c.id)).toBe(false)
    const roundtrip = await service.exportBook(restored.id)
    expect((await service.inspectBackup(roundtrip.bytes)).ok).toBe(true)
  })
})
