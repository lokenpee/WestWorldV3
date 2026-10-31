import { useEffect, useRef, useState } from 'react'
import type { ManualMergeRun } from './merge'

export function MergeHistory({ runs, initialId, onClose }: { runs: ManualMergeRun[]; initialId?: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [selected, setSelected] = useState(initialId ?? runs[0]?.id)
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close() }, [])
  const run = runs.find(row => row.id === selected) ?? runs[0]
  return <dialog ref={dialog} className="merge-dialog" aria-labelledby="history-title" onCancel={event => event.preventDefault()}>
    <header className="merge-dialog-heading"><h2 id="history-title">合并记录</h2><button className="text-button" onClick={onClose}>关闭记录</button></header>
    <div className="merge-dialog-body">{!run ? <p>还没有合并记录。</p> : <>
      <div className="asset-field"><label htmlFor="merge-history-id">选择合并记录</label><select id="merge-history-id" value={run.id} onChange={event => setSelected(event.target.value)}>{runs.map(row => <option key={row.id} value={row.id}>{new Date(row.startedAt).toLocaleString('zh-CN')} · {row.report.groups[0]?.canonicalName}</option>)}</select></div>
      <p>人物：{run.report.beforeCounts.characters} → {run.report.afterCounts.characters}；地点：{run.report.beforeCounts.locations} → {run.report.afterCounts.locations}</p>
      {run.report.groups.map((group, index) => <section className="merge-result" key={index}><h3>保留：{group.canonicalName}</h3><p>保留编号：{group.keepId}</p><ul>{group.memberIds.map((id, i) => <li key={id}>{group.memberNames[i]}（{id}） → {group.canonicalName}（{group.keepId}）</li>)}</ul><p>别名：{group.aliases.join('、') || '无'}</p><p>来源章节：{group.sourceChapters.join('、') || '人工'}</p>{group.conflicts.map((value, i) => <p className="field-error" key={i}>{value}</p>)}</section>)}
      <p className="field-help">本地手动合并，无模型调用。</p>
    </>}</div>
  </dialog>
}
