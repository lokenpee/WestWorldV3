import { createBackupProcessor, type BackupWorkerRequest, type BackupWorkerResponse } from './processor'

const processor = createBackupProcessor()
let queue = Promise.resolve()
self.onmessage = (event: MessageEvent<BackupWorkerRequest>) => {
  const { id, job } = event.data
  queue = queue.then(async () => {
    const send = (message: BackupWorkerResponse, transfer: Transferable[] = []) => self.postMessage(message, { transfer })
    try {
      const value = await processor.run(job, message => send({ id, type: 'progress', message }))
      const transfer = job.kind === 'encode' && typeof value === 'object' && 'bytes' in value ? [value.bytes.buffer] : []
      send({ id, type: 'result', value }, transfer)
    } catch (error) {
      send({ id, type: 'error', message: error instanceof Error ? error.message : '备份处理失败。' })
    }
  })
}
