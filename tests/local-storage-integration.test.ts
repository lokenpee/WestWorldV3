import 'fake-indexeddb/auto'
import { afterEach, expect, test, vi } from 'vitest'
import Dexie from 'dexie'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalStorageServer } from '../src/features/local-storage/server'
import { createWorkspace } from '../src/lib/storage/workspace'
import { transact } from '../src/lib/storage/transaction'
import { createModelConfigStore } from '../src/features/models/config'
import { createModelService } from '../src/features/models/service'
import { createStoryService } from '../src/features/story/service'
import { createExtractionService } from '../src/features/extraction/service'
import { createBackupService } from '../src/features/backup/service'
import { defaultConfig } from '../src/features/models/types'
import type { StorageCall } from '../src/features/local-storage/client'
import type { StoredValue } from '../src/features/local-storage/contracts'
import { migrateBrowserData } from '../src/features/local-storage/migration'
import { createImportService } from '../src/lib/storage/importService'
import { createAssetService } from '../src/features/assets/service'
import { makeAssetPage, type AssetPage } from '../src/features/assets/assetPage'
import { DEFAULT_CHAPTER_PATTERN, splitChapters } from '../src/features/import/text'
import { SqliteRecordStore } from '../src/features/local-storage/sqliteStore'
import { readBookTrace } from '../src/features/agents/trace'
import { character, createLegacyBook, bookSchemaV5 } from './support/legacy-book'
import { checksumOf } from '../src/features/backup/codec'
import { emptyTables } from '../src/features/backup/data'
import { storyResponse, storyTask } from './support/story-protocol'
import { agentStream } from './support/agent-protocol'
const protector = { protect: (text: string) => Buffer.from(text).toString('base64'), unprotect: (text: string) => Buffer.from(text, 'base64').toString() }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'westworld-disk-'))
  const service = createLocalStorageServer(dir, protector)
  const call: StorageCall = async body => JSON.parse(JSON.stringify(await service.execute(JSON.parse(JSON.stringify(body))) ?? null))
  const workspace = createWorkspace({ settingsName: 'test', bookPrefix: 'test-' }, call)
  cleanups.push(async () => { workspace.close(); await service.close(); rmSync(dir, { recursive: true, force: true }) })
  return { service, workspace, call, dir }
}
test('disk settings save and credential load share an atomic transaction', async () => {
  const { workspace } = fixture()
  const config = createModelConfigStore(workspace)
  await config.save(defaultConfig, 'fake-key')
  expect((await config.load()).apiKey).toBe('fake-key')
  await expect(transact(workspace.settings, 'rw', [workspace.settings.tables], async settings => {
    await settings.appSettings.put({ key: 'rollback', value: true })
    throw new Error('fixture rollback')
  })).rejects.toThrow('fixture rollback')
  expect(await workspace.settings.appSettings.get('rollback')).toBeUndefined()
})

test('P3 Agent 在本机书库暂停后续接同一事件并完成全书复核', async () => {
  const { workspace, call } = fixture()
  const bookId = 'p3-outline', now = new Date().toISOString()
  await workspace.settings.books.put({ id: bookId, title: 'P3 磁盘续接样本', sourceFileName: 'story.txt', createdAt: now })
  const db = workspace.openBook(bookId)
  const source = '沈青继续转交同一封信，沿路找到前文留下的线索。'
  const chapters = Array.from({ length: 12 }, (_, order) => ({ bookId, chapterIndex: String(order + 1), chapterName: `第${order + 1}章`, order, charCount: source.length }))
  await db.chapters.bulkPut(chapters)
  await db.table('chapterTexts').bulkPut(chapters.map(({ chapterIndex }) => ({ bookId, chapterIndex, text: source })))
  await db.table('nodes').bulkPut(chapters.map(({ chapterIndex, chapterName }) => ({
    id: `N${chapterIndex}`, bookId, chapterIndex, chapterName, order: 0, name: '信件进展', summary: source, quote: source, actors: [], eventLineIds: [], revision: 1, confidence: 1, createdBy: 'P1',
  })))
  await db.table('extractionReceipts').bulkPut(chapters.flatMap(({ chapterIndex }) => ['worldAssets', 'narrativeAssets'].map(substep => ({
    key: `${chapterIndex}:${substep}`, bookId, chapterIndex, substep, originIds: [],
  }))))

  let waiting = false, resume = false
  const seen: { phase: string; page: number }[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string)
    if (body.tools.length === 1 && body.tools[0].function.name === 'submit_result') return storyResponse(body)
    const { input } = storyTask(body)
    expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name).sort()).toEqual(input.quick ? [
      'get_story_detail', 'navigate_story_pages', 'save_story_notes', 'save_story_outline',
    ] : [
      'finish_story_batch', 'get_story_detail', 'navigate_story_pages', 'save_story_notes', 'save_story_outline', ...(input.phase === 'global_review' ? ['search_story_context'] : []),
    ])
    seen.push({ phase: input.phase, page: input.page.pageNumber })
    if (!resume && input.page.pageNumber === 2) {
      waiting = true
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('取消', 'AbortError')), { once: true }))
    }
    return storyResponse(body)
  })
  const models = createModelService(workspace, { fetch: fetcher, wait: async (_ms, signal) => signal.throwIfAborted() })
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://story-disk-fixture.invalid/v1', aggregationContextWindow: 65536 }, 'fixture-key')
  const first = createStoryService(workspace, models)
  const running = first.start(bookId)
  try { await vi.waitFor(() => expect(waiting).toBe(true), { timeout: 10000 }) }
  finally { first.cancel(bookId); await running }
  expect((await first.read(bookId)).reading).toMatchObject({ checked: 1, pageNumber: 2 })
  const [original] = await db.table('storyEvents').toArray()
  expect(original.nodeIds).toHaveLength(10)

  const reopened = createWorkspace({ settingsName: 'reopened', bookPrefix: 'reopened-' }, call)
  cleanups.unshift(async () => reopened.close())
  const resumed = createStoryService(reopened, createModelService(reopened, { fetch: fetcher, wait: async (_ms, signal) => signal.throwIfAborted() }))
  resume = true
  seen.length = 0
  await resumed.start(bookId)
  expect(resumed.state(bookId)?.error).toBeUndefined()
  expect(seen[0]).toEqual({ phase: 'window_link', page: 1 })
  expect(await reopened.openBook(bookId).table('storyEvents').toArray()).toMatchObject([{ id: original.id, nodeIds: chapters.map(({ chapterIndex }) => `N${chapterIndex}`) }])
  await resumed.review(bookId)
  expect(resumed.state(bookId)?.error).toBeUndefined()
  const reviewed = await resumed.read(bookId)
  expect(reviewed.progress).toMatchObject({ status: 'completed', phase: 'global_review' })
  expect(reviewed.review.pending).toBe(0)
  expect(seen.some(item => item.phase === 'global_review')).toBe(true)

  const linking = (await resumed.execution(bookId, 'window_link'))!
  const review = (await resumed.execution(bookId, 'global_review'))!
  expect(linking.runId).not.toBe(review.runId)
  expect(linking.chain.requests.length).toBeGreaterThan(0)
  expect(review.chain.requests.length).toBeGreaterThan(0)
  expect(linking.chain.requests.some(row => review.chain.requests.some(other => row.requestId === other.requestId))).toBe(false)
  expect(review.chain.requests[0].timelineOrdinal).toBe(1)
  const request = await review.chain.paging!.loadRequest(review.chain.requests[0])
  expect(JSON.stringify(request.request.input)).toContain('全书剧情大纲复核')
  await expect(review.chain.paging!.loadRequest(linking.chain.requests[0])).rejects.toThrow('不属于当前范围')
  expect(await reopened.openBook(bookId).table('storyEvents').get(original.id)).toMatchObject({ coreClue: expect.stringMatching(/去向/) })

  await resumed.review(bookId, 'all')
  expect(resumed.state(bookId)?.error).toBeUndefined()
  expect((await resumed.execution(bookId, 'global_review'))?.runId).not.toBe(review.runId)
  expect((await resumed.execution(bookId, 'window_link'))?.runId).toBe(linking.runId)
}, 30000)

const text = '第一章 书信\n沈青收到信。'
const preview = () => ({ fileName: '迁移样本.txt', byteLength: new TextEncoder().encode(text).length, text, encoding: 'UTF-8' as const, pattern: DEFAULT_CHAPTER_PATTERN, chapters: splitChapters(text, DEFAULT_CHAPTER_PATTERN) })

test('P1 精简字段与旧字段同库存入 SQLite，并通过书籍备份恢复', async () => {
  const { workspace, dir } = fixture()
  const importer = createImportService(workspace)
  cleanups.unshift(async () => importer.close())
  const book = await importer.importNovel(preview())
  const db = workspace.openBook(book.id)
  const assets = createAssetService(workspace)
  const oldPerson = await assets.create(book.id, 'character', { name: '老船工', chapterIndex: '1' })
  await db.table('characters').update(oldPerson.id, { profile: { age: 46 } })
  const oldNode = await assets.create(book.id, 'node', {
    name: '保留旧账册', summary: '老船工拿出账册', chapterIndex: '1', targets: ['旧账册'], started_actions: ['核账'],
  })

  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const world = JSON.parse(init?.body as string).tools[0].function.parameters.properties.characters
    const args = world ? {
      characters: [
        { name: '沈青', profile: { ageText: '十四五岁' }, relations: [{ target: '顾衡', relation_type: 'friendship', relation_label: '朋友', reverse_label: '朋友', quote: '沈青与顾衡是朋友' }] },
        { name: '顾衡' },
      ],
      locations: [{ name: '青石码头' }],
    } : { nodes: [{ name: '沈青收信', summary: '沈青收到来信。', quote: '沈青收到信。', actors: ['沈青', '顾衡'], clues: [' 来信 ', '来信'] }] }
    return agentStream([{ name: 'submit_result', args }])
  })
  const models = createModelService(workspace, { fetch: fetcher, wait: async (_ms, signal) => signal.throwIfAborted() })
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://p1-fields-disk.invalid/v1', extractionModel: 'test' }, 'fixture-key')
  const extraction = createExtractionService(workspace, models)
  await extraction.start(book.id)
  expect((await extraction.progress(book.id))?.status).toBe('completed')
  const node = await db.table('nodes').get('C1-N001')
  expect(node).toMatchObject({ actors: ['沈青', '顾衡'], clues: ['来信'] })
  await assets.update(book.id, 'node', node!.id, node!.revision, { clues: ['顾衡来信'] })

  const persisted = new SqliteRecordStore(dir)
  const stored = (table: string, key: string) => persisted.get({ scope: `book:${book.id}`, table, key })?.value
  try {
    expect(stored('nodes', node!.id)).toMatchObject({ clues: ['顾衡来信'] })
    for (const field of ['targets', 'started_actions', 'confidence']) expect(stored('nodes', node!.id)).not.toHaveProperty(field)
    expect(stored('characters', 'C1-P001')).toMatchObject({ profile: { ageText: '十四五岁' } })
    expect(stored('characters', 'C1-P001')).not.toHaveProperty('confidence')
    expect(stored('locations', 'C1-L001')).not.toHaveProperty('confidence')
    expect(stored('characters', oldPerson.id)).toMatchObject({ profile: { age: 46 }, confidence: 0.5 })
    expect(stored('nodes', oldNode.id)).toMatchObject({ targets: ['旧账册'], started_actions: ['核账'] })
  } finally { persisted.close() }

  const backups = createBackupService(workspace, importer)
  const { bytes } = await backups.exportBook(book.id)
  const restored = workspace.openBook((await backups.importBackup(bytes)).id)
  expect(await restored.table('nodes').get(node!.id)).toMatchObject({ clues: ['顾衡来信'] })
  expect(await restored.table('nodes').get(oldNode.id)).toMatchObject({ targets: ['旧账册'], started_actions: ['核账'] })
  expect(await restored.table('characters').get(oldPerson.id)).toMatchObject({ profile: { age: 46 }, confidence: 0.5 })
  expect(await restored.table('characterRelations').toArray()).toMatchObject([{ direction: 'bidirectional', forwardLabel: '朋友', reverseLabel: '朋友' }])
})

test('migration interrupted before publication retries without duplicates and keeps source and credentials', async () => {
  const { workspace, call } = fixture()
  const prefix = `migration-${crypto.randomUUID()}`
  const scope = { settingsName: `${prefix}-settings`, bookPrefix: `${prefix}-book-` }
  const browser = createWorkspace(scope), importer = createImportService(browser)
  cleanups.push(async () => { importer.close(); browser.close(); for (const name of await Dexie.getDatabaseNames()) if (name.startsWith(prefix)) await Dexie.delete(name) })
  const book = await importer.importNovel(preview())
  const assets = createAssetService(browser), character = await assets.create(book.id, 'character', { name: '沈青', chapterIndex: '1' })
  await createModelConfigStore(browser).save(defaultConfig, 'migration-fake-key')
  let fail = true
  const interrupted: StorageCall = async body => { if (body.action === 'publishMigration' && fail) { fail = false; throw new Error('fixture disconnect') }; return call(body) }
  await expect(migrateBrowserData(interrupted, () => {}, scope)).rejects.toThrow('fixture disconnect')
  expect(await workspace.listBooks()).toEqual([])
  expect(await browser.openBook(book.id).table('characters').get(character.id)).toEqual(character)
  await migrateBrowserData(call, () => {}, scope)
  await migrateBrowserData(call, () => {}, scope)
  expect((await workspace.listBooks()).map(row => row.id)).toEqual([book.id])
  expect(await workspace.openBook(book.id).table('characters').get(character.id)).toEqual(character)
  expect((await createModelConfigStore(workspace).load()).apiKey).toBe('migration-fake-key')
  expect(await browser.listBooks()).toEqual([book])
  await workspace.openBook(book.id).table('characters').update(character.id, { name: '磁盘修改' })
  await migrateBrowserData(call, () => {}, scope)
  expect((await workspace.openBook(book.id).table('characters').get(character.id)).name).toBe('磁盘修改')
})

test('disk commit failure rolls back asset, lifecycle and progress; deletion recovers after publication failure', async () => {
  const { workspace } = fixture(), importer = createImportService(workspace)
  cleanups.push(async () => importer.close())
  const book = await importer.importNovel(preview()), db = workspace.openBook(book.id)
  const before = await db.table('compileProgress').toArray()
  const fault = vi.spyOn(SqliteRecordStore.prototype, 'commit').mockImplementationOnce(() => { throw new Error('fixture disk full') })
  await expect(createAssetService(workspace).create(book.id, 'character', { name: '沈青', chapterIndex: '1' })).rejects.toThrow('fixture disk full')
  fault.mockRestore()
  expect(await db.table('characters').count()).toBe(0)
  expect(await db.table('assetLifecycle').count()).toBe(0)
  expect(await db.table('compileProgress').toArray()).toEqual(before)
  const deleting = createImportService(workspace, { checkpoint: async point => { if (point === 'after-delete-hide') throw new Error('fixture interruption') } })
  cleanups.push(async () => deleting.close())
  await expect(deleting.deleteBook(book.id)).rejects.toThrow('删除待完成')
  expect(await workspace.listBooks()).toEqual([])
  expect(await workspace.bookExists(book.id)).toBe(true)
  const recovery = createImportService(workspace, { ownerAlive: async () => false })
  cleanups.push(async () => recovery.close())
  expect(await recovery.recoverPending()).toMatchObject({ deleted: 1, pending: 0 })
  expect(await workspace.bookExists(book.id)).toBe(false)
})

test('legacy version 7 copies through validation without upgrading its source database', async () => {
  const { workspace, call } = fixture()
  const prefix = `migration-v7-${crypto.randomUUID()}`, scope = { settingsName: `${prefix}-settings`, bookPrefix: `${prefix}-` }
  const source = createWorkspace(scope)
  const book = { id: 'legacy', title: '旧版样本', sourceFileName: '旧版.txt', createdAt: '2026-10-31T00:00:00.000Z' }
  await source.settings.books.put(book)
  await createLegacyBook(scope, { bookId: 'legacy', characters: [character('C1-P001', '沈青')] }, 7, true)
  cleanups.push(async () => { source.close(); for (const name of await Dexie.getDatabaseNames()) if (name.startsWith(prefix)) await Dexie.delete(name) })
  await migrateBrowserData(call, () => {}, scope)
  expect((await workspace.openBook('legacy').table('characters').get('C1-P001')).name).toBe('沈青')
  const original = new Dexie(scope.bookPrefix + 'legacy')
  try { await original.open(); expect(original.verno).toBe(7); expect(await original.table('characters').count()).toBe(1) } finally { original.close() }
})

test('旧迁移摘要升级空表后仍跳过，有新记录时拒绝覆盖磁盘书', async () => {
  const { workspace, call } = fixture()
  const prefix = `migration-empty-v9-${crypto.randomUUID()}`, scope = { settingsName: `${prefix}-settings`, bookPrefix: `${prefix}-book-` }
  const browser = createWorkspace(scope), book = { id: 'old-marker', title: '旧迁移标记', sourceFileName: 'old.txt', createdAt: '2026-11-19T00:00:00.000Z' }
  cleanups.push(async () => { browser.close(); for (const name of await Dexie.getDatabaseNames()) if (name.startsWith(prefix)) await Dexie.delete(name) })
  await browser.settings.books.put(book)
  const old = new Dexie(scope.bookPrefix + book.id)
  old.version(8).stores({ ...bookSchemaV5, characterRelations: 'id, bookId, originCharacterId, sourceId, targetName, *targetIds', characterRelationEdits: 'pairKey, aId, bId, state', legacyRelationRecords: 'id, bookId, disposition' })
  const { extractionTasks: _tasks, extractionInputs: _inputs, storyEvents: _events, ...tables } = emptyTables()
  try {
    await old.open()
    await old.table('chapters').put({ bookId: book.id, chapterIndex: '1', chapterName: '第一章', order: 0, charCount: text.length })
    await old.table('chapterTexts').put({ bookId: book.id, chapterIndex: '1', text })
    for (const name of Object.keys(tables) as (keyof typeof tables)[]) tables[name] = await old.table(name).toArray()
    expect(old.verno).toBe(8)
  } finally { old.close() }
  const legacyDigest = await checksumOf(new TextEncoder().encode(JSON.stringify({ book, tables })))
  await migrateBrowserData(call, () => {}, scope)
  expect((await workspace.settings.appSettings.get(`migration:book:${book.id}`))?.value).toMatchObject({ digest: legacyDigest })
  await workspace.settings.books.update(book.id, { title: '磁盘保留的手动修改' })
  const upgraded = browser.openBook(book.id); await upgraded.open()
  expect(upgraded.verno).toBe(10)
  expect(await upgraded.table('storyEvents').count()).toBe(0)
  expect(await upgraded.table('extractionTasks').count()).toBe(0)
  expect(await upgraded.table('extractionInputs').count()).toBe(0)
  const messages: string[] = []
  await migrateBrowserData(call, message => messages.push(message), scope)
  expect(messages.some(message => message.includes('已迁移，保留磁盘上的最新结果'))).toBe(true)
  expect((await workspace.settings.books.get(book.id))?.title).toBe('磁盘保留的手动修改')
  const snapshotText = '新增历史输入', snapshotId = (await checksumOf(new TextEncoder().encode(snapshotText))).slice('sha256:'.length)
  await upgraded.table('extractionInputs').put({ id: snapshotId, bookId: book.id, text: snapshotText, createdAt: book.createdAt })
  await expect(migrateBrowserData(call, () => {}, scope)).rejects.toThrow('相同编号')
  expect((await workspace.settings.books.get(book.id))?.title).toBe('磁盘保留的手动修改')
})

test('disk trace pagination returns the requested page and only its referenced snapshots', async () => {
  const { workspace, call } = fixture(), db = workspace.openBook('book')
  await db.table('storySessionEntries').bulkPut([
    { id: 'prompt', sessionId: 's', ordinal: 1000, type: 'system_snapshot', snapshotId: 'prompt', text: 'fixture' },
    ...Array.from({ length: 61 }, (_, i) => ({ id: `request-${String(i).padStart(3, '0')}`, requestId: `r${String(i).padStart(3, '0')}`, sessionId: 's', ordinal: i, type: 'request_trace', runId: 'run', bookId: 'book', unitId: '', workId: 'profile:p1', startedAt: '2026-11-13T00:00:00.000Z', input: { systemPromptSnapshotId: 'prompt' } })),
  ])
  const page = await readBookTrace(workspace, 'book', 'run', { limit: 5 })
  expect(page.total).toBe(61)
  expect(page.requests.map(row => row.requestId)).toEqual(['r056', 'r057', 'r058', 'r059', 'r060'])
  expect(page.snapshots.get('prompt')?.text).toBe('fixture')
  const older = await call<{ rows: StoredValue[]; total: number }>({ action: 'tracePage', scope: 'book:book', options: { runId: 'run', unitId: 'profile:p1', before: { startedAt: '2026-11-13T00:00:00.000Z', requestId: 'r056' }, limit: 2 } })
  expect(older.rows.map(row => row.requestId)).toEqual(['r054', 'r055'])
})

test('事件节点列表先按章节和章内顺序排序再分页，保留缺号后的节点编号', async () => {
  const { workspace, call } = fixture(), bookId = 'ordered-nodes', db = workspace.openBook(bookId)
  const chapters = ['9', '3'].map((chapterIndex, order) => ({ bookId, chapterIndex, order, chapterName: `样本 ${chapterIndex}`, charCount: 0 }))
  const nodes = [
    { bookId, id: 'C3-N001', name: '甲节点', chapterIndex: '3', order: 0 },
    { bookId, id: 'C9-N007', name: '乙节点', chapterIndex: '9', order: 1 },
    { bookId, id: 'C9-N004', name: '丙节点', chapterIndex: '9', order: 0 },
  ]
  await db.chapters.bulkPut(chapters)
  await db.table('nodes').bulkPut(nodes)
  const options = { limit: 2 }
  const read = (offset: number) => call<AssetPage>({ action: 'assetPage', scope: `book:${bookId}`, kind: 'node', options: { ...options, offset } })
  const first = await read(0)
  expect(first).toEqual(makeAssetPage('node', nodes, chapters, options))
  expect(first.items.map(item => item.id)).toEqual(['C9-N004', 'C9-N007'])
  expect((await read(2)).items.map(item => item.id)).toEqual(['C3-N001'])
})

test('automatic backup failure stays visible without undoing saved data and can be retried', async () => {
  const { workspace, call } = fixture()
  const failure = vi.spyOn(SqliteRecordStore.prototype, 'backup').mockRejectedValue(new Error('fixture backup full'))
  await workspace.settings.appSettings.put({ key: 'saved', value: 'committed' })
  await vi.waitFor(async () => expect((await call<{ backupError?: string }>({ action: 'status' })).backupError).toContain('自动备份失败'))
  expect((await workspace.settings.appSettings.get('saved'))?.value).toBe('committed')
  failure.mockRestore()
  await call({ action: 'backup' })
  expect((await call<{ backupError?: string }>({ action: 'status' })).backupError).toBeUndefined()
})
test('scope transactions serialize competing writes and support queries after pending changes', async () => {
  const { workspace } = fixture(), db = workspace.openBook('book')
  await db.table('storySessionEntries').bulkPut([{ id: 'a', sessionId: 's', ordinal: 1, type: 'note' }, { id: 'b', sessionId: 's', ordinal: 2, type: 'note' }])
  await transact(db, 'rw', [db.tables], async db => {
    await db.table('storySessionEntries').delete('a')
    expect(await db.table('storySessionEntries').where('sessionId').equals('s').primaryKeys()).toEqual(['b'])
  })
  await db.table('characters').put({ id: 'person', counter: 0 })
  await Promise.all(Array.from({ length: 3 }, () => transact(db, 'rw', [db.table('characters')], async db => {
    const row = await db.table('characters').get('person')
    await db.table('characters').put({ ...row, counter: row.counter + 1 })
  })))
  expect((await db.table('characters').get('person')).counter).toBe(3)
})
