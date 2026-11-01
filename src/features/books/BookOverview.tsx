import { StoryPanel } from '../story/StoryPanel'
import type { StoryService } from '../story/service'
import { WorldPanel } from '../world/WorldPanel'
import type { WorldService } from '../world/service'
import { useCallback, useState } from 'react'
import { useLiveResult } from '../../hooks/useLiveResult'
import type { Book, BookRepository } from '../../lib/storage/workspace'
import { formatImportDate } from './formatImportDate'
import { ChapterBrowser } from './ChapterBrowser'
import './BookOverview.css'
import { AssetsPanel } from '../assets/AssetsPanel'
import type { AssetService } from '../assets/service'
import type { AssetKind } from '../assets/types'
import { ExtractionPanel } from '../extraction/ExtractionPanel'
import type { ExtractionService } from '../extraction/service'

export function BookOverview({ book, repository, assets, extraction, world, story, assetKind, onAssetKindChange }: { book: Book; repository: BookRepository; assets: AssetService; extraction?: ExtractionService; world?: WorldService; story?: StoryService; assetKind: AssetKind; onAssetKindChange: (kind: AssetKind) => void }) {
  const [attempt, setAttempt] = useState(0)
  const query = useCallback(() => repository.getBookSummary(book.id), [repository, book.id])
  const summary = useLiveResult(query, attempt)
  const metrics = [['characters', '人物'], ['locations', '地点'], ['nodes', '事件节点'], ['eventLines', '事件线']] as const
  return (
    <section className="book-overview" aria-label="当前书籍概览">
      <div className="page-heading"><p className="eyebrow">资产工作台</p><h1>{book.title}</h1><p>{formatImportDate(book.createdAt)} 导入 <span aria-hidden="true">·</span> {book.sourceFileName}</p></div>
      {summary.status === 'loading' && <p role="status" className="loading-note">正在读取本书资料…</p>}
      {summary.status === 'error' && <div role="alert" className="error-panel"><strong>无法读取本书资料</strong><p>{summary.message}</p><button className="secondary-button" onClick={() => setAttempt(value => value + 1)}>重新读取资料</button></div>}
      {summary.status === 'ready' && <>
        <section className="chapter-card" aria-labelledby="chapter-heading"><div className="section-heading"><h2 id="chapter-heading">章节概览</h2><span>{summary.value.counts.chapters} 章 / 块</span></div>
          <ChapterBrowser bookId={book.id} repository={repository} extraction={extraction} />
        </section>
        {extraction && <ExtractionPanel bookId={book.id} service={extraction} />}
        {world && <WorldPanel key={`world:${book.id}`} bookId={book.id} service={world} assets={assets} />}
        {story && <StoryPanel key={`story:${book.id}`} bookId={book.id} service={story} />}
        <div className="asset-metrics">{metrics.map(([key, label]) => <div className="metric-card" key={key}><span>{label}</span><strong>{summary.value.counts[key]}</strong><small>当前记录</small></div>)}</div>
        <AssetsPanel bookId={book.id} repository={repository} service={assets} kind={assetKind} onKindChange={onAssetKindChange} />
        <div className="next-stage-note"><span aria-hidden="true">○</span><div><strong>原文与资产保存在本地</strong><p>选择资产查看或编辑，点击章节名称查看完整原文。</p></div></div>
      </>}
    </section>
  )
}
