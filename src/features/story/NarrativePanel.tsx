import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useLiveResult, bookInterests } from '../../hooks/useLiveResult'
import { NarrativeExecutionPanel } from './NarrativeExecutionPanel'
import { labels, partLabel } from './narrativeLabels'
import { storylinesOnHold } from './narrativePlan'
import type { StoryExecutionPhase } from '../agents/executionPagingTypes'
import { SessionHistory } from './SessionHistory'
import type { StoryService } from './service'

export function NarrativePanel({
  bookId,
  service,
  createCopy,
}: {
  bookId: string
  service: StoryService
  createCopy?: (bookId:string)=>Promise<string>
}) {
  const api = service.narrative
  const [showTest,setShowTest]=useState(false)
  const [preparing, setPreparing] = useState(false)
  const [copyError, setCopyError] = useState('')
  async function start() {
    setShowTest(false)
    setPreparing(true)
    setCopyError('')
    try {
      let id = bookId
      if (await api.requiresCopy(bookId)) {
        if (!createCopy) throw Error('重建副本入口不可用。')
        id = await createCopy(bookId)
      }
      await api.start(id)
    } catch (error) { setCopyError(error instanceof Error ? error.message : String(error)) }
    finally { setPreparing(false) }
  }
  async function startReview() {
    setShowTest(true)
    setPreparing(true)
    setCopyError('')
    try { await api.start(bookId,true) }
    catch (error) { setCopyError(error instanceof Error ? error.message : String(error)) }
    finally { setPreparing(false) }
  }
  const [tick, refresh] = useState(0),
    [trace, setTrace] = useState<{ runId: string; phase: StoryExecutionPhase; eventReview?: boolean; reviewOnly?: boolean; reviewStage?:'review_boundaries'|'review_sequence' }>(),
    [history, setHistory] = useState(false)
  const running = useSyncExternalStore(api.subscribe, () => api.running(bookId))
  const runningMessage = useSyncExternalStore(api.subscribe, () => api.message(bookId))
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
  const testRun=useLiveResult(useCallback(()=>api.read(bookId,true),[api,bookId]),tick,
    bookInterests(bookId,['pipelineRuns','nodes','storyEvents']))
  const test=testRun.status==='ready' ? testRun.value : undefined
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
  const main = current.status === 'ready' ? current.value : undefined
  const viewingTest=!!test && (showTest || !main)
  const status = viewingTest ? test : main
  const plan = status?.plan,
    task = plan?.active,
    waiting = storylinesOnHold && status?.status === 'paused' && !!plan?.awaitingStorylines,
    heldStoryline = storylinesOnHold && plan?.layer === 'line' && ['paused', 'running'].includes(status!.status),
    message = runningMessage || status?.error
  return (
    <section className="story-panel narrative-panel" aria-label="P3 叙事大纲">
      <div className="story-heading">
        <h2>P3 叙事大纲</h2>
        {!running && !main?.plan.awaitingStorylines && main?.plan.layer!=='line' && (
          <button
            className="primary-button"
            disabled={preparing || current.status !== 'ready' || running || gate.status !== 'ready' || !!reason}
            onClick={() => void start()}
          >
            {main?.status === 'completed' || main?.status === 'cancelled'
              ? '在副本中重建大纲'
              : main?.plan
                ? '继续整理大纲'
                : '开始整理大纲'}
          </button>
        )}
        <button className="secondary-button" disabled={running || preparing || testRun.status!=='ready'}
          onClick={()=>void startReview()}>{test?.status==='paused' || test?.status==='running' ? '继续事件复核' : test?.status==='cancelled' ? '重新开始事件复核' : '事件复核'}</button>
        {running && (
          <button className="primary-button" onClick={() => void api.stop(bookId)}>
            暂停
          </button>
        )}
        {(running || [main?.status,test?.status].some(s=>s==='paused' || s==='running')) && (
          <button className="secondary-button" onClick={() => void api.stop(bookId, true).catch(error=>setCopyError(error instanceof Error ? error.message : String(error)))}>
            取消 P3
          </button>
        )}
        {test && main && !running && <button className="text-button" onClick={()=>setShowTest(!showTest)}>{showTest ? '查看主流程' : '查看独立复核'}</button>}
        {plan && (
          <button
            className="text-button"
            onClick={() =>
              setTrace({
                runId: status!.runId,
                phase: plan.layer === 'line' ? 'global_review' : 'window_link',
                eventReview: !!(waiting || plan.reviewOnly || plan.twoStep?.phase==='micro' || task?.mode.startsWith('review_')),
                reviewStage:task?.mode==='review_sequence' || plan.twoStep?.phase==='micro' ? 'review_sequence':'review_boundaries',
              })
            }
          >
            P3 整理详情
          </button>
        )}
      </div>
      <div className="story-body">
        {copyError && <p role="alert">{copyError}</p>}
        {waiting
          ? <p role="status">第一阶段已完成，已在故事线整理前暂停。</p>
          : heldStoryline ? <p role="status">第一阶段测试期间，故事线整理已暂停。</p>
          : (message || (!viewingTest && reason)) && <p role="status">{message || reason}</p>}
        {status && (
          <>
            {plan?.twoStep && <p role="status">
              宏观已确认 {status.stats.macroDone} 组 · 微观已主审 {status.stats.microDone}/{status.stats.totalEvents} 件
              {task && ' · 当前'+labels[task.mode]+' '+task.ids.join('、')}
            </p>}
            <p>
              节点归入事件 {status.stats.assignedNodes}/{status.stats.totalNodes} · 事件归入故事线{' '}
              {status.stats.assignedEvents}/{status.stats.totalEvents}{!plan?.twoStep && ' · 已复核 '+status.stats.reviewed+' 项次'}
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
            {plan?.twoStep?.macroIssue && <div><strong>宏观分组待核实</strong><ul>{plan.twoStep.macroIssue.map((p,i)=>
              <li key={i}>{String(p.issue)} · {String(p.checked_scope)} · {String(p.reason)}</li>)}</ul></div>}
            {Object.entries(plan?.twoStep?.pending ?? plan?.eventReview?.pending ?? {}).map(([id, issues]) =>
              <div key={id}><strong>待核实 · {id}</strong><ul>{issues.map((p,i)=><li key={i}>{String(p.issue)} · {String(p.checked_scope)} · {String(p.reason)}</li>)}</ul></div>)}
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
        {testRun.status === 'error' && <p role="alert">{testRun.message}</p>}
        {current.status === 'error' && <p role="alert">{current.message}</p>}
        {plan && (
          <>
            {!plan.reviewOnly && <><p>
              {plan.complete
                ? '事件复核完成'
                : task
                  ? plan.layer === 'event' ? labels[task.mode] : labels[task.mode] + ' · ' + partLabel(false, task.part)
                  : plan.layer === 'event'
                    ? waiting ? '事件复核完成' : '节点整理'
                    : '事件归线'}{' '}
              · 节点已处理 {Object.keys(plan.nodes).length} · 事件已处理 {Object.keys(plan.events).length}
            </p>
            <p>
              节点已确认 {plan.batches.event} · 归线批次已确认 {plan.batches.line}
              {task && ' · 当前范围 ' + task.ids.join('、')}
            </p></>}
            <button
              className="secondary-button"
              onClick={() =>
                setTrace({
                  runId: status!.runId,
                  phase: plan.layer === 'line' ? 'global_review' : 'window_link',
                  reviewOnly: true,
                  reviewStage: plan.twoStep?.phase==='micro' ? 'review_sequence' : 'review_boundaries',
                })
              }
            >
              查看逐项复核表
            </button>
            <details>
              <summary>运行参数与复核记录</summary>
              <p>
                逐节点串联完成后，先按疑似组复核边界，再逐事件核对经过。归线每组 {plan.config.eventGroupSize} 个事件，每 {plan.config.lineReviewInterval}{' '}
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
          initialEventReview={trace.eventReview}
          reviewStage={trace.reviewStage}
          reviewOnly={trace.reviewOnly}
          service={service}
          onClose={() => setTrace(undefined)}
        />
      )}
    </section>
  )
}
