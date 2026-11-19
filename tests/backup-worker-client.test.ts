import { afterEach, expect, it, vi } from 'vitest'
import { prepareBackup } from '../src/features/backup/preparation'
import { createBackupWorkerClient } from '../src/features/backup/workerClient'
import type { BackupWorkerRequest, BackupWorkerResponse } from '../src/features/backup/processor'

class ControlledWorker {
  static instances: ControlledWorker[] = []
  onmessage?: (event: MessageEvent<BackupWorkerResponse>) => void
  onerror?: () => void
  onmessageerror?: () => void
  requests: BackupWorkerRequest[] = []
  terminated = false
  constructor() { ControlledWorker.instances.push(this) }
  postMessage(request: BackupWorkerRequest, transfer?: unknown) { expect(transfer).toBeUndefined(); this.requests.push(structuredClone(request)) }
  terminate() { this.terminated = true }
  emit(message: BackupWorkerResponse) { this.onmessage?.({ data: message } as MessageEvent<BackupWorkerResponse>) }
}
afterEach(() => { vi.unstubAllGlobals(); ControlledWorker.instances = [] })

it('取消旧文件准备会终止 Worker，晚到结果和进度不会进入新文件的准备会话', async () => {
  vi.stubGlobal('Worker', ControlledWorker)
  const controller = new AbortController(), oldProgress = vi.fn(), nextProgress = vi.fn()
  const old = prepareBackup(new Uint8Array([1]), oldProgress, controller.signal)
  const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' })
  const oldWorker = ControlledWorker.instances[0]
  controller.abort()
  await rejected
  expect(oldWorker.terminated).toBe(true)
  const bytes = new Uint8Array([2, 3]), next = prepareBackup(bytes, nextProgress)
  const nextWorker = ControlledWorker.instances[1]
  oldWorker.emit({ id: 1, type: 'progress', message: '旧文件' })
  oldWorker.emit({ id: 1, type: 'result', value: { inspection: { ok: true, errors: [] } } })
  nextWorker.emit({ id: 1, type: 'progress', message: '新文件' })
  nextWorker.emit({ id: 1, type: 'result', value: { inspection: { ok: false, errors: [{ code: 'PARSE', path: '', message: '新文件损坏' }] } } })
  const handle = await next
  expect(handle.inspection.errors[0].message).toBe('新文件损坏')
  expect(oldProgress).not.toHaveBeenCalled()
  expect(nextProgress).toHaveBeenCalledExactlyOnceWith('新文件')
  expect(bytes.byteLength).toBe(2)
  handle.dispose()
  expect(nextWorker.terminated).toBe(true)
})

it.each(['onerror', 'onmessageerror'] as const)('Worker %s 会结束等待并释放线程', async event => {
  vi.stubGlobal('Worker', ControlledWorker)
  const client = createBackupWorkerClient(), result = client.run('prepare', { bytes: new Uint8Array([1]) })
  const rejected = expect(result).rejects.toThrow('请重新选择文件')
  const worker = ControlledWorker.instances[0]
  worker[event]?.()
  await rejected
  expect(worker.terminated).toBe(true)
})

it('已经取消的请求不创建 Worker', async () => {
  vi.stubGlobal('Worker', ControlledWorker)
  const controller = new AbortController(); controller.abort()
  await expect(prepareBackup(new Uint8Array([1]), undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(ControlledWorker.instances).toHaveLength(0)
})
