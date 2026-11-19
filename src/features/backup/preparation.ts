import type { Book } from '../../lib/storage/workspace'
import type { BackupProgress } from './codec'
import type { BookData, BookTables } from './data'
import type { BackupPreview } from './processor'
import { createBackupWorkerClient } from './workerClient'

export interface PreparedBackup {
  readonly inspection: BackupPreview
  dispose(): void
}
interface PreparedState {
  client: ReturnType<typeof createBackupWorkerClient>
  book?: Book
  inspection: BackupPreview
  progress?: BackupProgress
  restoring: boolean
  disposed: boolean
}
const preparedStates = new WeakMap<PreparedBackup, PreparedState>()
const expired = () => new Error('备份准备结果已失效，请重新选择文件。')

export async function prepareBackup(bytes: Uint8Array, onProgress?: BackupProgress, signal?: AbortSignal): Promise<PreparedBackup> {
  signal?.throwIfAborted()
  const client = createBackupWorkerClient()
  const abort = () => client.dispose()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const result = await client.run('prepare', { bytes }, onProgress)
    signal?.throwIfAborted()
    const state: PreparedState = { client, book: result.book, inspection: result.inspection, progress: onProgress, restoring: false, disposed: false }
    const handle: PreparedBackup = {
      inspection: structuredClone(result.inspection),
      dispose() {
        state.disposed = true
        if (!state.restoring) client.dispose()
      },
    }
    preparedStates.set(handle, state)
    return handle
  } catch (error) { client.dispose(); throw error }
  finally { signal?.removeEventListener('abort', abort) }
}

export async function restorePreparedBackup(handle: PreparedBackup, restore: (book: Book, read: (bookId: string) => Promise<BookTables>) => Promise<Book>, onProgress?: BackupProgress): Promise<Book> {
  const state = preparedStates.get(handle)
  if (!state || state.disposed) throw expired()
  if (state.restoring) throw new Error('这份备份正在恢复，请等待完成。')
  if (!state.inspection.ok || !state.book) throw new Error(state.inspection.errors.map(error => `${error.path}：${error.message}`).join('；') || '备份校验未通过。')
  state.restoring = true
  try {
    const book = await restore(structuredClone(state.book), bookId => state.client.run('restore', { bookId }, onProgress ?? state.progress))
    state.disposed = true
    return book
  } finally {
    state.restoring = false
    if (state.disposed) state.client.dispose()
  }
}

export async function inspectBackupInWorker(bytes: Uint8Array, onProgress?: BackupProgress) {
  const client = createBackupWorkerClient()
  try { return await client.run('inspect', { bytes }, onProgress) }
  finally { client.dispose() }
}

export async function encodeBackupInWorker(data: BookData, onProgress?: BackupProgress) {
  const client = createBackupWorkerClient()
  try { return await client.run('encode', { data }, onProgress) }
  finally { client.dispose() }
}

export async function prepareMigration(data: BookData, version: number, onProgress?: BackupProgress) {
  const client = createBackupWorkerClient()
  try {
    const digest = await client.run('migrationDigest', { data, version }, onProgress)
    return { digest, normalize: () => client.run('migrate', undefined, onProgress), dispose: () => client.dispose() }
  } catch (error) { client.dispose(); throw error }
}
