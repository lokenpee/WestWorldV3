import { useEffect, useRef, useState } from 'react'
import type { Book } from '../../lib/storage/workspace'
import type { BackupService } from './service'
import type { BackupInspection } from './codec'
import { chooseDirectory, rememberedDirectory, supportsDirectory } from './files'
import './BackupPanel.css'

export function BackupPanel({ service, books, selectedId, onExport, onRestored }: {
  service: BackupService; books: Book[]; selectedId: string | null; onExport: (book: Book) => void; onRestored: (book: Book) => void
}) {
  const [preview, setPreview] = useState<{ bytes: Uint8Array; inspection: BackupInspection }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [directory, setDirectory] = useState('')
  const token = useRef(0)
  useEffect(() => { let active = true; void rememberedDirectory(service).then(handle => { if (active) setDirectory(handle?.name ?? '尚未选择') }).catch(() => undefined); return () => { active = false } }, [service])
  async function inspect(file: File) {
    const request = ++token.current
    setPreview(undefined); setError(''); setMessage(''); setBusy(true)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const inspection = await service.inspectBackup(bytes)
      if (request === token.current) setPreview({ bytes, inspection })
    } catch (error) { if (request === token.current) setError(error instanceof Error ? error.message : '读取备份失败。') }
    finally { if (request === token.current) setBusy(false) }
  }
  async function restore() {
    if (busy || !preview?.inspection.ok) return
    setBusy(true); setError('')
    try { const book = await service.importBackup(preview.bytes); setPreview(undefined); setMessage(`已恢复：${book.title}。返回资产可查看独立副本。`); onRestored(book) }
    catch (error) { setError(error instanceof Error ? error.message : '恢复失败，请重试。') }
    finally { setBusy(false) }
  }
  async function pickDirectory() {
    setBusy(true); setError('')
    try { const handle = await chooseDirectory(service); setDirectory(handle.name); setMessage(`导出目录：${handle.name}`) }
    catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) setError(error instanceof Error ? error.message : '选择目录失败。') }
    finally { setBusy(false) }
  }
  const selected = books.find(book => book.id === selectedId)
  return <section className="backup-panel" aria-labelledby="backup-heading">
    <h2 id="backup-heading">备份与恢复</h2>
    <p>备份保存整本书的原文和资料。恢复会新建独立副本，完成后可在资产书架中查看。</p>
    <div className="backup-controls"><button className="primary-button" disabled={busy || !selected} onClick={() => selected && onExport(selected)}>导出当前书籍备份</button><span>{selected?.title || '请先在资产书架选择书籍'}</span></div>
    <div className="backup-controls"><button className="secondary-button" disabled={busy || !supportsDirectory()} onClick={() => void pickDirectory()}>选择导出目录</button><span>导出目录：{directory}</span></div>
    <p className="field-help">支持目录选择的浏览器可直接保存；也可下载备份到自己的文件夹。</p>
    <label className="backup-file-label" htmlFor="backup-file">选择备份文件（.wwv2）</label><input id="backup-file" type="file" accept=".wwv2,application/zip" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void inspect(file) }} />
    {busy && <p role="status">正在处理备份，请稍候…</p>}
    {preview && <section className="backup-preview" aria-label="备份预检"><h3>{preview.inspection.ok ? '备份校验通过' : '备份校验失败'}</h3>{preview.inspection.manifest && <p>书名：{preview.inspection.manifest.book.title}</p>}{preview.inspection.stats && <p>{preview.inspection.stats.chapters} 章 / 块 · 人物 {preview.inspection.stats.characters} · 地点 {preview.inspection.stats.locations} · 节点 {preview.inspection.stats.nodes} · 事件线 {preview.inspection.stats.eventLines}</p>}{preview.inspection.errors.map((item, index) => <p className="field-error" role="alert" key={index}>{item.path}：{item.message}</p>)}<div className="backup-controls"><button className="primary-button" disabled={busy || !preview.inspection.ok} onClick={() => void restore()}>确认恢复为新书</button><button className="secondary-button" disabled={busy} onClick={() => { ++token.current; setPreview(undefined); setError('') }}>取消恢复</button></div></section>}
    {error && <p className="field-error" role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
  </section>
}
