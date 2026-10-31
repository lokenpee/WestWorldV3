import type { BackupService } from './service'
import type { ExportResult } from './codec'

export interface ExportDirectory {
  name: string
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>
  getFileHandle(name: string, options: { create: true }): Promise<{ createWritable(): Promise<{ write(blob: Blob): Promise<void>; close(): Promise<void>; abort(): Promise<void> }> }>
}
type DirectoryWindow = Window & { showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<ExportDirectory> }
const directoryKey = 'assets.exportDirectory'
export const supportsDirectory = () => typeof (window as DirectoryWindow).showDirectoryPicker === 'function'
export async function rememberedDirectory(service: BackupService) { return (await service.settings.appSettings.get(directoryKey))?.value as ExportDirectory | undefined }
export async function chooseDirectory(service: BackupService) {
  const picker = (window as DirectoryWindow).showDirectoryPicker
  if (!picker) throw new Error('当前浏览器支持下载备份，可通过下载选择保存位置。')
  const handle = await picker.call(window, { mode: 'readwrite' })
  await service.settings.appSettings.put({ key: directoryKey, value: handle })
  return handle
}
export async function authorizeDirectory(directory: ExportDirectory) {
  if (await directory.queryPermission({ mode: 'readwrite' }) !== 'granted' && await directory.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('请授予所选目录的写入权限。')
}
export async function writeBackupToDirectory(backup: ExportResult, directory: ExportDirectory) {
  await authorizeDirectory(directory)
  const file = await directory.getFileHandle(backup.fileName, { create: true })
  const writer = await file.createWritable()
  try { await writer.write(new Blob([backup.bytes], { type: 'application/zip' })); await writer.close() }
  catch (error) { await writer.abort().catch(() => undefined); throw error }
  return backup.fileName
}
export function downloadBackup(backup: ExportResult) {
  const url = URL.createObjectURL(new Blob([backup.bytes], { type: 'application/zip' }))
  const link = document.createElement('a')
  link.href = url; link.download = backup.fileName
  document.body.appendChild(link)
  try { link.click() } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
}
