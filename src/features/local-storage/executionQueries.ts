import type { DatabaseSync } from 'node:sqlite'
import { projectRequestConversation, type ExecutionEvent } from '../agents/executionChain.ts'
import { executionStats } from '../agents/executionStats.ts'
import type { ExecutionPageResult, ExecutionQuery, ExecutionSummary } from '../agents/executionPagingTypes.ts'
import type { ExecutionRow as Row } from '../agents/executionTypes.ts'

const text = (value: unknown) => typeof value === 'string' ? value : ''
const record = (value: unknown): Row => value && typeof value === 'object' ? value as Row : {}
interface Header { key: string; version: number; row: Row }
function scopeHeaders(db: DatabaseSync, scope: string, options: ExecutionQuery): Header[] {
  if (!options?.runId) throw new Error('缺少执行链运行编号。')
  const args: string[] = [scope, options.runId]
  let where = "scope=? AND tableName='storySessionEntries' AND json_extract(body,'$.type')='request_trace' AND json_extract(body,'$.runId')=?"
  for (const key of ['unitId', 'sessionId', 'contextId'] as const) if (options[key]) {
    where += key === 'unitId' ? " AND coalesce(nullif(json_extract(body,'$.unitId'),''),json_extract(body,'$.workId'),'')=?" : ` AND json_extract(body,'$.${key}')=?`
    args.push(options[key]!)
  }
  const columns = ['requestId', 'requestOrdinal', 'startedAt', 'finishedAt', 'model', 'status', 'usage'].map(key => `'${key}',json_extract(body,'$.${key}')`).join(',')
  const rows = db.prepare(`SELECT recordKey,version,json_object('id',recordKey,${columns},'format',json_extract(body,'$.input.messageFormat'),'toolCount',json_array_length(json_extract(body,'$.toolCalls'))) AS header FROM records WHERE ${where} ORDER BY coalesce(json_extract(body,'$.startedAt'),''),coalesce(nullif(json_extract(body,'$.requestId'),''),recordKey)`).all(...args)
  return rows.map(row => ({ key: String(row.recordKey), version: Number(row.version), row: JSON.parse(String(row.header)) as Row }))
}
const idOf = (header: Header) => text(header.row.requestId) || header.key
function body(db: DatabaseSync, scope: string, key: string): Row | undefined {
  const row = db.prepare("SELECT body FROM records WHERE scope=? AND tableName='storySessionEntries' AND recordKey=?").get(scope, key)
  return row ? JSON.parse(String(row.body)) as Row : undefined
}
function eventsFor(db: DatabaseSync, scope: string, headers: Header[], at: number): ExecutionEvent[] {
  const current = headers[at], request = body(db, scope, current.key)
  if (!request) return []
  const previous = at > 0 ? body(db, scope, headers[at - 1].key) : undefined
  return projectRequestConversation({ entries: [], requests: previous ? [previous, request] : [request], snapshots: new Map() }).filter(event => event.apiIndex === (previous ? 2 : 1)).map(event => ({ ...event, apiIndex: Number(request.requestOrdinal) || at + 1 }))
}
function summaryOf(headers: Header[]): ExecutionSummary {
  const rows: Row[] = headers.map(header => ({ ...header.row, toolCalls: Array.from({ length: Number(header.row.toolCount) || 0 }, () => ({})) }))
  const starts = rows.map(row => Date.parse(text(row.startedAt))).filter(Number.isFinite), ends = rows.map(row => Date.parse(text(row.finishedAt) || text(row.startedAt))).filter(Number.isFinite)
  return { stats: executionStats(rows), duration: starts.length && ends.length ? `${Math.max(0, Math.round((Math.max(...ends) - Math.min(...starts)) / 1000))} 秒` : '未记录', model: text(rows.at(-1)?.model) }
}
export function executionPage(db: DatabaseSync, scope: string, options: ExecutionQuery, version: number): ExecutionPageResult {
  const headers = scopeHeaders(db, scope, options), summary = summaryOf(headers)
  const base = { summary, version, validRequestIds: headers.map(idOf), groups: [], hasEarlier: false }
  if (headers.some(header => header.row.format !== 'provider-request/v1')) return { ...base, legacy: true }
  const limit = Math.min(50, Math.max(1, Number(options.limit) || 20))
  let selected: Header[], hasEarlier = false
  if (options.since !== undefined) {
    const changed = new Set<number>()
    headers.forEach((header, index) => { if (header.version > options.since!) { changed.add(index); if (index + 1 < headers.length) changed.add(index + 1) } })
    selected = [...changed].sort((a, b) => a - b).map(index => headers[index])
  } else {
    const older = options.before ? headers.filter(header => text(header.row.startedAt) < options.before!.startedAt || text(header.row.startedAt) === options.before!.startedAt && idOf(header) < options.before!.requestId) : headers
    selected = older.slice(-limit); hasEarlier = older.length > selected.length
  }
  const groups = selected.map(header => {
    const events = eventsFor(db, scope, headers, headers.indexOf(header)).map(event => ({ ...event, content: '', thinking: '', toolCalls: event.toolCalls.map(call => ({ id: call.id, name: call.name })), execution: event.execution ? { name: event.execution.name, state: event.execution.state, isError: event.execution.isError } : undefined,
      entry: { requestId: idOf(header), version: header.version, hasContent: !!event.content, hasThinking: !!event.thinking, hasResult: event.execution?.result !== undefined || event.execution?.resultPreview !== undefined } }))
    return { request: { ...header.row, version: header.version }, events }
  })
  const first = selected[0]
  return { ...base, groups, hasEarlier, ...(first && options.since === undefined ? { nextBefore: { startedAt: text(first.row.startedAt), requestId: idOf(first) } } : {}) }
}
export function executionBody(db: DatabaseSync, scope: string, options: ExecutionQuery & { requestId: string; eventKey?: string }) {
  const headers = scopeHeaders(db, scope, options), at = headers.findIndex(header => idOf(header) === options.requestId)
  if (at < 0) throw new Error('执行详情已清理或不属于当前范围，请刷新。')
  if (options.eventKey) {
    const event = eventsFor(db, scope, headers, at).find(event => event.key === options.eventKey)
    if (!event) throw new Error('该消息已更新，请刷新后展开。')
    return { event }
  }
  const request = body(db, scope, headers[at].key)!
  const input = record(request.input), ids = ['systemPromptSnapshotId', 'businessPromptSnapshotId', 'toolSchemaSnapshotId'].map(key => text(input[key])).filter(Boolean)
  return { request, snapshots: ids.map(id => body(db, scope, id)).filter(Boolean) }
}
