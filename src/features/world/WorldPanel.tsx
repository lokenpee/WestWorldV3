import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveResult } from '../../hooks/useLiveResult'
import type { WorldService, Candidate } from './service'
import type { AssetService } from '../assets/service'
import type { MergeRequest } from '../assets/merge'
import type { MechanicalQueueItem } from './types'
import { MergeDialog } from '../assets/MergeDialog'
import { WorldReportDialog } from './WorldReportDialog'
import './WorldPanel.css'

export function WorldPanel({ bookId, service, assets }: { bookId: string; service: WorldService; assets: AssetService }) {
  const [, refresh] = useState(0); const [candidates, setCandidates] = useState<Candidate[]>()
  const [selected, setSelected] = useState<Candidate>(); const [memberIds, setMemberIds] = useState<string[]>([])
  const [preview, setPreview] = useState(false); const [reportOpen, setReportOpen] = useState(false); const [error, setError] = useState(''); const [scanning, setScanning] = useState(false)
  const [prepared, setPrepared] = useState<MergeRequest>(); const [merging, setMerging] = useState(false); const [message, setMessage] = useState('')
  const [chosenName, setChosenName] = useState('')
  const [queueSaving, setQueueSaving] = useState(false)
  const drafts = useRef(new Map<string, { memberIds: string[]; prepared?: MergeRequest; chosenName: string }>())
  const submitting = useRef(false)
  const [leaseAttempt, retryLease] = useState(0)
  const eligibility = useLiveResult(useCallback(() => service.eligibility(bookId), [service, bookId]), leaseAttempt)
  const queue = useLiveResult(useCallback(() => service.mechanical.read(bookId), [service, bookId]), leaseAttempt)
  useEffect(() => {
    let live = true
    const recover = () => { void service.mechanical.recover(bookId).catch(failure => { if (live) setError(failure instanceof Error ? failure.message : '队列恢复失败。') }) }
    recover(); const timer = setInterval(recover, 1000)
    return () => { live = false; clearInterval(timer) }
  }, [service, bookId])
  const leaseExpiry = eligibility.status === 'ready' ? eligibility.value.leaseExpiry : undefined
  useEffect(() => {
    if (leaseExpiry === undefined) return
    const timer = setTimeout(() => retryLease(value => value + 1), Math.max(1, leaseExpiry - Date.now() + 50))
    return () => clearTimeout(timer)
  }, [leaseExpiry])
  const reports = useLiveResult(useCallback(() => service.reports(bookId), [service, bookId]))
  const snapshot = useLiveResult(useCallback(() => service.worldRows(bookId), [service, bookId]))
  const state = service.state(bookId); const lastReport = useRef<string | undefined>(undefined)
  useEffect(() => service.subscribe(() => {
    refresh(value => value + 1)
    const latest = service.state(bookId)
    if (latest?.reportId && latest.reportId !== lastReport.current) {
      lastReport.current = latest.reportId
      if (latest.reportType === 'ai') setReportOpen(true)
    }
  }), [service, bookId])
  async function scan() {
    if (scanning) return
    setScanning(true); setError(''); setMessage(''); setSelected(undefined); setPrepared(undefined); setChosenName('')
    try { const result = await service.organize(bookId); setCandidates(result.candidates); setMessage(`同名自动合并 ${result.merged} 组${result.failed ? `，失败 ${result.failed} 组` : ''}。其余候选可继续核对。`) } catch (failure) { setError(failure instanceof Error ? failure.message : '候选读取失败。') } finally { setScanning(false) }
  }
  const ready = eligibility.status === 'ready' && eligibility.value.ready
  const queueData = queue.status === 'ready' ? queue.value : undefined
  const queueItems = queueData?.items ?? []
  const queueRunning = !!queueData?.running || !!state?.running && state.mode === 'mechanical'
  const aiRunning = !!state?.running && state.mode !== 'mechanical'
  const busy = !!state?.running || merging || queueRunning || queueSaving
  const queuedIds = new Set(queueItems.filter(item => item.status === 'pending' || item.status === 'running').flatMap(item => item.request.memberIds.map(id => `${item.kind}:${id}`)))
  const selectedRows = selected && snapshot.status === 'ready' ? (selected.kind === 'character' ? snapshot.value.characters : snapshot.value.locations).filter(row => selected.memberIds.includes(row.id)) : []
  const candidateNames = (candidate: Candidate) => snapshot.status === 'ready' ? [...new Set((candidate.kind === 'character' ? snapshot.value.characters : snapshot.value.locations).filter(row => candidate.memberIds.includes(row.id)).map(row => row.name))].slice(0, 3).join('、') : candidate.memberIds[0]
  const fresh = !!prepared && snapshot.status === 'ready' && prepared.memberIds.every(id => selectedRows.some(row => row.id === id && row.revision === prepared.expectedRevisions[id]))
  const mergingRows = selectedRows.filter(row => memberIds.includes(row.id))
  const names = [...new Set(mergingRows.flatMap(row => [row.name, ...(row.aliases ?? [])]))]
  const sameName = mergingRows.length > 0 && mergingRows.every(row => row.name === mergingRows[0].name)
  const protectedRows = mergingRows.filter(row => row.manualKeep)
  const keepId = prepared?.keepId ?? (protectedRows.length === 1 ? protectedRows[0].id : [...mergingRows].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))[0]?.id)
  const canonicalName = prepared?.canonicalName ?? (names.includes(chosenName) ? chosenName : sameName ? mergingRows[0].name : '')
  const canConfirm = memberIds.length >= 2 && mergingRows.length === memberIds.length && !!keepId && !!canonicalName
  const choose = (candidate: Candidate | undefined) => {
    if (selected) drafts.current.set(selected.id, { memberIds, prepared, chosenName })
    const draft = candidate ? drafts.current.get(candidate.id) : undefined
    const nextMembers = (draft?.memberIds ?? candidate?.memberIds ?? []).filter(id => !candidate || !queuedIds.has(`${candidate.kind}:${id}`))
    setSelected(candidate); setMemberIds(nextMembers)
    setPrepared(draft?.prepared && draft.prepared.memberIds.length === nextMembers.length && nextMembers.every(id => draft.prepared!.memberIds.includes(id)) ? draft.prepared : undefined)
    setChosenName(draft?.chosenName ?? ''); setError('')
  }
  const requestForSelection = (): MergeRequest => ({ memberIds: [...memberIds], keepId: keepId!, canonicalName, expectedRevisions: Object.fromEntries(mergingRows.map(row => [row.id, row.revision])) })
  async function addQueue() {
    if (!selected || !canConfirm || !ready || submitting.current || busy) return
    submitting.current = true; setQueueSaving(true); setError(''); setMessage('')
    try {
      await service.mechanical.add(bookId, selected.kind, requestForSelection())
      setMessage(`已确认“${canonicalName}”并加入待合并队列。可继续核对其他候选。`)
      choose(undefined)
    } catch (failure) { setError(failure instanceof Error ? failure.message : '加入队列失败。') }
    finally { submitting.current = false; setQueueSaving(false) }
  }
  async function runQueue() {
    if (!ready || busy || submitting.current) return
    submitting.current = true; setQueueSaving(true); setError(''); setMessage('')
    try {
      await service.mechanical.start(bookId)
      const saved = await service.mechanical.read(bookId)
      setMessage(`机械合并已保存：成功 ${saved.completed} 组，失败 ${saved.failed} 组，待处理 ${saved.pending} 组。`)
      try { setScanning(true); setCandidates(await service.scan(bookId, false)); choose(undefined) }
      catch (failure) { setError(`合并结果已保存，候选刷新失败：${failure instanceof Error ? failure.message : '请重新扫描。'}`) }
      finally { setScanning(false) }
    } catch (failure) { setError(failure instanceof Error ? failure.message : '机械合并启动失败。') }
    finally { submitting.current = false; setQueueSaving(false) }
  }
  async function removeQueue(item: MechanicalQueueItem) {
    setError(''); setQueueSaving(true)
    try { await service.mechanical.remove(bookId, item.id) }
    catch (failure) { setError(failure instanceof Error ? failure.message : '移除待办失败。') }
    finally { setQueueSaving(false) }
  }
  function reviewQueue(item: MechanicalQueueItem) {
    const candidate = candidates?.find(row => row.kind === item.kind && row.memberIds.some(id => item.request.memberIds.includes(id))) ?? { id: `review:${item.id}`, kind: item.kind, memberIds: item.request.memberIds, reason: '请核对当前成员资料，确认后重新加入队列。' }
    choose(candidate)
    setMemberIds(item.request.memberIds.filter(id => snapshot.status === 'ready' && (item.kind === 'character' ? snapshot.value.characters : snapshot.value.locations).some(row => row.id === id)))
    setPrepared(undefined); setChosenName(item.request.canonicalName)
  }
  async function confirm() {
    if (!selected || !canConfirm || !ready || submitting.current) return
    submitting.current = true; setMerging(true); setError(''); setMessage('')
    const candidate = selected
    const request: MergeRequest = { memberIds: [...memberIds], keepId, canonicalName, expectedRevisions: Object.fromEntries(mergingRows.map(row => [row.id, row.revision])) }
    try {
      const result = await service.confirm(bookId, candidate.kind, request)
      setPrepared(undefined)
      setMessage(`已合并“${result.asset.name}”，减少 ${request.memberIds.length - 1} 条。可继续处理剩余候选。`)
      try {
        const updated = await service.scan(bookId, false)
        setCandidates(updated)
        const next = updated.find(row => row.kind === candidate.kind && row.memberIds.some(id => candidate.memberIds.includes(id))) ?? updated[0]
        choose(next)
      } catch (failure) {
        setCandidates(current => current?.filter(row => row.id !== candidate.id)); setSelected(undefined)
        setError(`合并已保存，候选刷新失败：${failure instanceof Error ? failure.message : '请重新扫描。'}`)
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : '合并失败，请重试。') }
    finally { submitting.current = false; setMerging(false) }
  }
  return <section className="world-panel" aria-label="世界资产整理"><div className="world-heading"><h2>P2 世界资产整理</h2><div>
      <button className="secondary-button" disabled={!ready || scanning || busy} onClick={() => void scan()}>{scanning ? '正在查找候选…' : '代码整理'}</button>
      <button className="secondary-button" disabled={!ready || scanning || busy || queue.status !== 'ready' || !queueData?.pending && !queueData?.statisticsPending} onClick={() => void runQueue()}>{queueRunning ? queueData?.pending === 0 && queueData.statisticsPending ? '更新统计中…' : '机械合并中…' : queueData?.statisticsPending && !queueData.pending ? '完成合并收尾' : `一键机械合并（${queueData?.pending ?? 0}组）`}</button>
      <button className="primary-button" disabled={!ready || scanning || busy} onClick={() => { setError(''); void service.start(bookId) }}>{aiRunning ? 'AI整理中…' : eligibility.status === 'ready' && eligibility.value.resumable ? '继续AI整理' : 'AI整理'}</button>
      {aiRunning && <button className="text-button" onClick={() => service.cancel(bookId)}>取消AI整理</button>}
      {queueRunning && <button className="text-button" onClick={() => { void service.mechanical.stop(bookId).catch(failure => setError(failure instanceof Error ? failure.message : '停止请求失败。')) }}>停止机械合并</button>}
      {reports.status === 'ready' && reports.value.length > 0 && <button className="text-button" onClick={() => setReportOpen(true)}>查看整理报告</button>}
    </div></div>
    <p>代码整理：先自动合并完整同名项，其余候选核对后合并，可按需预览。AI整理：核对原文后合并，按需整编详细资料。</p>
    {eligibility.status === 'ready' && !eligibility.value.covered && <p className="muted">请先完成全书逐章提取。</p>}
    {eligibility.status === 'error' && <p role="alert">{eligibility.message}</p>}
    {scanning && !state?.running && <p role="status">正在刷新名称候选…</p>}
    {(aiRunning || queueRunning) && <p role="status">{state?.running ? `${state.phase} · 已处理 ${state.processed}/${state.total}` : `${queueData?.pending === 0 && queueData.statisticsPending ? '正在更新出场统计' : '机械合并队列处理中'} · 已处理 ${(queueData?.completed ?? 0) + (queueData?.failed ?? 0)}/${queueItems.length}`}</p>}
    {queue.status === 'error' && <p role="alert">{queue.message}</p>}
    {queueItems.length > 0 && <div className="mechanical-queue" role="region" aria-label="待合并队列"><p>待处理 {queueData?.pending ?? 0} 组 · 已合并 {queueData?.completed ?? 0} 组 · 失败 {queueData?.failed ?? 0} 组</p><p className="muted">完整同名项自动合并，异名项按人工确认执行。每组独立保存，停止后保留未处理项。</p><ul>{queueItems.map(item => <li key={item.id}><div><strong>{item.kind === 'character' ? '人物' : '地点'} · {item.request.canonicalName}</strong><span>{item.confirmation === 'exact_name' ? '同名自动' : '人工确认'} · {item.request.memberIds.length}条 · 保留 {item.request.keepId} · {{ pending: '待合并', running: '正在合并', completed: '已合并', failed: '待重新核对' }[item.status]}</span><small>{item.memberNames.map((name, index) => `${name}（${item.request.memberIds[index]}）`).join('、')}</small>{item.error && <p className="asset-warning">{item.error}</p>}</div>{item.status === 'failed' && <button className="text-button" disabled={busy || !ready} onClick={() => reviewQueue(item)}>重新核对</button>}{item.status !== 'completed' && <button className="text-button" disabled={busy || !ready} onClick={() => void removeQueue(item)}>移除待办</button>}</li>)}</ul></div>}
    {(error || state?.error) && <p role="alert">{error || state?.error}</p>}
    {message && <p role="status">{message}</p>}
    {candidates && <div className="world-candidates" role="region" aria-label="代码整理候选"><p>{candidates.length ? `找到 ${candidates.length} 组候选，请选择一组核对实际成员。` : '没有找到需要合并的名称候选。'}</p>{candidates.map(row => <button className="secondary-button" key={row.id} disabled={busy} onClick={() => choose(row)}>{row.kind === 'character' ? '人物' : '地点'} · {candidateNames(row)} · {row.memberIds.length} 条</button>)}</div>}
    {selected && <div className="world-selection"><p>{selected.reason}</p>{selectedRows.map(row => <label key={row.id}><input type="checkbox" disabled={busy || queuedIds.has(`${selected.kind}:${row.id}`)} checked={memberIds.includes(row.id)} onChange={event => { setMemberIds(current => event.target.checked ? [...current, row.id] : current.filter(id => id !== row.id)); setPrepared(undefined); setChosenName('') }} />{row.name} · {row.id}{queuedIds.has(`${selected.kind}:${row.id}`) ? '（已加入队列）' : ''} · {'identity' in row ? row.identity : 'description' in row ? row.description : ''}</label>)}{!sameName && !prepared && <div className="world-name-choice"><label htmlFor="world-merge-name">合并后主名</label><select id="world-merge-name" value={canonicalName} disabled={busy} onChange={event => setChosenName(event.target.value)}><option value="">请选择主名</option>{names.map(name => <option key={name} value={name}>{name}</option>)}</select></div>}{canonicalName && <p>{prepared && fresh ? '已预览：' : ''}保留 {keepId}，主名“{canonicalName}”。</p>}{prepared && !fresh && <p className="muted">资料已更新，请核对当前候选后确认。</p>}<div className="world-selection-actions"><button className="secondary-button" disabled={memberIds.length < 2 || !ready || busy} onClick={() => { if (canConfirm) setPrepared(requestForSelection()); setPreview(true) }}>预览代码合并</button><button className="secondary-button" disabled={!canConfirm || !ready || busy || queue.status !== 'ready'} onClick={() => void addQueue()}>加入待合并</button><button className="primary-button" disabled={!canConfirm || !ready || busy} onClick={() => void confirm()}>{merging ? '正在合并…' : '确认机械合并'}</button><button className="text-button" disabled={busy} onClick={() => choose(undefined)}>收起候选</button></div></div>}
    {preview && selected && <MergeDialog bookId={bookId} kind={selected.kind} memberIds={memberIds} service={assets} locked={!ready} initialRequest={prepared} onClose={() => setPreview(false)} onPrepared={request => { setPrepared(request); setPreview(false) }} onMerged={() => undefined} />}
    {reportOpen && reports.status === 'ready' && <WorldReportDialog runs={reports.value} initialId={state?.reportId} onClose={() => setReportOpen(false)} />}
  </section>
}
