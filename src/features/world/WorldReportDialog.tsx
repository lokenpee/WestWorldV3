import { useEffect, useRef, useState } from 'react'
import type { WorldRun } from './types'
import type { Row } from '../agents/repository'

const rows = (value: unknown) => Array.isArray(value) ? value as Row[] : []

export function WorldReportDialog({ runs, initialId, onClose }: { runs: WorldRun[]; initialId?: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [selected, setSelected] = useState(initialId)
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close() }, [])
  const run = runs.find(row => row.id === selected) ?? runs[0]
  return <dialog ref={ref} className="merge-dialog" aria-labelledby="world-report-title" onCancel={event => event.preventDefault()}><header className="merge-dialog-heading"><h2 id="world-report-title">世界资产整理报告</h2><button className="text-button" onClick={onClose}>关闭报告</button></header><div className="merge-dialog-body">{run ? <>
    <label htmlFor="world-report-select">选择整理报告</label><select id="world-report-select" value={run.id} onChange={event => setSelected(event.target.value)}>{runs.map(row => <option key={row.id} value={row.id}>{new Date(row.startedAt).toLocaleString('zh-CN')} · {row.phase === 'mechanical' ? '代码整理' : 'AI整理'}</option>)}</select>
    <p>{({ completed: '完成', failed: '失败', degraded: '部分完成', cancelled: '已取消', paused: '已暂停', running: '运行中' })[run.status]} · 人物 {run.report.beforeCounts.characters} → {run.report.afterCounts.characters} · 地点 {run.report.beforeCounts.locations} → {run.report.afterCounts.locations}</p>
    <p>合并 {run.report.groups.length} 组 · 减少 {run.report.groups.reduce((sum, group) => sum + group.memberIds.length - 1, 0)} 条 · 整编 {run.report.optimizedIds.length} 条</p>
    <p>总用量 {run.report.usage.totalTokens} · {run.phase === 'mechanical' ? '代码整理无模型调用' : run.report.usage.costStatus === 'unknown' ? '费用未知' : `估算费用 ${run.report.cost.toFixed(6)} 美元`}</p>
    {run.report.groups.map((group, i) => <section key={i} className="merge-result"><h3>保留：{group.canonicalName}</h3><p>编号：{group.keepId}</p><p>{group.memberNames.map((name, index) => `${name}（${group.memberIds[index]}）`).join('、')}</p><p>别名：{group.aliases.join('、') || '无'}；来源：{group.sourceChapters.join('、') || '人工资料'}</p><p>合并前后估算长度：{group.beforeTokens} → {group.afterTokens}</p>{group.conflicts.map((value, index) => <p key={index}>{value}</p>)}{group.method === 'ai_identity' && <details><summary>查看合并依据</summary>{(run.commandIntents ?? []).filter(intent => intent.state === 'applied').flatMap(intent => rows((intent.payload as Row)?.groups).filter(value => value.keepId === group.keepId && value.kind === group.kind)).map((value, index) => <div key={index}><p>{String(value.reason)}</p>{rows(value.evidence).map((evidence, index) => <p key={index}>第 {String(evidence.chapterIndex)} 章：{String(evidence.quote)}</p>)}</div>)}</details>}</section>)}
    {(['skipped', 'failed', 'conflicted', 'externalChanges'] as const).map((field, i) => !!run.report[field].length && <details key={field} open={field === 'failed'}><summary>{['候选与待复核', '失败', '冲突', '其他资料变化'][i]}（{run.report[field].length}）</summary>{run.report[field].map((value, index) => <p key={index}>{value}</p>)}</details>)}
  </> : <p>还没有整理报告。</p>}</div></dialog>
}
