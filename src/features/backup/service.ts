import { transact } from '../../lib/storage/transaction'
import type { createWorkspace } from '../../lib/storage/workspace'
import type { ImportService } from '../../lib/storage/importService'
import { emptyTables, tableNames } from './data'
import type { BackupProgress } from './codec'
import { encodeBackupInWorker, inspectBackupInWorker, prepareBackup, restorePreparedBackup, type PreparedBackup } from './preparation'
import { withTraceBarrier } from '../agents/trace'
import { clearCharacterNetworkCache } from '../character-network/cache'

export function createBackupService(workspace: ReturnType<typeof createWorkspace>, importer: ImportService) {
  async function exportBook(bookId: string, onProgress?: BackupProgress) {
    const book = await workspace.settings.books.get(bookId)
    if (!book) throw new Error('书籍不存在，请刷新书架。')
    if (!await workspace.bookExists(bookId)) throw new Error('本书数据库缺失，无法导出。')
    const db = workspace.openBook(bookId)
    const tables = await withTraceBarrier(async () => transact(db, 'r', [db.tables], async (db) => {
      const snapshot = emptyTables()
      for (const name of tableNames) snapshot[name] = await db.table(name).toArray()
      return snapshot
    }))
    return encodeBackupInWorker({ book, tables }, onProgress)
  }
  const restorePrepared = (prepared: PreparedBackup, onProgress?: BackupProgress) => restorePreparedBackup(prepared, (book, read) => importer.importData(book, async bookId => {
    const tables = await read(bookId)
    onProgress?.('正在保存并核对新书…')
    return tables
  }), onProgress)
  return {
    exportBook, inspectBackup: inspectBackupInWorker, prepareBackup, restorePrepared,
    async importBackup(bytes: Uint8Array, onProgress?: BackupProgress) {
      const prepared = await prepareBackup(bytes, onProgress)
      try { return await restorePrepared(prepared, onProgress) }
      finally { prepared.dispose() }
    },
    async deletionBlockers(bookId: string): Promise<string[]> {
      if (!await workspace.settings.books.get(bookId)) return ['书籍已删除']
      if (!await workspace.bookExists(bookId)) return []
      return (await workspace.openBook(bookId).table('pipelineRuns').toArray()).filter(row => row.recordType === 'lease' && (typeof row.expiresAt !== 'number' || row.expiresAt > Date.now())).map(row => String(row.resource ?? row.lockKey ?? row.stage ?? '任务'))
    },
    async deleteBook(bookId: string) { await importer.deleteBook(bookId); clearCharacterNetworkCache(bookId) },
    settings: workspace.settings,
    directorySettings: workspace.browserPermissions,
  }
}
export type BackupService = ReturnType<typeof createBackupService>
