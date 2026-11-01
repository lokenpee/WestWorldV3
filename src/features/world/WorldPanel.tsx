import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveResult } from '../../hooks/useLiveResult'
import type { WorldService, Candidate } from './service'
import type { AssetService } from '../assets/service'
import type { MergeRequest } from '../assets/merge'
import { MergeDialog } from '../assets/MergeDialog'
import { WorldReportDialog } from './WorldReportDialog'
import './WorldPanel.css'

export function WorldPanel({ bookId, service, assets }: { bookId: string; service: WorldService; assets: AssetService }) {
  const [, refresh] = useState(0); const [candidates, setCandidates] = useState<Candidate[]>()
  const [selected, setSelected] = useState<Candidate>(); const [memberIds, setMemberIds] = useState<string[]>([])
  const [preview, setPreview] = useState(false); const [reportOpen, setReportOpen] = useState(false); const [error, setError] = useState(''); const [scanning, setScanning] = useState(false)
  const [prepared, setPrepared] = useState<MergeRequest>(); const [merging, setMerging] = useState(false); const [message, setMessage] = useState('')
  const [chosenName, setChosenName] = useState('')
  const submitting = useRef(false)
  const [leaseAttempt, retryLease] = useState(0)
  const eligibility = useLiveResult(useCallback(() => service.eligibility(bookId), [service, bookId]), leaseAttempt)
  const leaseExpiry = eligibility.status === 'ready' ? eligibility.value.leaseExpiry : undefined
  useEffect(() => {
    if (leaseExpiry === undefined) return
    const timer = setTimeout(() => retryLease(value => value + 1), Math.max(1, leaseExpiry - Date.now() + 50))
    return () => clearTimeout(timer)
  }, [leaseExpiry])
  const reports = useLiveResult(useCallback(() => service.reports(bookId), [service, bookId]))
  const snapshot = useLiveResult(useCallback(() => assets.read(bookId), [assets, bookId]))
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
    try { setCandidates(await service.scan(bookId)) } catch (failure) { setError(failure instanceof Error ? failure.message : '候选读取失败。') } finally { setScanning(false) }
  }
  const ready = eligibility.status === 'ready' && eligibility.value.ready
  const busy = !!state?.running || merging
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
  const choose = (candidate: Candidate | undefined) => { setSelected(candidate); setMemberIds(candidate?.memberIds ?? []); setPrepared(undefined); setChosenName(''); setError('') }
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
  return <section className="world-panel" aria-label="世界资产整理"><div className="world-heading"><h2>P2 世界资产整理</h2><div><button className="secondary-button" disabled={!ready || scanning || busy} onClick={() => void scan()}>{scanning ? '正在查找候选…' : '代码整理'}</button><button className="primary-button" disabled={!ready || scanning || busy} onClick={() => { setError(''); void service.start(bookId) }}>{busy ? 'AI整理中…' : eligibility.status === 'ready' && eligibility.value.resumable ? '继续AI整理' : 'AI整理'}</button>{busy && <button className="text-button" onClick={() => service.cancel(bookId)}>取消AI整理</button>}{reports.status === 'ready' && reports.value.length > 0 && <button className="text-button" onClick={() => setReportOpen(true)}>查看整理报告</button>}</div></div>
    <p>代码整理：自动找候选，选择成员后确认合并，可按需预览。AI整理：核对原文后合并，按需整编详细资料。</p>
    {eligibility.status === 'ready' && !eligibility.value.covered && <p className="muted">请先完成全书逐章提取。</p>}
    {eligibility.status === 'error' && <p role="alert">{eligibility.message}</p>}
    {busy && <p role="status">{state?.phase} · 已处理 {state?.processed}/{state?.total}</p>}
    {(error || state?.error) && <p role="alert">{error || state?.error}</p>}
    {message && <p role="status">{message}</p>}
    {candidates && <div className="world-candidates" role="region" aria-label="代码整理候选"><p>{candidates.length ? `找到 ${candidates.length} 组候选，请选择一组核对实际成员。` : '没有找到需要合并的名称候选。'}</p>{candidates.map(row => <button className="secondary-button" key={row.id} disabled={busy} onClick={() => choose(row)}>{row.kind === 'character' ? '人物' : '地点'} · {candidateNames(row)} · {row.memberIds.length} 条</button>)}</div>}
    {selected && <div className="world-selection"><p>{selected.reason}</p>{selectedRows.map(row => <label key={row.id}><input type="checkbox" disabled={busy} checked={memberIds.includes(row.id)} onChange={event => { setMemberIds(current => event.target.checked ? [...current, row.id] : current.filter(id => id !== row.id)); setPrepared(undefined); setChosenName('') }} />{row.name} · {row.id} · {'identity' in row ? row.identity : 'description' in row ? row.description : ''}</label>)}{!sameName && !prepared && <div className="world-name-choice"><label htmlFor="world-merge-name">合并后主名</label><select id="world-merge-name" value={canonicalName} disabled={busy} onChange={event => setChosenName(event.target.value)}><option value="">请选择主名</option>{names.map(name => <option key={name} value={name}>{name}</option>)}</select></div>}{canonicalName && <p>{prepared && fresh ? '已预览：' : ''}保留 {keepId}，主名“{canonicalName}”。</p>}{prepared && !fresh && <p className="muted">资料已更新，请核对当前候选后确认。</p>}<div className="world-selection-actions"><button className="secondary-button" disabled={memberIds.length < 2 || !ready || busy} onClick={() => setPreview(true)}>预览代码合并</button><button className="primary-button" disabled={!canConfirm || !ready || busy} onClick={() => void confirm()}>{merging ? '正在合并…' : '确认机械合并'}</button><button className="text-button" disabled={busy} onClick={() => choose(undefined)}>收起候选</button></div></div>}
    {preview && selected && <MergeDialog bookId={bookId} kind={selected.kind} memberIds={memberIds} service={assets} locked={!ready} initialRequest={prepared} onClose={() => setPreview(false)} onPrepared={request => { setPrepared(request); setPreview(false) }} onMerged={() => undefined} />}
    {reportOpen && reports.status === 'ready' && <WorldReportDialog runs={reports.value} initialId={state?.reportId} onClose={() => setReportOpen(false)} />}
  </section>
}
