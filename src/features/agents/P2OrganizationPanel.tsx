import { useEffect, useRef, useState } from 'react'
import { ExecutionChainView } from './ExecutionChainView'
import { subscribeTraceHub, type OrganizationStepIndexEntry } from './trace'
import { completedCharacters, currentCharacter } from './p2History'
import { useP2Execution, type LoadP2Execution } from './useP2Execution'
import { MergeHistory } from '../world/MergeHistory'
import type { WorldRun } from '../world/types'
import type { Row } from './repository'

type Step = 'scan' | 'profiles' | 'relations'
const labels: Record<Step, string> = { scan: '识别与合并记录', profiles: '人物资料', relations: '人物关系' }
const keyOf = (entry: OrganizationStepIndexEntry) => `${entry.runId}:${entry.objectKey}`

export function P2OrganizationPanel({ bookId, loadIndex, loadExecution, loadMerges, maintainHistory, runs, initialRunId, initialStep, onOpenReport, onClose }: {
  bookId: string; loadIndex: (bookId: string, step: Step) => Promise<OrganizationStepIndexEntry[]>
  loadExecution: LoadP2Execution; loadMerges: (bookId: string) => Promise<Row[]>; maintainHistory: (bookId: string) => Promise<void>
  runs: WorldRun[]; initialRunId?: string; initialStep?: Step; onOpenReport?: () => void; onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [chosenStep, setChosenStep] = useState<Step | undefined>(initialStep)
  const [manual, setManual] = useState<OrganizationStepIndexEntry>()
  const [query, setQuery] = useState(''), [search, setSearch] = useState('')
  const [indexes, setIndexes] = useState<OrganizationStepIndexEntry[]>([])
  const [merges, setMerges] = useState<Row[]>()
  const [indexError, setIndexError] = useState(''), [mergeError, setMergeError] = useState('')
  const [loading, setLoading] = useState(true), [tick, setTick] = useState(0), [retry, setRetry] = useState(0)
  const preferred = runs.find(run => run.id === initialRunId) ?? runs.find(run => ['running', 'paused'].includes(run.status)) ?? runs[0]
  const step = chosenStep ?? preferred?.organization?.runStep ?? (preferred?.organization?.mode === 'profile' ? 'profiles' : preferred?.organization?.mode === 'relations' ? 'relations' : 'scan')
  const current = currentCharacter(runs, step === 'scan' ? undefined : step)
  const completed = completedCharacters(indexes.filter(entry => entry.step === step))
  const matches = completed.filter(entry => entry.label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  const selected = (manual ? completed.find(entry => entry.characterId === manual.characterId) ?? manual : undefined) ?? (step !== 'scan' ? current : undefined) ?? completed.find(entry => entry.runId === initialRunId) ?? completed[0]
  const { chain, loading: loadingChain, error } = useP2Execution(bookId, step === 'scan' ? undefined : selected?.runId, step, selected?.objectKey, loadExecution)
  const runKey = runs.map(run => `${run.id}:${run.status}`).join('|')
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close() }, [])
  useEffect(() => subscribeTraceHub(() => setTick(value => value + 1)), [])
  useEffect(() => { void maintainHistory(bookId).catch(() => undefined) }, [bookId, maintainHistory])
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      void Promise.all((['profiles', 'relations'] as const).map(name => loadIndex(bookId, name))).then(rows => {
        if (live) { setIndexes(rows.flat()); setIndexError('') }
      }).catch(failure => { if (live) setIndexError(failure instanceof Error ? failure.message : '人物记录读取失败。') }).finally(() => { if (live) setLoading(false) })
    }, loading ? 0 : 350)
    return () => { live = false; clearTimeout(timer) }
  }, [bookId, loadIndex, runKey, tick, retry, loading])
  useEffect(() => {
    let live = true
    void loadMerges(bookId).then(rows => { if (live) { setMerges(rows); setMergeError('') } }).catch(failure => { if (live) setMergeError(failure instanceof Error ? failure.message : '合并历史读取失败。') })
    return () => { live = false }
  }, [bookId, loadMerges, runKey, retry])
  const run = runs.find(run => run.id === selected?.runId)
  const items = step === 'profiles' ? run?.organization?.profileItems : run?.organization?.relationItems
  const item = items?.find(item => item.id === selected?.characterId)
  const edits = (run?.report.assetEdits ?? []).filter(edit => {
    if (!selected?.characterId) return false
    if (item?.commitIds?.length && !item.commitIds.includes(edit.commitId)) return false
    if (step === 'profiles') return edit.kind === 'character' && edit.id === selected.characterId
    if (edit.kind !== 'relation') return false
    try { return (JSON.parse(edit.id) as string[]).includes(selected.characterId) } catch { return false }
  }) as unknown as Row[]
  const names = new Map(runs.flatMap(run => [...(run.organization?.profileItems ?? []), ...(run.organization?.relationItems ?? [])].map(item => [item.id, item.name || item.id] as const)))
  return <dialog ref={ref} className="merge-dialog run-detail-dialog" aria-labelledby="p2-organization-title" onCancel={event => event.preventDefault()}>
    <header className="merge-dialog-heading"><h2 id="p2-organization-title">整理详情</h2><button className="text-button" onClick={onClose}>关闭</button></header>
    <div className="merge-dialog-body run-detail-body">
      <div className="run-heading-line"><nav className="run-window-tabs p2-step-tabs" aria-label="整理类型">{(['scan', 'profiles', 'relations'] as const).map(name => <button type="button" key={name} aria-pressed={step === name} className={step === name ? 'primary-button' : 'secondary-button'} onClick={() => { setChosenStep(name); setManual(undefined); setQuery(''); setSearch('') }}>{labels[name]}</button>)}</nav>{onOpenReport && <button className="text-button" onClick={onOpenReport}>查看完整整理报告</button>}</div>
      {step === 'scan' ? <>
        {mergeError ? <p role="alert">合并记录暂时无法读取：{mergeError} <button onClick={() => setRetry(value => value + 1)}>重试</button></p> : merges ? <MergeHistory runs={merges} /> : <p>正在读取合并记录…</p>}
      </> : <>
        <form className="p2-person-picker" onSubmit={event => { event.preventDefault(); setSearch(query); const found = completed.filter(entry => entry.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())); if (found.length === 1) setManual(found[0]) }}>
          <label>已完成人物<select aria-label="已完成人物" value={selected && (!current || manual) ? keyOf(selected) : ''} onChange={event => setManual(completed.find(entry => keyOf(entry) === event.target.value))}>
            <option value="">{current ? `当前：${current.label}` : '选择已完成人物'}</option>
            {matches.map(entry => <option key={keyOf(entry)} value={keyOf(entry)}>{entry.label}</option>)}
          </select></label>
          <label>搜索已完成人物<input value={query} onChange={event => setQuery(event.target.value)} placeholder="姓名或编号" /></label>
          <button className="secondary-button" type="submit">搜索</button>
          {manual && current && <button type="button" className="text-button" onClick={() => { setManual(undefined); setQuery(''); setSearch('') }}>回到当前人物</button>}
        </form>
        {search && <p role="status">{matches.length ? `找到 ${matches.length} 位已完成人物，请在下拉框选择。` : '未找到已完成的人物。'}</p>}
        {indexError && <p role="alert">人物记录暂时无法读取：{indexError} <button onClick={() => setRetry(value => value + 1)}>重试</button></p>}
        {loading && !selected && <p>正在读取人物记录…</p>}
        {!loading && !indexError && !selected && <p>暂无已完成人物。</p>}
        {selected && <section className="run-selected-object" aria-label="所选整理对象">
          <h3>{labels[step]} · {selected.label}</h3>
          <p className="field-help">{new Date(selected.runStartedAt).toLocaleString('zh-CN')}</p>
          {error && <p role="alert">整理详情暂时无法读取：{error}</p>}
          {loadingChain && !chain.requests.length && <p>正在读取 Agent 执行过程…</p>}
          <ExecutionChainView folded chain={{ ...chain, runStatus: selected.status === 'checked' ? 'completed' : selected.runStatus }} edits={edits} characterNames={names} />
        </section>}
      </>}
    </div>
  </dialog>
}
