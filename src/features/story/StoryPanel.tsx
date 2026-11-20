import { useCallback, useEffect, useState } from 'react'
import { useLiveResult, bookInterests } from '../../hooks/useLiveResult'
import type { StoryService } from './service'
import { SessionHistory } from './SessionHistory'
import { P3ExecutionPanel } from '../agents/P3ExecutionPanel'
import { AgentActivity } from '../agents/AgentActivity'
import { RestartDialog } from '../agents/RestartDialog'
import './StoryPanel.css'

export function StoryPanel({ bookId, service }: { bookId: string; service: StoryService }) {
  const [restartPhase, setRestartPhase] = useState<'window_link' | 'global_review'>()
  useEffect(() => setRestartPhase(undefined), [bookId])
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
  const interrupted = !!value?.progress && !finished && value.progress.status !== 'cancelled'
  const begin = (phase: 'window_link' | 'global_review') => {
    const samePhase = phase === 'global_review' ? value?.progress?.phase === phase : value?.progress?.phase !== 'global_review'
    if (value?.progress && (value.progress.status === 'cancelled' || value.progress.status === 'completed' && samePhase || phase === 'window_link' && !samePhase)) setRestartPhase(phase)
    else void (phase === 'global_review' ? service.review(bookId) : service.start(bookId))
  }
  return <section className="story-panel" aria-label="事件线窗口串联"><div className="story-heading"><h2>P3 叙事整理</h2><button className="primary-button" disabled={!value?.covered || value.locked || running} onClick={() => begin('window_link')}>{running && !reviewing ? '正在串联…' : finished || value?.progress?.status === 'cancelled' ? '重新串联事件线' : interrupted ? '继续串联事件线' : '串联事件线'}</button><button className="secondary-button" disabled={!reviewReady || value?.locked || running} onClick={() => begin('global_review')}>{reviewing ? '正在复核…' : reviewed || value?.progress?.phase === 'global_review' && value.progress.status === 'cancelled' ? '重新复核全书' : value?.progress?.phase === 'global_review' ? '继续全书复核' : '全书复核'}</button>{running && <button className="secondary-button" onClick={() => service.cancel(bookId)}>{reviewing ? '取消复核' : '取消串联'}</button>}{(running || value?.progress?.runId) && <button className="text-button" onClick={() => setTraceOpen(true)}>整理详情</button>}</div>
    <div className="story-body"><p>按章节逐步串联事件，查找前文伏笔并续接已有事件线。完成后可进行全书复核，检查遗漏节点、事件线和未解决的线索。</p>
    {!value?.covered && saved.status === 'ready' && <p className="muted">请先完成全书逐章提取。</p>}
    {value?.locked && !running && <p role="status">本书已有叙事、世界或提取任务，请等待执行权释放。</p>}
    {!running && value?.progress?.validity === 'stale' && <p className="muted">资料有更新或任务未完成，可继续整理。</p>}
    {value && <p role="status">{reviewed ? '全书复核完成' : reviewing ? '全书复核中' : finished ? '串联完成' : running ? '正在阅读与串联' : value.progress?.status === 'cancelled' ? '串联已取消' : ['failed', 'paused'].includes(value.progress?.status ?? '') ? '整理有未完成项' : '等待串联'} · {value.reading ? '已检查 ' + value.reading.checked + '/' + value.reading.totalPages + ' 页' : '已完成 ' + value.completed + '/' + value.windows.length + ' 个窗口'}</p>}
    {!!value?.reading?.reused && <p>已复用 {value.reading.reused} 项完成结果</p>}
    {value?.reading && !value.reading.complete && <p role="status">当前第 {value.reading.pageNumber}/{value.reading.totalPages} 页 · {value.reading.type === 'line_summary' ? '整条事件线核对' : value.reading.type === 'line_segment' ? '事件线分段复核' : value.reading.type === 'note_page' ? '未解线索核对' : reviewing ? '散落节点核对' : '节点阅读'}{value.reading.lineTitle && ' · ' + value.reading.lineTitle}{value.reading.segment && ' · 第 ' + value.reading.segment + '/' + value.reading.totalSegments + ' 段'}</p>}
    {value && reviewReady && <p>全书清单 {value.review.total} 项 · 待检查 {value.review.pending} 项</p>}
    {(running || value?.progress || activityError) && <AgentActivity bookId={bookId} runId={activityRunId} tasks={activityRunId === value?.progress?.runId ? value?.activityTasks : []} status={activityStatus} error={activityError} />}
    {value?.usage && <p>累计用量 {value.usage.totalTokens} · {value.usage.costStatus === 'unknown' ? '费用未知' : `估算费用 ${value.usage.cost.toFixed(6)} 美元`}</p>}
    {value?.session.id && <p>本书会话 · {value.session.entryCount} 条记录 · 已压缩 {value.session.compactions} 次 <button className="text-button" onClick={() => setHistoryOpen(open => !open)}>{historyOpen ? '收起会话历史' : '查看会话历史'}</button></p>}
    {historyOpen && <SessionHistory key={bookId} bookId={bookId} service={service} />}
    {value?.session.id && <details className="story-details"><summary>工作记忆与待复核事项</summary><div className="story-details-body"><p>{String(value.memory?.workingSummary || '还没有工作摘要')}</p>{value.notes.map(note => <p key={String(note.id)}>{note.validity === 'stale' ? '依据已变化' : '待复核'} · {String(note.statement)}</p>)}{!value.notes.length && <p>当前没有待复核事项。</p>}</div></details>}
    {value && <details className="story-details"><summary>阅读进度与串联依据</summary><div className="story-details-body">
      {value.reading ? value.reading.pages.map((page, index) => <p key={String(page.id)}>第 {index + 1} 页 · {page.checked ? '已检查' : '待检查'} · {String(page.reason || '')}</p>) : value.windows.map((window, index) => <p key={window.start}>旧窗口 {index + 1}：第 {window.start + 1}–{window.end} 原章</p>)}
      {value.tasks.filter(task => task.total > 0).map(task => <article key={task.id}><p>已检查 {task.reviewed.length}/{task.total} 项</p>{task.reviewed.map((row, index) => <p key={index}>{row.title || row.assetId}：{String(row.reason)}</p>)}{task.error && <p>{task.error}</p>}</article>)}
    </div></details>}
    </div>
  {traceOpen && (running || value?.progress?.runId) && <P3ExecutionPanel bookId={bookId} runId={value?.progress?.runId} sessionId={value?.progress?.editorSessionId} loadExecution={service.execution} run={value?.progress?.runId ? { id: value.progress.runId, status: value.runStatus, startedAt: value.runStartedAt, requestLedger: value.requestLedger, report: { assetEdits: value.assetEdits } } : undefined} onClose={() => setTraceOpen(false)} />}
    {restartPhase && <RestartDialog title={restartPhase === "global_review" ? "重新复核全书" : "重新串联事件线"} onClose={() => setRestartPhase(undefined)} onChoose={mode => { const phase = restartPhase; setRestartPhase(undefined); void (phase === "global_review" ? service.review(bookId, mode) : service.start(bookId, mode)) }} />}
  </section>
}
