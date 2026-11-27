import { transact } from './transaction'
import { assertPreview, chapterText, type ImportPreview } from '../../features/import/text'
import type { Book, createWorkspace } from './workspace'
import { createImportOwnership } from './importOwnership'
import { emptyTables, tableNames, validateBookData, type BookTables } from '../../features/backup/data'

type Workspace = ReturnType<typeof createWorkspace>
interface ImportJournal {
  operationId: string; action: 'import' | 'delete'; bookId: string
  state: 'preparing' | 'ready' | 'cleanup_pending' | 'deleting'
  owner: string; leaseUntil: number; createdAt: string; updatedAt: string
  book?: Book; error?: string
}
export interface RecoveryReport { recovered: number; cleaned: number; deleted: number; pending: number; errors: string[] }
interface Environment {
  now?: () => number
  ownerAlive?: (owner: string) => Promise<boolean>
  checkpoint?: (point: string) => Promise<void>
}
const keyOf = (id: string) => `book.lifecycle:${id}`
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

function isJournal(value: unknown): value is ImportJournal {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<ImportJournal>
  return ((row.action === 'import' && ['preparing', 'ready', 'cleanup_pending'].includes(row.state ?? '')) || (row.action === 'delete' && row.state === 'deleting' && row.book === undefined)) && typeof row.operationId === 'string' && !!row.operationId && typeof row.bookId === 'string' && !!row.bookId && typeof row.owner === 'string' && !!row.owner && typeof row.createdAt === 'string' && typeof row.updatedAt === 'string' && typeof row.leaseUntil === 'number' && Number.isSafeInteger(row.leaseUntil) && row.leaseUntil >= 0
}

export function createImportService(workspace: Workspace, environment: Environment = {}) {
  const now = environment.now ?? Date.now
  const ownership = createImportOwnership(workspace.scope.settingsName)
  const isAlive = environment.ownerAlive ?? ownership.isAlive
  const settings = workspace.settings
  const timers = new Set<ReturnType<typeof setInterval>>()
  let recovery: Promise<RecoveryReport> | undefined

  async function owned(journal: ImportJournal, scopeDb = settings) {
    const row = (await scopeDb.appSettings.get(keyOf(journal.operationId)))?.value
    if (!isJournal(row) || row.owner !== journal.owner || row.bookId !== journal.bookId || row.action !== journal.action) throw new Error('书籍操作已由其他页面接管，请刷新书架。')
    return row
  }

  async function update(journal: ImportJournal, changes: Partial<ImportJournal>) {
    return transact(settings, 'rw', [settings.appSettings], async (settings) => {
      const row = await owned(journal, settings)
      const next = { ...row, ...changes, updatedAt: new Date(now()).toISOString() }
      await settings.appSettings.put({ key: keyOf(row.operationId), value: next })
      return next
    })
  }

  function hold(journal: ImportJournal) {
    ownership.activate(journal.owner)
    const timer = setInterval(() => { void update(journal, { leaseUntil: now() + 300000 }).catch(() => undefined) }, 30000)
    timers.add(timer)
    return () => { clearInterval(timer); timers.delete(timer); ownership.release(journal.owner) }
  }

  async function publish(journal: ImportJournal) {
    return transact(settings, 'rw', [settings.books, settings.appSettings], async (settings) => {
      const row = await owned(journal, settings)
      if (row.state !== 'ready' || !row.book || row.book.id !== row.bookId || row.leaseUntil <= now()) throw new Error('导入尚未准备完成或租约已失效。')
      if (await settings.books.get(row.bookId)) throw new Error('书籍标识已存在，未覆盖原书。')
      const names = new Set((await settings.books.toArray()).map(book => book.title))
      const baseTitle = row.book.title
      let title = baseTitle
      for (let suffix = 1; names.has(title); suffix++) title = `${baseTitle}（${suffix}）`
      const book = { ...row.book, title }
      await settings.books.add(book)
      await settings.appSettings.delete(keyOf(row.operationId))
      return book
    })
  }

  async function clean(journal: ImportJournal) {
    await transact(settings, 'rw', [settings.books, settings.appSettings], async (settings) => {
      await owned(journal, settings)
      if (await settings.books.get(journal.bookId)) throw new Error('已有可用书籍，停止清理并保留资料。')
    })
    await update(journal, { state: 'cleanup_pending' })
    await removeDatabase(journal.bookId)
    await transact(settings, 'rw', [settings.appSettings], async (settings) => { await owned(journal, settings); await settings.appSettings.delete(keyOf(journal.operationId)) })
  }

  async function removeDatabase(bookId: string) {
    workspace.closeBook(bookId)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        workspace.removeBookDatabase(bookId),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('书库仍被其他页面占用，请关闭该页面后重试恢复。')), 1500) }),
      ])
    } finally { clearTimeout(timer) }
  }

  async function verifyReady(journal: ImportJournal) {
    if (!journal.book || journal.book.id !== journal.bookId || !journal.book.title?.trim() || !journal.book.createdAt) throw new Error('待恢复书籍信息不完整。')
    if (!await workspace.bookExists(journal.bookId)) throw new Error('待恢复书库不存在。')
    const db = workspace.openBook(journal.bookId)
    await db.open()
    const tables = await transact(db, 'r', [db.tables], async (db) => {
      const tables = emptyTables()
      for (const name of tableNames) tables[name] = await db.table(name).toArray()
      return tables
    })
    const errors = await validateBookData({ book: journal.book!, tables })
    if (errors.length) throw new Error(`待恢复资料不完整：${errors[0].path} ${errors[0].message}`)
  }

  async function importNovel(preview: ImportPreview): Promise<Book> {
    assertPreview(preview)
    return importPrepared((id, timestamp) => ({ id, title: preview.fileName.replace(/\.txt$/i, '').trim() || '未命名小说', sourceFileName: preview.fileName, createdAt: timestamp }), async (db, bookId, timestamp) => {
      await transact(db, 'rw', [db.chapters, db.table('chapterTexts'), db.table('compileProgress')], async (db) => {
        await db.chapters.bulkAdd(preview.chapters.map(({ chapterIndex, chapterName, order, charCount }) => ({ chapterIndex, chapterName, order, charCount, bookId })))
        for (let offset = 0; offset < preview.chapters.length; offset += 100) {
          await db.table('chapterTexts').bulkAdd(preview.chapters.slice(offset, offset + 100).map(chapter => ({ bookId, chapterIndex: chapter.chapterIndex, text: chapterText(preview.text, chapter) })))
        }
        await db.table('compileProgress').add({ bookId, stage: 'P1', status: 'idle', totalChapters: preview.chapters.length, completedChapters: [], failedChapters: [], updatedAt: timestamp, scope: 'fullBook', planVersion: '2.2', unit: 'chapter', validity: 'current' })
      })
    })
  }

  async function importPrepared(metadata: (id: string, timestamp: string) => Book, write: (db: ReturnType<Workspace['openBook']>, bookId: string, timestamp: string) => Promise<void>): Promise<Book> {
    const bookId = crypto.randomUUID()
    const timestamp = new Date(now()).toISOString()
    const journal: ImportJournal = { operationId: crypto.randomUUID(), action: 'import', bookId, state: 'preparing', owner: crypto.randomUUID(), leaseUntil: now() + 300000, createdAt: timestamp, updatedAt: timestamp }
    if (await workspace.bookExists(bookId)) throw new Error('书籍标识已存在，请重试。')
    await settings.appSettings.add({ key: keyOf(journal.operationId), value: journal })
    const release = hold(journal)
    try {
      const db = workspace.openBook(bookId)
      await db.open()
      await owned(journal)
      await write(db, bookId, timestamp)
      await environment.checkpoint?.('after-book-write')
      const book = metadata(bookId, timestamp)
      const ready = await update(journal, { state: 'ready', book })
      await verifyReady(ready)
      await environment.checkpoint?.('before-publish')
      return await publish(ready)
    } catch (error) {
      try { await clean(journal) }
      catch (cleanupError) {
        await update(journal, { error: messageOf(cleanupError), leaseUntil: 0 }).catch(() => undefined)
        throw new Error(`导入失败：${messageOf(error)}；临时资料待恢复清理：${messageOf(cleanupError)}`)
      }
      throw new Error(`导入失败：${messageOf(error)}。临时资料已清理，可重新导入。`)
    } finally { release() }
  }

  async function finishDelete(journal: ImportJournal) {
    await transact(settings, 'r', [settings.books, settings.appSettings], async (settings) => {
      await owned(journal, settings)
      if (await settings.books.get(journal.bookId)) throw new Error('书籍仍在书架中，保留资料并停止删除恢复。')
    })
    await removeDatabase(journal.bookId)
    await transact(settings, 'rw', [settings.appSettings], async (settings) => { await owned(journal, settings); await settings.appSettings.delete(keyOf(journal.operationId)) })
  }

  async function deleteBook(bookId: string) {
    if (!await settings.books.get(bookId)) throw new Error('书籍不存在，请刷新书架。')
    const timestamp = new Date(now()).toISOString()
    const journal: ImportJournal = { operationId: crypto.randomUUID(), action: 'delete', bookId, state: 'deleting', owner: crypto.randomUUID(), leaseUntil: now() + 300000, createdAt: timestamp, updatedAt: timestamp }
    const exists = await workspace.bookExists(bookId)
    const db = exists ? workspace.openBook(bookId) : undefined
    let registered = false
    let release: (() => void) | undefined
    try {
      if (db) await transact(db, 'rw', [db.tables], async (db) => {
        const leases = await db.table('pipelineRuns').toArray()
        const busy = leases.find(row => row.recordType === 'lease' && (typeof row.expiresAt !== 'number' || row.expiresAt > now()))
        if (busy) throw new Error(`本书正在处理（${busy.resource ?? busy.lockKey ?? busy.stage ?? '任务'}），请等待任务结束后删除。`)
        for (const resource of ['extraction', 'world', 'narrative']) await db.table('pipelineRuns').put({ id: `lease:${resource}`, recordType: 'lease', bookId, lockKey: resource, resource, owner: journal.owner, runId: journal.operationId, expiresAt: journal.leaseUntil })
      })
      await transact(settings, 'rw', [settings.books, settings.appSettings], async (settings) => {
        if (!await settings.books.get(bookId)) throw new Error('书籍已由其他页面删除。')
        await settings.appSettings.add({ key: keyOf(journal.operationId), value: journal })
        await settings.books.delete(bookId)
      })
      registered = true; release = hold(journal)
      await environment.checkpoint?.('after-delete-hide')
      await finishDelete(journal)
    } catch (error) {
      if (registered) {
        await update(journal, { error: messageOf(error), leaseUntil: 0 }).catch(() => undefined)
        throw new Error(`删除待完成：${messageOf(error)} 请重试书籍恢复。`)
      }
      if (db?.isOpen()) await transact(db, 'rw', [db.table('pipelineRuns')], async (db) => {
        for (const row of await db.table('pipelineRuns').toArray()) if (row.recordType === 'lease' && row.owner === journal.owner) await db.table('pipelineRuns').delete(row.id)
      })
      throw error
    } finally { release?.() }
  }

  async function performRecovery(): Promise<RecoveryReport> {
    const report: RecoveryReport = { recovered: 0, cleaned: 0, deleted: 0, pending: 0, errors: [] }
    const rows = await settings.appSettings.where('key').startsWith('book.lifecycle:').toArray()
    for (const entry of rows) {
      if (!isJournal(entry.value) || entry.key !== keyOf(entry.value.operationId)) continue
      const old = entry.value
      if (old.leaseUntil > now() || await isAlive(old.owner)) { report.pending += 1; continue }
      const owner = crypto.randomUUID()
      const journal = await transact(settings, 'rw', [settings.appSettings], async (settings) => {
        const current = (await settings.appSettings.get(entry.key))?.value
        if (!isJournal(current) || current.owner !== old.owner || current.leaseUntil !== old.leaseUntil || current.leaseUntil > now()) return undefined
        const next = { ...current, owner, leaseUntil: now() + 300000 }
        await settings.appSettings.put({ key: entry.key, value: next })
        return next
      })
      if (!journal) { report.pending += 1; continue }
      const release = hold(journal)
      try {
        if (journal.action === 'delete') { await finishDelete(journal); report.deleted += 1; continue }
        if (journal.state === 'ready') {
          try { await verifyReady(journal) }
          catch (error) { await clean(journal); report.cleaned += 1; report.errors.push(messageOf(error)); continue }
          await publish(journal)
          report.recovered += 1
        } else { await clean(journal); report.cleaned += 1 }
      } catch (error) {
        report.errors.push(messageOf(error)); report.pending += 1
        await update(journal, { error: messageOf(error), leaseUntil: 0 }).catch(() => undefined)
      } finally { release() }
    }
    return report
  }

  return {
    importNovel,
    pendingOperationsCount: () => settings.appSettings.where('key').startsWith('book.lifecycle:').count(),
    importData(book: Book, prepare: (bookId: string) => Promise<BookTables>, title = `${book.title}（导入）`) {
      return importPrepared((id, timestamp) => ({ ...book, id, title, createdAt: timestamp }), async (db, bookId) => {
        const tables = await prepare(bookId)
        const errors = await validateBookData({ book: { ...book, id: bookId }, tables })
        if (errors.length) throw new Error(`恢复校验失败：${errors[0].path} ${errors[0].message}`)
        await transact(db, 'rw', [db.tables], async (db) => { for (const name of tableNames) await db.table(name).bulkAdd(tables[name]) })
      })
    },
    deleteBook,
    recoverPending() {
      recovery ??= performRecovery().finally(() => { recovery = undefined })
      return recovery
    },
    close() { for (const timer of timers) clearInterval(timer); timers.clear(); ownership.close() },
  }
}

export type ImportService = ReturnType<typeof createImportService>
