import Dexie from 'dexie'
import type { createWorkspace } from '../../lib/storage/workspace'
import type { ImportService } from '../../lib/storage/importService'
import { emptyTables, tableNames } from './data'
import { encodeBackup, inspectBackup, restoredTables } from './codec'

export function createBackupService(workspace: ReturnType<typeof createWorkspace>, importer: ImportService) {
  async function exportBook(bookId: string) {
    const book = await workspace.settings.books.get(bookId)
    if (!book) throw new Error('书籍不存在，请刷新书架。')
    if (!await Dexie.exists(workspace.scope.bookPrefix + bookId)) throw new Error('本书数据库缺失，无法导出。')
    const db = workspace.openBook(bookId)
    const tables = await db.transaction('r', db.tables, async () => {
      const snapshot = emptyTables()
      for (const name of tableNames) snapshot[name] = await db.table(name).toArray()
      return snapshot
    })
    return encodeBackup({ book, tables })
  }
  return {
    exportBook, inspectBackup,
    async importBackup(bytes: Uint8Array) {
      const inspected = await inspectBackup(bytes)
      if (!inspected.ok || !inspected.data) throw new Error(inspected.errors.map(error => `${error.path}：${error.message}`).join('；'))
      const data = inspected.data
      return importer.importData(data.book, bookId => restoredTables(data, bookId))
    },
    async deletionBlockers(bookId: string): Promise<string[]> {
      if (!await workspace.settings.books.get(bookId)) return ['书籍已删除']
      if (!await Dexie.exists(workspace.scope.bookPrefix + bookId)) return []
      return (await workspace.openBook(bookId).table('pipelineRuns').toArray()).filter(row => row.recordType === 'lease' && (typeof row.expiresAt !== 'number' || row.expiresAt > Date.now())).map(row => String(row.resource ?? row.lockKey ?? row.stage ?? '任务'))
    },
    deleteBook: importer.deleteBook,
    settings: workspace.settings,
  }
}
export type BackupService = ReturnType<typeof createBackupService>
