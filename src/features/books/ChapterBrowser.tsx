import { useCallback, useEffect, useState } from 'react'
import type { ExtractionService, ExtractionStepStatus } from '../extraction/service'
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
  const busy = extraction?.state(bookId)?.running || saved?.busy
  const pending = saved?.reExtract
  const labels: Record<ExtractionStepStatus, string> = { pending: '待提取', running: '提取中', completed: '成功', failed: '失败 ↻', interrupted: '中断 ↻' }
  const [selected, setSelected] = useState<Chapter>()
  const [attempt, setAttempt] = useState(0)
  const [actionError, setActionError] = useState('')
  async function reExtractStep(chapterIndex: string, step: (typeof substeps)[number]) {
    if (!extraction) return
    setActionError('')
    try { await extraction.reExtract(bookId, { scope: 'chapter', chapterIndex, step }) }
    catch (error) { setActionError(error instanceof Error ? error.message : '重新提取失败。') }
  }
  const query = useCallback(() => repository.listChapters(bookId), [repository, bookId])
  const chapters = useLiveResult(query, attempt)
  if (chapters.status === 'loading') return <p role="status" className="muted">正在读取章节列表…</p>
  if (chapters.status === 'error') return <div role="alert" className="error-panel"><p>{chapters.message}</p><button className="secondary-button" onClick={() => setAttempt(value => value + 1)}>重试章节列表</button></div>
  return <>
    {chapters.value.length === 0 ? <p className="muted">这本书还没有章节。</p> : <ol className="chapter-list chapter-scroll">{chapters.value.map(chapter => <li key={chapter.chapterIndex}>
      {extraction && <div className="chapter-extraction" aria-label={`第${chapter.chapterIndex}章提取状态`}>{substeps.map(step => {
        const result = saved?.steps[chapter.chapterIndex]?.[step]
        const state = result?.status ?? 'pending'
        const label = step === 'worldAssets' ? '世界资产' : '叙事资产'
        const retryable = state === 'failed' || state === 'interrupted'
        return <span key={step} className="chapter-step-group">
          <button type="button" className={`chapter-step ${state}`} disabled={!!busy || !!pending || !retryable || progress.status !== 'ready'} aria-label={`第${chapter.chapterIndex}章 ${label}：${labels[state]}${retryable ? '，点击重试' : ''}`} title={result?.message ? `${result.message}${retryable ? '；点击重新提取此项' : ''}` : `${label}：${labels[state]}`} onClick={() => void extraction.retry(bookId, chapter.chapterIndex, step)}>{label}<span>{labels[state]}</span></button>
          {state === 'completed' && <button type="button" className="chapter-recycle" disabled={!!busy || !!pending || progress.status !== 'ready'} aria-label={`重新提取第${chapter.chapterIndex}章 ${label}`} title="清空本章该类资产并重新提取，不弹确认" onClick={() => void reExtractStep(chapter.chapterIndex, step)}>♻</button>}
        </span>
      })}</div>}
      <span className="chapter-number">{chapter.chapterIndex}</span><button className="chapter-open" aria-label={`查看原文 ${chapter.chapterName}`} onClick={() => setSelected(chapter)}>{chapter.chapterName}</button><small>{chapter.charCount.toLocaleString('zh-CN')} 字符</small></li>)}</ol>}
    {extraction && progress.status === 'error' && <p role="alert">提取状态读取失败：{progress.message}</p>}
    {actionError && <p role="alert">{actionError}</p>}
    <p className="muted chapter-help">点击章节名称查看完整原文。</p>
    {selected && <StoredText key={selected.chapterIndex} bookId={bookId} chapter={selected} repository={repository} onClose={() => setSelected(undefined)} />}
  </>
}
