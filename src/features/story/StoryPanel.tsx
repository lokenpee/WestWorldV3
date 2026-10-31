import { useCallback, useEffect, useState } from 'react'
import { useLiveResult } from '../../hooks/useLiveResult'
import type { StoryService } from './service'
import { SessionHistory } from './SessionHistory'
import './StoryPanel.css'

export function StoryPanel({ bookId, service }: { bookId: string; service: StoryService }) {
  const [, refresh] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  useEffect(() => service.subscribe(() => refresh(value => value + 1)), [service])
  const saved = useLiveResult(useCallback(() => service.read(bookId), [service, bookId]))
  const state = service.state(bookId), running = !!state?.running
  const value = saved.status === 'ready' ? saved.value : undefined
  const reviewed = value?.progress?.phase === 'global_review' && value.progress.status === 'completed' && value.progress.validity !== 'stale' && value.review.pending === 0
  const finished = (value?.progress?.phase === 'window_link_complete' || reviewed) && value?.progress?.validity !== 'stale'
  const reviewing = running && state.phase === 'global_review'
  const reviewReady = finished || value?.progress?.phase === 'global_review'
  const interrupted = !!value?.progress && !finished
  return <section className="story-panel" aria-label="事件线窗口串联"><div className="story-heading"><h2>P3 叙事整理</h2><button className="primary-button" disabled={!value?.covered || value.locked || running} onClick={() => void service.start(bookId)}>{running && !reviewing ? '正在串联…' : finished ? '重新串联事件线' : interrupted ? '继续串联事件线' : '串联事件线'}</button><button className="secondary-button" disabled={!reviewReady || value?.locked || running} onClick={() => void service.review(bookId)}>{reviewing ? '正在复核…' : reviewed ? '重新复核全书' : value?.progress?.phase === 'global_review' ? '继续全书复核' : '全书复核'}</button>{running && <button className="secondary-button" onClick={() => service.cancel(bookId)}>{reviewing ? '取消复核' : '取消串联'}</button>}</div>
    <div className="story-body"><p>每100原章处理一个窗口，相邻窗口重叠20章；已有节点与事件线继续复用。</p>
    {!value?.covered && saved.status === 'ready' && <p className="muted">请先完成全书逐章提取。</p>}
    {value?.locked && !running && <p role="status">本书已有叙事或提取任务，请等待执行权释放。</p>}
    {!running && value?.progress?.validity === 'stale' && <p className="muted">资料有更新或任务未完成，可继续核对窗口。</p>}
    {value && <p role="status">{reviewed ? '全书复核完成' : reviewing ? '全书复核中' : finished ? '窗口串联完成' : running ? '窗口串联中' : value.progress?.status === 'cancelled' ? '串联已取消' : ['failed', 'paused'].includes(value.progress?.status ?? '') ? '整理有未完成项' : '等待串联'} · 已完成 {value.completed}/{value.windows.length} 个窗口</p>}
    {running && <p role="status">{reviewing ? `复核已检查 ${state.processed}/${state.nodeTotal} 项 · ${{ orphans: '孤立节点', event_lines: '事件线', review_notes: '复核事项' }[state.queue ?? ''] ?? '核对清单'}` : `当前窗口 ${state.window}/${state.total} · 节点已处理 ${state.processed}/${state.nodeTotal}`}</p>}
    {value && reviewReady && <p>全书清单 {value.review.total} 项 · 待检查 {value.review.pending} 项</p>}
    {state?.sessionStatus && <p role="status">{state.sessionStatus.state === 'compressing' ? '正在压缩会话上下文…' : state.sessionStatus.state === 'compression_failed' ? '压缩未完成，完整历史已保留，可继续重试。' : `上下文压缩完成：约 ${state.sessionStatus.before} → ${state.sessionStatus.after} tokens`}</p>}
    {saved.status === 'error' && <p role="alert">{saved.message}</p>}{state?.error && <p role="alert">{state.error}</p>}
    {value?.usage && <p>累计用量 {value.usage.totalTokens} · {value.usage.costStatus === 'unknown' ? '费用未知' : `估算费用 ${value.usage.cost.toFixed(6)} 美元`}</p>}
    {value?.session.id && <p>本书会话 · {value.session.entryCount} 条记录 · 已压缩 {value.session.compactions} 次 <button className="text-button" onClick={() => setHistoryOpen(open => !open)}>{historyOpen ? '收起会话历史' : '查看会话历史'}</button></p>}
    {historyOpen && <SessionHistory key={bookId} bookId={bookId} service={service} />}
    {value?.session.id && <details className="story-details"><summary>工作记忆与待复核事项</summary><div className="story-details-body"><p>{String(value.memory?.workingSummary || '还没有工作摘要')}</p>{value.notes.map(note => <p key={String(note.id)}>{note.validity === 'stale' ? '依据已变化' : '待复核'} · {String(note.statement)}</p>)}{!value.notes.length && <p>当前没有待复核事项。</p>}</div></details>}
    {value && <details className="story-details"><summary>窗口进度与串联依据</summary><div className="story-details-body">{value.windows.map((window, index) => { const checkpoint = value.checkpoints.find(row => row.window.start === window.start && row.window.end === window.end); return <p key={window.start}>窗口 {index + 1}：第 {window.start + 1}–{window.end} 原章 · {checkpoint?.status === 'completed' ? '完成' : checkpoint?.status === 'cancelled' ? '已取消' : checkpoint?.status === 'failed' ? '失败' : '待处理'}{checkpoint && ` · ${checkpoint.scopeIds.length} 个节点`}</p> })}
      {value.tasks.map((task, i) => <article key={task.id}><strong>子任务 {i + 1} · {task.status === 'completed' ? '完成' : '保留进度'}</strong>{task.reviewed.map((row, index) => <p key={index}>{String(row.reason)}</p>)}{task.error && <p>{task.error}</p>}<details><summary>提交确认（{task.commits.length}）</summary>{task.commits.map(id => <p key={id}>{id}</p>)}</details></article>)}
      {value.review.conclusions.map(row => <p key={String(row.workItemId)}>全书复核 · {String(row.id)} · {String(row.reason)}</p>)}
    </div></details>}
    </div></section>
}
