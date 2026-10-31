import { useEffect, useRef, useState } from 'react'
import type { AssetService } from './service'
import type { AssetByKind } from './types'
import { fuseWorldAssets, uniqueStrings, type MergePreview, type MergeRequest, type WorldKind } from './merge'

export function MergeDialog({ bookId, kind, memberIds, service, locked, onClose, onMerged, onPrepared, initialRequest }: {
  bookId: string; kind: WorldKind; memberIds: string[]; service: AssetService; locked: boolean
  onClose: () => void; onMerged: (asset: AssetByKind[WorldKind], reportId: string, reduced: number) => void
  onPrepared?: (request: MergeRequest) => void; initialRequest?: MergeRequest
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [preview, setPreview] = useState<MergePreview>()
  const [keepId, setKeepId] = useState(initialRequest?.keepId ?? memberIds[0])
  const [chosenName, setChosenName] = useState(initialRequest?.canonicalName ?? '')
  const [customName, setCustomName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const submitting = useRef(false)
  const name = customName.trim() || chosenName
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close() }, [])
  useEffect(() => {
    let active = true
    service.read(bookId).then(snapshot => {
      const rows = kind === 'character' ? snapshot.characters : snapshot.locations
      const first = rows.find(row => row.id === memberIds[0])
      if (!first) throw new Error('所选条目已删除，请返回调整选择。')
      return service.previewMerge(bookId, kind, { memberIds, keepId: memberIds[0], canonicalName: first.name })
    }).then(value => {
      if (!active) return
      setPreview(value)
      if (!initialRequest && value.members.every(row => row.name === value.members[0].name)) setChosenName(value.members[0].name)
      if (initialRequest && !value.members.some(row => [row.name, ...(row.aliases ?? [])].includes(initialRequest.canonicalName))) { setChosenName(''); setCustomName(initialRequest.canonicalName) }
    }).catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : '读取合并预览失败。') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [bookId, kind, memberIds, service, initialRequest])

  const names = preview ? uniqueStrings(preview.members.flatMap(row => [row.name, ...(row.aliases ?? [])])) : []
  const proposed = preview ? fuseWorldAssets(kind, preview.members, keepId, name || preview.members.find(row => row.id === keepId)!.name) : undefined
  async function refresh() {
    if (busy || loading) return
    setLoading(true); setError('')
    try { setPreview(await service.previewMerge(bookId, kind, { memberIds, keepId, canonicalName: name || preview?.members.find(row => row.id === keepId)?.name || '预览' })) }
    catch (failure) { setError(failure instanceof Error ? failure.message : '刷新预览失败。') }
    finally { setLoading(false) }
  }
  async function confirm() {
    if (!preview || !name || busy || loading || locked || submitting.current) return
    submitting.current = true; setBusy(true); setError('')
    try {
      const result = await service.confirmMerge(bookId, kind, { ...preview.request, keepId, canonicalName: name })
      onMerged(result.asset, result.run.id, memberIds.length - 1)
    } catch (failure) { setError(failure instanceof Error ? failure.message : '合并失败，请重试。') }
    finally { submitting.current = false; setBusy(false) }
  }

  return <dialog ref={dialog} className="merge-dialog" aria-labelledby="merge-title" onCancel={event => event.preventDefault()}>
    <header className="merge-dialog-heading"><h2 id="merge-title">{kind === 'character' ? '人物' : '地点'}合并预览</h2><button className="text-button" disabled={busy} onClick={onClose}>取消预览</button></header>
    <div className="merge-dialog-body">
      {loading && <p role="status">正在读取合并资料…</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
      {locked && <p className="asset-warning">世界资产正在处理，释放后可确认合并。</p>}
      {preview && proposed && <>
        <p className="field-help">共选择 {preview.members.length} 条，合并后保留 1 条。其他条目的资料、别名与来源会合入保留条目。</p>
        <ul className="merge-member-list">{preview.members.map(row => <li key={row.id}><strong>{row.name}</strong><span>{row.id} · 修订 {row.revision}</span><small>来源：{row.sourceChapters?.join('、') || row.manualSourceNote || '人工资料'}</small></li>)}</ul>
        <div className="asset-field"><label htmlFor="merge-keep">保留条目</label><select id="merge-keep" value={keepId} disabled={busy || loading} onChange={event => setKeepId(event.target.value)}>{preview.members.map(row => <option key={row.id} value={row.id}>{row.name} · {row.id}</option>)}</select><small>保留该条目的编号。主名在下方单独选择。</small></div>
        <div className="asset-field"><label htmlFor="merge-name">合并后主名</label><select id="merge-name" value={chosenName} disabled={busy || loading} onChange={event => { setChosenName(event.target.value); setCustomName('') }}><option value="">请选择主名或别名</option>{names.map(value => <option key={value}>{value}</option>)}</select></div>
        <div className="asset-field"><label htmlFor="merge-custom-name">自定义主名</label><input id="merge-custom-name" value={customName} disabled={busy || loading} placeholder="也可以填写新的主名" onChange={event => { setCustomName(event.target.value); setChosenName('') }} /></div>
        {!name && <p className="field-help">所选条目的名称不同，请明确选择合并后的主名。</p>}
        <section className="merge-result" aria-label="融合结果"><h3>{name || '待选择主名'}</h3><p>别名：{proposed.result.aliases?.join('、') || '无'}</p><p>来源章节：{proposed.result.sourceChapters?.join('、') || '人工资料'}</p><p>来源说明：{proposed.result.manualSourceNote || '无'}</p>
          {kind === 'character' ? <>{(['identity', 'appearance', 'personality', 'background', 'speechStyleSample'] as const).map((field, i) => <p key={field}><strong>{['身份', '外貌', '性格', '背景', '原话片段'][i]}：</strong>{(proposed.result as AssetByKind['character'])[field] || '无'}</p>)}<p>年龄描述：{(proposed.result as AssetByKind['character']).profile?.ageText || '无'}</p></> : <p><strong>地点描述：</strong>{(proposed.result as AssetByKind['location']).description || '无'}</p>}
          {proposed.conflicts.map((conflict, index) => <p className="field-error" key={index}>{conflict}</p>)}
          <details><summary>事实底稿（{proposed.result.mergeFacts?.length ?? 0}条）</summary>{proposed.result.mergeFacts?.map(fact => <p key={fact.id}>{fact.text}（来源：{fact.chapters.join('、') || '人工'}）</p>)}</details>
        </section>
        <p className="field-help">合并无法直接撤销，请核对保留条目和主名。人物合并会同步替换事件节点中的人物关联。</p>
      </>}
    </div>
    <footer className="merge-dialog-actions"><button className="secondary-button" disabled={busy || loading} onClick={() => void refresh()}>刷新预览</button>{onPrepared ? <button className="primary-button" disabled={!preview || !name || loading || locked} onClick={() => { if (preview) onPrepared({ ...preview.request, keepId, canonicalName: name }) }}>完成预览</button> : <button className="primary-button" disabled={!preview || !name || busy || loading || locked} onClick={() => void confirm()}>{busy ? '正在合并…' : '确认机械合并'}</button>}</footer>
  </dialog>
}
