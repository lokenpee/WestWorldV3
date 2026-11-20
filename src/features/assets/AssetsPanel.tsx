import { useCallback, useEffect, useRef, useState } from 'react'
import type { BookRepository } from '../../lib/storage/workspace'
import { useLiveResult, bookInterests } from '../../hooks/useLiveResult'
import type { AssetService } from './service'
import { assetLabels, assetName, assetTables, roleWeights, type Asset, type AssetKind } from './types'
import type { AssetEditorHandle } from './AssetEditor'
import { AssetDetails, AssetNetwork, AssetMergeHistory } from './AssetViews'
import type { AssetPage } from './assetPage'
import { setLeaveGuard } from './leaveGuard'
import './AssetsPanel.css'
import { MergeDialog } from './MergeDialog'
import { LegacyRelationReport } from './LegacyRelationReport'
import { OutlineView } from '../story/OutlineViews'

export function AssetsPanel({ bookId, repository, service, kind, onKindChange, organizeDisabled, organizeDisabledReason, resumeCharacterId, onAutoTier, onOrganizeCharacter, onContinueCharacter }: {
  bookId: string; repository: BookRepository; service: AssetService; kind: AssetKind; onKindChange: (kind: AssetKind) => void
  organizeDisabled?: boolean; organizeDisabledReason?: string; resumeCharacterId?: string
  onAutoTier?: () => Promise<{ total: number; changed: number; manual: number }>
  onOrganizeCharacter?: (characterId: string, mode: 'profile' | 'relations') => Promise<void> | void
  onContinueCharacter?: (characterId: string) => Promise<void> | void
}) {
  const [selection, setSelection] = useState<{ id: string; saved?: Asset } | 'new'>()
  const editorRef = useRef<AssetEditorHandle>(null)
  const [pendingLeave, setPendingLeave] = useState<{ action: () => void }>()
  const [queryText, setQueryText] = useState('')
  const [offset, setOffset] = useState(0)
  const [lastPage, setLastPage] = useState<{ bookId: string; kind: AssetKind; value: AssetPage }>()
  const [role, setRole] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [mergeMode, setMergeMode] = useState(false)
  const [mergeIds, setMergeIds] = useState<string[]>([])
  const [previewOpen, setPreviewOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [networkView, setNetworkView] = useState(false)
  const [networkOpened, setNetworkOpened] = useState(false)
  const [characterView, setCharacterView] = useState<'list' | 'network'>('list')
  const [lastReport, setLastReport] = useState<string>()
  const [mergeMessage, setMergeMessage] = useState('')
  const [tiering, setTiering] = useState(false)
  const [tierMessage, setTierMessage] = useState(''), [tierError, setTierError] = useState('')
  const tierPending = useRef(false)
  async function autoTier() {
    if (!onAutoTier || tierPending.current) return
    tierPending.current = true; setTiering(true); setTierMessage(''); setTierError('')
    try {
      const result = await onAutoTier()
      setTierMessage(result.total ? `人物自动分层完成：已处理 ${result.total} 人，调整 ${result.changed} 人层级，保留 ${result.manual} 人的手动层级。` : '暂无人物可自动分层。')
    } catch (error) { setTierError(error instanceof Error ? error.message : '人物自动分层失败，请重试。') }
    finally { tierPending.current = false; setTiering(false); setAttempt(value => value + 1) }
  }
  const query = useCallback(() => service.readAssetPage(bookId, kind, { query: queryText, role, offset, limit: 100, selectedIds: mergeIds }), [service, bookId, kind, queryText, role, offset, mergeIds])
  const chapterQuery = useCallback(() => repository.listChapters(bookId), [repository, bookId])
  const data = useLiveResult(query, attempt, bookInterests(bookId, [assetTables[kind], 'chapters']))
  const countsQuery = useCallback(() => service.assetCounts(bookId), [service, bookId])
  const counts = useLiveResult(countsQuery, attempt, [...bookInterests(bookId, Object.values(assetTables)), { scope: `book:${bookId}`, tables: ['pipelineRuns'], category: 'merge' }])
  if (data.status === 'ready' && lastPage?.value !== data.value) setLastPage({ bookId, kind, value: data.value })
  const page = data.status === 'ready' ? data.value : lastPage?.bookId === bookId && lastPage.kind === kind ? lastPage.value : undefined
  const locksQuery = useCallback(() => service.readLocks(bookId), [service, bookId])
  const locks = useLiveResult(locksQuery, attempt, bookInterests(bookId, ['pipelineRuns'], 'lease'))
  const chapters = useLiveResult(chapterQuery, attempt, bookInterests(bookId, ['chapters']))
  const navigate = useCallback((action: () => void) => { if (editorRef.current?.isDirty()) setPendingLeave({ action }); else action() }, [])
  useEffect(() => { setLeaveGuard(navigate); return () => setLeaveGuard(undefined) }, [navigate])
  async function leaveWithSave() {
    if (!pendingLeave) return
    const ok = await editorRef.current?.save()
    if (!ok) { setPendingLeave(undefined); return }
    const action = pendingLeave.action
    setPendingLeave(undefined); action()
  }
  function leaveWithDiscard() {
    if (!pendingLeave) return
    editorRef.current?.discard()
    const action = pendingLeave.action
    setPendingLeave(undefined); action()
  }
  const panelRef = useRef<HTMLElement>(null)
  const [outlineOpen, setOutlineOpen] = useState(false)
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
  if ((!page && data.status === 'error') || chapters.status === 'error') return <div role="alert" className="error-panel"><p>{data.status === 'error' ? data.message : chapters.status === 'error' ? chapters.message : ''}</p><button className="secondary-button" onClick={() => setAttempt(value => value + 1)}>重新读取资产</button></div>
  if (!page || chapters.status !== 'ready') return <p role="status" className="muted">正在读取资产…</p>
  const rows = page.items, visible = rows
  const normalized = queryText.trim().toLowerCase()
  const locked = (locks.status === 'ready' ? locks.value : { world: true, narrative: true })[kind === 'character' || kind === 'location' ? 'world' : 'narrative']
  const worldKind = kind === 'character' || kind === 'location' ? kind : undefined
  const eventNetworkVisible = networkView && (kind === 'node' || kind === 'eventLine')
  const characterNetworkVisible = kind === 'character' && characterView === 'network'
  const hidden = mergeIds.filter(id => !visible.some(row => row.id === id)).length
  const missingIds = page.missingIds
  const editorVisible = !!selection || kind === 'character'

  return <section ref={panelRef} className={`assets-panel${editorVisible ? ' has-editor' : ''}${eventNetworkVisible ? ' has-network' : ''}`} aria-label="资产管理">
    <div className="asset-tabs" aria-label="资产类型">{(Object.keys(assetLabels) as AssetKind[]).map(tab => <button key={tab} aria-pressed={kind === tab} onClick={() => navigate(() => { onKindChange(tab); setSelection(undefined); setQueryText(''); setRole(''); setOffset(0); setMergeMode(false); setMergeIds([]); setPreviewOpen(false); setMergeMessage('') })}>{assetLabels[tab]} <span>{counts.status === 'ready' ? counts.value[tab] : '…'}</span></button>)}</div>
    <div className="asset-toolbar"><input hidden={characterNetworkVisible} aria-label="搜索资产" placeholder={kind === 'character' ? '搜索姓名或别名' : '搜索名称、别名、内容或编号'} value={queryText} onChange={event => { setQueryText(event.target.value); setOffset(0) }} />{kind === 'character' && <select aria-label="筛选人物层级" value={role} onChange={event => { setRole(event.target.value); setOffset(0) }}><option value="">全部层级</option>{roleWeights.map(value => <option key={value}>{value}</option>)}</select>}{kind === 'character' && onAutoTier && <button className="secondary-button" disabled={locked || organizeDisabled || tiering} onClick={() => navigate(() => { void autoTier() })}>{tiering ? '正在分层…' : '人物自动分层'}</button>}<button className="primary-button" disabled={locked} onClick={() => navigate(() => setSelection('new'))}>新增{assetLabels[kind]}</button>{kind === 'character' ? <div className="asset-view-switch" aria-label="展示方式"><button className="secondary-button" aria-pressed={characterView === 'list'} onClick={() => setCharacterView('list')}>人物列表</button><button className="secondary-button" aria-pressed={characterView === 'network'} onClick={() => setCharacterView('network')}>人物网络</button></div> : !worldKind && <div className="asset-view-switch" aria-label="展示方式"><button className="secondary-button" aria-pressed={!eventNetworkVisible} onClick={() => setNetworkView(false)}>列表</button><button className="secondary-button" aria-pressed={eventNetworkVisible} onClick={() => { setNetworkOpened(true); setNetworkView(true) }}>事件网络</button></div>}</div>
    {kind === 'character' && tierMessage && <p className="merge-success" role="status">{tierMessage}</p>}
    {kind === 'character' && tierError && <p className="field-error" role="alert">{tierError}</p>}
    <div className="merge-toolbar">
      {worldKind && !mergeMode && characterView !== 'network' && <button className="secondary-button" disabled={locked} onClick={() => navigate(() => { setMergeMode(true); setMergeIds([]); setSelection(undefined); setMergeMessage('') })}>手动合并</button>}
      {mergeMode && <><span>已选 {mergeIds.length} 项{hidden ? `（含隐藏 ${hidden} 项）` : ''}</span><button className="primary-button" disabled={locked || mergeIds.length < 2} onClick={() => setPreviewOpen(true)}>确定合并</button><button className="secondary-button" onClick={() => { setMergeMode(false); setMergeIds([]); setPreviewOpen(false) }}>退出合并</button>{missingIds.length > 0 && <button className="text-button" onClick={() => setMergeIds(ids => ids.filter(id => !missingIds.includes(id)))}>清除失效选择（{missingIds.length}）</button>}</>}
      {counts.status === 'ready' && counts.value.manualMerges > 0 && <button className="text-button" onClick={() => setHistoryOpen(true)}>合并记录（{counts.status === 'ready' ? counts.value.manualMerges : 0}）</button>}
      <LegacyRelationReport bookId={bookId} service={service} />
    </div>
    {mergeMessage && <p className="merge-success" role="status">{mergeMessage}</p>}
    {locked && <p className="asset-warning" role="status">这类资产正在处理，任务结束后可新增或修改。</p>}
    {organizeDisabled && organizeDisabledReason && <p className="asset-warning" role="status">{organizeDisabledReason}，AI 整理按钮暂不可用。</p>}
    <div className={`assets-layout-grid${editorVisible ? ' has-editor' : ''}${characterNetworkVisible ? ' character-network-grid' : kind === 'character' ? ' character-list-grid' : ''}`}>
      {characterNetworkVisible
        ? <AssetNetwork key={`${bookId}:${kind}`} bookId={bookId} service={service} kind={kind} chapters={chapters.value} selectedId={selection && selection !== 'new' ? selection.id : undefined} onNavigate={navigate} onSelect={id => setSelection({ id })} onClear={() => setSelection(undefined)} />
        : <div className="asset-results">{networkOpened && <AssetNetwork key={bookId} bookId={bookId} service={service} kind={kind === 'eventLine' ? 'eventLine' : 'node'} active={eventNetworkVisible} chapters={chapters.value} selectedId={kind === 'node' && selection && selection !== 'new' ? selection.id : undefined} onNavigate={navigate} onSelect={id => setSelection({ id })} onClear={() => setSelection(undefined)} />}<div hidden={eventNetworkVisible} className="asset-list-view">
          {kind === 'eventLine' && <details open={outlineOpen} onToggle={event => setOutlineOpen(event.currentTarget.open)}><summary>剧情大纲</summary>{outlineOpen && <OutlineView key={bookId} bookId={bookId} service={service} onNode={id => navigate(() => { onKindChange('node'); setSelection({ id }); setQueryText(''); setOffset(0) })} />}</details>}
          <p className="result-count">显示 {visible.length} / {page.total} 条 · {normalized ? '按相关度排列' : kind === 'character' ? '按层级与姓名排列' : '按名称排列'}{data.status === 'loading' ? ' · 正在查询…' : ''}</p>
          {data.status === 'error' && <p role="alert">{data.message}<button onClick={() => setAttempt(value => value + 1)}>重试</button></p>}
          {visible.length === 0 ? <p className="asset-empty">{page.total ? '没有匹配的资产，请调整搜索或筛选。' : `还没有${assetLabels[kind]}，可以点击上方按钮新增。`}</p> : <ul className="asset-list">{visible.map(row => <li key={row.id}>{mergeMode ? <label className="merge-selection"><input type="checkbox" aria-label={`选择合并 ${row.label} ${row.id}`} checked={mergeIds.includes(row.id)} onChange={event => setMergeIds(ids => event.target.checked ? [...ids, row.id] : ids.filter(id => id !== row.id))} /><span><strong>{row.label}</strong><small>{row.id} · {row.chapterName || '人工来源'}</small></span></label> : <button className={selection && selection !== 'new' && selection.id === row.id ? 'selected' : ''} aria-label={`编辑 ${row.label}`} onClick={() => navigate(() => setSelection({ id: row.id }))}><strong>{row.label}</strong><span>{row.preview}</span><small>{row.createdBy === 'manual' ? '人工' : '提取'} · {row.chapterName || (kind === 'eventLine' ? '事件线' : '无章节来源')} · 修订 {row.revision}</small><code>{row.id}</code></button>}</li>)}</ul>}
          {page.matched > page.limit && <div className="story-history-pages" aria-label="资产列表分页"><button className="text-button" disabled={!page.offset || data.status === 'loading'} onClick={() => setOffset(Math.max(0, page.offset - page.limit))}>上一页资产</button><span>第 {Math.floor(page.offset / page.limit) + 1} / {Math.ceil(page.matched / page.limit)} 页 · 匹配 {page.matched} 条</span><button className="text-button" disabled={page.offset + page.limit >= page.matched || data.status === 'loading'} onClick={() => setOffset(page.offset + page.limit)}>下一页资产</button></div>}
        </div></div>}
      {selection
        ? <AssetDetails ref={editorRef} key={`details:${bookId}:${kind}`} kind={kind} selectedId={selection === 'new' ? undefined : selection.id} confirmed={selection === 'new' ? undefined : selection.saved} creating={selection === 'new'} locks={locks.status === 'ready' ? locks.value : { world: true, narrative: true }} chapters={chapters.value} service={service} repository={repository} bookId={bookId} onClose={() => navigate(() => setSelection(undefined))} onSaved={row => setSelection({ id: row.id, saved: row })} onSelect={id => navigate(() => setSelection({ id }))} onOrganizeDisabled={organizeDisabled} onOrganizeProfile={onOrganizeCharacter ? id => onOrganizeCharacter(id, 'profile') : undefined} onOrganizeRelations={onOrganizeCharacter ? id => onOrganizeCharacter(id, 'relations') : undefined} canContinue={selection !== 'new' && selection.id === resumeCharacterId} onContinueOrganization={onContinueCharacter} />
        : kind === 'character' ? <div className="asset-editor editor-placeholder" role="status">请选择人物查看或编辑</div> : null}
    </div>
    {previewOpen && worldKind && <MergeDialog bookId={bookId} kind={worldKind} memberIds={mergeIds} service={service} locked={locked} onClose={() => setPreviewOpen(false)} onMerged={(asset, reportId, reduced) => { setPreviewOpen(false); setMergeMode(false); setMergeIds([]); setQueryText(''); setRole(''); setOffset(0); setSelection({ id: asset.id, saved: asset }); setLastReport(reportId); setMergeMessage(`合并完成，保留“${assetName(asset)}”，减少 ${reduced} 条。`) }} />}
    {historyOpen && <AssetMergeHistory bookId={bookId} service={service} initialId={lastReport} onClose={() => setHistoryOpen(false)} />}
    {pendingLeave && <div className="leave-dialog-backdrop"><section role="alertdialog" aria-modal="true" aria-label={`未保存的${assetLabels[kind]}修改`} className="leave-dialog">
      <h4>有未保存的{assetLabels[kind]}修改</h4>
      <p>切换后会丢失当前输入。可以先保存并继续，或放弃这次修改。</p>
      <div className="editor-actions"><button type="button" className="primary-button" onClick={() => void leaveWithSave()}>保存并继续</button><button type="button" className="secondary-button" onClick={leaveWithDiscard}>放弃并继续</button><button type="button" className="secondary-button" onClick={() => setPendingLeave(undefined)}>取消</button></div>
    </section></div>}
  </section>
}
