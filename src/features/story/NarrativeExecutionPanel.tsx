import { useCallback, useEffect, useRef, useState } from 'react'
import { EventTaskOutcome } from './EventTaskOutcomePanel'
import { bookInterests, useLiveResult } from '../../hooks/useLiveResult'
import { executionStats } from '../agents/executionStats'
import type { ExecutionChain } from '../agents/trace'
import type { StoryExecutionPhase } from '../agents/executionPagingTypes'
import type { Row } from '../agents/repository'
import type { StoryService } from './service'
import { labels, partLabel } from './narrativeLabels'
import { NarrativeRequest } from './NarrativeRequest'

type Tasks = Awaited<ReturnType<StoryService['narrativeTasks']>>
type TaskOption = ReturnType<typeof taskOptions>[number]
const phases = [
  ['link_node', '节点串联'],
  ['review_boundaries', '宏观复核'],
  ['review_sequence', '逐事件主审'],
  ['review_event', '旧版事件复核'],
  ['global_review', '事件归入故事线'],
] as const
const states: Record<string, string> = {
  running: '进行中',
  completed: '已确认',
  partial: '待继续',
  paused: '已暂停',
  cancelled: '已取消',
  failed: '失败',
}
function taskOptions(tasks: Tasks) {
  let batch = 0,
    cycle = 0,
    segment = 0
  return tasks.map((task, i) => {
    const previous = tasks[i - 1]
    if (task.part === 'batch') batch++
    if (task.mode.endsWith('_cycle') && previous?.mode !== task.mode) cycle++
    segment = previous?.mode === task.mode && previous.part === task.part ? segment + 1 : 1
    const title =
      ['link_node','review_boundaries','review_sequence','review_event'].includes(task.mode) ? labels[task.mode] + ' · ' + (task.displayNames || task.ids.join('、') || '未归属节点') : task.part === 'batch'
        ? (task.mode === 'node_batch' ? '节点批次 ' : '归线组 ') + batch
        : labels[task.mode] +
          (task.mode.endsWith('_cycle') ? ' ' + cycle : '') +
          ' · ' +
          partLabel(task.mode === 'event_review' || task.mode === 'event_cycle', task.part) +
          ' · 第 ' +
          segment +
          ' 段'
    return { ...task, title }
  })
}
type Common = { bookId: string; runId: string; service: StoryService }
export function NarrativeExecutionPanel({
  bookId,
  runId,
  service,
  initialPhase,
  initialEventReview = false,
  reviewOnly = false,
  reviewStage,
  onClose,
}: Common & { initialPhase: StoryExecutionPhase; initialEventReview?: boolean; reviewStage?:'review_boundaries'|'review_sequence'; reviewOnly?: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  const [phase, setPhase] = useState<(typeof phases)[number][0]>(
    initialPhase === 'global_review' ? 'global_review' : initialEventReview || reviewOnly ? reviewStage ?? 'review_boundaries' : 'link_node'
  ),
    [picked, setPicked] = useState('')
  const tasks = useLiveResult(
    useCallback(() => service.narrativeTasks(bookId, runId), [bookId, runId, service]),
    0,
    bookInterests(bookId, ['pipelineRuns'])
  )
  const options = taskOptions(tasks.status === 'ready' ? tasks.value.filter(t => {
    if (phase === 'global_review') return t.phase === phase
    if (t.phase !== 'window_link') return false
    return t.mode === phase
  }) : [])
  const choices = reviewOnly ? options.filter((t) => t.part !== 'batch') : options
  const task = choices.find((t) => t.id === picked) ?? choices.at(-1)
  return (
    <dialog
      ref={ref}
      className="merge-dialog run-detail-dialog"
      aria-labelledby="narrative-detail-title"
      onCancel={onClose}
    >
      <header className="merge-dialog-heading">
        <h2 id="narrative-detail-title">{reviewOnly ? 'P3 逐项复核表' : 'P3 整理详情'}</h2>
        <button className="text-button" onClick={onClose}>
          关闭
        </button>
      </header>
      <div className="merge-dialog-body run-detail-body">
        <nav className="run-window-tabs" aria-label="P3 整理阶段">
          {phases.filter(([id]) => (!reviewOnly || id !== 'link_node') && (id!=='review_event' || (tasks.status==='ready' && tasks.value.some(t=>t.mode==='review_event')))).map(([id, label]) => (
            <button
              key={id}
              aria-pressed={phase === id}
              className={phase === id ? 'primary-button' : 'secondary-button'}
              onClick={() => {
                setPhase(id)
                setPicked('')
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        {tasks.status === 'error' ? (
          <p role="alert">{tasks.message}</p>
        ) : tasks.status === 'loading' ? (
          <p role="status">正在读取本轮任务…</p>
        ) : !task ? (
          <p>{reviewOnly ? '本阶段尚未开始复核。' : '本轮尚未生成该阶段的任务。'}</p>
        ) : (
          <>
            {(task.mode === 'event_review' || task.mode === 'line_review') && (
              <ol aria-label={labels[task.mode] + '任务'}>
                {(['structure', 'doubts', 'unassigned', 'descriptions'] as const).map((part, index, order) => {
                  const segments = options.filter(item => item.mode === task.mode && item.part === part)
                  const completed = segments.filter(item => item.status === 'completed').length
                  const passed = options.some(item => item.mode === task.mode && order.slice(index + 1).some(next => item.part === next))
                  let state = passed ? '此轮跳过' : '尚未开始'
                  if (segments.length) state = completed === segments.length ? '已确认 ' + completed + ' 段' : '第 ' + segments.length + ' 段' + (states[segments.at(-1)!.status] ?? '')
                  return <li key={part}>{partLabel(task.mode === 'event_review', part)} · {state}</li>
                })}
              </ol>
            )}
            <label className="narrative-task-picker">
              {phase === 'link_node' ? '节点任务' : phase !== 'global_review' ? '事件任务' : '归线任务'}{' '}
              <select value={task.id} onChange={(e) => setPicked(e.target.value)}>
                {choices.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title} · {states[t.status] ?? t.status}
                  </option>
                ))}
              </select>
            </label>
            {task.part === 'batch' && (
              <details className="narrative-range">
                <summary>任务范围 · {task.ids.length} 项</summary>
                {task.ids.join('、')}
              </details>
            )}
            {task.degraded && <p role="status">检索降级 · {task.degraded}</p>}
            <TaskOutcome
              key={'outcome' + task.id}
              task={task}
              bookId={bookId}
              runId={runId}
              service={service}
            />
            {!reviewOnly && (
              <TaskCalls key={task.id} taskId={task.id} bookId={bookId} runId={runId} service={service} />
            )}
          </>
        )}
      </div>
    </dialog>
  )
}
function TaskOutcome({ task, bookId, runId, service }: Common & { task: TaskOption }) {
  const taskId = task.id
  const data = useLiveResult(
    useCallback(() => service.narrativeOutcome(bookId, runId, taskId), [service, bookId, runId, taskId]),
    0,
    bookInterests(bookId, ['pipelineRuns'])
  )
  if (data.status !== 'ready')
    return <p role="status">{data.status === 'error' ? data.message : '正在读取成果…'}</p>
  if (!data.value) return null
  if (data.value.eventOutcome) return <EventTaskOutcome key={taskId} result={data.value.eventOutcome} />
  const { label, groups, notes } = data.value
  if (data.value.review) {
    const { rows, confirmed, membershipCount, descriptionCount, targetCount } = data.value.review
    const eventLayer = task.mode === 'event_cycle' || task.mode === 'event_review'
    const targetLabel = task.part === 'doubts' ? '条疑点' : task.part === 'unassigned'
      ? (eventLayer ? '个节点' : '个事件') : (eventLayer ? '个事件' : '条故事线')
    const changesSummary = [
      membershipCount ? membershipCount + (eventLayer ? ' 处节点归属调整' : ' 处事件归属调整') : '',
      descriptionCount ? descriptionCount + (eventLayer ? ' 个事件' : ' 条故事线') + '的说明' : '',
    ].filter(Boolean)
    const hasChanges = rows.some(row => row.changes.length)
    const outcomes: Record<string, string> = {
      repaired: '已修正',
      no_change: task.part === 'unassigned' ? (eventLayer ? '保留单节点事件' : '保留单事件故事线') : '核对无改动',
      resolved: '已解决',
      independent: '独立保留',
      unassigned: '保留未归线',
      retained_open: '保留疑点',
    }
    return (
      <section className="narrative-review" aria-label="复核成果">
        <header className="narrative-review-heading">
          <h3>{task.title} · {targetCount} {targetLabel}</h3>
          <span className="narrative-review-state">{confirmed ? '本段已确认' : '本段未确认'}</span>
          {task.status !== 'completed' && task.status !== 'running' && states[task.status] && (
            <span className="narrative-review-run-state">{states[task.status]}</span>
          )}
        </header>
        <p role="status" className="narrative-review-summary">
          {changesSummary.length ? '已保存 ' + changesSummary.join('、') :
            hasChanges ? '已保存以下修改。' : confirmed ? '本段无保存修改。' : '本段尚无已保存的修改。'}
        </p>
        <table>
          <thead>
            <tr>
              <th>复核对象</th>
              <th>已保存的改动</th>
              {confirmed && <th>复核结论</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.title} {r.context && <small>{r.context}</small>}{r.title !== r.id && <small>{r.id}</small>}
                </td>
                <td>
                  {r.changes.length > 0 && <ul>{r.changes.map(({ label, value }, index) => (
                    <li key={index}>
                      {value ? <details><summary>{label}</summary><p>{value}</p></details> : label}
                    </li>
                  ))}</ul>}
                </td>
                {confirmed && <td>
                  {outcomes[r.outcome] ?? r.outcome}
                  {r.note && <p>{r.note}</p>}
                </td>}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    )
  }
  return (
    <details className="narrative-outcome">
      <summary>
        <strong>批次成果</strong> · {label}（{groups.length + notes.length} 项）
      </summary>
      {groups.map(({ parent, items }, i) => (
        <div key={i}>
          <strong>{parent.title || parent.id}</strong> <small>{parent.title && parent.id}</small>
          <ul>
            {items.map((item, j) => (
              <li key={j}>
                {item.title} <small>{item.id}</small>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {notes.map((note, i) => (
        <p key={i}>{note}</p>
      ))}
      {!groups.length && !notes.length && <p>尚无可展示的已保存成果。</p>}
    </details>
  )
}
function TaskCalls({ taskId, bookId, runId, service }: Common & { taskId: string }) {
  const [picked, setPicked] = useState(''),
    [tick, refresh] = useState(0),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false)
  const read = useCallback(
    () => service.narrativeCalls(bookId, runId, taskId),
    [bookId, runId, service, taskId]
  )
  const data = useLiveResult(read, tick, bookInterests(bookId, ['storySessionEntries', 'pipelineRuns']))
  if (data.status !== 'ready')
    return (
      <p role={data.status === 'error' ? 'alert' : 'status'}>
        {data.status === 'error' ? data.message : '正在读取请求…'}
      </p>
    )
  const chain = data.value
  const index = chain.requests.findIndex((row) => row.requestId === picked)
  const at = index < 0 ? chain.requests.length - 1 : index,
    selected = chain.requests[at]
  const stats = chain.summary?.stats ?? executionStats(chain.requests)
  if (!selected) return <p>此任务尚无请求记录。</p>
  return (
    <>
      <p>
        本任务共 {stats.requests} 次请求 · 工具调用 {stats.tools} 次 · 费用{' '}
        {stats.cost === null ? '未返回' : stats.cost.toFixed(6) + ' 美元'}
      </p>
      <nav className="narrative-request-nav" aria-label="当前任务的模型请求">
        {chain.paging?.hasEarlier && (
          <button
            disabled={loading}
            onClick={async () => {
              setLoading(true)
              setError('')
              try {
                await chain.paging!.loadEarlier()
                refresh((value) => value + 1)
              } catch (e) {
                setError(String(e))
              } finally {
                setLoading(false)
              }
            }}
          >
            更早请求
          </button>
        )}
        {chain.requests.map((row, i) => (
          <button
            key={String(row.requestId)}
            aria-pressed={i === at}
            onClick={() => setPicked(String(row.requestId))}
          >
            第 {Number(row.timelineOrdinal ?? i + 1)} 次请求
          </button>
        ))}
      </nav>
      {error && <p role="alert">{error}</p>}
      <RequestBody
        key={String(selected.requestId)}
        chain={chain}
        request={selected}
        ordinal={Number(selected.timelineOrdinal ?? at + 1)}
      />
    </>
  )
}
function RequestBody({ chain, request, ordinal }: { chain: ExecutionChain; request: Row; ordinal: number }) {
  const load = chain.paging?.loadRequest
  const [saved, setSaved] = useState<Awaited<ReturnType<NonNullable<typeof load>>>>()
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    if (load)
      void load(request)
        .then((value) => {
          if (active) {
            setSaved(value)
            setError('')
          }
        })
        .catch((e) => {
          if (active) setError(String(e))
        })
    return () => {
      active = false
    }
  }, [request, load])
  if (error) return <p role="alert">{error}</p>
  if (load && !saved) return <p role="status">正在读取本次输入…</p>
  return (
    <NarrativeRequest
      request={load ? saved!.request : request}
      snapshots={load ? saved!.snapshots : chain.snapshots}
      previousHashes={
        load
          ? saved!.request.previousMessageHashes
          : (chain.requests[chain.requests.indexOf(request) - 1]?.input as Row | undefined)?.messageHashes
      }
      ordinal={ordinal}
    />
  )
}
