import { useCallback, useEffect, useState } from 'react'
import type { ExtractionService } from '../extraction/service'
import { substeps } from '../extraction/types'
import type { BookRepository, Chapter } from '../../lib/storage/workspace'
import { useLiveResult } from '../../hooks/useLiveResult'
import { ChapterTextDialog } from './ChapterTextDialog'

function StoredText({ bookId, chapter, repository, onClose }: { bookId: string; chapter: Chapter; repository: BookRepository; onClose: () => void }) {
  const query = useCallback(() => repository.readChapter(bookId, chapter.chapterIndex), [repository, bookId, chapter.chapterIndex])
  const text = useLiveResult(query)
  if (text.status === 'loading') return <p role="status">正在读取章节原文…</p>
  if (text.status === 'error') return <div role="alert" className="error-panel"><p>{text.message}</p><button onClick={onClose} className="secondary-button">关闭提示</button></div>
  return <ChapterTextDialog title={chapter.chapterName} text={text.value} onClose={onClose} />
}

export function ChapterBrowser({ bookId, repository, extraction }: { bookId: string; repository: BookRepository; extraction?: ExtractionService }) {
  const [, refresh] = useState(0)
  useEffect(() => extraction?.subscribe(() => refresh(value => value + 1)), [extraction])
  const progressQuery = useCallback(async () => extraction?.progress(bookId), [extraction, bookId])
  const progress = useLiveResult(progressQuery)
  const saved = progress.status === 'ready' ? progress.value : undefined
  const extractionError = extraction?.state(bookId)?.error
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<Chapter>()
  const [attempt, setAttempt] = useState(0)
  const [actionError, setActionError] = useState('')
  async function reExtractStep(chapterIndex: string, step: (typeof substeps)[number]) {
    if (!extraction) return
    setActionError('')
    try { await extraction.extractChapter(bookId, chapterIndex, step) }
    catch (error) { setActionError(error instanceof Error ? error.message : '重新提取失败。') }
  }
  const query = useCallback(() => repository.listChapters(bookId), [repository, bookId])
  const chapters = useLiveResult(query, attempt)
  if (chapters.status === 'loading') return <p role="status" className="muted">正在读取章节列表…</p>
  if (chapters.status === 'error') return <div role="alert" className="error-panel"><p>{chapters.message}</p><button className="secondary-button" onClick={() => setAttempt(value => value + 1)}>重试章节列表</button></div>
  return <>
    {(extractionError || actionError) && <p role="alert">{extractionError || actionError}</p>}
    {chapters.value.length === 0 ? <p className="muted">这本书还没有章节。</p> : <ol className="chapter-list chapter-scroll">{chapters.value.slice(page * 100, (page + 1) * 100).map(chapter => <li key={chapter.chapterIndex}>
      {extraction && <div className="chapter-extraction" aria-label={`第${chapter.chapterIndex}章提取状态`}>{substeps.map(step => {
        const result = saved?.steps[chapter.chapterIndex]?.[step]
        const state = result?.status ?? 'pending'
        const label = step === 'worldAssets' ? '世界资产' : '叙事资产'
        const status = state === 'completed' ? '提取成功' : state === 'failed' ? '提取失败' : '待提取'
        const active = extraction.laneState(bookId, step)?.running || saved?.extractionJobs[step]?.status === 'running'
        const blocked = active || saved?.externalBusy || (saved?.busy && !Object.keys(saved.extractionJobs).length)
        const action = state === 'completed' || state === 'failed' ? '重新提取' : '提取'
        return <span key={step} className="chapter-step-group">
          <span className={`chapter-step ${state}`} aria-label={`第${chapter.chapterIndex}章 ${label}：${status}`} title={result?.message}>{label}<span>{status}{state === 'running' ? ' · 正在提取' : ''}</span></span>
          <button type="button" className="chapter-recycle" disabled={!!blocked || progress.status !== 'ready'} aria-label={`${action}第${chapter.chapterIndex}章 ${label}`} title={`${action}本章${label}`} onClick={() => void reExtractStep(chapter.chapterIndex, step)}>{state === 'pending' || state === 'interrupted' ? '▷' : '♻'}</button>
        </span>
      })}</div>}
      <span className="chapter-number">{chapter.chapterIndex}</span><button className="chapter-open" aria-label={`查看原文 ${chapter.chapterName}`} onClick={() => setSelected(chapter)}>{chapter.chapterName}</button><small>{chapter.charCount.toLocaleString('zh-CN')} 字符</small></li>)}</ol>}
    {chapters.value.length > 100 && <nav aria-label="章节分页"><button className="secondary-button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>上一页章节</button><span>第 {page + 1}/{Math.ceil(chapters.value.length / 100)} 页</span><button className="secondary-button" disabled={(page + 1) * 100 >= chapters.value.length} onClick={() => setPage(value => value + 1)}>下一页章节</button></nav>}
    {extraction && progress.status === 'error'  && <p role="alert">提取状态读取失败：{progress.message}</p>}
    <p className="muted chapter-help">点击章节名称查看完整原文。</p>
    {selected && <StoredText key={selected.chapterIndex} bookId={bookId} chapter={selected} repository={repository} onClose={() => setSelected(undefined)} />}
  </>
}
