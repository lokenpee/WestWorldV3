import Dexie from 'dexie'
import { MAIN_SCOPE, type Book, type DatabaseScope } from '../../lib/storage/workspace'
import { emptyTables, migrateRelationsData, tableNames } from '../backup/data'
import { checksumOf, encodeBackup, inspectBackup } from '../backup/codec'
import { remoteDatabase, storageChanged, type StorageCall } from './client'
import { transact } from '../../lib/storage/transaction'
import type { StoredValue } from './contracts'

export async function legacyBooks(scope: DatabaseScope = MAIN_SCOPE): Promise<Book[]> {
  if (!await Dexie.exists(scope.settingsName)) return []
  const db = new Dexie(scope.settingsName)
  try { await db.open(); return db.table<Book>('books').toArray() } finally { db.close() }
}

/** Source databases are opened without version declarations: no upgrade or ready repair writes. */
export async function migrateBrowserData(call: StorageCall, progress: (message: string) => void, scope: DatabaseScope = MAIN_SCOPE) {
  const books = await legacyBooks(scope)
  for (const [index, book] of books.entries()) {
    progress(`正在读取 ${book.title}（${index + 1}/${books.length}）`)
    if (!await Dexie.exists(scope.bookPrefix + book.id)) throw new Error(`《${book.title}》的浏览器书库缺失，原书架已保留。`)
    const source = new Dexie(scope.bookPrefix + book.id)
    let data = { book, tables: emptyTables() }
    let version = 8
    try {
      await source.open()
      version = source.verno
      if (source.verno < 5 || source.verno > 8) throw new Error(`《${book.title}》的旧库版本不支持直接迁移，请先使用对应版本导出整书备份。`)
      await source.transaction('r', source.tables, async tx => {
        for (const name of tableNames) if (source.tables.some(table => table.name === name)) data.tables[name] = await tx.table(name).toArray()
      })
      if (data.tables.pipelineRuns.some(row => row.recordType === 'lease' && Number(row.expiresAt ?? Infinity) > Date.now())) throw new Error(`《${book.title}》还有运行中的任务，请在旧页面暂停后再迁移。`)
    } finally { source.close() }
    const digest = await checksumOf(new TextEncoder().encode(JSON.stringify(data)))
    const marker = await call<{ value: { value?: { digest?: string } } } | null>({ action: 'get', scope: 'settings', table: 'appSettings', key: `migration:book:${book.id}` })
    const exists = await call({ action: 'get', scope: 'settings', table: 'books', key: book.id })
    if (exists && marker?.value.value?.digest === digest) { progress(`已迁移，保留磁盘上的最新结果：${book.title}`); continue }
    if (exists) throw new Error(`磁盘已有《${book.title}》的相同编号，未覆盖。请使用整书备份恢复为副本。`)
    if (version < 6) data = migrateRelationsData(data)
    // Reuse the established in-memory backup conversion/validation, including paused task recovery.
    const inspected = await inspectBackup((await encodeBackup(data)).bytes)
    if (!inspected.ok || !inspected.data) throw new Error(`《${book.title}》迁移核对失败：${inspected.errors[0]?.message}`)
    data = inspected.data
    const pending = remoteDatabase<Dexie>(call, `book:pending:${book.id}`, 'migration')
    progress(`正在复制并核对：${book.title}`)
    await transact(pending, 'rw', [pending.tables], async db => {
      for (const name of tableNames) { await db.table(name).clear(); await db.table(name).bulkPut(data.tables[name]) }
      for (const name of tableNames) {
        const saved = await db.table(name).toArray()
        const stable = (rows: StoredValue[]) => rows.map(row => JSON.stringify(row)).sort()
        if (JSON.stringify(stable(saved)) !== JSON.stringify(stable(data.tables[name]))) throw new Error(`《${book.title}》的${name}复制核对失败，源数据已保留。`)
      }
    })
    await call({ action: 'publishMigration', book, digest, source: scope.settingsName, counts: Object.fromEntries(tableNames.map(name => [name, data.tables[name].length])) })
  }
  if (await Dexie.exists(scope.settingsName)) {
    const settings = new Dexie(scope.settingsName)
    try {
      await settings.open()
      const copied = await settings.transaction('r', settings.tables, async tx => ({
        appSettings: await tx.table('appSettings').toArray(), credentials: settings.tables.some(table => table.name === 'credentials') ? await tx.table('credentials').toArray() : [],
      }))
      await call({ action: 'migrateSettings', ...copied, appSettings: copied.appSettings.filter(row => row.key !== 'assets.exportDirectory') })
    } finally { settings.close() }
  }
  await call({ action: 'backup' })
  storageChanged()
  progress(`迁移完成：${books.length} 本书，原浏览器数据已保留。`)
  return books.length
}
