import { useEffect, useRef, useState } from 'react'
import type { Book } from '../../lib/storage/workspace'
import type { BackupService } from './service'
import { authorizeDirectory, chooseDirectory, downloadBackup, rememberedDirectory, supportsDirectory, writeBackupToDirectory } from './files'

export interface BookAction { kind: 'export' | 'delete'; book: Book }
export function BookDialogs({ action, service, onClose, onExport, onMessage, onDeleted }: {
  action: BookAction; service: BackupService; onClose: () => void; onExport: (book: Book) => void
  onMessage: (message: string) => void; onDeleted: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [directory, setDirectory] = useState('')
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close() }, [])
  useEffect(() => { let active = true; void rememberedDirectory(service).then(handle => { if (active) setDirectory(handle?.name ?? '') }).catch(() => undefined); return () => { active = false } }, [service])
  async function perform(target: 'download' | 'directory' | 'delete') {
    if (busy) return
    setBusy(true); setError('')
    try {
      if (target === 'delete') {
        await service.deleteBook(action.book.id)
        onDeleted(); onMessage(`已删除：${action.book.title}`)
      } else {
        const handle = target === 'directory' ? await rememberedDirectory(service) ?? await chooseDirectory(service) : undefined
        if (handle) await authorizeDirectory(handle)
        const backup = await service.exportBook(action.book.id)
        if (handle) { await writeBackupToDirectory(backup, handle); onMessage(`已保存到目录 ${handle.name}：${backup.fileName}`) }
        else { downloadBackup(backup); onMessage(`已请求下载：${backup.fileName}${backup.processing ? '（处理中快照）' : ''}`) }
      }
      onClose()
    } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) setError(error instanceof Error ? error.message : '操作失败，请重试。') }
    finally { setBusy(false) }
  }
  return <dialog ref={ref} className="book-operation-dialog" onCancel={event => event.preventDefault()} aria-labelledby="book-action-title">
    <h2 id="book-action-title">{action.kind === 'export' ? `导出 ${action.book.title}` : `删除 ${action.book.title}？`}</h2>
    {action.kind === 'export' ? <><p>备份包含原文、当前资产、来源、合并报告和会话。恢复时会建立独立副本。</p><p>导出目录：{directory || '尚未选择'}</p><p className="field-help">可在处理期间导出快照。恢复后，进行中的任务保持暂停。</p></> : <p>确认后永久删除这本书的原文、资产和处理记录。可以先导出备份，再回来删除。</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="book-operation-actions">
      <button className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
      {action.kind === 'export' ? <><button className="secondary-button" disabled={busy || !supportsDirectory()} onClick={() => void perform('directory')}>保存到目录</button><button className="primary-button" disabled={busy} onClick={() => void perform('download')}>{busy ? '正在导出…' : '下载备份'}</button></> : <><button className="secondary-button" disabled={busy} onClick={() => onExport(action.book)}>先导出</button><button className="danger-button" disabled={busy} onClick={() => void perform('delete')}>{busy ? '正在删除…' : '确认删除整书'}</button></>}
    </div>
  </dialog>
}
