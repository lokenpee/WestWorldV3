import Dexie, { type Table } from 'dexie'

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

  constructor(name: string) {
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
  }
}

export function createWorkspace(scope: DatabaseScope = MAIN_SCOPE) {
  const settings = new SettingsDatabase(scope.settingsName)
  const bookDatabases = new Map<string, BookDatabase>()

  function openBook(bookId: string) {
    if (!bookId) throw new Error('缺少书籍标识')
    let db = bookDatabases.get(bookId)
    if (!db) {
      db = new BookDatabase(`${scope.bookPrefix}${bookId}`)
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
    return db.transaction('r', names.map(name => db.table(name)), async () => {
      const [chapters, characters, locations, nodes, eventLines] = await Promise.all(names.map(name => db.table(name).count()))
      return {
        bookId,
        counts: { chapters, characters, locations, nodes, eventLines },
        chapters: await db.chapters.orderBy('order').limit(5).toArray(),
      }
    })
  }

  return {
    scope, settings, openBook, listBooks, getBookSummary,
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
    },
  }
}
