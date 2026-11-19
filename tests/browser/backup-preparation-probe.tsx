import { createRoot } from 'react-dom/client'
import { BackupPanel } from '../../src/features/backup/BackupPanel'
import type { PreparedBackup } from '../../src/features/backup/preparation'
import type { BackupService } from '../../src/features/backup/service'

/** 单组件生命周期样本；不连接书库，不执行真实恢复。 */
export function mountBackupPreparationProbe() {
  const container = document.createElement('div')
  container.id = 'backup-preparation-probe'
  document.body.appendChild(container)
  const root = createRoot(container)
  const disposed: string[] = []
  const waiting = new Map<string, () => void>()
  const handle = (name: string): PreparedBackup => ({
    inspection: {
      ok: true, errors: [],
      manifest: { format: 'westworld-v2', formatVersion: 11, appVersion: 'test', exportedAt: '2026-11-19T00:00:00.000Z', book: { id: name, title: name, chapterCount: 1 }, contents: [], excludes: [], checksums: {} },
    },
    dispose() { disposed.push(name) },
  })
  function render(name: string, delayed = false) {
    const service = {
      directorySettings: { appSettings: { get: async () => undefined } },
      prepareBackup: async (_bytes: Uint8Array, progress?: (message: string) => void) => {
        progress?.(`正在准备 ${name}`)
        if (delayed) await new Promise<void>(resolve => { waiting.set(name, resolve) })
        return handle(name)
      },
    } as unknown as BackupService
    root.render(<BackupPanel service={service} books={[]} selectedId={null} onExport={() => {}} onRestored={() => {}} />)
  }
  render('文件 A')
  return {
    render,
    disposed,
    isWaiting: (name: string) => waiting.has(name),
    finish: (name: string) => { waiting.get(name)?.(); waiting.delete(name) },
    unmount: () => { root.unmount(); container.remove() },
  }
}
