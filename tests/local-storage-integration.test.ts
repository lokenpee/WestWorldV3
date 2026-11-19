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
import { defaultConfig } from '../src/features/models/types'
import type { StorageCall } from '../src/features/local-storage/client'
import type { StoredValue } from '../src/features/local-storage/contracts'
import { migrateBrowserData } from '../src/features/local-storage/migration'
import { createImportService } from '../src/lib/storage/importService'
import { createAssetService } from '../src/features/assets/service'
import { DEFAULT_CHAPTER_PATTERN, splitChapters } from '../src/features/import/text'
import { SqliteRecordStore } from '../src/features/local-storage/sqliteStore'
import { readBookTrace } from '../src/features/agents/trace'
import { character, createLegacyBook } from './support/legacy-book'
const protector = { protect: (text: string) => Buffer.from(text).toString('base64'), unprotect: (text: string) => Buffer.from(text, 'base64').toString() }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'westworld-disk-'))
  const service = createLocalStorageServer(dir, protector)
  const call: StorageCall = async body => JSON.parse(JSON.stringify(await service.execute(JSON.parse(JSON.stringify(body))) ?? null))
  const workspace = createWorkspace({ settingsName: 'test', bookPrefix: 'test-' }, call)
  cleanups.push(async () => { workspace.close(); await service.close(); rmSync(dir, { recursive: true, force: true }) })
  return { service, workspace, call }
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

const text = '第一章 书信\n沈青收到信。'
const preview = () => ({ fileName: '迁移样本.txt', byteLength: new TextEncoder().encode(text).length, text, encoding: 'UTF-8' as const, pattern: DEFAULT_CHAPTER_PATTERN, chapters: splitChapters(text, DEFAULT_CHAPTER_PATTERN) })

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
