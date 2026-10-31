import type { StoryService } from './features/story/service'
import type { WorldService } from './features/world/service'
import type { ExtractionService } from './features/extraction/service'
import { useCallback, useState, type ReactNode } from 'react'
import { Bookshelf } from './features/books/Bookshelf'
import { BookOverview } from './features/books/BookOverview'
import { useLiveResult } from './hooks/useLiveResult'
import type { BookRepository } from './lib/storage/workspace'
import './App.css'
import { ImportPanel } from './features/import/ImportPanel'
import { ImportRecovery } from './features/import/ImportRecovery'
import type { ImportService } from './lib/storage/importService'
import type { AssetService } from './features/assets/service'
import type { AssetKind } from './features/assets/types'
import type { BackupService } from './features/backup/service'
import { BackupPanel } from './features/backup/BackupPanel'
import { BookDialogs, type BookAction } from './features/backup/BookDialogs'
import type { ModelService } from './features/models/service'
import { ModelSettings } from './features/models/ModelSettings'

type View = 'assets' | 'play' | 'settings'
const navigation: { id: View; label: string }[] = [
  { id: 'assets', label: '资产' }, { id: 'play', label: '游玩' }, { id: 'settings', label: '设置' },
]

export default function App({ repository, importer, assets, backups, models, extraction, world, story, acceptanceTools }: { repository: BookRepository; importer: ImportService; assets: AssetService; backups: BackupService; models: ModelService; extraction?: ExtractionService; world?: WorldService; story?: StoryService; acceptanceTools?: ReactNode }) {
  const [activeView, setActiveView] = useState<View>('assets')
  const [bookId, setBookId] = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [importBusy, setImportBusy] = useState(false)
  const [pendingSelection, setPendingSelection] = useState<string | null>(null)
  const [assetKind, setAssetKind] = useState<AssetKind>('character')
  const [bookAction, setBookAction] = useState<BookAction>()
  const [bookMessage, setBookMessage] = useState('')
  const query = useCallback(() => repository.listBooks(), [repository])
  const books = useLiveResult(query, attempt)

  if (pendingSelection && books.status === 'ready' && books.value.some(book => book.id === pendingSelection)) {
    setBookId(pendingSelection); setPendingSelection(null)
  }
  if (!pendingSelection && books.status === 'ready' && !books.value.some(book => book.id === bookId)) {
    const nextId = books.value[0]?.id ?? null
    if (nextId !== bookId) setBookId(nextId)
  }

  const selectedBook = books.status === 'ready' ? books.value.find(book => book.id === bookId) : undefined
  const selectBook = (id: string) => { setBookId(id); setShowImport(false) }

  return <div className="app-shell">
    <header className="app-header"><a className="brand" href="#" onClick={event => { event.preventDefault(); setActiveView('assets') }} aria-label="WestWorld 回到资产"><span className="brand-mark" aria-hidden="true">W</span><span>WESTWORLD <small>V3</small></span></a>
      <nav aria-label="主导航">{navigation.map(view => <button key={view.id} className={activeView === view.id ? 'nav-active' : ''} aria-current={activeView === view.id ? 'page' : undefined} onClick={() => setActiveView(view.id)}>{view.label}</button>)}</nav>
      <span className="header-local"><span className="local-dot" />本地工作空间</span>
    </header>
    {acceptanceTools}
    <ImportRecovery importer={importer} />
    {bookMessage && <p className="book-action-message" role="status">{bookMessage}</p>}
    {bookAction && <BookDialogs key={`${bookAction.kind}:${bookAction.book.id}`} action={bookAction} service={backups} onClose={() => setBookAction(undefined)} onExport={book => setBookAction({ kind: 'export', book })} onMessage={setBookMessage} onDeleted={() => setAttempt(value => value + 1)} />}
    <main className={`app-main ${activeView === 'assets' ? 'assets-layout' : 'single-layout'}`}>
      {activeView === 'assets' && <>
        {books.status === 'loading' && <div className="page-feedback" role="status"><span className="loading-dot" />正在读取本地书架…</div>}
        {books.status === 'error' && <section className="page-feedback error-panel" role="alert"><h1>无法读取书架</h1><p>{books.message}</p><p>已有资料不会被自动清除。请恢复存储访问后重试。</p><button className="secondary-button" onClick={() => setAttempt(value => value + 1)}>重新读取书架</button></section>}
        {books.status === 'ready' && <><Bookshelf books={books.value} repository={repository} selectedId={showImport ? null : bookId} onSelect={selectBook} onImport={() => setShowImport(true)} busy={importBusy} backups={backups} onExport={book => { setBookMessage(''); setBookAction({ kind: 'export', book }) }} onDelete={book => { setBookMessage(''); setBookAction({ kind: 'delete', book }) }} /><div className="workspace-content">
          {pendingSelection ? <p role="status">正在打开新导入的书籍…</p> : showImport || books.value.length === 0 ? <ImportPanel hasBooks={books.value.length > 0} importer={importer} onBusyChange={setImportBusy} onImported={book => { setPendingSelection(book.id); setShowImport(false) }} /> : selectedBook ? <BookOverview key={selectedBook.id} book={selectedBook} repository={repository} assets={assets} extraction={extraction} world={world} story={story} assetKind={assetKind} onAssetKindChange={setAssetKind} /> : <p role="status">正在选择书籍…</p>}
        </div></>}
      </>}
      {activeView === 'settings' && <section className="placeholder-page"><p className="eyebrow">设置</p><h1>模型与存储设置</h1><p className="muted">管理模型连接和本地资料的地方。</p><ModelSettings service={models} /><BackupPanel service={backups} books={books.status === 'ready' ? books.value : []} selectedId={bookId} onExport={book => setBookAction({ kind: 'export', book })} onRestored={book => setPendingSelection(book.id)} /></section>}
      {activeView === 'play' && <section className="placeholder-page play-placeholder"><p className="eyebrow">游玩 · 预留入口</p><h1>故事尚未启程</h1><p className="muted">这里还没有接入故事引擎。</p><div className="placeholder-card"><h2>{selectedBook ? `当前书籍：${selectedBook.title}` : '尚未选择书籍'}</h2><p>本阶段不提供行动结算或对话，不调用模型，也不生成存档。</p><label htmlFor="player-action">玩家行动</label><textarea id="player-action" rows={3} placeholder="游玩能力尚未开放" disabled /><button className="primary-button" disabled>发送</button></div></section>}
    </main>
  </div>
}
