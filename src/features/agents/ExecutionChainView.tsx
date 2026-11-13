import { LazyDetails } from './LazyDetails'
import { executionStats } from './executionStats'
import type { ReactNode } from 'react'
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

function ApiBoundary({ request, ordinal, snapshots }: { request?: Row; ordinal: number; snapshots: Map<string, Row> }) {
  const usage = record(request?.usage)
  return <LazyDetails className="run-api-boundary" summary={<> <strong>API {String(ordinal).padStart(2, '0')}</strong><span>{request ? `${status(request.status)} · ${when(request.startedAt)} · 输入 ${num(usage.input)} · 输出 ${num(usage.output)}` : '未记录请求信息'}</span><span>查看本次实际请求</span> </>}>{() => <>
    {request ? <div className="run-api-boundary-body"><ApiRequest row={request} index={ordinal - 1} snapshots={snapshots} /></div> : <p className="field-help">未保存本次实际请求。</p>}
  </>}</LazyDetails>
}

function ConversationEvent({ event, firstUser }: { event: ExecutionEvent; firstUser: boolean }) {
  if (event.kind === 'system') return <LazyDetails className="run-role run-role-system" summary={<> SYSTEM PROMPT · 实际发送 </>}>{() => <>
    <pre>{displayContent(event.content)}</pre>
  </>}</LazyDetails>
  if (event.kind === 'user') return <LazyDetails className="run-role run-role-user" summary={<> {firstUser ? 'USER · 程序注入' : 'USER · 运行消息'} </>}>{() => <>
    <pre>{displayContent(event.content)}</pre>
  </>}</LazyDetails>
  if (event.kind === 'other') return <LazyDetails className="run-role" summary={event.role.toUpperCase()}>{() => <pre>{event.content}</pre>}</LazyDetails>
  if (event.kind === 'compaction') return <LazyDetails className="run-role" summary="上下文压缩">{() => <pre>{event.content}</pre>}</LazyDetails>
  if (event.kind === 'assistant') return <LazyDetails className="run-role run-conversation-assistant" summary={<>ASSISTANT{event.toolCalls.length ? ` · ${event.toolCalls.length} 次工具调用` : ' · 模型回复'}</>}>{() => <>
    {event.thinking && <LazyDetails summary="思考内容">{() => <pre>{event.thinking}</pre>}</LazyDetails>}
    {event.content && <pre>{event.content}</pre>}
    {event.toolCalls.map((call, index) => <LazyDetails className="run-role run-role-toolcall" key={text(call.id) || index} summary={<>TOOL CALL · {text(call.name)}</>}>{() => <pre>{displayContent(call.arguments)}</pre>}</LazyDetails>)}
  </>}</LazyDetails>
  const execution = event.execution
  const result = execution?.result
  const failed = event.isError || execution?.isError === true || execution?.state === 'failed'
  const state = failed ? '失败' : execution?.state === 'pending' ? '待执行' : result === undefined ? '未记录' : '成功'
  return <LazyDetails className="run-role run-role-toolresult" summary={<> TOOL RESULT · {event.toolName || text(execution?.name) || '工具'}<span className={failed ? 'field-error run-result-state' : 'run-result-state'}>{state}</span> </>}>{() => <>
    {result === undefined && !event.content ? <p className="field-help">等待返回或未记录工具结果。</p> : <pre>{result === undefined ? displayContent(event.content) : toolResultContent(result)}</pre>}
  </>}</LazyDetails>
}

export function ExecutionChainView({ chain, edits, characterNames, raw = true, folded = false }: { chain: ExecutionChain; edits: Row[]; characterNames?: Map<string, string>; raw?: boolean; folded?: boolean }) {
  const requests = chain.requests
  const stats = executionStats(requests)
  const events = folded ? projectRequestConversation(chain) : projectExecution(chain).events
  const firstUser = events.find(event => event.kind === 'user')?.key
  const declarations = new Map<string, Row>()
  for (const request of requests) {
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
  for (const event of events) {
    if (!folded && event.kind === 'user' && event.content.startsWith('当前运行状态：')) continue
    if (!folded && event.kind === 'system') {
      if (seenSystem === event.content) continue
      seenSystem = event.content
    }
    if (event.kind === 'assistant' && typeof event.apiIndex === 'number' && event.apiIndex !== lastApi) {
      blocks.push(<ApiBoundary key={`api-${event.apiIndex}`} request={folded ? requests[event.apiIndex - 1] : requests.find(row => Number(row.requestOrdinal) === event.apiIndex)} ordinal={event.apiIndex} snapshots={chain.snapshots} />)
      lastApi = event.apiIndex
    }
    blocks.push(<ConversationEvent key={event.key} event={event} firstUser={event.key === firstUser} />)
  }
  return <section className="execution-chain" aria-label="Agent 执行过程">
    <section className="run-stats" aria-label="执行统计">
      <span>API 请求 <strong>{stats.requests}</strong> 次</span><span>工具调用 <strong>{stats.tools}</strong> 次</span><span>耗时 <strong>{duration(requests)}</strong></span><span>Token <strong>{stats.total ?? '待返回'}</strong>（输入 {stats.input ?? '待返回'} / 缓存 {stats.cacheRead ?? '待返回'} / 输出 {stats.output ?? '待返回'}）</span><span>费用 <strong>{stats.cost === null ? '未返回' : stats.cost.toFixed(6)}</strong> 美元</span><span>模型 <strong>{text(requests.at(-1)?.model) || '未记录'}</strong></span>{chain.runStatus ? <span>状态 <strong>{({ running: '进行中', completed: '已完成', paused: '已暂停', cancelled: '已取消', failed: '失败' } as Record<string, string>)[chain.runStatus] ?? chain.runStatus}</strong></span> : null}
    </section>
    {raw && <section className="execution-conversation" aria-label="Agent 会话">
      {!folded && <p className="field-help run-conversation-note">System Prompt 和程序注入按实际发送显示一次；每次 API 只显示本次新增的 Assistant 和工具结果。展开 API 分隔行可查看该次完整请求体。</p>}
      {declarations.size > 0 && <LazyDetails className="run-role run-role-tools" summary={<> TOOLS · 本次运行可用工具（{declarations.size}） </>}>{() => <>{[...declarations.values()].map(tool => <LazyDetails className="run-tool-definition" key={text(tool.name)} summary={<> {text(tool.name)} </>}>{() => <><pre>{full(tool)}</pre></>}</LazyDetails>)}</>}</LazyDetails>}
      {events.length ? blocks : requests.length ? <section className="execution-api-calls" aria-label="旧请求记录">
        <p className="field-help">旧日志没有保存逐条会话消息，以下按请求快照显示。</p>
        {requests.map((row, index) => folded ? <ApiBoundary key={text(row.requestId) || index} request={row} ordinal={index + 1} snapshots={chain.snapshots} /> : <ApiRequest key={text(row.requestId) || index} row={row} index={index} snapshots={chain.snapshots} />)}
      </section> : <p className="field-help" role="status">没有记录到 API 请求。</p>}
    </section>}
    <Changes edits={edits} characterNames={characterNames} sideBySide={folded} />
  </section>
}
