import { useCallback, useEffect, useState } from 'react'
import { useLiveResult, bookInterests } from '../../hooks/useLiveResult'
import type { StoryService } from './service'
import { SessionHistory } from './SessionHistory'
import { P3ExecutionPanel } from '../agents/P3ExecutionPanel'
import { AgentActivity } from '../agents/AgentActivity'
import { RestartDialog } from '../agents/RestartDialog'
import './StoryPanel.css'

const reviewSteps: Record<string, string> = {
  directory_open: '全书目录初查', directory_final: '全书目录复查', member_batch: '核对节点的事件归属',
  node_page: '检查散落节点', line_segment: '核对本段节点的归属', line_structure: '核对故事线的事件归属和顺序',
  note_page: '核对留下的疑点', event_summary: '核对事件概况与核心关键线索', line_summary: '核对故事线概况与核心关键线索',
}

export function StoryPanel({ bookId, service }: { bookId: string; service: StoryService }) {
  return <NarrativePanel key={bookId} bookId={bookId} service={service} historical={<HistoricalStoryPanel bookId={bookId} service={service} />} />
}

function HistoricalStoryPanel({ bookId, service }: { bookId: string; service: StoryService }) {
  const [restartReview, setRestartReview] = useState(false)
  useEffect(() => setRestartReview(false), [bookId])
  const [, refresh] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [traceOpen, setTraceOpen] = useState(false)
  useEffect(() => service.subscribe(() => refresh(value => value + 1)), [service])
  const [leaseAttempt, retryLease] = useState(0)
  const saved = useLiveResult(useCallback(() => service.read(bookId), [service, bookId]), leaseAttempt, [...bookInterests(bookId, ['compileProgress', 'pipelineRuns', 'chapters', 'chapterTexts', 'characters', 'characterRelations', 'characterRelationEdits', 'locations', 'nodes', 'eventLines', 'storyEvents', 'extractionReceipts', 'storySessions', 'storyEditorMemory', 'storyEditorNotes', 'storyEditorCheckpoints', 'assetLifecycle', 'legacyRelationRecords']), { scope: `book:${bookId}`, tables: ['storySessionEntries'], category: 'business' }])
  const state = service.state(bookId), running = !!state?.running
  const value = saved.status === 'ready' ? saved.value : undefined
  const activityError = state?.error || (saved.status === 'error' ? saved.message : undefined)
  const activityRunId = state ? state.runId : value?.progress?.runId
  const activityStatus = running ? 'running' : activityError && !(activityRunId && activityRunId === value?.progress?.runId && value.progress.status === 'cancelled') ? 'failed' : value?.progress?.status ?? 'idle'
  useEffect(() => {
    if (value?.leaseExpiry === undefined) return
    const timer = setTimeout(() => retryLease(attempt => attempt + 1), Math.max(1, value.leaseExpiry - Date.now() + 50))
    return () => clearTimeout(timer)
  }, [value?.leaseExpiry, bookId])
  const reviewed = value?.progress?.phase === 'global_review' && value.progress.status === 'completed' && value.progress.validity !== 'stale' && value.review.pending === 0
  const finished = (value?.reading?.complete && value.progress?.phase !== 'global_review' || value?.progress?.phase === 'window_link_complete' || reviewed) && value?.progress?.validity !== 'stale'
  const reviewing = running && state.phase === 'global_review'
  const reviewReady = finished || value?.progress?.phase === 'global_review'
  const progress = value?.progress
  const reviewProgress = progress?.phase === 'global_review'
  const pageLabel = (type: unknown) => reviewProgress ? reviewSteps[String(type)] ?? '复核大纲' : '串联节点'
  const conclusions = value?.reading?.conclusions ?? []
  const pendingNotes = value?.notes ?? []
  const openKeys = new Set(pendingNotes.map(note => note.key))
  const checkedKeys = new Set(conclusions.map(row => row.key))
  const linkingCancelled = progress?.phase !== 'global_review' && progress?.status === 'cancelled'
  const continueLinking = !!progress && progress.phase !== 'global_review' && !linkingCancelled && !finished
  const canCancel = running || !!progress && (progress.phase === 'window_link' || progress.phase === 'global_review')
    && (progress.status === 'paused' || progress.status === 'running')
  const canQuickCheck = !!progress && (progress.phase === 'global_review' || !!value?.reading?.checked || !!value?.reading?.reused || !!value?.reading?.quickTotal)
  const beginLinking = () => {
    if (running) service.pause(bookId)
    else void service.start(bookId, linkingCancelled ? 'replace' : progress?.phase === 'global_review' && progress.validity === 'stale' ? 'reuse' : progress && !continueLinking ? 'all' : undefined)
  }
  const beginReview = () => {
    if (progress?.status === 'completed' && progress.phase === 'global_review') setRestartReview(true)
    else void service.review(bookId)
  }
  return <section className="story-panel" aria-label="事件线窗口串联"><div className="story-heading"><h2>P3 叙事整理</h2>
    <button className="primary-button" disabled={!!state?.stopping || (running ? reviewing : !value?.covered || value.locked)} onClick={beginLinking}>{running && !reviewing ? state?.stopping === 'pause' ? '正在暂停…' : state?.stopping === 'cancel' ? '正在取消…' : '暂停串联' : continueLinking ? '继续串联' : finished ? '重新串联事件线' : '串联事件线'}</button>
    <button className="secondary-button" disabled={running || !!state?.stopping || !value?.covered || value.locked || !canQuickCheck} onClick={() => void service.start(bookId, 'quick')}>快速核对后继续</button>
    <button className="secondary-button" disabled={!!state?.stopping || (!reviewing && (!reviewReady || value?.locked || running))} onClick={() => reviewing ? service.pause(bookId) : beginReview()}>{reviewing ? state?.stopping === 'pause' ? '正在暂停…' : '暂停复核' : reviewed || progress?.phase === 'global_review' && progress.status === 'cancelled' ? '重新复核全书' : progress?.phase === 'global_review' ? '继续全书复核' : '全书复核'}</button>
    {canCancel && <button className="secondary-button" disabled={state?.stopping === 'cancel' || !running && value?.locked} onClick={() => void service.cancel(bookId, running ? state.runId : progress?.runId)}>{state?.stopping === 'cancel' ? '正在取消…' : '取消 P3'}</button>}<button className="text-button" onClick={() => setTraceOpen(true)}>P3 整理详情</button></div>
    <div className="story-body"><p>串联把节点归入事件，再把事件归入故事线。全书复核先看这三级目录，调整归属、核对疑点，再补写或修正事件和故事线的概况与核心关键线索。</p>
    {!value?.covered && saved.status === 'ready' && <p className="muted">请先完成全书逐章提取。</p>}
    {value?.locked && !running && <p role="status">本书已有叙事、世界或提取任务，请等待执行权释放。</p>}
    {!running && linkingCancelled && <p className="muted">快速核对后继续会保留当前大纲；点击串联事件线会在新会话中从空大纲重建。</p>}
    {!running && progress?.phase === 'global_review' && progress.status === 'cancelled' && <p className="muted">重新复核会保留当前大纲和待复核事项，开启新会话，从全书目录初查开始。</p>}
    {!running && progress?.status !== 'cancelled' && value?.progress?.validity === 'stale' && <p className="muted">资料有更新或任务未完成，可继续整理。</p>}
    {value && <p role="status">{reviewed ? '全书复核完成' : reviewing ? '全书复核中' : finished ? '串联完成' : running ? '正在阅读与串联' : progress?.phase === 'global_review' && progress.status === 'paused' ? '复核已暂停' : progress?.status === 'cancelled' ? progress.phase === 'global_review' ? '复核已取消' : '串联已取消' : continueLinking && progress?.status === 'paused' && !activityError ? '串联已暂停' : ['failed', 'paused'].includes(progress?.status ?? '') ? '整理有未完成项' : '等待串联'} · {value.reading?.reviewCounts ? value.reading.reviewCounts : value.reading ? '已检查 ' + value.reading.checked + '/' + value.reading.totalPages + ' 页' : '已完成 ' + value.completed + '/' + value.windows.length + ' 个窗口'}</p>}
    {!!value?.reading?.quickTotal && <p>快速核对 {value.reading.quickChecked}/{value.reading.quickTotal} 页</p>}
    {!!value?.reading?.reused && <p>已复用 {value.reading.reused} 项完成结果</p>}
      {progress?.status !== 'cancelled' && value?.reading && !value.reading.complete && <p role="status">{value.reading.reviewCounts ? '当前' : `当前第 ${value.reading.pageNumber}/${value.reading.totalPages} 页`} · {pageLabel(value.reading.type)}{value.reading.lineTitle && ' · ' + value.reading.lineTitle}{value.reading.eventTitle && ' · ' + value.reading.eventTitle}{value.reading.segment && ' · 第 ' + value.reading.segment + '/' + value.reading.totalSegments + ' 段'}</p>}
    {value && reviewReady && !value.reading?.reviewCounts && <p>全书清单 {value.review.total} 项 · 待检查 {value.review.pending} 项</p>}
    {(running || value?.progress || activityError) && <AgentActivity bookId={bookId} runId={activityRunId} tasks={activityRunId === value?.progress?.runId ? value?.activityTasks : []} status={activityStatus} error={activityError} />}
    {value?.usage && <p>累计用量 {value.usage.totalTokens} · {value.usage.costStatus === 'unknown' ? '费用未知' : `估算费用 ${value.usage.cost.toFixed(6)} 美元`}</p>}
    {value?.session.id && <p>本书会话 · {value.session.entryCount} 条记录 · 已压缩 {value.session.compactions} 次 <button className="text-button" onClick={() => setHistoryOpen(open => !open)}>{historyOpen ? '收起会话历史' : '查看会话历史'}</button></p>}
    {historyOpen && !!value?.memory?.workingSummary && <p>当前{reviewProgress ? '复核' : '串联'}会话的工作摘要 · {String(value.memory.workingSummary)}</p>}
    {historyOpen && <SessionHistory key={bookId} bookId={bookId} service={service} />}
    {(pendingNotes.length > 0 || conclusions.length > 0) && <details className="story-details">
      <summary>大纲归类疑点与处理结果</summary><div className="story-details-body">
        {pendingNotes.filter(note => !checkedKeys.has(note.key)).map(note => <p key={String(note.id)}>{note.validity === 'stale' ? '依据有变，需再核对' : '待核对'} · {String(note.statement)}</p>)}
        {conclusions.map(row => <article key={String(row.key)}><p>{openKeys.has(row.key) ? '已核对，疑点保留' : '已解决'} · {String(row.question)}</p><p>{String(row.conclusion)}</p></article>)}
      </div></details>}
    {value && ((value.reading?.pages.length ?? value.windows.length) > 0 || value.tasks.some(task => task.total > 0)) ? <details className="story-details">
      <summary>{reviewProgress ? '全书复核进度' : '节点串联进度'}</summary><div className="story-details-body">
      {value.reading ? value.reading.pages.map((page, index) => <p key={String(page.id)}>第 {index + 1} {reviewProgress ? '项' : '页'} · {pageLabel(page.type)} · {page.checked ? '已检查' : '待检查'}{page.reason ? ' · ' + String(page.reason) : ''}</p>) : value.windows.map((window, index) => <p key={window.start}>旧窗口 {index + 1}：第 {window.start + 1}–{window.end} 原章</p>)}
      {value.tasks.filter(task => task.total > 0).map(task => <article key={task.id}><p>已检查 {task.reviewed.length}/{task.total} 项</p>{task.reviewed.map((row, index) => <p key={index}>{row.title || row.assetId}：{String(row.reason)}</p>)}{task.error && <p>{task.error}</p>}</article>)}
    </div></details> : null}
    </div>
    {traceOpen && <P3ExecutionPanel bookId={bookId} initialPhase={(running ? state?.phase : value?.progress?.phase) === 'global_review' ? 'global_review' : 'window_link'} loadExecution={service.execution} onClose={() => setTraceOpen(false)} />}
    {restartReview && <RestartDialog storyReview title="重新复核全书" onClose={() => setRestartReview(false)} onChoose={mode => { setRestartReview(false); void service.review(bookId, mode) }} />}
  </section>
}
import { NarrativePanel } from './NarrativePanel'
