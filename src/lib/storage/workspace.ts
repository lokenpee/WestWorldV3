import { migrateNarrativeFields, type NarrativeTables } from '../../features/assets/narrativeMigration'
import { transact } from './transaction'
import Dexie, { type Table } from 'dexie'
import { remoteDatabase, type StorageCall } from '../../features/local-storage/client'
import { migrateCharacterRelations, migrateNodeBindings } from '../../features/assets/migrate'
import type { Character, CharacterRelationEdit, EventNode, LegacyRelationRecord, Lifecycle } from '../../features/assets/types'
import { dexieMergeStore } from '../../features/assets/mergeCore'
import { repairRelationBindings } from '../../features/assets/repair'
import { convertLegacyRelations } from '../../features/assets/legacyRelations'
import { invalidateAssetProgress } from '../../features/assets/invalidate'

export interface Book {
  id: string
  title: string
  sourceFileName: string
  createdAt: string
}

export interface Chapter {
  bookId: string
  chapterIndex: string
  chapterName: string
  order: number
  charCount: number
}

export interface DatabaseScope {
  settingsName: string
  bookPrefix: string
}

export const MAIN_SCOPE: DatabaseScope = {
  settingsName: 'westworld_settings',
  bookPrefix: 'westworld_canon_',
}
export const BOOK_SCHEMA_VERSION = 12

export interface BookSummary {
  bookId: string
  counts: { chapters: number; characters: number; locations: number; nodes: number; eventLines: number }
  chapters: Chapter[]
}

export interface BookRepository {
  listBooks(): Promise<Book[]>
  getBookSummary(bookId: string): Promise<BookSummary>
  listChapters(bookId: string): Promise<Chapter[]>
  readChapter(bookId: string, chapterIndex: string): Promise<string>
}

class SettingsDatabase extends Dexie {
  declare books: Table<Book, string>
  declare appSettings: Table<{ key: string; value: unknown }, string>

  constructor(name: string) {
    super(name)
    this.version(2).stores({ credentials: 'providerId', appSettings: 'key', books: 'id, createdAt' })
  }
}

// 每本书独立保存当前资产和原文。
class BookDatabase extends Dexie {
  declare chapters: Table<Chapter, string>

  constructor(name: string, bookId: string) {
    super(name)
    this.version(5).stores({
      chapters: 'chapterIndex, order',
      chapterTexts: 'chapterIndex',
      characters: 'id, chapterIndex, name',
      locations: 'id, chapterIndex, name',
      nodes: 'id, chapterIndex, order',
      eventLines: 'id, lineStatus',
      compileProgress: 'stage',
      storyEditorMemory: 'id, sessionId',
      storyEditorNotes: 'id, &[sessionId+key], sessionId, kind, status, updatedAt',
      storyEditorCheckpoints: 'id, sessionId, stage, phase, status, updatedAt',
      storySessions: 'id, status, createdAt, parentSessionId',
      storySessionEntries: 'id, &[sessionId+ordinal], sessionId, parentId, type',
      extractionReceipts: 'key, chapterIndex, substep',
      assetLifecycle: 'key, kind, originId, currentId, state',
      pipelineRuns: 'id, recordType, stage, status, startedAt, &lockKey',
    }).upgrade(() => {
      // 升级事务中止时，浏览器保留原库。
      throw new Error('检测到旧版书库，需要完成数据迁移后打开。')
    })
    this.version(6).stores({
      characterRelations: 'id, bookId, originCharacterId, sourceId, targetName, *targetIds',
    }).upgrade(async transaction => {
      // 人物行旧关系移出为独立记录；旧节点称呼变成绑定来源。事务失败时原库保持不变。
      const characters = await transaction.table('characters').toArray() as unknown as Character[]
      const lifecycle = await transaction.table('assetLifecycle').toArray() as unknown as Lifecycle[]
      const relations = migrateCharacterRelations(characters, lifecycle)
      if (relations.length) await transaction.table('characterRelations').bulkPut(relations)
      for (const person of characters) if ('relations' in person) {
        const { relations: _legacy, ...rest } = person
        await transaction.table('characters').put(rest)
      }
      const nodes = await transaction.table('nodes').toArray() as unknown as EventNode[]
      for (const [index, node] of nodes.entries()) {
        const next = migrateNodeBindings([node], characters)[0]
        if (JSON.stringify(next) === JSON.stringify(nodes[index])) continue
        await transaction.table('nodes').put({ ...next, revision: (node.revision ?? 1) + 1 })
      }
    })
    this.version(7).stores({
      characterRelationEdits: 'pairKey, aId, bId, state',
    })
    this.version(8).stores({
      chapters: 'chapterIndex, order',
      chapterTexts: 'chapterIndex',
      characters: 'id, chapterIndex, name',
      locations: 'id, chapterIndex, name',
      nodes: 'id, chapterIndex, order',
      eventLines: 'id, lineStatus',
      compileProgress: 'stage',
      storyEditorMemory: 'id, sessionId',
      storyEditorNotes: 'id, &[sessionId+key], sessionId, kind, status, updatedAt',
      storyEditorCheckpoints: 'id, sessionId, stage, phase, status, updatedAt',
      storySessions: 'id, status, createdAt, parentSessionId',
      storySessionEntries: 'id, &[sessionId+ordinal], sessionId, parentId, type',
      extractionReceipts: 'key, chapterIndex, substep',
      assetLifecycle: 'key, kind, originId, currentId, state',
      pipelineRuns: 'id, recordType, stage, status, startedAt, &lockKey',
      characterRelations: 'id, bookId, originCharacterId, sourceId, targetName, *targetIds',
      characterRelationEdits: 'pairKey, aId, bId, state',
      legacyRelationRecords: 'id, bookId, disposition',
    }).upgrade(async transaction => {
      const runs = await transaction.table('pipelineRuns').toArray()
      const active = runs.find(row => row.recordType === 'lease' && (row.expiresAt === undefined || Number(row.expiresAt) > Date.now()))
      if (active) throw new Error(`本书任务正在运行（${active.lockKey === 'narrative' ? '叙事整理' : active.lockKey === 'extraction' ? '逐章提取' : '世界资产整理'}），请先暂停任务再打开书籍。`)
      const characters = await transaction.table('characters').toArray() as unknown as Character[]
      const lifecycle = await transaction.table('assetLifecycle').toArray() as unknown as Lifecycle[]
      const relations = await transaction.table('characterRelations').toArray()
      const edits = await transaction.table('characterRelationEdits').toArray() as unknown as CharacterRelationEdit[]
      const chapterTexts = await transaction.table('chapterTexts').toArray() as unknown as { chapterIndex: string; text: string }[]
      const nodes = await transaction.table('nodes').toArray() as unknown as EventNode[]
      const timestamp = new Date().toISOString()
      const migrationId = `legacy-migration:${crypto.randomUUID()}`
      const converted = convertLegacyRelations({ bookId, relations, characters, lifecycle, edits, chapterTexts, timestamp, migrationId })
      if (converted.report) {
        await transaction.table('characterRelations').clear()
        if (converted.relations.length) await transaction.table('characterRelations').bulkPut(converted.relations as unknown as Record<string, unknown>[])
        await transaction.table('legacyRelationRecords').bulkPut(converted.legacyRecords as unknown as LegacyRelationRecord[])
        await transaction.table('characterRelationEdits').bulkPut(converted.edits as unknown as Record<string, unknown>[])
        await transaction.table('pipelineRuns').put({
          id: migrationId, bookId, recordType: 'asset_edit', stage: 'asset_edit', status: 'completed',
          startedAt: timestamp, finishedAt: timestamp, planVersion: '2.2', result: converted.report,
        })
        await invalidateAssetProgress({
          rows: async table => table === 'pipelineRuns' ? await transaction.table('pipelineRuns').toArray() : await transaction.table(table).toArray(),
          get: async (table, id) => transaction.table(table).get(id),
          put: async (table, row) => { await transaction.table(table).put(row) },
          remove: async (table, id) => { await transaction.table(table).delete(id) },
        }, converted.report.affectedIds.map(id => ({ kind: 'character' as const, id })), timestamp, runs)
      }
      // 历史节点若还没有绑定来源，先补齐再交给 ready 修复。
      for (const [index, node] of nodes.entries()) {
        if (node.actorBindings !== undefined) continue
        const next = migrateNodeBindings([node], characters)[0]
        if (JSON.stringify(next) === JSON.stringify(nodes[index])) continue
        await transaction.table('nodes').put({ ...next, revision: Number(node.revision ?? 1) + 1 })
      }
    })
    this.version(9).stores({
      extractionTasks: 'id, runId, [runId+ordinal], [runId+status]',
      extractionInputs: 'id',
    })
    this.version(10).stores({ storyEvents: 'id' })
    this.version(11).stores({ eventRetrievalVectors: 'id' })
    this.version(BOOK_SCHEMA_VERSION).stores({}).upgrade(async tx => {
      const tables: NarrativeTables = { nodes: [], storyEvents: [], eventLines: [], characters: [] }
      for (const name of Object.keys(tables) as (keyof NarrativeTables)[]) tables[name] = await tx.table(name).toArray()
      migrateNarrativeFields(tables)
      for (const name of ['nodes', 'storyEvents', 'eventLines'] as const) await tx.table(name).bulkPut(tables[name])
    })
    this.on('ready', () => this.transaction('rw', this.tables, async () => {
      await repairRelationBindings(dexieMergeStore(this), bookId)
    }))
  }
}

export function createWorkspace(scope: DatabaseScope = MAIN_SCOPE, disk?: StorageCall) {
  const settings = disk ? remoteDatabase<SettingsDatabase>(disk, 'settings', scope.settingsName) : new SettingsDatabase(scope.settingsName)
  // FileSystemDirectoryHandle is a browser permission object, not serializable book data.
  const browserPermissions = disk ? new SettingsDatabase(`${scope.settingsName}-permissions`) : settings
  const bookDatabases = new Map<string, BookDatabase>()

  function openBook(bookId: string) {
    if (!bookId) throw new Error('缺少书籍标识')
    let db = bookDatabases.get(bookId)
    if (!db) {
      db = disk ? remoteDatabase<BookDatabase>(disk, `book:${bookId}`, `${scope.bookPrefix}${bookId}`) : new BookDatabase(`${scope.bookPrefix}${bookId}`, bookId)
      bookDatabases.set(bookId, db)
    }
    return db
  }

  async function listBooks() {
    await settings.open()
    const books = await settings.books.toArray()
    return books.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  }

  async function getBookSummary(bookId: string): Promise<BookSummary> {
    await settings.open()
    if (!await settings.books.get(bookId)) throw new Error('书籍不存在，请重新选择。')
    const db = openBook(bookId)
    await db.open()
    const names = ['chapters', 'characters', 'locations', 'nodes', 'eventLines'] as const
    return transact(db, 'r', [names.map(name => db.table(name))], async (db) => {
      const [chapters, characters, locations, nodes, eventLines] = await Promise.all(names.map(name => db.table(name).count()))
      return {
        bookId,
        counts: { chapters, characters, locations, nodes, eventLines },
        chapters: await db.chapters.orderBy('order').limit(5).toArray(),
      }
    })
  }

  return {
    scope, settings, browserPermissions, openBook, listBooks, getBookSummary, disk,
    async bookExists(bookId: string) { return disk ? disk<boolean>({ action: 'exists', scope: `book:${bookId}` }) : Dexie.exists(scope.bookPrefix + bookId) },
    async removeBookDatabase(bookId: string) {
      if (!disk) { await new Dexie(scope.bookPrefix + bookId).delete(); return }
      const db = openBook(bookId)
      await transact(db, 'rw', [db.tables], async db => { for (const table of db.tables) await table.clear() })
    },
    async listChapters(bookId: string) {
      if (!await settings.books.get(bookId)) throw new Error('书籍不存在，请重新选择。')
      const db = openBook(bookId)
      await db.open()
      return db.chapters.orderBy('order').toArray()
    },
    async readChapter(bookId: string, chapterIndex: string) {
      if (!await settings.books.get(bookId)) throw new Error('书籍不存在，请重新选择。')
      const db = openBook(bookId)
      await db.open()
      const row = await db.table<{ text: string }>('chapterTexts').get(chapterIndex)
      if (!row) throw new Error('该章节正文缺失，无法预览。')
      return row.text
    },
    closeBook(bookId: string) { bookDatabases.get(bookId)?.close(); bookDatabases.delete(bookId) },
    close() {
      for (const db of bookDatabases.values()) db.close()
      bookDatabases.clear()
      settings.close()
      if (browserPermissions !== settings) browserPermissions.close()
    },
  }
}
