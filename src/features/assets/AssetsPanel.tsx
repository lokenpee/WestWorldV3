import { useCallback, useEffect, useRef, useState } from 'react'
import type { BookRepository } from '../../lib/storage/workspace'
import { useLiveResult } from '../../hooks/useLiveResult'
import type { AssetService } from './service'
import { assetLabels, assetName, assetTables, roleWeights, type Asset, type AssetKind, type Character } from './types'
import { AssetEditor } from './AssetEditor'
import './AssetsPanel.css'
import { MergeDialog } from './MergeDialog'
import { MergeHistory } from './MergeHistory'
import { EventNetwork } from '../network/EventNetwork'
import { searchAssets } from './search'

export function AssetsPanel({ bookId, repository, service, kind, onKindChange }: {
  bookId: string; repository: BookRepository; service: AssetService; kind: AssetKind; onKindChange: (kind: AssetKind) => void
}) {
  const [selection, setSelection] = useState<{ id: string; saved?: Asset } | 'new'>()
  const [queryText, setQueryText] = useState('')
  const [role, setRole] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [mergeMode, setMergeMode] = useState(false)
  const [mergeIds, setMergeIds] = useState<string[]>([])
  const [previewOpen, setPreviewOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [networkView, setNetworkView] = useState(false)
  const [lastReport, setLastReport] = useState<string>()
  const [mergeMessage, setMergeMessage] = useState('')
  const query = useCallback(() => service.read(bookId), [service, bookId])
  const chapterQuery = useCallback(() => repository.listChapters(bookId), [repository, bookId])
  const data = useLiveResult(query, attempt)
  const chapters = useLiveResult(chapterQuery, attempt)
  const panelRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const panel = panelRef.current
    const workspace = panel?.closest<HTMLElement>('.workspace-content')
    if (!panel || !workspace) return
    const resize = () => {
      const top = getComputedStyle(workspace).overflowY === 'visible' ? 0 : workspace.getBoundingClientRect().top
      panel.style.setProperty('--asset-panel-height', `${Math.max(0, window.innerHeight - top - 24)}px`)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(workspace)
    window.addEventListener('resize', resize)
    return () => { observer.disconnect(); window.removeEventListener('resize', resize) }
  }, [data.status, chapters.status])
  if (data.status === 'loading' || chapters.status === 'loading') return <p role="status" className="muted">正在读取资产…</p>
  if (data.status === 'error' || chapters.status === 'error') return <div role="alert" className="error-panel"><p>{data.status === 'error' ? data.message : chapters.status === 'error' ? chapters.message : ''}</p><button className="secondary-button" onClick={() => setAttempt(value => value + 1)}>重新读取资产</button></div>
  const rows: Asset[] = data.value[assetTables[kind]]
  const normalized = queryText.trim().toLowerCase()
  const visible = searchAssets(rows.filter(row => kind !== 'character' || !role || (row as Character).roleWeight === role), queryText, chapters.value)
  const current = selection && selection !== 'new' ? rows.find(row => row.id === selection.id) : undefined
  if (selection && selection !== 'new' && selection.saved && current && current.revision >= selection.saved.revision) setSelection({ id: selection.id })
  const confirmed = selection && selection !== 'new' ? selection.saved : undefined
  const selected = confirmed && (!current || confirmed.revision > current.revision) ? confirmed : current
  const locked = data.value.locks[kind === 'character' || kind === 'location' ? 'world' : 'narrative']
  const worldKind = kind === 'character' || kind === 'location' ? kind : undefined
  const networkVisible = networkView && (kind === 'node' || kind === 'eventLine')
  const hidden = mergeIds.filter(id => !visible.some(row => row.id === id)).length
  const missingIds = mergeIds.filter(id => !rows.some(row => row.id === id))

  return <section ref={panelRef} className={`assets-panel${selection ? ' has-editor' : ''}${networkVisible ? ' has-network' : ''}`} aria-label="资产管理">
    <div className="asset-tabs" aria-label="资产类型">{(Object.keys(assetLabels) as AssetKind[]).map(tab => <button key={tab} aria-pressed={kind === tab} onClick={() => { onKindChange(tab); setSelection(undefined); setQueryText(''); setRole(''); setMergeMode(false); setMergeIds([]); setPreviewOpen(false); setMergeMessage('') }}>{assetLabels[tab]} <span>{data.value[assetTables[tab]].length}</span></button>)}</div>
    <div className="asset-toolbar"><input hidden={networkVisible} aria-label="搜索资产" placeholder="搜索名称、别名、内容或编号" value={queryText} onChange={event => setQueryText(event.target.value)} />{kind === 'character' && <select aria-label="筛选人物层级" value={role} onChange={event => setRole(event.target.value)}><option value="">全部层级</option>{roleWeights.map(value => <option key={value}>{value}</option>)}</select>}<button className="primary-button" disabled={locked} onClick={() => setSelection('new')}>新增{assetLabels[kind]}</button>{!worldKind && <div className="asset-view-switch" aria-label="展示方式"><button className="secondary-button" aria-pressed={!networkVisible} onClick={() => setNetworkView(false)}>列表</button><button className="secondary-button" aria-pressed={networkVisible} onClick={() => setNetworkView(true)}>事件网络</button></div>}</div>
    <div className="merge-toolbar">
      {worldKind && !mergeMode && <button className="secondary-button" disabled={locked} onClick={() => { setMergeMode(true); setMergeIds([]); setSelection(undefined); setMergeMessage('') }}>手动合并</button>}
      {mergeMode && <><span>已选 {mergeIds.length} 项{hidden ? `（含隐藏 ${hidden} 项）` : ''}</span><button className="primary-button" disabled={locked || mergeIds.length < 2} onClick={() => setPreviewOpen(true)}>确定合并</button><button className="secondary-button" onClick={() => { setMergeMode(false); setMergeIds([]); setPreviewOpen(false) }}>退出合并</button>{missingIds.length > 0 && <button className="text-button" onClick={() => setMergeIds(ids => ids.filter(id => !missingIds.includes(id)))}>清除失效选择（{missingIds.length}）</button>}</>}
      {data.value.manualMerges.length > 0 && <button className="text-button" onClick={() => setHistoryOpen(true)}>合并记录（{data.value.manualMerges.length}）</button>}
    </div>
    {mergeMessage && <p className="merge-success" role="status">{mergeMessage}</p>}
    {locked && <p className="asset-warning" role="status">这类资产正在处理，任务结束后可新增或修改。</p>}
    <div className={`assets-layout-grid${selection ? ' has-editor' : ''}`}>
      <div className="asset-results"><EventNetwork key={bookId} bookId={bookId} nodes={data.value.nodes} lines={data.value.eventLines} chapters={chapters.value} active={networkVisible} selectedId={kind === 'node' && selection && selection !== 'new' ? selection.id : undefined} onSelectNode={id => { onKindChange('node'); setSelection({ id }) }} onEditLine={id => { onKindChange('eventLine'); setSelection({ id }) }} /><div hidden={networkVisible} className="asset-list-view"><p className="result-count">显示 {visible.length} / {rows.length} 条 · {normalized ? '按相关度排列' : '按名称排列'}</p>{visible.length === 0 ? <p className="asset-empty">{rows.length ? '没有匹配的资产，请调整搜索或筛选。' : `还没有${assetLabels[kind]}，可以点击上方按钮新增。`}</p> : <ul className="asset-list">{visible.map(row => <li key={row.id}>{mergeMode ? <label className="merge-selection"><input type="checkbox" aria-label={`选择合并 ${assetName(row)} ${row.id}`} checked={mergeIds.includes(row.id)} onChange={event => setMergeIds(ids => event.target.checked ? [...ids, row.id] : ids.filter(id => id !== row.id))} /><span><strong>{assetName(row)}</strong><small>{row.id} · {'chapterName' in row ? row.chapterName || '人工来源' : ''}</small></span></label> : <button className={selection && selection !== 'new' && selection.id === row.id ? 'selected' : ''} aria-label={`编辑 ${assetName(row)}`} onClick={() => setSelection({ id: row.id })}><strong>{assetName(row)}</strong><span>{'summary' in row ? row.summary : 'identity' in row ? row.identity : 'description' in row ? row.description : ''}</span><small>{row.createdBy === 'manual' ? '人工' : '提取'} · {'chapterName' in row ? row.chapterName || '无章节来源' : '事件线'} · 修订 {row.revision}</small><code>{row.id}</code></button>}</li>)}</ul>}</div></div>
      {selection && <AssetEditor key={`${kind}:${selection === 'new' ? 'new' : selection.id}`} kind={kind} asset={selected} creating={selection === 'new'} snapshot={data.value} chapters={chapters.value} service={service} repository={repository} bookId={bookId} onClose={() => setSelection(undefined)} onSaved={row => setSelection({ id: row.id, saved: row })} onSelect={id => setSelection({ id })} />}
    </div>
    {previewOpen && worldKind && <MergeDialog bookId={bookId} kind={worldKind} memberIds={mergeIds} service={service} locked={locked} onClose={() => setPreviewOpen(false)} onMerged={(asset, reportId, reduced) => { setPreviewOpen(false); setMergeMode(false); setMergeIds([]); setQueryText(''); setRole(''); setSelection({ id: asset.id, saved: asset }); setLastReport(reportId); setMergeMessage(`合并完成，保留“${assetName(asset)}”，减少 ${reduced} 条。`) }} />}
    {historyOpen && <MergeHistory runs={data.value.manualMerges} initialId={lastReport} onClose={() => setHistoryOpen(false)} />}
  </section>
}
