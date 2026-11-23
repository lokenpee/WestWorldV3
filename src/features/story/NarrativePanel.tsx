import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useLiveResult, bookInterests } from '../../hooks/useLiveResult'
import { NarrativeExecutionPanel } from './NarrativeExecutionPanel'
import { labels, partLabel } from './narrativeLabels'
import type { StoryExecutionPhase } from '../agents/executionPagingTypes'
import { SessionHistory } from './SessionHistory'
import type { StoryService } from './service'

export function NarrativePanel({
  bookId,
  service,
  historical,
}: {
  bookId: string
  service: StoryService
  historical: ReactNode
}) {
  const api = service.narrative
  const historicalKey = 'p3-history-open:' + bookId
  const [showHistorical, setShowHistorical] = useState(() => sessionStorage.getItem(historicalKey) === 'true')
  const [tick, refresh] = useState(0),
    [trace, setTrace] = useState<{ runId: string; phase: StoryExecutionPhase; reviewOnly?: boolean }>(),
    [history, setHistory] = useState(false)
  useEffect(() => api.subscribe(() => refresh((t) => t + 1)), [api])
  const current = useLiveResult(
    useCallback(() => api.read(bookId), [api, bookId]),
    tick,
    bookInterests(bookId, [
      'compileProgress',
      'pipelineRuns',
      'storyEditorNotes',
      'nodes',
      'storyEvents',
      'eventLines',
    ])
  )
  const gate = useLiveResult(
    useCallback(() => api.eligibility(bookId), [api, bookId]),
    tick,
    bookInterests(bookId, ['chapters', 'extractionReceipts', 'pipelineRuns'])
  )
  const reason = gate.status === 'ready' ? gate.value : undefined
  useEffect(() => {
    if (!reason?.includes('执行权')) return
    const timer = setTimeout(() => refresh((t) => t + 1), 30000)
    return () => clearTimeout(timer)
  }, [reason, tick])
  const status = current.status === 'ready' ? current.value : undefined
  const plan = status?.plan,
    task = plan?.active,
    running = api.running(bookId),
    message = api.message(bookId) || status?.error
  return (
    <section className="story-panel narrative-panel" aria-label="P3 叙事大纲">
      <div className="story-heading">
        <h2>P3 叙事大纲</h2>
        {!running && (
          <button
            className="primary-button"
            disabled={current.status !== 'ready' || running || gate.status !== 'ready' || !!reason}
            onClick={() => void api.start(bookId)}
          >
            {status?.status === 'completed' || status?.status === 'cancelled'
              ? '重新整理大纲'
              : plan
                ? '继续整理大纲'
                : '开始整理大纲'}
          </button>
        )}
        {running && (
          <button className="primary-button" onClick={() => void api.stop(bookId)}>
            暂停
          </button>
        )}
        {(running || status?.status === 'paused') && (
          <button className="secondary-button" onClick={() => void api.stop(bookId, true)}>
            取消 P3
          </button>
        )}
        {plan && (
          <button
            className="text-button"
            onClick={() =>
              setTrace({
                runId: status!.runId,
                phase: plan.layer === 'line' ? 'global_review' : 'window_link',
              })
            }
          >
            P3 整理详情
          </button>
        )}
      </div>
      <div className="story-body">
        {(message || reason) && <p role="status">{running ? message : reason || message}</p>}
        {status && (
          <>
            <p>
              节点归入事件 {status.stats.assignedNodes}/{status.stats.totalNodes} · 事件归入故事线{' '}
              {status.stats.assignedEvents}/{status.stats.totalEvents} · 已复核 {status.stats.reviewed} 项次
            </p>
            <details>
              <summary>会话疑点清单（{status.stats.doubts.length}）</summary>
              {status.stats.doubts.length ? (
                <ul>
                  {status.stats.doubts.map((d) => (
                    <li key={d.id}>
                      <strong>{d.status === 'resolved' ? '已解决' : '未决'}</strong> · {d.statement}
                      {d.targets.length > 0 && <div>关联对象　{d.targets.join('、')}</div>}
                      {d.resolution && <div>解决依据　{d.resolution}</div>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>尚未登记疑点。</p>
              )}
            </details>
            {!!status.stats.independentReasons.length && (
              <details>
                <summary>独立保留依据（{status.stats.independentReasons.length}）</summary>
                <ul>
                  {status.stats.independentReasons.map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
        {current.status === 'error' && <p role="alert">{current.message}</p>}
        {plan && (
          <>
            <p>
              {plan.complete
                ? '全书复核完成'
                : task
                  ? labels[task.mode] + ' · ' + partLabel(plan.layer === 'event', task.part)
                  : plan.layer === 'event'
                    ? '节点整理'
                    : '事件归线'}{' '}
              · 节点已处理 {Object.keys(plan.nodes).length} · 事件已处理 {Object.keys(plan.events).length}
            </p>
            <p>
              节点批次已确认 {plan.batches.event} · 归线批次已确认 {plan.batches.line}
              {task && ' · 当前范围 ' + task.ids.join('、')}
            </p>
            <button
              className="secondary-button"
              onClick={() =>
                setTrace({
                  runId: status!.runId,
                  phase: plan.layer === 'line' ? 'global_review' : 'window_link',
                  reviewOnly: true,
                })
              }
            >
              查看逐项复核表
            </button>
            <details>
              <summary>运行参数与复核记录</summary>
              <p>
                每批 {plan.config.nodeBatchSize} 个节点，每组 {plan.config.eventGroupSize} 个事件。每{' '}
                {plan.config.eventReviewInterval} 个节点批次、{plan.config.lineReviewInterval}{' '}
                个归线组复核一次，每段最多 {plan.config.segmentSize} 项。
              </p>
              {plan.reviews?.map((r, i) => (
                <p key={i}>
                  {r.layer === 'event' ? '事件' : '故事线'}
                  {r.final ? '全书' : '周期'}复核 · 结构 {r.counts.structure} · 疑点 {r.counts.doubts} ·
                  {r.layer === 'event' ? '节点归属复查' : '未归线事件'} {r.counts.unassigned}
                  {r.final && ' · 说明 ' + r.counts.descriptions}
                </p>
              ))}
            </details>
            {status?.usage && (
              <p>
                请求 {status.usage.requests} 次 · 输入 {status.usage.input} · 输出 {status.usage.output} ·
                缓存读取 {status.usage.cacheRead} · 缓存写入 {status.usage.cacheWrite} ·{' '}
                {status.usage.unknown ? '费用未知' : '估算费用 ' + status.usage.cost.toFixed(5) + ' 美元'}
              </p>
            )}
          </>
        )}
        <button className="text-button" onClick={() => setHistory(!history)}>
          {history ? '收起会话历史' : '查看会话历史'}
        </button>
        {history && <SessionHistory bookId={bookId} service={service} />}
      </div>
      {trace && (
        <NarrativeExecutionPanel
          bookId={bookId}
          runId={trace.runId}
          initialPhase={trace.phase}
          reviewOnly={trace.reviewOnly}
          service={service}
          onClose={() => setTrace(undefined)}
        />
      )}
      {!plan && (
        <details
          open={showHistorical}
          onToggle={(e) => {
            setShowHistorical(e.currentTarget.open)
            sessionStorage.setItem(historicalKey, String(e.currentTarget.open))
          }}
        >
          <summary>旧版串联与复核</summary>
          {historical}
        </details>
      )}
    </section>
  )
}
