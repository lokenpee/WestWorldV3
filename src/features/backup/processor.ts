import type { Book } from '../../lib/storage/workspace'
import { checksumOf, encodeBackup, inspectBackup, restoredTables, type BackupInspection, type BackupProgress, type ExportResult } from './codec'
import { migrateRelationsData, type BookData, type BookTables } from './data'

export type BackupPreview = Omit<BackupInspection, 'data'>
export interface BackupJobInputs {
  prepare: { bytes: Uint8Array }
  inspect: { bytes: Uint8Array }
  restore: { bookId: string }
  encode: { data: BookData }
  migrationDigest: { data: BookData; version: number }
  migrate: undefined
}
export interface BackupJobResults {
  prepare: { inspection: BackupPreview; book?: Book }
  inspect: BackupInspection
  restore: BookTables
  encode: ExportResult
  migrationDigest: string
  migrate: BookData
}
export type BackupJobKind = keyof BackupJobInputs
export type BackupJob = { [K in BackupJobKind]: { kind: K; input: BackupJobInputs[K] } }[BackupJobKind]
export type BackupJobResult = BackupJobResults[BackupJobKind]

/** 每个准备会话持有一份资料；界面只收到预检摘要，恢复时才取出换号后的表。 */
export function createBackupProcessor() {
  let prepared: BookData | undefined
  let migration: { data: BookData; version: number } | undefined
  return {
    async run(job: BackupJob, onProgress?: BackupProgress): Promise<BackupJobResult> {
      switch (job.kind) {
        case 'prepare': {
          prepared = undefined
          const { data, ...inspection } = await inspectBackup(job.input.bytes, onProgress)
          if (inspection.ok) prepared = data
          return { inspection, ...(prepared ? { book: prepared.book } : {}) }
        }
        case 'inspect': return inspectBackup(job.input.bytes, onProgress)
        case 'restore': {
          if (!prepared) throw new Error('备份准备结果已失效，请重新选择文件。')
          return restoredTables(prepared, job.input.bookId, onProgress)
        }
        case 'encode': return encodeBackup(job.input.data, onProgress)
        case 'migrationDigest': {
          migration = job.input
          onProgress?.('正在核对旧库是否已经迁移…')
          let digestData = migration.data
          if (!migration.data.tables.extractionTasks.length && !migration.data.tables.extractionInputs.length) {
            const { extractionTasks: _tasks, extractionInputs: _inputs, ...tables } = migration.data.tables
            // 仅新增空表的旧源库保持既有迁移摘要，已保存的磁盘资料仍按原标记跳过。
            digestData = { ...migration.data, tables } as BookData
          }
          return checksumOf(new TextEncoder().encode(JSON.stringify(digestData)))
        }
        case 'migrate': {
          if (!migration) throw new Error('旧库准备结果已失效，请重新迁移。')
          const data = migration.version < 6 ? migrateRelationsData(migration.data) : migration.data
          const inspected = await inspectBackup((await encodeBackup(data, onProgress)).bytes, onProgress)
          if (!inspected.ok || !inspected.data) throw new Error(`《${data.book.title}》迁移核对失败：${inspected.errors[0]?.message}`)
          return inspected.data
        }
      }
    },
    dispose() { prepared = undefined; migration = undefined },
  }
}

export interface BackupWorkerRequest { id: number; job: BackupJob }
export type BackupWorkerResponse =
  | { id: number; type: 'progress'; message: string }
  | { id: number; type: 'result'; value: BackupJobResult }
  | { id: number; type: 'error'; message: string }
