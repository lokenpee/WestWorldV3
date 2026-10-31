import { useCallback, useState } from 'react'
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

export function ChapterBrowser({ bookId, repository }: { bookId: string; repository: BookRepository }) {
  const [selected, setSelected] = useState<Chapter>()
  const [attempt, setAttempt] = useState(0)
  const query = useCallback(() => repository.listChapters(bookId), [repository, bookId])
  const chapters = useLiveResult(query, attempt)
  if (chapters.status === 'loading') return <p role="status" className="muted">正在读取章节列表…</p>
  if (chapters.status === 'error') return <div role="alert" className="error-panel"><p>{chapters.message}</p><button className="secondary-button" onClick={() => setAttempt(value => value + 1)}>重试章节列表</button></div>
  return <>
    {chapters.value.length === 0 ? <p className="muted">这本书还没有章节。</p> : <ol className="chapter-list chapter-scroll">{chapters.value.map(chapter => <li key={chapter.chapterIndex}><span className="chapter-number">{chapter.chapterIndex}</span><button className="chapter-open" aria-label={`查看原文 ${chapter.chapterName}`} onClick={() => setSelected(chapter)}>{chapter.chapterName}</button><small>{chapter.charCount.toLocaleString('zh-CN')} 字符</small></li>)}</ol>}
    <p className="muted chapter-help">点击章节名称查看完整原文。</p>
    {selected && <StoredText key={selected.chapterIndex} bookId={bookId} chapter={selected} repository={repository} onClose={() => setSelected(undefined)} />}
  </>
}
