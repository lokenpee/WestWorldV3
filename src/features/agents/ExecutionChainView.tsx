import { LazyDetails } from './LazyDetails'
import { executionStats } from './executionStats'
import { useEffect, useState, type ReactNode } from 'react'
import type { Row } from './repository'
import type { ExecutionChain } from './trace'
import { ApiRequest, Changes } from './AgentRunPanel'
import { projectExecution, projectRequestConversation, type ExecutionEvent } from './executionChain'
import { displayContent, toolDeclaration, toolResultContent } from './requestPresentation'

const text = (value: unknown) => typeof value === 'string' ? value : ''
const num = (value: unknown) => typeof value === 'number' ? String(value) : '未记录'
const record = (value: unknown): Row => value && typeof value === 'object' ? value as Row : {}
const list = (value: unknown): Row[] => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') as Row[] : []
const when = (value: unknown) => text(value) ? new Date(text(value)).toLocaleString('zh-CN') : '未记录'
const status = (value: unknown) => ({ running: '进行中', succeeded: '成功', failed: '失败', cancelled: '取消', interrupted: '已中断' } as Record<string, string>)[text(value)] ?? text(value)
const full = (value: unknown) => {
  if (value === undefined) return '未记录'
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) ?? String(value) } catch { return '无法显示该内容' }
}
const duration = (requests: Row[]) => {
  const starts = requests.map(row => Date.parse(text(row.startedAt))).filter(Number.isFinite)
  const ends = requests.map(row => Date.parse(text(row.finishedAt ?? row.modelFinishedAt ?? row.startedAt))).filter(Number.isFinite)
  return starts.length && ends.length ? `${Math.max(0, Math.round((Math.max(...ends) - Math.min(...starts)) / 1000))} 秒` : '未记录'
}

function LoadedRequest({ request, ordinal, load }: { request: Row; ordinal: number; load: NonNullable<ExecutionChain['paging']>['loadRequest'] }) {
  const [result, setResult] = useState<Awaited<ReturnType<typeof load>>>()
  const [error, setError] = useState('')
  useEffect(() => { let live = true; setResult(undefined); setError(''); void load(request).then(value => { if (live) setResult(value) }).catch(error => { if (live) setError(String(error)) }); return () => { live = false } }, [request, load])
  if (error) return <p role="alert">{error}</p>
  if (!result) return <p role="status">正在读取本次请求…</p>
  return <ApiRequest row={result.request} index={ordinal - 1} snapshots={result.snapshots} />
}
const apiLabel = (ordinal: number) => `API ${String(ordinal).padStart(2, '0')}`
function ApiHeading({ request, ordinal }: { request?: Row; ordinal: number }) {
  const usage = record(request?.usage)
  const fullInput = typeof usage.totalTokens === 'number' && typeof usage.output === 'number' ? usage.totalTokens - usage.output : undefined
  return <><strong>{apiLabel(ordinal)}</strong><span>{request ? `${status(request.status)} · ${when(request.startedAt)} · 完整输入 ${num(fullInput)} token（普通输入 ${num(usage.input)}，缓存读 ${num(usage.cacheRead)}，缓存写 ${num(usage.cacheWrite)}）· 本次输出 ${num(usage.output)}` : '未记录请求信息'}</span></>
}
function ApiBoundary({ request, ordinal, snapshots, load }: { request?: Row; ordinal: number; snapshots: Map<string, Row>; load?: NonNullable<ExecutionChain['paging']>['loadRequest'] }) {
  return <LazyDetails className="run-api-boundary" summary={<><ApiHeading request={request} ordinal={ordinal} /><span>查看本次实际请求</span></>}>{() => <>
    {request ? <div className="run-api-boundary-body">{load ? <LoadedRequest request={request} ordinal={ordinal} load={load} /> : <ApiRequest row={request} index={ordinal - 1} snapshots={snapshots} />}</div> : <p className="field-help">未保存本次实际请求。</p>}
  </>}</LazyDetails>
}

function EventContents({ event }: { event: ExecutionEvent }) {
  if (event.kind === 'assistant') return <>
    {event.thinking && <LazyDetails summary="思考内容">{() => <pre>{event.thinking}</pre>}</LazyDetails>}
    {event.content && <pre>{event.content}</pre>}
    {event.toolCalls.map((call, index) => <LazyDetails className="run-role run-role-toolcall" key={text(call.id) || index} summary={<>TOOL CALL · {text(call.name)}</>}>{() => <pre>{displayContent(call.arguments)}</pre>}</LazyDetails>)}
  </>
  if (event.kind !== 'toolResult') return <pre>{displayContent(event.content)}</pre>
  return event.execution?.result === undefined && !event.content ? <p className="field-help">等待返回或未记录工具结果。</p> : <pre>{event.execution?.result === undefined ? displayContent(event.content) : toolResultContent(event.execution.result)}</pre>
}
function LoadedEvent({ event, load }: { event: ExecutionEvent; load: NonNullable<ExecutionChain['paging']>['loadEvent'] }) {
  const [value, setValue] = useState<ExecutionEvent>()
  const [error, setError] = useState('')
  useEffect(() => { let live = true; setValue(undefined); setError(''); void load(event).then(value => { if (live) setValue(value) }).catch(error => { if (live) setError(String(error)) }); return () => { live = false } }, [event, load])
  return error ? <p role="alert">{error}</p> : value ? <EventContents event={value} /> : <p role="status">正在读取消息…</p>
}
function ConversationEvent({ event, firstUser, load, timeline = false, historical = false }: { event: ExecutionEvent; firstUser: boolean; load?: NonNullable<ExecutionChain['paging']>['loadEvent']; timeline?: boolean; historical?: boolean }) {
  const execution = event.execution
  const result = execution?.result
  const failed = event.isError || execution?.isError === true || execution?.state === 'failed'
  const state = failed ? '失败' : execution?.state === 'pending' ? '待执行' : result === undefined && !event.entry.hasResult ? '未记录' : '成功'
  const summaries: Partial<Record<ExecutionEvent['kind'], ReactNode>> = {
    system: historical ? 'SYSTEM PROMPT · 已保存' : 'SYSTEM PROMPT · 实际发送', user: firstUser ? 'USER · 程序注入' : timeline ? 'USER' : 'USER · 运行消息', other: event.role.toUpperCase(), compaction: '上下文压缩',
    assistant: <>ASSISTANT{event.toolCalls.length ? ` · ${event.toolCalls.length} 次工具调用` : ' · 模型回复'}</>,
    toolResult: <>TOOL RESULT · {event.toolName || text(execution?.name) || '工具'}<span className={failed ? 'field-error run-result-state' : 'run-result-state'}>{state}</span></>,
  }
  const classes = { system: 'run-role-system', user: 'run-role-user', assistant: 'run-conversation-assistant', toolResult: 'run-role-toolresult', other: '', compaction: '' }
  return <LazyDetails className={`run-role ${classes[event.kind]}`} summary={summaries[event.kind]}>{() => load ? <LoadedEvent event={event} load={load} /> : <EventContents event={event} />}</LazyDetails>
}

const requestId = (request: Row) => String(request.requestId ?? request.id)
const toolSnapshotId = (request: Row) => text(request.toolSchemaSnapshotId ?? record(request.input).toolSchemaSnapshotId)

function SentTools({ snapshot }: { snapshot?: Row }) {
  const definitions = list(snapshot?.schema).map(toolDeclaration)
  if (!definitions.length) {
    const names = Array.isArray(snapshot?.toolNames) ? snapshot.toolNames.join('、') : ''
    return <p className="field-help">{names ? `仅保存了工具名称：${names}` : snapshot && !snapshot.truncated ? '本次没有工具定义。' : '未保存完整的工具定义。'}</p>
  }
  return definitions.map((tool, index) => <LazyDetails className="run-tool-definition" key={index} summary={text(tool.name) || `工具 ${index + 1}`}>{() => <pre>{full(tool)}</pre>}</LazyDetails>)
}

function LoadedTools({ request, load }: { request: Row; load: NonNullable<ExecutionChain['paging']>['loadRequest'] }) {
  const [result, setResult] = useState<{ snapshot?: Row; error?: string }>()
  useEffect(() => {
    let live = true
    void load(request).then(({ request: saved, snapshots }) => {
      if (live) setResult({ snapshot: snapshots.get(toolSnapshotId(saved)) })
    }).catch(error => { if (live) setResult({ error: String(error) }) })
    return () => { live = false }
  }, [request, load])
  return !result ? <p role="status">正在读取工具定义…</p> : result.error ? <p role="alert">{result.error}</p> : <SentTools snapshot={result.snapshot} />
}

function RequestTimeline({ chain, events, fullRequests }: { chain: ExecutionChain; events: ExecutionEvent[]; fullRequests: boolean }) {
  const { requests, paging, snapshots } = chain
  const first = chain.firstRequest ?? (!paging?.hasEarlier ? requests[0] : undefined)
  const byRequest = new Map<string, ExecutionEvent[]>()
  for (const event of events) {
    const id = paging ? text(event.entry.requestId) : String(event.apiIndex)
    const group = byRequest.get(id) ?? []
    group.push(event)
    byRequest.set(id, group)
  }
  return requests.map((request, index) => {
    const id = requestId(request), ordinal = paging ? Number(request.timelineOrdinal ?? request.requestOrdinal) || index + 1 : index + 1
    const group = byRequest.get(paging ? id : String(index + 1)) ?? []
    const isFirst = first && requestId(first) === id && (fullRequests || !Number(first.requestOrdinal) || Number(first.requestOrdinal) === 1)
    const snapshotId = first && isFirst ? toolSnapshotId(first) : ''
    const firstUser = isFirst ? group.find(event => event.kind === 'user')?.key : undefined
    const historical = !paging && record(request.input).messageFormat !== 'provider-request/v1'
    const afterSystem = group.findIndex(event => event.kind !== 'system')
    const toolPosition = afterSystem < 0 ? group.length : afterSystem
    const rows = group.map(event => <ConversationEvent key={event.key} event={event} firstUser={event.key === firstUser} load={paging?.loadEvent} timeline historical={historical} />)
    if (snapshotId) rows.splice(toolPosition, 0, <LazyDetails key={`tools:${snapshotId}`} className="run-role run-role-tools" summary={historical ? 'TOOLS · 已保存的工具' : 'TOOLS · 可调用工具'}>{() => paging
      ? <LoadedTools key={String(first?.version ?? '')} request={first!} load={paging.loadRequest} />
      : <SentTools snapshot={snapshots.get(snapshotId)} />}</LazyDetails>)
    return <section key={id} className="run-api-slice" aria-label={apiLabel(ordinal)}>
      {fullRequests ? <ApiBoundary request={request} ordinal={ordinal} snapshots={snapshots} load={paging?.loadRequest} />
        : <div className="run-api-boundary run-api-marker"><ApiHeading request={request} ordinal={ordinal} /></div>}
      {rows}
    </section>
  })
}

export function ExecutionChainView({ chain, edits, characterNames, raw = true, folded = false, fullRequests = false, onChainChange }: { chain: ExecutionChain; edits?: Row[]; characterNames?: Map<string, string>; raw?: boolean; folded?: boolean; fullRequests?: boolean; onChainChange?: (chain: ExecutionChain) => void }) {
  const [earlierLoading, setEarlierLoading] = useState(false)
  const [pageError, setPageError] = useState('')
  const requests = chain.requests
  const stats = chain.summary?.stats ?? executionStats(requests)
  const events = chain.paging?.events ?? (folded ? projectRequestConversation(chain, true) : projectExecution(chain).events)
  const requestTimeline = folded && requests.length > 0
  const firstUser = events.find(event => event.kind === 'user')?.key
  const declarations = new Map<string, Row>()
  for (const request of requestTimeline ? [] : requests) {
    const snapshot = chain.snapshots.get(text(record(request.input).toolSchemaSnapshotId))
    for (const tool of list(snapshot?.schema)) {
      const declaration = toolDeclaration(tool)
      const name = text(declaration.name)
      if (name && !declarations.has(name)) declarations.set(name, declaration)
    }
  }
  const blocks: ReactNode[] = []
  let lastApi: number | undefined
  let seenSystem = ''
  for (const event of requestTimeline ? [] : events) {
    if (!chain.paging && !folded && event.kind === 'user' && event.content.startsWith('当前运行状态：')) continue
    if (!chain.paging && !folded && event.kind === 'system') {
      if (seenSystem === event.content) continue
      seenSystem = event.content
    }
    if ((chain.paging || event.kind === 'assistant') && typeof event.apiIndex === 'number' && event.apiIndex !== lastApi) {
      blocks.push(<ApiBoundary key={`api-${event.apiIndex}`} request={chain.paging ? requests.find(row => String(row.requestId ?? row.id) === event.entry.requestId) : folded ? requests[event.apiIndex - 1] : requests.find(row => Number(row.requestOrdinal) === event.apiIndex)} ordinal={event.apiIndex} snapshots={chain.snapshots} load={chain.paging?.loadRequest} />)
      lastApi = event.apiIndex
    }
    blocks.push(<ConversationEvent key={event.key} event={event} firstUser={event.key === firstUser} load={chain.paging?.loadEvent} />)
  }
  return <section className="execution-chain" aria-label="Agent 执行过程">
    <section className="run-stats" aria-label="执行统计">
      <span>API 请求 <strong>{stats.requests}</strong> 次</span><span>工具调用 <strong>{stats.tools}</strong> 次</span><span>耗时 <strong>{chain.summary?.duration ?? duration(requests)}</strong></span><span>Token <strong>{stats.total ?? '待返回'}</strong>（普通输入 {stats.input ?? '待返回'} / 缓存 {stats.cacheRead ?? '待返回'} / 输出 {stats.output ?? '待返回'}）</span><span>费用 <strong>{stats.cost === null ? '未返回' : stats.cost.toFixed(6)}</strong> 美元</span><span>模型 <strong>{chain.summary?.model || text(requests.at(-1)?.model) || '未记录'}</strong></span>{chain.runStatus ? <span>状态 <strong>{({ running: '进行中', completed: '已完成', paused: '已暂停', cancelled: '已取消', failed: '失败' } as Record<string, string>)[chain.runStatus] ?? chain.runStatus}</strong></span> : null}
    </section>
    {raw && <section className="execution-conversation" aria-label="Agent 会话">
      {!chain.paging && !folded && <p className="field-help run-conversation-note">System Prompt 和程序注入按实际发送显示一次；每次 API 只显示本次新增的 Assistant 和工具结果。展开 API 分隔行可查看该次完整请求体。</p>}
      {chain.paging?.hasEarlier && onChainChange && <button className="text-button" disabled={earlierLoading} onClick={() => {
        setEarlierLoading(true); setPageError('')
        void chain.paging!.loadEarlier().then(onChainChange).catch(error => setPageError(String(error))).finally(() => setEarlierLoading(false))
      }}>{earlierLoading ? '正在读取…' : '查看更早的调用'}</button>}
      {pageError && <p role="alert">{pageError}</p>}
      {declarations.size > 0 && <LazyDetails className="run-role run-role-tools" summary={<> TOOLS · 本次运行可用工具（{declarations.size}） </>}>{() => <>{[...declarations.values()].map(tool => <LazyDetails className="run-tool-definition" key={text(tool.name)} summary={<> {text(tool.name)} </>}>{() => <><pre>{full(tool)}</pre></>}</LazyDetails>)}</>}</LazyDetails>}
      {requestTimeline ? <RequestTimeline chain={chain} events={events} fullRequests={fullRequests} /> : events.length ? blocks : requests.length ? <section className="execution-api-calls" aria-label="旧请求记录">
        <p className="field-help">旧日志没有保存逐条会话消息，以下按请求快照显示。</p>
        {requests.map((row, index) => folded ? <ApiBoundary key={text(row.requestId) || index} request={row} ordinal={index + 1} snapshots={chain.snapshots} /> : <ApiRequest key={text(row.requestId) || index} row={row} index={index} snapshots={chain.snapshots} />)}
      </section> : <p className="field-help" role="status">没有记录到 API 请求。</p>}
    </section>}
    {edits && <Changes edits={edits} characterNames={characterNames} sideBySide={folded} />}
  </section>
}
