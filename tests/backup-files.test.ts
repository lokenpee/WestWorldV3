import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadBackup, writeBackupToDirectory, type ExportDirectory } from '../src/features/backup/files'
import type { ExportResult } from '../src/features/backup/codec'

const backup = { bytes: new Uint8Array([1, 2, 3]), fileName: '书.wwv2' } as ExportResult
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function directory(permission: PermissionState = 'granted') {
  const writer = { write: vi.fn(async (): Promise<void> => undefined), close: vi.fn(async (): Promise<void> => undefined), abort: vi.fn(async (): Promise<void> => undefined) }
  const handle: ExportDirectory = { name: '备份', queryPermission: vi.fn(async () => permission), requestPermission: vi.fn(async () => permission), getFileHandle: vi.fn(async () => ({ createWritable: async () => writer })) }
  return { handle, writer }
}
describe('备份文件交付', () => {
  it('目录写入只有close完成才报告成功，写入失败会abort', async () => {
    const { handle, writer } = directory()
    let closed = false
    let release: () => void = () => undefined
    writer.close.mockImplementation(() => new Promise<void>(resolve => { release = () => { closed = true; resolve() } }))
    const saving = writeBackupToDirectory(backup, handle)
    await vi.waitFor(() => expect(writer.close).toHaveBeenCalled())
    expect(closed).toBe(false)
    release()
    expect(await saving).toBe('书.wwv2')
    expect(closed).toBe(true)
    const failure = directory()
    failure.writer.write.mockRejectedValueOnce(new Error('磁盘已满'))
    await expect(writeBackupToDirectory(backup, failure.handle)).rejects.toThrow('磁盘已满')
    expect(failure.writer.abort).toHaveBeenCalledOnce()
    expect(failure.writer.close).not.toHaveBeenCalled()
  })
  it('未取得目录权限时不创建文件', async () => {
    const { handle } = directory('denied')
    await expect(writeBackupToDirectory(backup, handle)).rejects.toThrow('写入权限')
    expect(handle.requestPermission).toHaveBeenCalledOnce()
    expect(handle.getFileHandle).not.toHaveBeenCalled()
  })
  it('下载链接点击后保持至少1000毫秒，回收地址且移除临时元素', () => {
    vi.useFakeTimers()
    const link = { href: '', download: '', click: vi.fn(), remove: vi.fn() }
    vi.stubGlobal('document', { createElement: vi.fn(() => link), body: { appendChild: vi.fn() } })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:backup')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    downloadBackup(backup)
    expect(link.click).toHaveBeenCalledOnce()
    expect(link.remove).toHaveBeenCalledOnce()
    expect(link.download).toBe('书.wwv2')
    vi.advanceTimersByTime(999); expect(revoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1); expect(revoke).toHaveBeenCalledWith('blob:backup')
  })
})
