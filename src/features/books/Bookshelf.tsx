import { useCallback } from 'react'
import { useLiveResult } from '../../hooks/useLiveResult'
import type { Book, BookRepository } from '../../lib/storage/workspace'
import { formatImportDate } from './formatImportDate'
import './Bookshelf.css'
import type { BackupService } from '../backup/service'

function BookCard({ book, repository, selected, onSelect, busy, backups, onExport, onDelete }: {
  book: Book; repository: BookRepository; selected: boolean; onSelect: (id: string) => void; busy: boolean
  backups: BackupService; onExport: (book: Book) => void; onDelete: (book: Book) => void
}) {
  const query = useCallback(() => repository.getBookSummary(book.id), [repository, book.id])
  const summary = useLiveResult(query)
  const blockerQuery = useCallback(() => backups.deletionBlockers(book.id), [backups, book.id])
  const blockers = useLiveResult(blockerQuery)
  return (
    <article className={`book-card${selected ? ' is-selected' : ''}`}>
    <button disabled={busy} className="book-select" aria-label={`进入 ${book.title}`} aria-current={selected ? 'page' : undefined} onClick={() => onSelect(book.id)}>
      <span className="book-card-top"><span className="book-symbol" aria-hidden="true">▤</span><span className="book-status">本地书籍</span></span>
      <strong>{book.title}</strong>
      <span className="book-date">{formatImportDate(book.createdAt)} 导入</span>
      {summary.status === 'ready' ? <>
        <span>{summary.value.counts.chapters} 章 / 块</span>
        <span className="book-counts">人物 {summary.value.counts.characters} · 地点 {summary.value.counts.locations}<br />节点 {summary.value.counts.nodes} · 事件线 {summary.value.counts.eventLines}</span>
      </> : <span>{summary.status === 'loading' ? '正在读取摘要…' : '摘要读取失败，进入后可重试'}</span>}
      <span className="book-enter">{selected ? '当前书籍' : '进入工作台'} <span aria-hidden="true">→</span></span>
    </button>
    <div className="book-card-actions"><button className="text-button" disabled={busy} aria-label={`导出 ${book.title}`} onClick={() => onExport(book)}>导出</button><button className="text-button" disabled={busy || blockers.status !== 'ready' || blockers.value.length > 0} aria-label={`删除整书 ${book.title}`} onClick={() => onDelete(book)}>删除</button></div>
    {blockers.status === 'ready' && blockers.value.length > 0 && <p className="field-help">处理中：{blockers.value.join('、')}，结束后可删除。</p>}
    </article>
  )
}

export function Bookshelf({ books, repository, selectedId, onSelect, onImport, busy = false, backups, onExport, onDelete }: {
  books: Book[]; repository: BookRepository; selectedId: string | null
  onSelect: (id: string) => void; onImport: () => void; busy?: boolean
  backups: BackupService; onExport: (book: Book) => void; onDelete: (book: Book) => void
}) {
  return (
    <aside className="bookshelf" aria-label="资产书架">
      <div className="shelf-heading"><h2>资产书架 <span>{books.length}</span></h2><p>你的小说，保存在这个浏览器</p></div>
      <button disabled={busy} className="primary-button import-button" onClick={onImport}><span aria-hidden="true">＋ </span>导入小说</button>
      <div className="book-list">
        {books.length === 0 ? <div className="shelf-empty"><span aria-hidden="true">▤</span><p>还没有资产</p><small>导入小说后会出现在这里。</small></div> : books.map(book => <BookCard key={book.id} book={book} repository={repository} selected={book.id === selectedId} onSelect={onSelect} busy={busy} backups={backups} onExport={onExport} onDelete={onDelete} />)}
      </div>
      <div className="shelf-footer"><span className="local-dot" /> 本地存储<p>书卡可导出整书备份，设置页可恢复副本。</p></div>
    </aside>
  )
}
