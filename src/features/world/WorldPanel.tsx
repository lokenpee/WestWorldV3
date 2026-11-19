import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveResult, bookInterests } from '../../hooks/useLiveResult'
import type { WorldService, Candidate } from './service'
import type { AssetService } from '../assets/service'
import type { MergeRequest } from '../assets/merge'
import type { MechanicalQueueItem } from './types'
import { MergeDialog } from '../assets/MergeDialog'
import { combineCandidates } from './identityReview'
import { WorldReportDialog } from './WorldReportDialog'
import { P2OrganizationPanel } from '../agents/P2OrganizationPanel'
import { P2Progress } from './P2Progress'
import type { LoadP2Execution } from '../agents/useP2Execution'
import { RestartDialog } from '../agents/RestartDialog'
import './WorldPanel.css'

const text = (value: unknown) => typeof value === 'string' ? value : ''

export function WorldPanel({ bookId, service, assets, focusRunId }: { bookId: string; service: WorldService; assets: AssetService; focusRunId?: string }) {
  const [restartStep, setRestartStep] = useState<'scan' | 'profiles' | 'relations'>()
  useEffect(() => setRestartStep(undefined), [bookId])
  const [showOrganization, setShowOrganization] = useState(true)
  const [activityFailure, setActivityFailure] = useState<{ bookId: string; message: string }>()
  const loadExecution: LoadP2Execution = useCallback((id, query) => service.execution(id, query.runId, { unitId: query.objectKey }), [service])
  const [, refresh] = useState(0); const [candidates, setCandidates] = useState<Candidate[]>()
  const [selected, setSelected] = useState<Candidate>(); const [memberIds, setMemberIds] = useState<string[]>([])
  const [preview, setPreview] = useState(false); const [reportOpen, setReportOpen] = useState(false); const [traceOpen, setTraceOpen] = useState(false); const [error, setError] = useState(''); const [scanning, setScanning] = useState(false)
  const [prepared, setPrepared] = useState<MergeRequest>(); const [merging, setMerging] = useState(false); const [message, setMessage] = useState(''); const [traceRunId, setTraceRunId] = useState<string>()
  const [chosenName, setChosenName] = useState('')
  const [queueSaving, setQueueSaving] = useState(false)
  const drafts = useRef(new Map<string, { memberIds: string[]; prepared?: MergeRequest; chosenName: string }>())
  const submitting = useRef(false)
  const [leaseAttempt, retryLease] = useState(0)
  const eligibility = useLiveResult(useCallback(() => service.eligibility(bookId), [service, bookId]), leaseAttempt, bookInterests(bookId, ['chapters', 'extractionReceipts', 'pipelineRuns', 'compileProgress']))
  const queue = useLiveResult(useCallback(() => service.mechanical.read(bookId), [service, bookId]), leaseAttempt, bookInterests(bookId, ['pipelineRuns']))
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
  const reports = useLiveResult(useCallback(() => service.reports(bookId), [service, bookId]), 0, bookInterests(bookId, ['pipelineRuns'], 'run'))
  const snapshot = useLiveResult(useCallback(() => service.worldRows(bookId), [service, bookId]), 0, bookInterests(bookId, ['characters', 'locations']))
  const aiCandidates = useLiveResult(useCallback(() => service.identityCandidates(bookId), [service, bookId]), 0, [...bookInterests(bookId, ['characters', 'assetLifecycle']), { scope: `book:${bookId}`, tables: ['pipelineRuns'], category: 'run' }])
  const visibleCandidates = combineCandidates(candidates ?? [], aiCandidates.status === 'ready' ? aiCandidates.value : [])
  const state = service.state(bookId); const lastReport = useRef<string | undefined>(undefined)
  useEffect(() => { if (!focusRunId) return; setShowOrganization(true); setTraceRunId(focusRunId); setTraceOpen(true) }, [focusRunId])
  useEffect(() => { void service.recoverOrganization(bookId).catch(failure => setError(failure instanceof Error ? failure.message : '人物整理状态恢复失败。')) }, [service, bookId])
  useEffect(() => service.subscribe(() => {
    refresh(value => value + 1)
    const latest = service.state(bookId)
    if (latest?.reportId && latest.reportId !== lastReport.current) {
      lastReport.current = latest.reportId
      if (latest.reportType === 'ai') setReportOpen(true)
    }
  }), [service, bookId])
  async function scan() {
    setShowOrganization(false)
    if (scanning) return
    setScanning(true); setError(''); setMessage(''); setSelected(undefined); setPrepared(undefined); setChosenName('')
    try { const result = await service.organize(bookId); setCandidates(result.candidates); setMessage(`同名自动合并 ${result.merged} 组${result.failed ? `，失败 ${result.failed} 组` : ''}。其余候选可继续核对。`) } catch (failure) { setError(failure instanceof Error ? failure.message : '候选读取失败。') } finally { setScanning(false) }
  }
  const ready = eligibility.status === 'ready' && eligibility.value.ready
  const queueData = queue.status === 'ready' ? queue.value : undefined
  const queueItems = queueData?.items ?? []
  const queueRunning = !!queueData?.running || !!state?.running && state.mode === 'mechanical'
  const allOrganizationRuns = reports.status === 'ready' ? reports.value.filter(row => row.workflow === 'character_organization_v1') : []
  const stepRuns = allOrganizationRuns.filter(row => !!row.organization?.runStep)
  const legacyActiveRun = allOrganizationRuns.find(row => !row.organization?.runStep && (row.status === 'running' || row.status === 'paused'))
  const activeOrgRun = stepRuns.find(row => row.status === 'running' || row.status === 'paused') ?? legacyActiveRun
  const legacyStep = activeOrgRun && !activeOrgRun.organization?.runStep
    ? (['scan', 'resolve'].includes(text(activeOrgRun.organization?.step ?? '')) ? 'scan' : activeOrgRun.organization?.step === 'profiles' ? 'profiles' : activeOrgRun.organization?.step === 'relations' ? 'relations' : undefined)
    : undefined
  const activeStep = activeOrgRun?.organization?.runStep ?? legacyStep ?? state?.organizationStep
  const activeStatus = state?.paused ? 'paused' : activeOrgRun?.status ?? (state?.running ? 'running' : undefined)
  const aiRunning = activeStatus === 'running' || !!state?.running
  const organizationRun = activeOrgRun ?? stepRuns[0] ?? allOrganizationRuns.filter(row => row.scope !== 'character')[0]
  const busy = !!state?.running || (!!activeStatus && !(activeStep === 'scan' && activeStatus === 'paused')) || merging || queueRunning || queueSaving
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
    setShowOrganization(false)
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
    setQueueSaving(true)
    try { await service.mechanical.remove(bookId, item.id) }
    finally { setQueueSaving(false) }
  }
  function reviewQueue(item: MechanicalQueueItem) {
    const candidate = candidates?.find(row => row.kind === item.kind && row.memberIds.some(id => item.request.memberIds.includes(id))) ?? { id: `review:${item.id}`, kind: item.kind, memberIds: item.request.memberIds, reason: '请核对当前成员资料，确认后重新加入队列。' }
    choose(candidate)
    setMemberIds(item.request.memberIds.filter(id => snapshot.status === 'ready' && (item.kind === 'character' ? snapshot.value.characters : snapshot.value.locations).some(row => row.id === id)))
    setPrepared(undefined); setChosenName(item.request.canonicalName)
  }
  async function confirm() {
    if (!selected || !canConfirm || !ready || busy || submitting.current) return
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
      {(['scan', 'profiles', 'relations'] as const).map((step, index) => {
        const label = `第${['一', '二', '三'][index]}步：${{ scan: '识别重复人物', profiles: '优化人物资料', relations: '整理人物关系' }[step]}`
        const isActive = activeStep === step
        const status = isActive ? activeStatus : undefined
        const controllable = status === 'running' || status === 'paused'
        const disabled = !controllable && (!!activeStep && !isActive || (!isActive && (!!state?.running || !!activeStatus)) || !ready || scanning)
        const text = status === 'running' ? `暂停第${['一', '二', '三'][index]}步` : status === 'paused' ? `继续第${['一', '二', '三'][index]}步` : label
        return <button key={step} className={isActive ? 'primary-button' : 'secondary-button'} disabled={disabled} onClick={() => {
          setError(''); setMessage(''); setShowOrganization(true); setActivityFailure(undefined)
          if (status !== 'running' && status !== 'paused' && allOrganizationRuns.some(run => run.organization?.runStep === step || !run.organization?.runStep)) { setRestartStep(step); return }
          const action = status === 'running' ? service.pauseOrganization(bookId) : status === 'paused' ? service.continueOrganization(bookId) : service.startOrganizationStep(bookId, step)
          void action.catch(failure => setActivityFailure({ bookId, message: failure instanceof Error ? failure.message : '人物整理暂时无法继续。' }))
        }}>{text}</button>
      })}
      {activeStep && (activeStatus === 'running' || activeStatus === 'paused') && <button className="text-button" onClick={() => void service.cancelOrganization(bookId)}>取消整理</button>}
      {queueRunning && <button className="text-button" onClick={() => { void service.mechanical.stop(bookId).catch(failure => setError(failure instanceof Error ? failure.message : '停止请求失败。')) }}>停止机械合并</button>}
      <button className="text-button" onClick={() => { setTraceRunId(showOrganization ? organizationRun?.id : undefined); setTraceOpen(true) }}>整理详情</button>
      {!organizationRun && !aiRunning && reports.status === 'ready' && reports.value.length > 0 && <button className="text-button" onClick={() => setReportOpen(true)}>查看整理报告</button>}
    </div></div>
    <p>代码整理：先自动合并完整同名项，其余候选核对后合并，可按需预览。AI整理按步骤独立执行：第一步识别重复人物，第二步优化人物资料，第三步整理人物关系；暂停保留原任务，重新开始时可选择复用已完成结果或全部重新整理。</p>
    {eligibility.status === 'ready' && !eligibility.value.covered && <p className="muted">请先完成全书逐章提取。</p>}
    {eligibility.status === 'ready' && eligibility.value.covered && eligibility.value.locked && <p className="muted">本书已有世界、叙事或提取任务，人物整理按钮暂不可用。</p>}
    {eligibility.status === 'error' && <p role="alert">{eligibility.message}</p>}
    {scanning && !state?.running && <p role="status">正在刷新名称候选…</p>}
    {showOrganization && organizationRun && <P2Progress bookId={bookId} run={organizationRun} load={loadExecution} phase={state?.phase} error={activityFailure?.bookId === bookId ? activityFailure.message : state?.error} candidateCount={aiCandidates.status === 'ready' ? aiCandidates.value.filter(row => !row.dismissed).length : undefined} />}
    {!!organizationRun?.organization?.reusedCount && <p>已复用 {organizationRun.organization.reusedCount} 人的完成结果</p>}
    {activityFailure?.bookId === bookId && !organizationRun && <p role="alert">{activityFailure.message}</p>}
    {((aiRunning && !organizationRun) || queueRunning) && <p role="status">{state?.running ? `${state.phase} · 已处理 ${state.processed}/${state.total}` : `${queueData?.pending === 0 && queueData.statisticsPending ? '正在更新出场统计' : '机械合并队列处理中'} · 已处理 ${(queueData?.completed ?? 0) + (queueData?.failed ?? 0)}/${queueItems.length}`}</p>}
    {queue.status === 'error' && <p role="alert">{queue.message}</p>}
    {(error || state?.error && !showOrganization) && <p role="alert">{error || state?.error}</p>}
    {message && <p role="status">{message}</p>}
    {(candidates || visibleCandidates.length > 0) && <div className="world-candidates" role="region" aria-label="代码整理候选"><p>{visibleCandidates.length ? `找到 ${visibleCandidates.length} 组疑似重复，请选择一组核对；确认后才会合并。` : '没有待处理的合并候选。'}</p>{visibleCandidates.map(row => <button className="secondary-button" key={row.id} onClick={() => choose(row)}>{row.ai ? 'AI发现' : '代码发现'} · {row.kind === 'character' ? '人物' : '地点'} · {candidateNames(row)} · {row.memberIds.length} 条</button>)}</div>}
    {aiCandidates.status === 'error' && <p role="alert">{aiCandidates.message}</p>}
    {selected?.ai && <button className="secondary-button" disabled={busy || !ready} onClick={() => { void service.dismissIdentityCandidate(bookId, selected).then(() => { choose(undefined); setMessage('已记录不是同一人。') }).catch(failure => setError(failure instanceof Error ? failure.message : '候选处理失败。')) }}>不是同一人</button>}
    {activeStep === 'scan' && aiRunning && <p className="muted">正在识别，可查看疑似组；识别运行期间不能合并人物。</p>}
    {selected && <div className="world-selection"><p>{selected.reason}</p>{selectedRows.map(row => <label key={row.id}><input type="checkbox" disabled={busy || queuedIds.has(`${selected.kind}:${row.id}`)} checked={memberIds.includes(row.id)} onChange={event => { setMemberIds(current => event.target.checked ? [...current, row.id] : current.filter(id => id !== row.id)); setPrepared(undefined); setChosenName('') }} />{row.name} · {row.id}{queuedIds.has(`${selected.kind}:${row.id}`) ? '（已加入队列）' : ''} · {'identity' in row ? row.identity : 'description' in row ? row.description : ''}</label>)}{!sameName && !prepared && <div className="world-name-choice"><label htmlFor="world-merge-name">合并后主名</label><select id="world-merge-name" value={canonicalName} disabled={busy} onChange={event => setChosenName(event.target.value)}><option value="">请选择主名</option>{names.map(name => <option key={name} value={name}>{name}</option>)}</select></div>}{canonicalName && <p>{prepared && fresh ? '已预览：' : ''}保留 {keepId}，主名“{canonicalName}”。</p>}{prepared && !fresh && <p className="muted">资料已更新，请核对当前候选后确认。</p>}<div className="world-selection-actions"><button className="secondary-button" disabled={memberIds.length < 2 || !ready || busy} onClick={() => { if (canConfirm) setPrepared(requestForSelection()); setPreview(true) }}>预览代码合并</button><button className="secondary-button" disabled={!canConfirm || !ready || busy || queue.status !== 'ready'} onClick={() => void addQueue()}>加入待合并</button><button className="primary-button" disabled={!canConfirm || !ready || busy} onClick={() => void confirm()}>{merging ? '正在合并…' : '确认机械合并'}</button><button className="text-button" disabled={busy} onClick={() => choose(undefined)}>收起候选</button></div></div>}
    {preview && selected && <MergeDialog bookId={bookId} kind={selected.kind} memberIds={memberIds} service={assets} locked={!ready} initialRequest={prepared} onClose={() => setPreview(false)} onPrepared={request => { setPrepared(request); setPreview(false) }} onMerged={() => undefined} />}
    {reportOpen && reports.status === 'ready' && <WorldReportDialog runs={reports.value} initialId={state?.reportId} queue={queueData ? { items: queueItems, pending: queueData.pending, completed: queueData.completed, failed: queueData.failed } : undefined} queueBusy={busy || queueSaving} onRemoveQueue={removeQueue} onReviewQueue={reviewQueue} onClose={() => setReportOpen(false)} />}
    {traceOpen && <P2OrganizationPanel bookId={bookId} loadIndex={service.organizationIndex} loadExecution={loadExecution} loadMerges={service.mergeHistory} maintainHistory={service.maintainOrganizationHistory} runs={allOrganizationRuns} initialRunId={traceRunId} initialStep={showOrganization ? undefined : 'scan'} onOpenReport={() => { setTraceOpen(false); setReportOpen(true) }} onClose={() => { setTraceOpen(false); setTraceRunId(undefined) }} />}
    {restartStep && <RestartDialog title="重新开始人物整理" onClose={() => setRestartStep(undefined)} onChoose={mode => { const step = restartStep; setRestartStep(undefined); void service.startOrganizationStep(bookId, step, mode).catch(failure => setActivityFailure({ bookId, message: failure instanceof Error ? failure.message : "人物整理启动失败。" })) }} />}
  </section>
}
