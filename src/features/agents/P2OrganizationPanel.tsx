import { useCallback, useEffect, useRef, useState } from 'react'
import type { RunTraceRun } from './AgentRunPanel'
import { ExecutionChainView } from './ExecutionChainView'
import { subscribeTraceHub, type ExecutionChain, type OrganizationStepIndexEntry } from './trace'

type Step = 'scan' | 'profiles' | 'relations'
type Indexes = Record<Step, OrganizationStepIndexEntry[]>
const text = (value: unknown) => typeof value === 'string' ? value : ''
const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') as Record<string, unknown>[] : []
const stepLabel: Record<Step, string> = { scan: '第一步：识别与合并', profiles: '第二步：整理人物资料', relations: '第三步：整理人物关系' }
const kindLabel: Record<OrganizationStepIndexEntry['kind'], string> = { directory: '目录页', candidate: '疑似组', profile: '人物资料', relations: '人物关系' }
const when = (value: unknown) => text(value) ? new Date(text(value)).toLocaleString('zh-CN') : '未记录'
const statusLabel = (entry: OrganizationStepIndexEntry) => entry.outcome ? ({ changed: '已修改', no_change: '无需修改', uncertain: '仍有疑点', unavailable: '已不可用', merged: '已合并', not_same: '不是同一人', partial: '部分合并' } as Record<string, string>)[entry.outcome] ?? entry.outcome : entry.status === 'checked' || entry.status === 'resolved' ? '已完成' : entry.status === 'pending' ? '待处理' : entry.status || '已记录'

export function P2OrganizationPanel({ bookId, loadIndex, loadExecution, runs, initialRunId, onOpenReport, onClose }: {
  bookId: string
  loadIndex: (bookId: string, step: Step) => Promise<OrganizationStepIndexEntry[]>
  loadExecution: (bookId: string, query: { runId: string; step: Step; objectKey: string }) => Promise<ExecutionChain>
  runs: RunTraceRun[]
  initialRunId?: string
  onOpenReport?: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const [step, setStep] = useState<Step>('scan')
  const [indexes, setIndexes] = useState<Indexes>({ scan: [], profiles: [], relations: [] })
  const [loadingIndex, setLoadingIndex] = useState(true)
  const [selected, setSelected] = useState<OrganizationStepIndexEntry>()
  const [chain, setChain] = useState<ExecutionChain>()
  const [loadingObjects, setLoadingObjects] = useState(false)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const focusedRun = useRef<string | undefined>(undefined)
  const requestToken = useRef(0)
  const runKey = runs.map(row => `${row.id}:${row.status ?? ''}`).join('|')
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close() }, [])
  useEffect(() => subscribeTraceHub(() => setTick(value => value + 1)), [])
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      void Promise.all((['scan', 'profiles', 'relations'] as Step[]).map(name => loadIndex(bookId, name).then(rows => [name, rows] as const)))
        .then(rows => { if (live) setIndexes(Object.fromEntries(rows) as Indexes) })
        .catch(failure => { if (live) setError(failure instanceof Error ? failure.message : '整理索引读取失败。') })
        .finally(() => { if (live) setLoadingIndex(false) })
    }, loadingIndex ? 0 : 350)
    return () => { live = false; clearTimeout(timer) }
  }, [bookId, loadIndex, runKey, tick, loadingIndex])
  const load = useCallback(async (entry: OrganizationStepIndexEntry, token: number) => {
    setLoadingObjects(true); setError('')
    try {
      const next = await loadExecution(bookId, { runId: entry.runId, step: entry.step, objectKey: entry.objectKey })
      if (token === requestToken.current) setChain(next)
    } catch (failure) {
      if (token === requestToken.current) setError(failure instanceof Error ? failure.message : '执行链读取失败。')
    } finally {
      if (token === requestToken.current) setLoadingObjects(false)
    }
  }, [bookId, loadExecution])
  const select = (entry: OrganizationStepIndexEntry) => {
    const token = ++requestToken.current
    setSelected(entry); setChain(undefined); setError('')
    void load(entry, token)
  }
  useEffect(() => {
    if (!initialRunId || loadingIndex || focusedRun.current === initialRunId) return
    const entries = (['scan', 'profiles', 'relations'] as Step[]).flatMap(name => indexes[name])
    const entry = entries.find(row => row.runId === initialRunId && (!row.characterId || row.kind === 'profile' || row.kind === 'relations'))
    if (entry) { focusedRun.current = initialRunId; setStep(entry.step); select(entry) }
  }, [initialRunId, indexes, loadingIndex])
  useEffect(() => {
    void tick
    if (!selected) return
    const timer = setTimeout(() => {
      const token = ++requestToken.current
      void load(selected, token)
    }, 300)
    return () => clearTimeout(timer)
  }, [tick, selected, load])
  const entries = indexes[step]
  const run = runs.find(row => row.id === selected?.runId)
  const edits = list(run?.report?.assetEdits)
  const selectedCharacterId = selected?.characterId
  const scopedEdits = selected?.kind === 'profile' && selectedCharacterId
    ? edits.filter(edit => text(edit.kind) === 'character' && text(edit.id) === selectedCharacterId)
    : selected?.kind === 'relations' && selectedCharacterId
      ? edits.filter(edit => text(edit.kind) === 'relation' && text(edit.id).includes(selectedCharacterId))
      : []
  return <dialog ref={ref} className="merge-dialog run-detail-dialog" aria-labelledby="p2-organization-title" onCancel={event => event.preventDefault()}><header className="merge-dialog-heading"><h2 id="p2-organization-title">整理详情</h2><button className="text-button" onClick={onClose}>关闭</button></header>
    <div ref={body} className="merge-dialog-body run-detail-body">
      <div className="run-heading-line"><p>P2 人物整理 · {stepLabel[step]} · 共 {entries.length} 个对象</p>{onOpenReport && <button type="button" className="secondary-button" onClick={onOpenReport}>查看完整整理报告</button>}</div>
      <div className="run-window-tabs" role="tablist" aria-label="整理步骤">{(['scan', 'profiles', 'relations'] as Step[]).map(name => <button type="button" role="tab" aria-selected={step === name} className={step === name ? 'primary-button' : 'secondary-button'} key={name} onClick={() => { setStep(name); setSelected(undefined); setChain(undefined) }}>{stepLabel[name]}（{indexes[name].length}）</button>)}</div>
      {loadingIndex && <p className="field-help">正在读取整理索引…</p>}
      {error && <p role="alert">{error}</p>}
      {!loadingIndex && !entries.length && <p className="field-help">本步骤还没有整理记录。</p>}
      {!!entries.length && <div className="p2-object-list" aria-label={`${stepLabel[step]}对象`}>{entries.map(entry => <button type="button" key={`${entry.runId}:${entry.objectKey}`} className={selected?.runId === entry.runId && selected.objectKey === entry.objectKey ? 'selected' : ''} onClick={() => select(entry)}><strong>{kindLabel[entry.kind]} · {entry.label}</strong><span>{when(entry.runStartedAt)} · {statusLabel(entry)} · {entry.requestCount} 次请求{entry.hasTrace ? '' : ' · 无 API 明细'}</span></button>)}</div>}
      {selected && <section className="run-selected-object" aria-label="所选整理对象">
        <div className="run-heading-line"><p>{kindLabel[selected.kind]} · {selected.label} · {when(selected.runStartedAt)}</p><span>{selected.hasTrace ? 'Agent 执行过程' : '旧版本未保存 API 明细'}</span></div>
        {loadingObjects && !chain && <p className="field-help">正在读取 Agent 执行过程…</p>}
        {!loadingObjects && !selected.hasTrace && !chain?.entries.length && <p className="field-help">此对象来自旧运行，没有可重建的消息事件；以下是现有结果和修改记录。</p>}
        {chain && <ExecutionChainView chain={chain} edits={scopedEdits} />}
      </section>}
    </div>
  </dialog>
}
