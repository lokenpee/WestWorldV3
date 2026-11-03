import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { AssetService, RelationPairInput } from './service'
import { searchCharacters } from './search'
import { pairFromPerspective } from './relations'
import type { AssetSnapshot, Character, CharacterPairResult, RelationEvidence } from './types'

interface LabelEditorProps { labels: string[]; onChange: (labels: string[]) => void; placeholder: string }
function LabelEditor({ labels, onChange, placeholder }: LabelEditorProps) {
  return <div className="relation-labels">{labels.map((label, index) => <div key={index} className="relation-label-row"><input aria-label={`${placeholder} ${index + 1}`} value={label} maxLength={100} onChange={event => onChange(labels.map((value, at) => at === index ? event.target.value : value))} /><button type="button" className="text-button" onClick={() => onChange(labels.filter((_, at) => at !== index))}>移除</button></div>)}<button type="button" className="secondary-button" disabled={labels.length >= 20} onClick={() => onChange([...labels, ''])}>增加标签</button></div>
}

export interface RelationEditorHandle { isDirty: () => boolean; save: () => Promise<boolean>; discard: () => void }
export const RelationEditor = forwardRef<RelationEditorHandle, {
  bookId: string; character: Character; snapshot: AssetSnapshot; service: AssetService; locked: boolean; onDirtyChange: (dirty: boolean) => void
}>(function RelationEditor({ bookId, character, snapshot, service, locked, onDirtyChange }, ref) {
  const [page, setPage] = useState(1)
  const [dialog, setDialog] = useState<{ otherId?: string; forward: string[]; reverse: string[]; unclear: boolean; evidence: RelationEvidence[]; fingerprint?: string; state?: CharacterPairResult['state']; loading?: boolean; error?: string }>()
  const [query, setQuery] = useState('')
  const [candidatePage, setCandidatePage] = useState(1)
  const [initialDialog, setInitialDialog] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const generation = useRef(0)
  const [deletePair, setDeletePair] = useState<CharacterPairResult>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const pageSize = 50
  const people = useMemo(() => new Map(snapshot.characters.map(row => [row.id, row])), [snapshot.characters])
  const pairStates = useMemo(() => new Map(snapshot.pairs.map(pair => [pair.pairKey, pair.state])), [snapshot.pairs])
  const dialogContent = dialog?.otherId && !dialog.loading ? JSON.stringify([dialog.otherId, dialog.forward, dialog.reverse, dialog.unclear, dialog.evidence]) : ''
  const dirty = !!dialogContent && !!initialDialog && dialogContent !== initialDialog
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])
  function discard() { generation.current++; setDialog(undefined); setInitialDialog(''); setConfirmDiscard(false) }
  function close() { if (dirty) setConfirmDiscard(true); else discard() }
  useImperativeHandle(ref, () => ({ isDirty: () => dirty, save, discard }))
  const pairs = useMemo(() => snapshot.pairs.filter(pair => pair.state === 'active' && (pair.fromId === character.id || pair.toId === character.id))
    .map(pair => pairFromPerspective([pair], character.id, pair.fromId === character.id ? pair.toId : pair.fromId))
    .sort((a, b) => (people.get(a.toId)?.name ?? '').localeCompare(people.get(b.toId)?.name ?? '', 'zh-CN-u-co-pinyin') || a.toId.localeCompare(b.toId)), [snapshot.pairs, people, character.id])
  const visible = pairs.slice(0, page * pageSize)
  const other = (id: string) => people.get(id)
  const stateOf = (id: string) => pairStates.get(pairFromPerspective([], character.id, id).pairKey) ?? 'absent'
  const results = useMemo(() => {
    const base = snapshot.characters.filter(row => row.id !== character.id)
    return searchCharacters(base, query)
  }, [snapshot.characters, character.id, query])

  async function begin(otherId?: string) {
    const request = ++generation.current
    setInitialDialog('')
    if (!otherId) { setDialog({ forward: [''], reverse: [''], unclear: false, evidence: [] }); setQuery(''); setCandidatePage(1); return }
    setDialog({ otherId, forward: [], reverse: [], unclear: false, evidence: [], loading: true })
    try {
      const pair = await service.getRelationPair(bookId, character.id, otherId)
      if (request !== generation.current) return
      const next = { otherId, forward: pair.forwardLabels.length ? pair.forwardLabels : [''], reverse: pair.reverseLabels.length ? pair.reverseLabels : [''], unclear: pair.directionUnclear, evidence: pair.evidence, fingerprint: pair.fingerprint, state: pair.state }
      setDialog(next)
      setInitialDialog(JSON.stringify([next.otherId, next.forward, next.reverse, next.unclear, next.evidence]))
    } catch (error) {
      if (request === generation.current) setDialog({ otherId, forward: [''], reverse: [''], unclear: false, evidence: [], error: error instanceof Error ? error.message : '读取关系失败。' })
    }
  }

  async function save(): Promise<boolean> {
    if (busy || !dialog?.otherId || !dialog.fingerprint) return false
    const forward = dialog.forward.map(label => label.trim()).filter(Boolean)
    const reverse = dialog.reverse.map(label => label.trim()).filter(Boolean)
    if (!forward.length && !reverse.length) { setDialog({ ...dialog, error: '有效关系至少一个方向要有标签；删除整组请使用删除按钮。' }); return false }
    setBusy(true)
    try {
      const input: RelationPairInput = { fromId: character.id, toId: dialog.otherId, forwardLabels: forward, reverseLabels: reverse, directionUnclear: dialog.unclear, evidence: dialog.evidence, reason: '人工保存人物对关系', expectedFingerprint: dialog.fingerprint, operationKey: crypto.randomUUID() }
      await service.saveRelationPair(bookId, input)
      setMessage('关系已保存。'); discard(); return true
    } catch (error) {
      setDialog({ ...dialog, error: error instanceof Error ? error.message : '保存失败，请重试。' })
      return false
    } finally { setBusy(false) }
  }

  async function remove(pair: CharacterPairResult) {
    setBusy(true)
    try {
      await service.deleteRelationPair(bookId, { fromId: character.id, toId: pair.toId, forwardLabels: [], reverseLabels: [], reason: '人工删除人物对关系', expectedFingerprint: pair.fingerprint, operationKey: crypto.randomUUID() })
      setMessage('关系已删除。'); setDeletePair(undefined)
    } catch (error) { setMessage(error instanceof Error ? error.message : '删除失败，请重试。') }
    finally { setBusy(false) }
  }

  return <section className="relation-manager" aria-label="人物关系">
    <div className="relation-manager-head"><h4>人物关系</h4><button type="button" className="secondary-button" disabled={locked || busy} onClick={() => void begin()}>添加关系</button></div>
    {message && <p role="status" className="field-help">{message}</p>}
    {!pairs.length && <p className="field-help">暂无当前关系。</p>}
    <ul className="relation-pair-list">
      {visible.map(pair => {
        const person = other(pair.toId)
        return <li key={pair.pairKey} className="relation-pair">
          <div className="relation-pair-title"><strong>{person?.name ?? pair.toId}</strong><small>{person?.identity ? `${person.identity} · ` : ''}{pair.toId}</small></div>
          <div className="relation-pair-labels"><span>→ 对方：{pair.forwardLabels.join('、') || '（空）'}</span><span>← 对方：{pair.reverseLabels.join('、') || '（空）'}</span>{pair.directionUnclear && <span>方向未明确</span>}</div>
          <div className="relation-pair-actions"><button type="button" className="text-button" disabled={locked || busy} onClick={() => void begin(pair.toId)}>编辑</button><button type="button" className="text-button" disabled={locked || busy} onClick={() => setDeletePair(pair)}>删除</button></div>
        </li>
      })}
    </ul>
    {visible.length < pairs.length && <button type="button" className="text-button" onClick={() => setPage(value => value + 1)}>加载更多（共 {pairs.length} 组）</button>}
    {(() => {
      const names = new Set([character.name, ...(character.aliases ?? [])])
      const unresolved = snapshot.unresolvedRelations.filter(item => names.has(item.sourceName) || item.targetName === character.name)
      return unresolved.length ? <div className="relation-unresolved"><h5>待关联的原始关系</h5>{unresolved.map(item => <p key={item.relationId}>{item.sourceName} → {item.targetName}：{item.forwardLabel}（{item.reason === 'source_missing' ? '来源已失效' : item.reason === 'self' ? '两端合为同一人物' : '目标尚未入库'}）</p>)}</div> : null
    })()}

    {dialog && <div className="relation-dialog-backdrop"><section role="dialog" aria-modal="true" aria-label="编辑人物关系" className="relation-dialog">
      <h4>{dialog.otherId ? '编辑人物关系' : '添加人物关系'}</h4>
      {!dialog.otherId && <>
        <label htmlFor="relation-search">关系对象</label>
        <input id="relation-search" aria-label="搜索关系对象" placeholder="姓名或别名" value={query} onChange={event => { setQuery(event.target.value); setCandidatePage(1) }} />
        <ul className="relation-candidates">{results.slice(0, candidatePage * pageSize).map(row => {
          const state = stateOf(row.id)
          const connected = state === 'active'
          return <li key={row.id}><button type="button" disabled={connected} onClick={() => void begin(row.id)}><strong>{row.name}</strong><small>{row.identity ? `${row.identity} · ` : ''}{row.id}</small>{connected && <em>已建立关系</em>}</button></li>
        })}</ul>
        {results.length > candidatePage * pageSize && <button type="button" className="text-button" onClick={() => setCandidatePage(value => value + 1)}>更多关系对象（共 {results.length} 人）</button>}
        {!results.length && <p className="field-help">没有匹配的人物。</p>}
      </>}
      {dialog.otherId && <>
        <p className="relation-dialog-pair">对象：<strong>{other(dialog.otherId)?.name ?? dialog.otherId}</strong>（{dialog.otherId}）{dialog.state === 'deleted' ? ' · 已删除，可恢复' : ''}{dialog.state === 'absent' ? ' · 尚未建立' : ''}</p>
        <fieldset disabled={busy || dialog.loading}><legend>本人物对对方的说法</legend><LabelEditor labels={dialog.forward} placeholder="正向标签" onChange={forward => setDialog({ ...dialog, forward })} /></fieldset>
        <fieldset disabled={busy || dialog.loading}><legend>对方对本人物的说法</legend><LabelEditor labels={dialog.reverse} placeholder="反向标签" onChange={reverse => setDialog({ ...dialog, reverse })} /></fieldset>
        <label className="relation-check"><input type="checkbox" checked={dialog.unclear} onChange={event => setDialog({ ...dialog, unclear: event.target.checked })} />方向未明确（保留原描述，不猜测反向）</label>
        <details className="relation-evidence"><summary>补填本次依据（可选）</summary>
          {dialog.evidence.map((item, index) => <div key={index} className="relation-evidence-row"><input aria-label="依据章节" placeholder="章节" value={item.chapterIndex} onChange={event => setDialog({ ...dialog, evidence: dialog.evidence.map((row, at) => at === index ? { ...row, chapterIndex: event.target.value } : row) })} /><textarea aria-label="依据原文" placeholder="逐字原文" rows={2} value={item.quote} onChange={event => setDialog({ ...dialog, evidence: dialog.evidence.map((row, at) => at === index ? { ...row, quote: event.target.value } : row) })} /><button type="button" className="text-button" onClick={() => setDialog({ ...dialog, evidence: dialog.evidence.filter((_, at) => at !== index) })}>移除</button></div>)}
          <button type="button" className="text-button" onClick={() => setDialog({ ...dialog, evidence: [...dialog.evidence, { chapterIndex: '', quote: '' }] })}>增加依据</button>
        </details>
        {dialog.error && <p className="field-error" role="alert">{dialog.error}</p>}
        <div className="editor-actions"><button type="button" className="primary-button" disabled={busy || dialog.loading} onClick={() => void save()}>{busy ? '正在保存…' : '保存关系'}</button><button type="button" className="secondary-button" disabled={busy} onClick={close}>取消</button></div>
      </>}
      {!dialog.otherId && dialog.error && <p className="field-error" role="alert">{dialog.error}</p>}
      {!dialog.otherId && <div className="editor-actions"><button type="button" className="secondary-button" onClick={close}>关闭</button></div>}
    </section></div>}

    {confirmDiscard && <div className="relation-dialog-backdrop"><section role="alertdialog" aria-modal="true" aria-label="放弃关系修改" className="relation-dialog"><h4>放弃未保存的关系修改？</h4><div className="editor-actions"><button type="button" className="danger-button" onClick={discard}>放弃修改</button><button type="button" className="secondary-button" onClick={() => setConfirmDiscard(false)}>继续编辑</button></div></section></div>}

    {deletePair && <div className="relation-dialog-backdrop"><section role="alertdialog" aria-modal="true" aria-label="删除人物关系" className="relation-dialog">
      <h4>删除整组关系？</h4>
      <p>{character.name}（{character.id}）与 {other(deletePair.toId)?.name ?? deletePair.toId}（{deletePair.toId}）之间的两个方向都会删除。原始提取依据仍保留可追溯。</p>
      <div className="editor-actions"><button type="button" className="danger-button" disabled={busy} onClick={() => void remove(deletePair)}>{busy ? '正在删除…' : '确认删除'}</button><button type="button" className="secondary-button" disabled={busy} onClick={() => setDeletePair(undefined)}>取消</button></div>
    </section></div>}
  </section>
})
