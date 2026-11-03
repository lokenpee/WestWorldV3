import { useEffect, useRef, useState } from 'react'
import type { BookRepository, Chapter } from '../../lib/storage/workspace'
import { ChapterTextDialog } from '../books/ChapterTextDialog'
import type { AssetService } from './service'
import { AssetError, assetLabels, assetName, roleWeights, type Asset, type AssetInput, type AssetKind, type AssetSnapshot, type Character } from './types'
import { formInput, formValues, labels, memberIds, type FormValues } from './form'
import { paginateEdges } from './relations'
import { NodeCharacters } from './NodeCharacters'

function DeleteDialog({ name, busy, onConfirm, onClose }: { name: string; busy: boolean; onConfirm: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close() }, [])
  return <dialog ref={ref} className="delete-asset-dialog" onCancel={event => event.preventDefault()} aria-labelledby="delete-title"><h2 id="delete-title">删除 {name}？</h2><p>删除后会同步清理事件线关联。提取来源记录会保留。</p><div className="editor-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="danger-button" disabled={busy} onClick={onConfirm}>{busy ? '正在删除…' : '确认删除'}</button></div></dialog>
}

export function AssetEditor({ kind, asset, creating, snapshot, chapters, service, repository, bookId, onClose, onSaved, onSelect }: {
  kind: AssetKind; asset?: Asset; creating: boolean; snapshot: AssetSnapshot; chapters: Chapter[]; service: AssetService; repository: BookRepository; bookId: string
  onClose: () => void; onSaved: (row: Asset) => void; onSelect: (id: string) => void
}) {
  const [baseline, setBaseline] = useState(asset)
  const [initialValues, setInitialValues] = useState(() => formValues(asset, snapshot.characters))
  const [values, setValues] = useState(initialValues)
  const [fieldError, setFieldError] = useState<{ field?: keyof AssetInput; message: string }>()
  const [busy, setBusy] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Asset>()
  const [reader, setReader] = useState<{ title: string; text: string }>()
  const [savedMessage, setSavedMessage] = useState('')
  const [expandedFields, setExpandedFields] = useState<Partial<Record<keyof FormValues, boolean>>>({})
  const [relationLimit, setRelationLimit] = useState(100)
  const editorRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (kind !== 'character') return
    const showEditor = () => {
      const editor = editorRef.current
      const workspace = editor?.closest<HTMLElement>('.workspace-content')
      if (!editor || !workspace) return
      const pageScroll = getComputedStyle(workspace).overflowY === 'visible'
      const workspaceTop = pageScroll ? 0 : workspace.getBoundingClientRect().top
      editor.style.setProperty('--character-editor-height', `${Math.max(0, window.innerHeight - workspaceTop - 24)}px`)
      if (pageScroll) window.scrollBy({ top: editor.getBoundingClientRect().top - 12 })
      else workspace.scrollBy({ top: editor.getBoundingClientRect().top - workspaceTop - 12 })
    }
    showEditor()
    window.addEventListener('resize', showEditor)
    return () => window.removeEventListener('resize', showEditor)
  }, [kind])
  const submitting = useRef(false)
  const dirty = JSON.stringify(values) !== JSON.stringify(initialValues)
  const loadValues = (row?: Asset) => { const next = formValues(row, snapshot.characters); setBaseline(row); setInitialValues(next); setValues(next) }
  if (asset && baseline && asset.revision > baseline.revision && !dirty) loadValues(asset)
  const conflict = !!asset && !!baseline && asset.revision > baseline.revision && dirty
  const missing = !creating && !asset
  const mapping = baseline ? snapshot.lifecycle.find(row => row.key === `${kind}:${baseline.id}`) : undefined
  const locked = snapshot.locks[kind === 'character' || kind === 'location' ? 'world' : 'narrative']
  const disabled = busy || locked || missing

  const update = (key: keyof FormValues, value: string) => { setValues(current => ({ ...current, [key]: value, ...(key === 'actors' ? { actorIds: '' } : key === 'targets' ? { targetCharacterIds: '' } : {}) })); setFieldError(undefined); setSavedMessage('') }
  const error = (failure: unknown) => { setFieldError({ field: failure instanceof AssetError ? failure.field : undefined, message: failure instanceof Error ? failure.message : '操作失败，请重试。' }) }

  async function save() {
    if (disabled || conflict || submitting.current) return
    submitting.current = true; setBusy(true); setFieldError(undefined)
    try {
      const input = formInput(kind, values, creating)
      const saved = creating ? await service.create(bookId, kind, input) : await service.update(bookId, kind, baseline!.id, baseline!.revision, input)
      loadValues(saved); setSavedMessage('已保存'); onSaved(saved)
    } catch (failure) { error(failure) }
    finally { setBusy(false); submitting.current = false }
  }

  async function immediate(key: 'roleWeight' | 'lineStatus', value: string) {
    if (creating) { update(key, value); return }
    if (disabled || conflict || submitting.current || !baseline) return
    submitting.current = true; setBusy(true); setFieldError(undefined)
    try {
      const saved = await service.update(bookId, kind, baseline.id, baseline.revision, { [key]: value } as AssetInput)
      setBaseline(saved); setInitialValues(formValues(saved, snapshot.characters)); setValues(previous => ({ ...previous, [key]: value })); setSavedMessage('已保存'); onSaved(saved)
    } catch (failure) { error(failure) }
    finally { setBusy(false); submitting.current = false }
  }

  async function remove() {
    if (disabled || submitting.current || !deleteTarget) return
    submitting.current = true; setBusy(true); setFieldError(undefined)
    try { await service.remove(bookId, kind, deleteTarget.id, deleteTarget.revision); onClose() }
    catch (failure) { error(failure); setDeleteTarget(undefined) }
    finally { setBusy(false); submitting.current = false }
  }

  function field(key: keyof FormValues, multiline = false) {
    const compact = kind === 'character' && multiline
    const expanded = !!expandedFields[key]
    const rows = compact ? expanded ? 8 : values[key].includes('\n') || values[key].length > 30 ? 2 : 1 : key === 'quote' ? 4 : 3
    return <div className="asset-field" key={key}>{compact ? <div className="asset-field-label"><label htmlFor={`asset-${key}`}>{labels[key]}</label><button className="text-button" type="button" aria-expanded={expanded} aria-controls={`asset-${key}`} aria-label={`${expanded ? '收起' : '展开'}${labels[key]}`} onClick={() => setExpandedFields(current => ({ ...current, [key]: !expanded }))}>{expanded ? '收起' : '展开'}</button></div> : <label htmlFor={`asset-${key}`}>{labels[key]}</label>}{multiline ? <textarea id={`asset-${key}`} value={values[key]} rows={rows} disabled={disabled} onChange={event => update(key, event.target.value)} /> : <input id={`asset-${key}`} value={values[key]} disabled={disabled} onChange={event => update(key, event.target.value)} />}{fieldError?.field === key && <p className="field-error" role="alert">{fieldError.message}</p>}</div>
  }
  function chapterField(required: boolean) {
    return <div className="asset-field"><label htmlFor="asset-chapterIndex">{required ? '所属章节' : '来源章节'}</label><select id="asset-chapterIndex" value={values.chapterIndex} disabled={disabled || (!creating && !required)} onChange={event => update('chapterIndex', event.target.value)}><option value="">{required ? '请选择章节' : '无章节来源'}</option>{chapters.map(chapter => <option key={chapter.chapterIndex} value={chapter.chapterIndex}>{chapter.chapterIndex} · {chapter.chapterName}</option>)}</select>{fieldError?.field === 'chapterIndex' && <p className="field-error" role="alert">{fieldError.message}</p>}</div>
  }

  return <section ref={editorRef} className={`asset-editor${kind === 'character' ? ' asset-editor-character' : ''}`} aria-label={`${creating ? '新增' : '编辑'}${assetLabels[kind]}`}>
    <header className="editor-heading"><div><h3>{creating ? '新增' : '编辑'}{assetLabels[kind]}</h3>{baseline && <small>{baseline.id} · 修订 {baseline.revision}</small>}</div><button className="text-button" onClick={onClose}>关闭详情</button></header>
    {locked && <p className="asset-warning" role="status">这类资产正在处理，任务结束后可编辑。表单输入已保留。</p>}
    {missing && <div className="asset-warning" role="status">{mapping?.state === 'merged' ? '此条目已并入其他条目。' : '此条目已删除，当前输入保留供查看。'}{mapping?.currentId && <button className="text-button" onClick={() => onSelect(mapping.currentId!)}>查看保留条目</button>}</div>}
    {conflict && <div className="asset-warning" role="status">此条目已被更新，请重新载入后保存。<button className="text-button" onClick={() => { loadValues(asset); setFieldError(undefined) }}>重新载入</button></div>}
    {fieldError && !fieldError.field && <p className="field-error" role="alert">{fieldError.message}</p>}
    <form noValidate onSubmit={event => { event.preventDefault(); void save() }}>
      <div className="asset-editor-body">
      {kind === 'character' || kind === 'location' ? <>
        {field('name')}{field('aliases')}{chapterField(false)}{field('manualSourceNote')}
        <p className="field-help">没有来源章节时，请填写来源说明。别名用逗号分隔。</p>
        {kind === 'character' ? <>
          <div className="asset-field"><label htmlFor="asset-roleWeight">人物层级</label><select id="asset-roleWeight" value={values.roleWeight} disabled={disabled || conflict} onChange={event => void immediate('roleWeight', event.target.value)}>{roleWeights.map(role => <option key={role}>{role}</option>)}</select><small>{creating ? '保存人物时生效' : '选择后立即保存'}</small></div>
          {field('identity', true)}{field('ageText')}{field('appearance', true)}{field('personality', true)}{field('background', true)}{field('speechStyleSample', true)}
        </> : field('description', true)}
      </> : kind === 'node' ? <>
        {field('name')}{field('summary', true)}{chapterField(true)}{field('quote', true)}
        <p className="field-help">参考引文可留空。与原文匹配时自动定位，未匹配也可保存。</p>
        {baseline && 'quoteStatus' in baseline && baseline.quoteStatus === 'unmatched' && <p className="asset-warning" role="status">参考引文未能在所选章节中定位，节点已保存，可对照原文调整。</p>}
        <button className="text-button" type="button" disabled={!values.chapterIndex || busy} onClick={() => {
          void repository.readChapter(bookId, values.chapterIndex).then(text => setReader({ text, title: chapters.find(chapter => chapter.chapterIndex === values.chapterIndex)?.chapterName ?? '章节原文' })).catch(error)
        }}>查看所选章节原文</button>
        {field('process', true)}
        <NodeCharacters characters={snapshot.characters} ids={memberIds(values.participantIds)} names={values.unlinkedParticipants} disabled={disabled || conflict} error={fieldError?.field && ['participantIds', 'unlinkedParticipants', 'actors', 'actorIds', 'targets', 'targetCharacterIds'].includes(fieldError.field) ? fieldError.message : undefined} onChange={(ids, names) => {
          setValues(current => ({ ...current, participantIds: ids.join('\n'), unlinkedParticipants: names }))
          setFieldError(undefined); setSavedMessage('')
        }} />
        {field('time_text')}{field('time_hint')}{field('world_delta', true)}{field('new_facts', true)}{field('started_actions', true)}
        <p className="field-help">状态变化、事实与行动可每行一项。</p>
      </> : <>
        {field('title')}
        <div className="asset-field"><label htmlFor="asset-lineStatus">事件线状态</label><select id="asset-lineStatus" value={values.lineStatus} disabled={disabled || conflict} onChange={event => void immediate('lineStatus', event.target.value)}><option value="open">进行中</option><option value="closed">已结束</option></select><small>{creating ? '保存事件线时生效' : '选择后立即保存'}</small></div>
        <fieldset className="node-choices" disabled={disabled}><legend>成员节点</legend>{snapshot.nodes.length === 0 && <p>请先新增事件节点。</p>}{snapshot.nodes.map(node => <label key={node.id}><input type="checkbox" checked={memberIds(values.nodeIds).includes(node.id)} onChange={event => update('nodeIds', (event.target.checked ? [...memberIds(values.nodeIds), node.id] : memberIds(values.nodeIds).filter(id => id !== node.id)).join('\n'))} />{node.name}<small>{node.chapterName}</small></label>)}{memberIds(values.nodeIds).filter(id => !snapshot.nodes.some(node => node.id === id)).map(id => <button type="button" className="text-button" key={id} onClick={() => update('nodeIds', memberIds(values.nodeIds).filter(value => value !== id).join('\n'))}>移除失效节点 {id}</button>)}</fieldset>
        {fieldError?.field === 'nodeIds' && <p role="alert" className="field-error">{fieldError.message}</p>}
        {field('cause', true)}{field('process', true)}{field('result', true)}
      </>}
      {baseline && kind === 'character' && (() => {
        const person = baseline as Character
        const edges = snapshot.relationEdges[baseline.id] ?? []
        const page = paginateEdges(edges, 0, relationLimit)
        const name = (id: string) => snapshot.characters.find(row => row.id === id)?.name ?? id
        const names = new Set([person.name, ...(person.aliases ?? [])])
        const unresolved = snapshot.unresolvedRelations.filter(item => names.has(item.sourceName) || item.targetName === person.name)
        return <details className="asset-metadata" open><summary>人物关系</summary>{!edges.length && !unresolved.length && <p>暂无关系记录。</p>}{page.items.map(edge => <p key={`${edge.fromId}>${edge.toId}`}>{edge.fromId === baseline.id ? `${name(edge.toId)}：${edge.labels.join('、')}` : `来自 ${name(edge.fromId)}：${edge.labels.join('、')}`}{edge.directionUnclear ? '（方向未明确）' : ''}</p>)}{page.nextOffset !== null && <button className="text-button" type="button" onClick={() => setRelationLimit(value => value + 100)}>加载更多（共 {page.total} 条）</button>}{unresolved.map(item => <p key={item.relationId}>{item.sourceName} → {item.targetName}：{item.forwardLabel}（{item.reason === 'source_missing' ? '来源已失效' : item.reason === 'self' ? '两端合为同一人物' : '目标尚未入库'}）</p>)}</details>
      })()}
      {baseline && <details className="asset-metadata"><summary>来源与事实底稿</summary><p>创建来源：{baseline.createdBy === 'manual' ? '人工' : '提取'}；修订：{baseline.revision}</p>{'sourceChapters' in baseline && <p>来源章节：{baseline.sourceChapters?.join('、') || '无'}</p>}{'mergeNotes' in baseline && baseline.mergeNotes?.map((note, index) => <p key={index}>{note}</p>)}{'mergeFacts' in baseline && baseline.mergeFacts?.map(fact => <p key={fact.id}>{fact.text}（来源：{fact.chapters.join('、') || '人工'}）</p>)}{kind === 'character' && (baseline as Character).relations?.map((relation, index) => <p key={index}>{relation.target}：{relation.relation_label ?? relation.relation_type}</p>)}</details>}
      {baseline && kind === 'character' && <p className="field-help">基础资料：年龄 {(baseline as Character).profile?.age ?? '未记录'}；性别 {(baseline as Character).profile?.gender || '未记录'}</p>}
      {baseline && kind === 'eventLine' && <p className="field-help">当前可确定人物：{(snapshot.lineCharacterIds[baseline.id] ?? []).map(id => snapshot.characters.find(row => row.id === id)?.name ?? id).join('、') || '无'}；来源章节：{'chapters' in baseline ? baseline.chapters.join('、') : ''}</p>}
      </div>
      <footer className="editor-actions"><button className="primary-button" type="submit" disabled={disabled || conflict}>{busy ? '正在保存…' : '保存'}</button><button type="button" className="secondary-button" onClick={onClose}>取消编辑</button>{!creating && !missing && <button type="button" className="danger-button" disabled={disabled || conflict} onClick={() => setDeleteTarget(baseline)}>删除条目</button>}<span role="status">{savedMessage}</span></footer>
    </form>
    {deleteTarget && <DeleteDialog name={assetName(deleteTarget)} busy={busy} onClose={() => setDeleteTarget(undefined)} onConfirm={() => void remove()} />}
    {reader && <ChapterTextDialog title={reader.title} text={reader.text} onClose={() => setReader(undefined)} />}
  </section>
}
