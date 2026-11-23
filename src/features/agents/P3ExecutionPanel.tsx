import { useEffect, useRef, useState } from 'react'
import { ExecutionChainView } from './ExecutionChainView'
import { subscribeTraceHub } from './trace'
import { onStorageChanged } from '../local-storage/client'
import type { StoryExecution } from '../story/execution'
import type { StoryExecutionPhase } from './executionPagingTypes'

const phases = [['window_link', '事件串联'], ['global_review', '全书复核']] as const
type LoadExecution = (bookId: string, phase: StoryExecutionPhase) => Promise<StoryExecution>

export function P3ExecutionPanel({ bookId, initialPhase, loadExecution, onClose }: {
  bookId: string

  initialPhase: StoryExecutionPhase
  loadExecution: LoadExecution
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [phase, setPhase] = useState(initialPhase)
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close() }, [])
  return <dialog ref={ref} className="merge-dialog run-detail-dialog" aria-labelledby="p3-execution-title" onCancel={event => event.preventDefault()}><header className="merge-dialog-heading"><h2 id="p3-execution-title">整理详情</h2><button className="text-button" onClick={onClose}>关闭</button></header>
    <div className="merge-dialog-body run-detail-body">
      <nav className="run-window-tabs" aria-label="P3 整理阶段">{phases.map(([value, label]) => <button type="button" key={value} aria-pressed={phase === value} className={phase === value ? 'primary-button' : 'secondary-button'} onClick={() => setPhase(value)}>{label}</button>)}</nav>
      <PhaseExecution key={phase} bookId={bookId} phase={phase} loadExecution={loadExecution} />
    </div>
  </dialog>
}

function PhaseExecution({ bookId, phase, loadExecution }: { bookId: string; phase: StoryExecutionPhase; loadExecution: LoadExecution }) {
  const [data, setData] = useState<StoryExecution>()
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  useEffect(() => subscribeTraceHub(() => setTick(value => value + 1)), [])
  useEffect(() => onStorageChanged(() => setTick(value => value + 1), [{ scope: `book:${bookId}`, tables: ['storySessionEntries', 'pipelineRuns'] }]), [bookId])
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      void loadExecution(bookId, phase).then(value => { if (live) { setData(value); setError('') } })
        .catch(failure => { if (live) setError(failure instanceof Error ? failure.message : '执行链读取失败。') })
    }, 300)
    return () => { live = false; clearTimeout(timer) }
  }, [bookId, phase, loadExecution, tick])
  return <>
    {error && <p role="alert">{error}</p>}
    {!error && data === undefined && <p className="field-help" role="status">正在读取 Agent 执行过程…</p>}
    {data === null && <p className="field-help" role="status">该阶段暂无 API 请求记录。</p>}
    {data && <ExecutionChainView key={data.runId} chain={data.chain} folded fullRequests onChainChange={chain => setData(current => current?.runId === data.runId ? { ...current, chain } : current)} />}
  </>
}
