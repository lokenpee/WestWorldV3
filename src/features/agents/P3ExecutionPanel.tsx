import { useEffect, useRef, useState } from 'react'
import type { RunTraceRun } from './AgentRunPanel'
import { ExecutionChainView } from './ExecutionChainView'
import { subscribeTraceHub, type ExecutionChain } from './trace'

const text = (value: unknown) => typeof value === 'string' ? value : ''
const when = (value: unknown) => text(value) ? new Date(text(value)).toLocaleString('zh-CN') : '未记录'

export function P3ExecutionPanel({ bookId, runId, sessionId, run, loadExecution, onClose }: {
  bookId: string
  runId?: string
  sessionId?: string
  run?: RunTraceRun
  loadExecution: (bookId: string, runId: string, options?: { unitId?: string; contextId?: string; sessionId?: string }) => Promise<ExecutionChain>
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [chain, setChain] = useState<ExecutionChain>()
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close() }, [])
  useEffect(() => subscribeTraceHub(() => setTick(value => value + 1)), [])
  useEffect(() => {
    if (!runId) { setChain({ entries: [], requests: [], snapshots: new Map() }); return }
    let live = true
    const timer = setTimeout(() => {
      void loadExecution(bookId, runId, { sessionId }).then(value => { if (live) { setChain(value); setError('') } })
        .catch(failure => { if (live) setError(failure instanceof Error ? failure.message : '执行链读取失败。') })
    }, 300)
    return () => { live = false; clearTimeout(timer) }
  }, [bookId, runId, sessionId, loadExecution, tick])
  const edits = Array.isArray(run?.report?.assetEdits) ? run!.report!.assetEdits as Record<string, unknown>[] : []
  return <dialog ref={ref} className="merge-dialog run-detail-dialog" aria-labelledby="p3-execution-title" onCancel={event => event.preventDefault()}><header className="merge-dialog-heading"><h2 id="p3-execution-title">整理详情</h2><button className="text-button" onClick={onClose}>关闭</button></header>
    <div className="merge-dialog-body run-detail-body">
      <div className="run-heading-line"><p>P3 叙事整理 · {run?.status ? when(run.startedAt) : '当前会话'}</p>{run?.status && <span>{run.status}</span>}</div>
      {error && <p role="alert">{error}</p>}
      {!chain && <p className="field-help">正在读取 Agent 执行过程…</p>}
      {chain && <ExecutionChainView chain={chain} edits={edits} onChainChange={setChain} />}
    </div>
  </dialog>
}
