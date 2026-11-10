import type { Row } from './repository'
import type { ExecutionChain } from './trace'
import { projectExecution } from './executionChain'
import { ApiRequest, Changes } from './AgentRunPanel'

const text = (value: unknown) => typeof value === 'string' ? value : ''
const record = (value: unknown): Row => value && typeof value === 'object' ? value as Row : {}
const list = (value: unknown): Row[] => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') as Row[] : []
const full = (value: unknown) => {
  if (value === undefined) return '未记录'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) ?? String(value) } catch { return '无法显示该内容' }
}
const when = (value: unknown) => text(value) ? new Date(text(value)).toLocaleString('zh-CN') : '未记录'
const duration = (requests: Row[]) => {
  const starts = requests.map(row => Date.parse(text(row.startedAt))).filter(Number.isFinite)
  const ends = requests.map(row => Date.parse(text(row.finishedAt ?? row.modelFinishedAt ?? row.startedAt))).filter(Number.isFinite)
  return starts.length && ends.length ? `${Math.max(0, Math.round((Math.max(...ends) - Math.min(...starts)) / 1000))} 秒` : '未记录'
}

export function ExecutionChainView({ chain, edits, characterNames, raw = true }: { chain: ExecutionChain; edits: Row[]; characterNames?: Map<string, string>; raw?: boolean }) {
  const projected = projectExecution(chain)
  const requests = projected.requests
  const stats = requests.reduce<{ input: number; output: number; cacheRead: number; total: number; cost: number; tools: number }>((sum, row) => {
    const usage = record(row.usage)
    return { input: sum.input + (Number(usage.input) || 0), output: sum.output + (Number(usage.output) || 0), cacheRead: sum.cacheRead + (Number(usage.cacheRead) || 0), total: sum.total + (Number(usage.totalTokens) || 0), cost: sum.cost + (Number(usage.cost) || 0), tools: sum.tools + list(row.toolCalls).length }
  }, { input: 0, output: 0, cacheRead: 0, total: 0, cost: 0, tools: 0 })
  return <section className="execution-chain" aria-label="Agent 执行过程">
    <section className="run-stats" aria-label="执行统计">
      <span>API 请求 <strong>{requests.length}</strong> 次</span><span>工具调用 <strong>{stats.tools}</strong> 次</span><span>耗时 <strong>{duration(requests)}</strong></span><span>Token <strong>{stats.total}</strong>（输入 {stats.input} / 缓存 {stats.cacheRead} / 输出 {stats.output}）</span><span>费用 <strong>{stats.cost.toFixed(6)}</strong> 美元</span><span>模型 <strong>{text(requests.at(-1)?.model) || '未记录'}</strong></span>{chain.runStatus ? <span>状态 <strong>{({ running: '进行中', completed: '已完成', paused: '已暂停', cancelled: '已取消', failed: '失败' } as Record<string, string>)[chain.runStatus] ?? chain.runStatus}</strong></span> : null}
    </section>
    {!projected.events.length && <p className="field-help" role="status">此运行没有可重建的 Agent 消息事件；请查看原始 API 请求或旧运行摘要。</p>}
    <div className="execution-events">{projected.events.map(event => {
      if (event.kind === 'compaction') return <details className="execution-event execution-compaction" key={event.key}><summary><strong>上下文压缩</strong></summary><pre>{event.content || '已压缩历史上下文'}</pre></details>
      if (event.kind === 'system') return <details className="execution-event execution-system" key={event.key}><summary>SYSTEM · 系统提示词</summary><pre>{event.content}</pre></details>
      if (event.kind === 'user') return <details className="execution-event execution-user" key={event.key}><summary>USER · 程序注入</summary><pre>{event.content}</pre></details>
      if (event.kind === 'assistant') return <details className="execution-event execution-assistant" key={event.key}>
        <summary><strong>ASSISTANT</strong>{event.apiIndex ? <span> · API #{event.apiIndex}</span> : null}{event.toolCalls.length ? <span> · {event.toolCalls.map(call => text(call.name)).join('、')}</span> : null}{event.content ? <span> · {event.content.slice(0, 80)}</span> : null}</summary>
        {event.thinking && <details><summary>THINKING · 推理内容</summary><pre>{event.thinking}</pre></details>}
        {event.content && <pre className="execution-message-text">{event.content}</pre>}
        {event.toolCalls.map(call => <details className="execution-tool-call" key={text(call.id)}><summary>TOOL CALL · {text(call.name)}</summary><pre>{full(call.arguments)}</pre></details>)}
        {!event.content && !event.thinking && !event.toolCalls.length && <p className="field-help">本回合没有正文或工具调用。</p>}
      </details>
      const execution = event.execution
      return <details className="execution-event execution-tool-result" key={event.key}>
        <summary><strong>TOOL RESULT · {event.toolName || '工具'}</strong>{event.isError ? <span className="field-error"> · 错误</span> : null}<span> · {text(execution?.state) || '已完成'}</span></summary>
        <div className="run-tool-execution">TOOL EXECUTION · {text(execution?.state) || '已完成'}{execution?.startedAt ? ` · ${when(execution.startedAt)}` : ''}{execution?.finishedAt ? ` → ${when(execution.finishedAt)}` : ''}</div>
        <pre>{event.content}</pre>
      </details>
    })}</div>
    <Changes edits={edits} characterNames={characterNames} />
    {raw && !!requests.length && <details className="execution-raw"><summary>原始 API 请求（{requests.length}）</summary><p className="field-help">以下保留每次请求实际发送的完整上下文，仅用于排查；主执行链不再重复这些历史消息。</p>{requests.map((row, index) => <ApiRequest key={text(row.requestId)} row={row} index={index} snapshots={chain.snapshots} />)}</details>}
  </section>
}
