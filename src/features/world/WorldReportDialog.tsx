import { useEffect, useMemo, useRef, useState } from 'react'
import type { MechanicalQueueItem, WorldRun } from './types'
import type { Row } from '../agents/repository'

const rows = (value: unknown) => Array.isArray(value) ? value as Row[] : []
const fieldName = (field: string) => ({ identity: '身份', appearance: '外貌', personality: '性格', background: '背景', description: '地点描述', name: '主名', aliases: '别名' } as Record<string, string>)[field] ?? field
const runTime = (run: WorldRun) => run.finishedAt ?? run.startedAt
const isCodeRun = (run: WorldRun) => ['mechanical', 'mechanical_queue'].includes(run.phase) && !run.tasks?.length
const statusLabel = (status: string) => ({ completed: '完成', failed: '失败', degraded: '部分完成', cancelled: '已取消', paused: '已暂停', running: '运行中' } as Record<string, string>)[status] ?? status
const queueStatus = (status: MechanicalQueueItem['status']) => ({ pending: '待合并', running: '正在合并', completed: '已合并', failed: '待重新核对' })[status]
function taskStatus(task: Row, run: WorldRun) {
  const work = rows((task.input as Row)?.workItems)
  const coverage = task.phase === 'asset_review' ? run.assetReview && { pendingIds: run.assetReview.items.filter(item => item.status === 'pending' || item.status === 'deferred').map(item => item.workItemId) } : run.coverage
  const pending = new Set(coverage?.pendingIds ?? [])
  const resolved = !!coverage && work.length > 0 && work.every(item => !pending.has(String(item.workItemId)))
  if (task.status === 'failed') return resolved ? '曾失败，现已处理' : '失败，待重试'
  if (task.status === 'completed') return coverage && !resolved ? '当时完成，当前待复核' : '完成'
  return resolved ? '历史记录，现已处理' : '保留进度'
}

export interface ReportQueue { items: MechanicalQueueItem[]; pending: number; completed: number; failed: number }
export function WorldReportDialog({ runs, initialId, queue, queueBusy, onRemoveQueue, onReviewQueue, onClose }: {
  runs: WorldRun[]; initialId?: string; queue?: ReportQueue; queueBusy?: boolean
  onRemoveQueue?: (item: MechanicalQueueItem) => Promise<void>
  onReviewQueue?: (item: MechanicalQueueItem) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const sorted = useMemo(() => [...runs].sort((a, b) => runTime(b).localeCompare(runTime(a)) || b.id.localeCompare(a.id)), [runs])
  const codeRuns = useMemo(() => sorted.filter(isCodeRun), [sorted])
  const aiRuns = useMemo(() => sorted.filter(run => !isCodeRun(run)), [sorted])
  const initial = sorted.find(run => run.id === initialId)
  const firstTab = (): 'code' | 'ai' => {
    if (initial) return isCodeRun(initial) ? 'code' : 'ai'
    if (!codeRuns.length) return 'ai'
    if (!aiRuns.length) return 'code'
    return runTime(codeRuns[0]).localeCompare(runTime(aiRuns[0])) >= 0 ? 'code' : 'ai'
  }
  const [tab, setTab] = useState<'code' | 'ai'>(firstTab)
  const [selected, setSelected] = useState<{ code?: string; ai?: string }>({
    code: initial && isCodeRun(initial) ? initial.id : codeRuns[0]?.id,
    ai: initial && !isCodeRun(initial) ? initial.id : aiRuns[0]?.id,
  })
  const [actionError, setActionError] = useState('')
  const [removing, setRemoving] = useState('')
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close() }, [])
  const list = tab === 'code' ? codeRuns : aiRuns
  const run = list.find(row => row.id === selected[tab]) ?? list[0]
  const chooseTab = (next: 'code' | 'ai') => setTab(next)
  const chooseRun = (id: string) => setSelected(current => ({ ...current, [tab]: id }))
  async function remove(item: MechanicalQueueItem) {
    if (!onRemoveQueue) return
    setActionError(''); setRemoving(item.id)
    try { await onRemoveQueue(item) }
    catch (error) { setActionError(error instanceof Error ? error.message : '移除待办失败。') }
    finally { setRemoving('') }
  }
  function review(item: MechanicalQueueItem) {
    onReviewQueue?.(item)
    onClose()
  }
  const groups = (value: WorldRun) => value.report.groups.map((group, i) => <section key={i} className="merge-result"><h3>保留：{group.canonicalName}</h3><p>编号：{group.keepId}</p><p>{group.memberNames.map((name, index) => `${name}（${group.memberIds[index]}）`).join('、')}</p><p>别名：{group.aliases.join('、') || '无'}；来源：{group.sourceChapters.join('、') || '人工资料'}</p><p>合并前后估算长度：{group.beforeTokens} → {group.afterTokens}</p>{group.conflicts.map((value, index) => <p key={index}>{value}</p>)}{group.method === 'ai_identity' && <details><summary>查看合并依据</summary>{(value.commandIntents ?? []).filter(intent => intent.state === 'applied').flatMap(intent => rows((intent.payload as Row)?.groups).filter(item => item.keepId === group.keepId && item.kind === group.kind)).map((item, index) => <div key={index}><p>{String(item.reason)}</p>{rows(item.evidence).map((evidence, index) => <p key={index}>第 {String(evidence.chapterIndex)} 章：{String(evidence.quote)}</p>)}</div>)}</details>}</section>)
  return <dialog ref={ref} className="merge-dialog" aria-labelledby="world-report-title" onCancel={event => event.preventDefault()}><header className="merge-dialog-heading"><h2 id="world-report-title">世界资产整理报告</h2><button className="text-button" onClick={onClose}>关闭报告</button></header><div className="merge-dialog-body">
    <div className="report-tabs" role="tablist" aria-label="整理报告类型">
      <button type="button" role="tab" aria-selected={tab === 'code'} className={tab === 'code' ? 'primary-button' : 'secondary-button'} onClick={() => chooseTab('code')}>代码整理</button>
      <button type="button" role="tab" aria-selected={tab === 'ai'} className={tab === 'ai' ? 'primary-button' : 'secondary-button'} onClick={() => chooseTab('ai')}>AI整理</button>
    </div>
    {actionError && <p className="field-error" role="alert">{actionError}</p>}
    {tab === 'code' ? <>
      <section className="mechanical-queue" aria-label="当前队列"><h3>当前队列</h3>{queue ? <><p>待处理 {queue.pending} 组 · 已合并 {queue.completed} 组 · 失败 {queue.failed} 组</p>{!queue.items.length && <p className="field-help">当前没有待合并组。</p>}{!!queue.items.length && <ul>{queue.items.map(item => <li key={item.id}><div><strong>{item.kind === 'character' ? '人物' : '地点'} · {item.request.canonicalName}</strong><span>{item.confirmation === 'exact_name' ? '同名自动' : '人工确认'} · {item.request.memberIds.length}条 · 保留 {item.request.keepId} · {queueStatus(item.status)}</span><small>{item.memberNames.map((name, index) => `${name}（${item.request.memberIds[index]}）`).join('、')}</small>{item.error && <p className="asset-warning">{item.error}</p>}</div><div className="editor-actions">{item.status === 'failed' && onReviewQueue && <button type="button" className="text-button" disabled={queueBusy} onClick={() => review(item)}>重新核对</button>}{item.status !== 'completed' && onRemoveQueue && <button type="button" className="text-button" disabled={queueBusy || removing === item.id} onClick={() => void remove(item)}>{removing === item.id ? '正在移除…' : '移除待办'}</button>}</div></li>)}</ul>}</> : <p className="field-help">当前没有队列记录。</p>}</section>
      {run ? <>
        <section aria-label="代码整理报告"><h3>所选代码报告</h3>{codeRuns.length > 1 && <label htmlFor="code-report-select">选择代码报告 <select id="code-report-select" value={run.id} onChange={event => chooseRun(event.target.value)}>{codeRuns.map(row => <option key={row.id} value={row.id}>{new Date(runTime(row)).toLocaleString('zh-CN')} · {row.phase === 'mechanical_queue' ? '队列' : '扫描'} · {row.id}</option>)}</select></label>}
          <p>当前报告：{run.phase === 'mechanical_queue' ? '队列整理' : '候选扫描'} · 编号 {run.id} · {new Date(runTime(run)).toLocaleString('zh-CN')}</p>
          <p>{statusLabel(run.status)} · 人物 {run.report.beforeCounts.characters} → {run.report.afterCounts.characters} · 地点 {run.report.beforeCounts.locations} → {run.report.afterCounts.locations}</p>
          <p>合并 {run.report.groups.length} 组 · 减少 {run.report.groups.reduce((sum, group) => sum + group.memberIds.length - 1, 0)} 条 · 代码整理不调用模型</p>
          {!!run.report.skipped.length && <details open><summary>候选与待复核（{run.report.skipped.length}）</summary>{run.report.skipped.map((value, index) => <p key={index}>{value}</p>)}</details>}
          {!!run.report.failed.length && <details open><summary>失败（{run.report.failed.length}）</summary>{run.report.failed.map((value, index) => <p key={index}>{value}</p>)}</details>}
          {groups(run)}
        </section>
      </> : <p className="field-help">还没有代码整理报告。</p>}
    </> : run ? <>
      <label htmlFor="world-report-select">选择 AI 整理报告</label>{aiRuns.length > 1 && <select id="world-report-select" value={run.id} onChange={event => chooseRun(event.target.value)}>{aiRuns.map(row => <option key={row.id} value={row.id}>{new Date(runTime(row)).toLocaleString('zh-CN')} · AI整理 · {row.id}</option>)}</select>}
      <p>当前报告：AI整理 · 编号 {run.id} · {new Date(runTime(run)).toLocaleString('zh-CN')}</p>
      <p>{statusLabel(run.status)} · 人物 {run.report.beforeCounts.characters} → {run.report.afterCounts.characters} · 地点 {run.report.beforeCounts.locations} → {run.report.afterCounts.locations}</p>
      <p>合并 {run.report.groups.length} 组 · 减少 {run.report.groups.reduce((sum, group) => sum + group.memberIds.length - 1, 0)} 条 · 整编 {run.report.optimizedIds.length} 条</p>
      <p>总用量 {run.report.usage.totalTokens} · {run.report.usage.costStatus === 'unknown' ? '费用未知' : `估算费用 ${run.report.cost.toFixed(6)} 美元`}</p>
      {run.coverage && <p>身份核实已完成 {run.coverage.checked}/{run.coverage.total} 条 · 待处理 {run.coverage.pendingIds.length} 条</p>}
      {!!run.tasks?.length && <details><summary>批次与实际请求（{run.tasks.length}批）</summary><p>以下为累计执行记录；当前剩余工作以待处理数量为准。</p>{run.tasks.map((task, index) => <section key={String(task.taskId)}><p>第{index + 1}批 · 分配{rows((task.input as Row)?.workItems).length}条 · 实际请求{Number(task.stepsUsed ?? 0)}次 · {taskStatus(task, run)}</p><p>资产：{rows((task.input as Row)?.workItems).map(item => String(item.id)).join('、')}</p><p>已核实{rows(task.reviewedItems).length}条 · 提交确认{Array.isArray(task.appliedCommitIds) ? task.appliedCommitIds.length : 0}条</p><p>查询记录：{rows((task.readSet as Row)?.queries).map(row => String(row.tool)).join('、') || '尚无成功查询'}</p>{!!task.lastError && <p>当时反馈：{String((task.lastError as Row).message)}</p>}</section>)}</details>}
      {groups(run)}
      {!!run.report.protectionRepairs?.length && <details><summary>自动合并来源纠正（{run.report.protectionRepairs.length}）</summary>{run.report.protectionRepairs.map(item => <p key={`${item.kind}:${item.id}`}>{item.name}（{item.id}）：{item.reason}</p>)}</details>}
      {run.assetReview && <p>{run.reviewScope === 'relations' ? '人物关系核对' : '全资产核对'} {run.reviewMode === 'sample' ? '（先核对10项）' : ''} 已完成 {run.assetReview.items.filter(item => item.status === 'checked').length}/{run.assetReview.items.length} 条 · 暂缓 {run.assetReview.items.filter(item => item.status === 'deferred').length} 条 · 未处理 {run.assetReview.items.filter(item => item.status === 'pending').length} 条</p>}
      {!!run.report.assetEdits?.length && <details open><summary>资产核对修改（{run.report.assetEdits.length}）</summary>{run.report.assetEdits.map(item => <section key={item.commitId}><p>{item.kind === 'relation' ? '人物关系' : ({ character: '人物', location: '地点', node: '事件节点', eventLine: '事件线' }[item.kind])}：{item.id} · {item.tool}</p><p>理由：{item.reason || '未填写'}</p>{item.fieldChanges.map((change, index) => <p key={index}>{change.field}：{JSON.stringify(change.before)} → {JSON.stringify(change.after)}</p>)}{item.evidence.map((evidence, index) => <p key={index}>第{evidence.chapterIndex}章：{evidence.quote}</p>)}</section>)}</details>}
      {!!run.report.aliasChecks?.length && <details open><summary>别名核实与纠正（{run.report.aliasChecks.length}）</summary>{run.report.aliasChecks.map(item => <section key={item.id}><h3>{item.name}（{item.assetId}）</h3><p>原别名：{item.beforeAliases.join('、') || '无'} → 当前别名：{item.afterAliases.join('、') || '无'}</p><p>已核实称呼：{item.verifiedAliases.join('、') || '无'}</p>{item.decisions.map(decision => <details key={decision.alias}><summary>{decision.decision === 'keep' ? '确认' : '移除'}：{decision.alias} · {decision.reason}</summary>{decision.evidence.map((evidence, index) => <p key={index}>第{evidence.chapterIndex}章：{evidence.quote}</p>)}{decision.referentId && <p>实际指向：{decision.referentId}</p>}</details>)}{!!item.affectedNodeIds?.length && <p>相关节点待复核：{item.affectedNodeIds.join('、')}</p>}<p>提交确认：{item.commitId}</p></section>)}</details>}
      {!!run.report.optimizations?.length && <details open><summary>资料整编与复核（{run.report.optimizations.length}）</summary>{run.report.optimizations.map(item => <section key={item.id}><h3>{item.name}（{item.assetId}）· {{ pending_review: '稿件待复核', applied: '已更新资料', no_change: '资料无变化', rejected: '复核未通过，原资料保留', stale: '历史稿件已过期' }[item.status]}</h3>{item.review && <p>AI复核：{item.review.summary}</p>}{item.reviewError && <p>{item.reviewError}</p>}{item.review?.issues.map((issue, index) => <p key={index}>{fieldName(issue.field)}：{issue.message}{issue.factIds.length ? `（${issue.factIds.join('、')}）` : ''}</p>)}{item.proposedName !== item.name && <p>主名：{item.name} → {item.proposedName}</p>}{Object.keys(item.before).filter(field => item.before[field] !== item.after[field]).map(field => <details key={field}><summary>{fieldName(field)} · {item.status === 'applied' ? '修改前后' : '原资料与稿件'}</summary><p>原资料：{item.before[field] || '空'}</p><p>{item.status === 'applied' ? '当前资料' : '整编稿'}：{item.after[field] || '空'}</p></details>)}</section>)}</details>}
      {(['skipped', 'failed', 'conflicted', 'externalChanges'] as const).map((field, i) => !!run.report[field].length && <details key={field} open={field === 'failed'}><summary>{['候选与待复核', '失败', '冲突', '其他资料变化'][i]}（{run.report[field].length}）</summary>{run.report[field].map((value, index) => <p key={index}>{value}</p>)}</details>)}
    </> : <p className="field-help">还没有 AI 整理报告。</p>}
  </div></dialog>
}
