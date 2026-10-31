import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type { Book } from '../../lib/storage/workspace'
import type { ImportService } from '../../lib/storage/importService'
import { ChapterTextDialog } from '../books/ChapterTextDialog'
import { DEFAULT_CHAPTER_PATTERN, type ChapterDraft, type EncodingChoice, type NovelPreview } from './text'
import { PreviewLoader } from './previewLoader'
import { parseInWorker } from './parseInWorker'
import './ImportPanel.css'

export function ImportPanel({ hasBooks, importer, onImported, onBusyChange }: {
  hasBooks: boolean; importer: ImportService; onImported: (book: Book) => void; onBusyChange: (busy: boolean) => void
}) {
  const [pattern, setPattern] = useState(DEFAULT_CHAPTER_PATTERN)
  const [file, setFile] = useState<File>()
  const [encoding, setEncoding] = useState<EncodingChoice>('auto')
  const [preview, setPreview] = useState<NovelPreview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'loading' | 'saving' | null>(null)
  const [dragging, setDragging] = useState(false)
  const [reading, setReading] = useState<ChapterDraft>()
  const active = useRef(true)
  const loadId = useRef(0)
  const saving = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const loader = useMemo(() => new PreviewLoader(parseInWorker), [])
  useEffect(() => { active.current = true; return () => { active.current = false; loader.reset() } }, [loader])
  const stale = preview !== null && preview.pattern !== pattern

  async function load(files: File[], choice: EncodingChoice, regex: string) {
    if (saving.current) return
    const requestId = ++loadId.current
    setFile(files.length === 1 ? files[0] : undefined)
    setEncoding(choice); setPreview(null); setReading(undefined); setError(''); setBusy('loading')
    try {
      const result = await loader.load(files, choice, regex)
      if (active.current && requestId === loadId.current && result) { setPreview(result); setBusy(null) }
    } catch (failure) {
      if (active.current && requestId === loadId.current) { setError(failure instanceof Error ? failure.message : '文件读取失败，请重试。'); setBusy(null) }
    }
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault(); setDragging(false)
    if (!busy) void load(Array.from(event.dataTransfer.files), 'auto', pattern)
  }

  async function save() {
    if (!preview || stale || busy || saving.current) return
    saving.current = true; setBusy('saving'); setError(''); onBusyChange(true)
    try { onImported(await importer.importNovel(preview)) }
    catch (failure) { if (active.current) setError(failure instanceof Error ? failure.message : '导入失败，请重试。') }
    finally { saving.current = false; onBusyChange(false); if (active.current) setBusy(null) }
  }

  return <section className="import-panel">
    <div className="page-heading"><p className="eyebrow">导入原文</p><h1>{hasBooks ? '导入另一本小说' : '导入第一本小说'}</h1><p>选择 TXT 小说，先检查分章结果，再保存到本地书架。</p></div>
    <div className="regex-card"><label htmlFor="chapter-regex">章节分隔正则</label><textarea id="chapter-regex" value={pattern} disabled={busy !== null} rows={3} spellCheck={false} onChange={event => { setPattern(event.target.value); setError('') }} />
      <div className="import-actions"><button className="secondary-button" disabled={!file || !!busy} onClick={() => file && void load([file], encoding, pattern)}>应用正则并重新预览</button><button className="text-button" disabled={!!busy} onClick={() => { setPattern(DEFAULT_CHAPTER_PATTERN); setError(''); if (file) void load([file], encoding, DEFAULT_CHAPTER_PATTERN) }}>恢复默认</button></div>
      <p>默认识别“第一章”“第 12 回”等标题。序文保留，长章按 10,000 字符切块。</p>
    </div>
    <div className={`file-drop${dragging ? ' is-dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={drop} aria-label="TXT文件拖放区">
      <span className="file-mark" aria-hidden="true">TXT</span><strong>{busy === 'loading' ? '正在读取并分章…' : '将小说文件拖到这里'}</strong><p>每次一个 .txt 文件 · 自动识别 UTF-8 / GBK</p>
      <button className="primary-button" disabled={!!busy} onClick={() => input.current?.click()}>选择小说文件</button>
      <input ref={input} type="file" accept=".txt,text/plain" aria-label="小说TXT文件" disabled={!!busy} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) void load(files, 'auto', pattern) }} hidden />
    </div>
    {busy === 'loading' && <p className="loading-note" role="status">正在检查编码和分章，请稍候…</p>}
    {error && <div className="error-panel" role="alert">{error}</div>}
    {stale && <p className="stale-preview" role="status">正则已修改，当前预览已过期。请重新预览后再导入。</p>}
    {preview && <section className="import-preview" aria-label="分章预览">
      <div className="preview-heading"><div><h2>{preview.fileName}</h2><p>{preview.encoding} · {preview.byteLength.toLocaleString('zh-CN')} 字节 · {preview.chapters.length} 章 / 块 · {preview.text.length.toLocaleString('zh-CN')} 字符</p></div><button className="text-button" disabled={!!busy} onClick={() => { loader.reset(); setPreview(null); setFile(undefined); setReading(undefined); setError('') }}>换一个文件</button></div>
      <div className="import-actions"><button className="secondary-button" disabled={!!busy} onClick={() => file && void load([file], 'utf-8', pattern)}>按 UTF-8 重读</button><button className="secondary-button" disabled={!!busy} onClick={() => file && void load([file], 'gbk', pattern)}>按 GBK 重读</button><span>乱码时可切换编码后检查原文。</span></div>
      <div className="preview-table-wrap"><table><thead><tr><th>编号</th><th>章节名称</th><th>字符数</th><th>原文</th></tr></thead><tbody>{preview.chapters.map(chapter => <tr key={chapter.chapterIndex}><td>{chapter.chapterIndex}</td><td>{chapter.chapterName}</td><td>{chapter.charCount.toLocaleString('zh-CN')}</td><td><button className="text-button" aria-label={`预览 ${chapter.chapterName}`} onClick={() => setReading(chapter)}>预览</button></td></tr>)}</tbody></table></div>
      <div className="import-submit"><p>仅保存在当前浏览器，不会调用模型。确认章节内容后再导入。</p><div className="import-actions"><button className="primary-button" disabled={!!busy || stale} onClick={() => void save()}>{busy === 'saving' ? '正在导入…' : '仅导入'}</button><button className="secondary-button" disabled>导入并开始 P1 提取</button><span>P1 提取将在阶段 7 开放</span></div></div>
    </section>}
    {reading && <ChapterTextDialog title={reading.chapterName} text={reading.text} onClose={() => setReading(undefined)} />}
  </section>
}
