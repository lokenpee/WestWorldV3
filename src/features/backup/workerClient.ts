import type { BackupProgress } from './codec'
import type { BackupJob, BackupJobInputs, BackupJobKind, BackupJobResult, BackupJobResults, BackupWorkerResponse, createBackupProcessor } from './processor'

const cancelled = () => new DOMException('备份准备已取消。', 'AbortError')

/** 浏览器使用专用 Worker；Node 测试执行同一个处理器。 */
export function createBackupWorkerClient() {
  let worker: Worker | undefined
  let inline: Promise<ReturnType<typeof createBackupProcessor>> | undefined
  let closed = false
  let nextId = 0
  const pending = new Map<number, { resolve: (value: BackupJobResult) => void; reject: (error: Error) => void; progress?: BackupProgress }>()
  const dispose = (error: Error = cancelled()) => {
    if (closed) return
    closed = true
    worker?.terminate()
    void inline?.then(processor => processor.dispose())
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  const receive = (message: BackupWorkerResponse) => {
    const request = pending.get(message.id)
    if (!request) return
    if (message.type === 'progress') { request.progress?.(message.message); return }
    pending.delete(message.id)
    if (message.type === 'error') request.reject(new Error(message.message))
    else request.resolve(message.value)
  }
  return {
    run<K extends BackupJobKind>(kind: K, input: BackupJobInputs[K], onProgress?: BackupProgress): Promise<BackupJobResults[K]> {
      if (closed) return Promise.reject(cancelled())
      const id = ++nextId
      const job = { kind, input } as BackupJob
      return new Promise<BackupJobResults[K]>((resolve, reject) => {
        pending.set(id, { resolve: value => resolve(value as BackupJobResults[K]), reject, progress: onProgress })
        try {
          if (typeof Worker !== 'undefined') {
            if (!worker) {
              worker = new Worker(new URL('./backup.worker.ts', import.meta.url), { type: 'module' })
              worker.onmessage = (event: MessageEvent<BackupWorkerResponse>) => receive(event.data)
              worker.onerror = () => dispose(new Error('备份处理线程出错，请重新选择文件。'))
              worker.onmessageerror = () => dispose(new Error('无法读取备份处理结果，请重新选择文件。'))
            }
            // 不转移调用方的 buffer；同一备份仍可再次预检、导入或另存。
            worker.postMessage({ id, job })
          } else {
            const copy = structuredClone(job)
            inline ??= import('./processor').then(module => module.createBackupProcessor())
            void inline.then(processor => processor.run(copy, message => receive({ id, type: 'progress', message })))
              .then(value => receive({ id, type: 'result', value: structuredClone(value) }), error => receive({ id, type: 'error', message: error instanceof Error ? error.message : '备份处理失败。' }))
          }
        } catch (error) {
          pending.delete(id)
          reject(error)
        }
      })
    },
    dispose,
  }
}
