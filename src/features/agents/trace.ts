import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessageEvent, Usage } from '@earendil-works/pi-ai'
import type { createWorkspace } from '../../lib/storage/workspace'
import type { ModelTraceEnd, ModelTraceHooks, ModelTraceStart, TracePurpose } from '../models/types'
import { canonical, records, strings } from './contracts'
import { estimateMessageTokens, observationTypes } from './context'
import type { AgentRepository, Row } from './repository'
import type { OrganizationMode, OrganizationState } from '../world/types'
import { getCurrentTools, toToolDeclaration } from '@earendil-works/pi-ai/utils/transcript'
import { sentMessages, toolDeclaration } from './requestPresentation'

export interface OrganizationStepIndexEntry { runId: string; runStartedAt: string; runStatus: string; mode: OrganizationMode; scope: 'fullBook' | 'character'; step: 'scan' | 'profiles' | 'relations'; kind: 'directory' | 'candidate' | 'profile' | 'relations'; objectKey: string; label: string; status?: string; outcome?: string | null; characterId?: string; requestCount: number; hasTrace: boolean; detailReady?: boolean }
export interface OrganizationRequestBefore { startedAt: string; requestId: string }
export interface OrganizationRequestPage { requests: Row[]; snapshots: Map<string, Row>; total: number; hasEarlier: boolean; nextBefore?: OrganizationRequestBefore }

export interface TraceIdentity {
  bookId: string; runId: string; executionId: string; taskId?: string; sessionId?: string
  contextId?: string; workId?: string; characterId?: string
}
export interface TraceSessionOptions {
  businessPrompt?: string
  purpose?: TracePurpose
  now?: () => number
  estimate?: () => Promise<{ usage: number; quota: number } | undefined>
}
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null
const text = (value: unknown) => typeof value === 'string' ? value : ''
const traceBytes = new Map<string, number>()
let tracePaused = 0
let traceOrdinal = 0
const nextTraceOrdinal = () => { traceOrdinal = Math.max(Date.now() * 1000, traceOrdinal + 1); return traceOrdinal }
const writers = new Set<TraceSession>()
const listeners = new Set<() => void>()
const hub = new Map<string, TraceSession[]>()

function digest(value: unknown): string {
  const input = canonical(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index++) { hash ^= input.charCodeAt(index); hash = Math.imul(hash, 0x01000193) }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`
}
function clone<T>(value: T): T {
  try { return structuredClone(value) } catch { return JSON.parse(JSON.stringify(value)) as T }
}
function preview(value: unknown): string {
  const content = typeof value === 'string' ? value : JSON.stringify(value)
  return content.length > 4000 ? `${content.slice(0, 4000)}…` : content
}
function messageParts(message: AgentMessage) {
  const content = Array.isArray((message as unknown as { content?: unknown }).content) ? (message as unknown as { content: Row[] }).content : []
  const textValue = content.filter(part => part.type === 'text').map(part => text(part.text)).join('')
  const thinking = content.filter(part => part.type === 'thinking').map(part => text(part.thinking ?? part.text)).join('')
  const tools = content.filter(part => part.type === 'toolCall').map(part => ({ toolCallId: text(part.id), name: text(part.name), arguments: part.arguments ?? null, state: 'pending' as const }))
  return { text: textValue, thinking, tools }
}
function usageOf(value: Usage | undefined) {
  if (!value) return null
  return {
    input: number(value.input), output: number(value.output), cacheRead: number(value.cacheRead), cacheWrite: number(value.cacheWrite),
    totalTokens: number(value.totalTokens), cost: (value.cost as Row | undefined)?.total ?? null,
    costStatus: value.cost ? 'estimated' : 'unknown', provider: 'reported',
  }
}
function identityOf(value: TraceIdentity) {
  return { bookId: value.bookId, runId: value.runId, executionId: value.executionId, ...(value.taskId ? { taskId: value.taskId } : {}), ...(value.sessionId ? { sessionId: value.sessionId } : {}), ...(value.contextId ? { contextId: value.contextId } : {}), ...(value.workId ? { unitId: value.workId } : {}), ...(value.characterId ? { characterId: value.characterId } : {}) }
}

export class TraceSession {
  readonly identity: TraceIdentity
  readonly hooks: ModelTraceHooks
  private readonly repo: AgentRepository
  private readonly options: TraceSessionOptions
  private readonly now: () => number
  private readonly records = new Map<string, Row>()
  private readonly snapshots = new Map<string, Row>()
  private readonly failedRefs = new Set<string>()
  private queue: Row[] = []
  private flushing?: Promise<void>
  private active?: string
  private ordinal = 0
  private stopped = false
  closed = false
  warning?: string
  private readonly subscriptions = new Set<() => void>()
  private notifyScheduled = false

  constructor(repo: AgentRepository, identity: TraceIdentity, options: TraceSessionOptions = {}) {
    this.repo = repo; this.identity = identity; this.options = options; this.now = options.now ?? Date.now
    this.hooks = { start: value => this.start(value), request: value => this.request(value), delta: value => this.delta(value), modelEnd: value => this.modelEnd(value) }
    writers.add(this)
    const list = hub.get(identity.bookId) ?? []; hub.set(identity.bookId, [...list.filter(row => row !== this), this].slice(-20))
    notifyHub()
  }

  subscribe(listener: () => void) {
    this.subscriptions.add(listener)
    return () => { this.subscriptions.delete(listener) }
  }
  private notify() {
    if (this.notifyScheduled) return
    this.notifyScheduled = true
    setTimeout(() => { this.notifyScheduled = false; this.subscriptions.forEach(listener => listener()); notifyHub() }, 80)
  }
  snapshot(): { records: Row[]; snapshots: Row[]; warning?: string } {
    return { records: [...this.records.values()].sort((a, b) => Number(a.requestOrdinal) - Number(b.requestOrdinal)), snapshots: [...this.snapshots.values()], ...(this.warning ? { warning: this.warning } : {}) }
  }
  record(requestId: string) { return this.records.get(requestId) }

  private start(value: ModelTraceStart) {
    if (this.stopped) return
    if (this.active) {
      const prior = this.records.get(this.active)
      if (prior && !prior.final) { if (prior.status === 'running') prior.status = 'interrupted'; prior.final = true; prior.finishedAt = prior.finishedAt ?? new Date(this.now()).toISOString(); this.enqueue(prior) }
    }
    const startedAt = value.startedAt
    const requestOrdinal = ++this.ordinal
    const messages = (value.context.messages ?? []) as AgentMessage[]
    const systemFromMessages = messages.filter(message => message.role === 'system').map(message => {
      const content = (message as unknown as { content?: unknown }).content
      return typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => text((part as Row).text)).join('') : ''
    }).join('\n')
    const system = text(value.context.systemPrompt) || systemFromMessages
    const business = text(this.options.businessPrompt)
    const promptSystemId = system ? `${this.identity.executionId}:prompt:system:${digest(system).slice(-8)}` : undefined
    const promptBusinessId = business ? `${this.identity.executionId}:prompt:business:${digest(business).slice(-8)}` : undefined
    const declared = getCurrentTools(messages)
    const tools = (declared.length ? declared : value.context.tools ?? []).map(toToolDeclaration)
    const toolId = tools?.length ? `${this.identity.executionId}:tools:${digest(tools).slice(-8)}` : undefined
    const snapshots: Row[] = []
    if (promptSystemId) snapshots.push(this.snapshotRow(promptSystemId, 'prompt_snapshot', { snapshotId: promptSystemId, promptKind: 'system', content: system, contentHash: digest(system), createdAt: startedAt }))
    if (promptBusinessId) snapshots.push(this.snapshotRow(promptBusinessId, 'prompt_snapshot', { snapshotId: promptBusinessId, promptKind: 'business', content: business, contentHash: digest(business), createdAt: startedAt }))
    if (toolId) snapshots.push(this.snapshotRow(toolId, 'tool_snapshot', { snapshotId: toolId, toolNames: (tools ?? []).map(tool => text(tool.name)), schema: tools ?? [], schemaHash: digest(tools), createdAt: startedAt }))
    const freshSnapshots = snapshots.filter(row => !this.snapshots.has(text(row.snapshotId)))
    freshSnapshots.forEach(row => this.snapshots.set(text(row.snapshotId), row))
    const input = {
      ...(promptSystemId ? { systemPromptSnapshotId: promptSystemId } : {}), ...(promptBusinessId ? { businessPromptSnapshotId: promptBusinessId } : {}), ...(toolId ? { toolSchemaSnapshotId: toolId } : {}),
      messageFormat: 'pi-agent-message/v1', messages: clone(messages.map(message => {
        const { toolsAdded: _added, toolsRemoved: _removed, ...content } = message as Row
        return content
      })), messageHashes: messages.map(message => digest(message)),
      estimatedContextTokens: messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0), completeness: 'complete' as const,
    }
    const record: Row = {
      id: `trace:${value.requestId}`, traceId: value.requestId, type: 'request_trace', ...identityOf(this.identity), requestId: value.requestId,
      ...(value.parentRequestId ? { parentRequestId: value.parentRequestId } : {}), requestOrdinal, purpose: value.purpose,
      model: `${value.model.providerId}/${value.model.modelId}`, status: 'running', startedAt, input,
      thinking: '', text: '', toolCalls: [], usage: null, attemptIds: [], complete: true, final: false, createdAt: startedAt,
      sessionId: this.identity.sessionId, bookId: this.identity.bookId, ordinal: nextTraceOrdinal(), parentId: null,
    }
    this.records.set(value.requestId, record); this.active = value.requestId
    freshSnapshots.forEach(row => this.enqueue(row))
    this.enqueue(record)
    this.notify()
  }

  private request(value: { requestId: string; attemptId: string; body: Row }) {
    const record = this.records.get(value.requestId)
    if (!record) return
    const { messages: _messages, input: _input, system: _system, instructions: _instructions, tools: _tools, ...parameters } = value.body
    const messages = sentMessages(value.body)
    const tools = records(value.body.tools).map(toolDeclaration)
    const snapshotId = `${this.identity.executionId}:tools:${digest(tools).slice(-8)}`
    const snapshot = this.snapshotRow(snapshotId, 'tool_snapshot', { snapshotId, toolNames: tools.map(tool => text(tool.name)), schema: tools, schemaHash: digest(tools), createdAt: record.startedAt })
    if (!this.snapshots.has(snapshotId)) { this.snapshots.set(snapshotId, snapshot); this.enqueue(snapshot) }
    const prior = record.input as Row
    const attempts = strings(prior.transportAttemptIds)
    if (attempts.length && !attempts.includes(value.attemptId)) {
      // 重试是新的响应，不能把失败尝试的片段拼入本次输出。
      record.text = ''; record.thinking = ''; record.toolCalls = []
    }
    record.input = { ...prior, messages: clone(messages), messageHashes: messages.map(message => digest(message)), messageFormat: 'provider-request/v1',
      toolSchemaSnapshotId: snapshotId, requestParameters: parameters, transportAttemptIds: [...attempts, value.attemptId] }
    this.enqueue(record); this.notify()
  }

  private delta(value: { requestId: string; event: AssistantMessageEvent }) {
    const record = this.records.get(value.requestId)
    if (!record) return
    const update = value.event
    if (update.type === 'text_delta') record.text = text(record.text) + update.delta
    else if (update.type === 'thinking_delta') record.thinking = text(record.thinking) + update.delta
    else if (update.type === 'toolcall_end') this.upsertTool(record, update.toolCall.id, { name: update.toolCall.name, arguments: update.toolCall.arguments, state: 'pending' })
    else return
    this.notify()
  }

  private modelEnd(value: ModelTraceEnd) {
    const record = this.records.get(value.requestId)
    if (!record) return
    const message = value.message
    const parts = message ? messageParts(message) : { text: '', thinking: '', tools: [] }
    record.status = value.status
    record.modelFinishedAt = new Date(this.now()).toISOString()
    record.finishedAt = record.finishedAt ?? record.modelFinishedAt
    // 有些最终消息只带工具调用或错误；保留本次流式响应已返回的可见内容。
    record.text = parts.text || text(record.text)
    record.thinking = parts.thinking || text(record.thinking)
    const prior = Array.isArray(record.toolCalls) ? record.toolCalls as Row[] : []
    record.toolCalls = parts.tools.map(tool => ({ ...(prior.find(row => row.toolCallId === tool.toolCallId) ?? {}), ...tool }))
    record.usage = usageOf(value.usage)
    record.attemptIds = value.attempts.map(attempt => attempt.attemptId).filter((id): id is string => !!id)
    if (value.status !== 'succeeded' || this.options.purpose !== 'work') record.final = true
    ;(record.input as Row).providerInputTokens = number(value.usage?.input)
    ;(record.input as Row).providerCacheReadTokens = number(value.usage?.cacheRead)
    if (value.error) record.error = { code: value.error.kind, message: value.error.message, status: value.error.status ?? null, recoverable: !['auth', 'cancelled'].includes(value.error.kind) }
    if (message?.stopReason === 'error' || message?.stopReason === 'aborted') record.status = message.stopReason === 'aborted' ? 'cancelled' : 'failed'
    this.enqueue(record); this.notify()
  }

  handleEvent(event: AgentEvent) {
    if (!this.active) return
    const record = this.records.get(this.active)
    if (!record) return
    if (event.type === 'message_update') {
      const update = event.assistantMessageEvent
      if (update.type === 'text_delta') { if (!record.modelFinishedAt) record.text = text(record.text) + update.delta }
      else if (update.type === 'thinking_delta') { if (!record.modelFinishedAt) record.thinking = text(record.thinking) + update.delta }
      else if (update.type === 'toolcall_end') this.upsertTool(record, update.toolCall.id, { name: update.toolCall.name, arguments: update.toolCall.arguments, state: 'pending' })
      this.notify(); return
    }
    if (event.type === 'message_end') {
      if (event.message.role !== 'assistant') return
      const parts = messageParts(event.message)
      record.text = parts.text || text(record.text); record.thinking = parts.thinking || text(record.thinking)
      for (const tool of parts.tools) this.upsertTool(record, tool.toolCallId, tool)
      this.enqueue(record); this.notify(); return
    }
    if (event.type === 'tool_execution_start') { this.upsertTool(record, event.toolCallId, { name: event.toolName, arguments: event.args, state: 'running', startedAt: new Date(this.now()).toISOString() }); this.notify(); return }
    if (event.type === 'tool_execution_update') { this.upsertTool(record, event.toolCallId, { name: event.toolName, arguments: event.args, state: 'running', resultPreview: preview(event.partialResult) }); this.notify(); return }
    if (event.type === 'tool_execution_end') {
      this.upsertTool(record, event.toolCallId, { name: event.toolName, result: event.result, resultPreview: preview(event.result), state: event.isError ? 'failed' : 'succeeded', isError: event.isError, finishedAt: new Date(this.now()).toISOString() })
      this.enqueue(record); this.notify(); return
    }
    if (event.type === 'turn_end') {
      const parts = messageParts(event.message)
      record.text = parts.text || text(record.text); record.thinking = parts.thinking || text(record.thinking)
      for (const result of event.toolResults) {
        const id = text((result as Row).toolCallId)
        if (id) this.upsertTool(record, id, { toolName: text((result as Row).toolName), result, resultPreview: preview(result), state: (result as Row).isError ? 'failed' : 'succeeded', isError: !!(result as Row).isError, finishedAt: new Date(this.now()).toISOString() })
      }
      record.status = record.status === 'running' ? 'succeeded' : record.status
      record.finishedAt = new Date(this.now()).toISOString(); record.final = true
      this.enqueue(record); this.notify(); return
    }
    if (event.type === 'agent_end') {
      if (record.status === 'running') { record.status = 'interrupted'; record.finishedAt = new Date(this.now()).toISOString(); record.final = true; this.enqueue(record); this.notify() }
      this.active = undefined
    }
  }

  private upsertTool(record: Row, id: string, patch: Row) {
    if (!id) return
    const list = Array.isArray(record.toolCalls) ? record.toolCalls as Row[] : []
    const index = list.findIndex(row => row.toolCallId === id)
    if (index < 0) list.push({ toolCallId: id, ...patch }); else list[index] = { ...list[index], ...patch }
    record.toolCalls = list
  }

  private snapshotRow(id: string, type: string, value: Row): Row {
    return { id, type, ...identityOf(this.identity), sessionId: this.identity.sessionId, bookId: this.identity.bookId, ordinal: nextTraceOrdinal(), parentId: null, createdAt: text(value.createdAt) || new Date(this.now()).toISOString(), ...value }
  }

  private enqueue(row: Row) {
    if (this.stopped) return
    this.queue.push(clone(row))
    void this.flush()
  }

  async flush(): Promise<void> {
    if (this.flushing) { await this.flushing; if (this.queue.length) await this.flush(); return }
    if (tracePaused || !this.queue.length) return
    this.flushing = (async () => {
      while (this.queue.length && !tracePaused && !this.stopped) {
        const batch = [...new Map(this.queue.splice(0, 20).map(row => [String(row.id), row])).values()]
        let prepared: Row[]
        try { prepared = await this.prepare(batch) } catch { this.warning = '日志未保存：容量检查失败。'; this.notify(); continue }
        if (!prepared.length) continue
        const degraded = prepared.some(row => row.truncated === true || row.complete === false)
        try {
          const size = prepared.reduce((sum, row) => sum + canonical(row).length, 0)
          await this.repo.tracePut(prepared)
          traceBytes.set(this.identity.bookId, (traceBytes.get(this.identity.bookId) ?? 0) + size)
          this.warning = degraded ? '日志已降级：浏览器存储空间不足，仅保存摘要。' : undefined
        } catch (error) {
          for (const row of batch) if (row.type === 'prompt_snapshot' || row.type === 'tool_snapshot') this.failedRefs.add(text(row.snapshotId ?? row.id))
          const requests = prepared.filter(row => row.type === 'request_trace')
          if (requests.length && prepared.some(row => row.type !== 'request_trace')) {
            const fallback = requests.map(row => {
              const input = { ...(row.input as Row) }
              const refs = [input.systemPromptSnapshotId, input.businessPromptSnapshotId, input.toolSchemaSnapshotId].filter((value): value is string => typeof value === 'string')
              input.completeness = 'partial'; input.incompleteReason = '快照写入失败，引用缺失。'
              return { ...row, input, complete: false, missingRefs: refs }
            })
            try { await this.repo.tracePut(fallback); this.warning = '日志不完整：快照写入失败。'; this.notify(); continue } catch { /* 记录原始失败 */ }
          }
          this.warning = `日志保存失败：${error instanceof Error ? error.message : '未知原因'}`; this.notify()
        }
      }
    })()
    try { await this.flushing } finally { this.flushing = undefined; if (this.closed && !this.queue.length) writers.delete(this) }
  }

  private async prepare(inputRows: Row[]): Promise<Row[]> {
    const rows = inputRows.map(row => this.markFailedRefs(row))
    if (this.repo.storage === 'disk') return rows
    const estimate = this.options.estimate ? await this.options.estimate() : typeof navigator !== 'undefined' && navigator.storage?.estimate ? await navigator.storage.estimate().then(value => value.quota ? { usage: value.usage ?? 0, quota: value.quota } : undefined).catch(() => undefined) : undefined
    if (!estimate) return rows
    const free = estimate.quota - estimate.usage
    const bookBytes = traceBytes.get(this.identity.bookId) ?? rows.reduce((sum, row) => sum + canonical(row).length, 0)
    const soft = free < estimate.quota * 0.2 || bookBytes > estimate.quota * 0.15
    const hard = free < estimate.quota * 0.1
    if (hard) { this.stopped = true; this.warning = '日志未保存：浏览器存储空间不足。'; this.notify(); return [] }
    if (!soft) return rows
    return rows.map(row => {
      if (row.type === 'prompt_snapshot') return { ...row, content: '[存储空间不足，未保存完整提示词]', truncated: true }
      if (row.type === 'tool_snapshot') return { ...row, schema: [], truncated: true }
      if (row.type === 'request_trace') {
        const input = { ...(row.input as Row) }; input.completeness = 'partial'; input.incompleteReason = '浏览器存储空间不足，仅保存摘要。'
        input.messages = Array.isArray(input.messages) ? input.messages.map(message => ({ role: (message as Row).role, content: [{ type: 'text', text: '[存储空间不足，未保存完整内容]' }], timestamp: (message as Row).timestamp })) : []
        delete input.requestParameters
        const toolCalls = Array.isArray(row.toolCalls) ? (row.toolCalls as Row[]).map(tool => ({ ...tool, ...(tool.result !== undefined ? { result: undefined, resultPreview: preview(tool.result), resultTruncated: true } : {}) })) : []
        return { ...row, input, toolCalls, complete: false }
      }
      return row
    })
  }

  private markFailedRefs(row: Row): Row {
    if (row.type !== 'request_trace' || !row.input || typeof row.input !== 'object') return row
    const input = row.input as Row
    const refs = [input.systemPromptSnapshotId, input.businessPromptSnapshotId, input.toolSchemaSnapshotId].filter((value): value is string => typeof value === 'string' && this.failedRefs.has(value))
    if (!refs.length) return row
    return { ...row, complete: false, missingRefs: refs, input: { ...input, completeness: 'partial', incompleteReason: '快照写入失败，引用缺失。' } }
  }

  async close() {
    this.closed = true
    this.notify()
    if (this.active) {
      const record = this.records.get(this.active)
      if (record && record.status === 'running') { record.status = 'interrupted'; record.finishedAt = new Date(this.now()).toISOString(); record.final = true; this.enqueue(record) }
      else if (record && !record.final) { record.final = true; record.finishedAt = record.finishedAt ?? new Date(this.now()).toISOString(); this.enqueue(record) }
      this.active = undefined
    }
    await this.flush()
    if (this.stopped) this.queue = []
    if (!this.queue.length) writers.delete(this)
  }
}

function notifyHub() { listeners.forEach(listener => listener()) }
export function subscribeTraceHub(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function traceSessions(bookId: string) { return hub.get(bookId) ?? [] }
export async function flushTraceWriters() { await Promise.all([...writers].map(session => session.flush())) }
export async function withTraceBarrier<T>(work: () => Promise<T>): Promise<T> {
  tracePaused++
  try { await flushTraceWriters(); return await work() } finally { tracePaused = Math.max(0, tracePaused - 1); if (!tracePaused) void flushTraceWriters() }
}
const traceUnit = (row: Row) => text(row.unitId) || text(row.workId)
const traceRequestId = (row: Row) => text(row.requestId) || text(row.id)

function originOf(group: Row, decision: Row | undefined, mode: OrganizationMode) {
  const origin = text(group.originStep) || text(decision?.originStep)
  if (origin === 'scan' || origin === 'resolve' || origin === 'profiles' || origin === 'relations') return origin
  return mode === 'full' ? 'scan' : mode
}

// 三个步骤同时请求索引时共享一次读取；请求完成即释放，后续刷新仍读取新数据。
const indexReads = new WeakMap<object, Promise<{ runs: Row[]; counts: Map<string, number>; ready: Map<string, boolean> }>>()
async function organizationIndexData(workspace: ReturnType<typeof createWorkspace>, bookId: string) {
  const db = workspace.openBook(bookId)
  const pending = indexReads.get(db)
  if (pending) return pending
  const read = (async () => {
    const runs = (await db.table('pipelineRuns').toArray()).filter(row => row.bookId === bookId && row.workflow === 'character_organization_v1' && row.organization)
    const runIds = new Set(runs.map(row => text(row.id)))
    const sessionIds = [...new Set(runs.map(row => text(row.sessionId)).filter(Boolean))]
    const traces = runs.length === 0 ? [] : runs.every(row => text(row.sessionId))
      ? await db.table('storySessionEntries').where('sessionId').anyOf(sessionIds).toArray()
      : await db.table('storySessionEntries').where('type').equals('request_trace').toArray()
    const counts = new Map<string, number>()
    const ready = new Map<string, boolean>()
    for (const row of traces) if (row.type === 'request_trace' && runIds.has(text(row.runId))) {
      const key = `${text(row.runId)}|${traceUnit(row)}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
      ready.set(key, (ready.get(key) ?? true) && row.final === true && row.complete !== false)
    }
    return { runs, counts, ready }
  })()
  indexReads.set(db, read)
  try { return await read } finally { indexReads.delete(db) }
}

export async function readOrganizationStepIndex(workspace: ReturnType<typeof createWorkspace>, bookId: string, step: 'scan' | 'profiles' | 'relations'): Promise<OrganizationStepIndexEntry[]> {
  const { runs, counts, ready } = await organizationIndexData(workspace, bookId)
  const entries: OrganizationStepIndexEntry[] = []
  for (const run of runs.sort((a, b) => text(b.startedAt).localeCompare(text(a.startedAt)))) {
    const organization = run.organization as unknown as OrganizationState
    const mode = (organization.mode ?? 'full') as OrganizationMode
    const scope: 'fullBook' | 'character' = run.scope === 'character' ? 'character' : 'fullBook'
    const base = { runId: text(run.id), runStartedAt: text(run.startedAt), runStatus: text(run.status), mode, scope }
    const push = (entry: Omit<OrganizationStepIndexEntry, 'runId' | 'runStartedAt' | 'runStatus' | 'mode' | 'scope' | 'requestCount' | 'hasTrace'>) => {
      const count = counts.get(`${base.runId}|${entry.objectKey}`) ?? (scope === 'character' ? [...counts.entries()].filter(([key]) => key.startsWith(`${base.runId}|`)).reduce((sum, [, value]) => sum + value, 0) : 0)
      entries.push({ ...base, ...entry, requestCount: count, hasTrace: count > 0, detailReady: ready.get(`${base.runId}|${entry.objectKey}`) ?? false })
    }
    if (step === 'scan') {
      for (const page of records(organization.scanPages)) push({ step, kind: 'directory', objectKey: `directory:${text(page.pageId)}`, label: `目录页 ${text(page.pageId)}`, status: text(page.status) })
      const decisions = records(organization.candidateDecisions)
      const groups = records(organization.candidateGroups)
      const ids = new Set([...groups.map(group => text(group.id)), ...decisions.map(decision => text(decision.groupId))])
      for (const id of ids) {
        const group = groups.find(row => text(row.id) === id) ?? {}
        const decision = decisions.find(row => text(row.groupId) === id)
        if (scope === 'character') continue
        const origin = originOf(group, decision, mode)
        if (origin !== 'scan' && origin !== 'resolve') continue
        const names = strings(group.memberNames).length ? strings(group.memberNames) : strings(decision?.memberNames)
        push({ step, kind: 'candidate', objectKey: `candidate:${id}`, label: `疑似组 ${names.join('、') || id}`, status: decision ? 'resolved' : text(group.status), outcome: decision ? text(decision.outcome) : null })
      }
    } else {
      const items = step === 'profiles' ? records(organization.profileItems) : records(organization.relationItems)
      for (const item of items) {
        const id = text(item.id)
        push({ step, kind: step === 'profiles' ? 'profile' : 'relations', objectKey: `${step === 'profiles' ? 'profile' : 'relations'}:${id}`, label: `${text(item.name) || id}（${id}）`, status: text(item.status), ...(text(item.outcome) ? { outcome: text(item.outcome) } : {}), characterId: id })
      }
      if (scope === 'fullBook') {
        const decisions = records(organization.candidateDecisions)
        const groups = records(organization.candidateGroups)
        const ids = new Set([...groups.map(group => text(group.id)), ...decisions.map(decision => text(decision.groupId))])
        for (const id of ids) {
          const group = groups.find(row => text(row.id) === id) ?? {}
          const decision = decisions.find(row => text(row.groupId) === id)
          if (originOf(group, decision, mode) !== step) continue
          const names = strings(group.memberNames).length ? strings(group.memberNames) : strings(decision?.memberNames)
          push({ step, kind: 'candidate', objectKey: `candidate:${id}`, label: `疑似组 ${names.join('、') || id}`, status: decision ? 'resolved' : text(group.status), outcome: decision ? text(decision.outcome) : null })
        }
      }
    }
  }
  return entries
}

export async function readOrganizationRequests(workspace: ReturnType<typeof createWorkspace>, bookId: string, query: { runId: string; step: 'scan' | 'profiles' | 'relations'; objectKey: string; before?: OrganizationRequestBefore; limit?: number }): Promise<OrganizationRequestPage> {
  const db = workspace.openBook(bookId)
  const run = await db.table('pipelineRuns').get(query.runId)
  const organization = run?.organization as unknown as OrganizationState | undefined
  if (!run?.organization || !organization) return { requests: [], snapshots: new Map(), total: 0, hasEarlier: false }
  const mode = (organization.mode ?? 'full') as OrganizationMode
  const scope: 'fullBook' | 'character' = run.scope === 'character' ? 'character' : 'fullBook'
  if (workspace.disk) {
    if (scope === 'character' && (mode === 'profile' ? query.step !== 'profiles' : query.step !== 'relations')) return { requests: [], snapshots: new Map(), total: 0, hasEarlier: false }
    const page = await workspace.disk<{ rows: Row[]; total: number; hasEarlier: boolean }>({ action: 'tracePage', scope: `book:${bookId}`, options: { runId: query.runId, ...(scope === 'character' ? {} : { unitId: query.objectKey }), before: query.before, limit: query.limit } })
    const snapshots = await diskTraceSnapshots(db, page.rows)
    const first = page.rows[0]
    return { requests: page.rows, snapshots, total: page.total, hasEarlier: page.hasEarlier, ...(first ? { nextBefore: { startedAt: text(first.startedAt), requestId: traceRequestId(first) } } : {}) }
  }
  const rows = (await db.table('storySessionEntries').toArray()).filter(row => row.type === 'request_trace' && row.runId === query.runId)
  const selected = rows.filter(row => {
    const unit = traceUnit(row)
    if (scope === 'character') return mode === 'profile' ? query.step === 'profiles' : query.step === 'relations'
    return unit === query.objectKey
  }).sort((a, b) => text(a.startedAt).localeCompare(text(b.startedAt)) || traceRequestId(a).localeCompare(traceRequestId(b)))
  const older = query.before ? selected.filter(row => {
    const at = text(row.startedAt), id = traceRequestId(row)
    return at < query.before!.startedAt || at === query.before!.startedAt && id < query.before!.requestId
  }) : selected
  const limit = Math.max(1, query.limit ?? 50)
  const requests = older.slice(-limit)
  const referenced = new Set<string>()
  for (const row of requests) {
    const input = row.input && typeof row.input === 'object' ? row.input as Row : {}
    for (const key of ['systemPromptSnapshotId', 'businessPromptSnapshotId', 'toolSchemaSnapshotId']) if (typeof input[key] === 'string') referenced.add(input[key] as string)
  }
  const snapshots = (await db.table('storySessionEntries').toArray()).filter(row => row.type !== 'request_trace' && referenced.has(String(row.snapshotId ?? row.id)))
  const first = requests[0]
  return { requests, snapshots: new Map(snapshots.map(row => [String(row.snapshotId ?? row.id), row])), total: selected.length, hasEarlier: older.length > requests.length, ...(first ? { nextBefore: { startedAt: text(first.startedAt), requestId: traceRequestId(first) } } : {}) }
}

export interface ExecutionChain { entries: Row[]; requests: Row[]; snapshots: Map<string, Row>; runStatus?: string }

export async function readExecutionChain(workspace: ReturnType<typeof createWorkspace>, bookId: string, runId: string, options: { unitId?: string; contextId?: string; sessionId?: string } = {}): Promise<ExecutionChain> {
  const db = workspace.openBook(bookId)
  const run = await db.table('pipelineRuns').get(runId)
  if (!run) return { entries: [], requests: [], snapshots: new Map() }
  const sessionId = text(options.sessionId) || text(run.sessionId)
  const all = sessionId ? await db.table('storySessionEntries').where('sessionId').equals(sessionId).toArray() : await db.table('storySessionEntries').toArray()
  const unitId = text(options.unitId)
  const targeted = run.scope === 'character'
  const entries = all.filter(row => {
    if (row.type !== 'message' && row.type !== 'compaction') return false
    if (sessionId && row.sessionId !== sessionId) return false
    if (unitId && !targeted && row.unitId !== unitId) return false
    if (!unitId && options.contextId && row.contextId && row.contextId !== options.contextId) return false
    return true
  }).sort((a, b) => Number(a.ordinal) - Number(b.ordinal))
  const requests = all.filter(row => row.type === 'request_trace' && row.runId === runId && (!unitId || targeted || (text(row.unitId) || text(row.workId)) === unitId))
    .sort((a, b) => Number(a.requestOrdinal) - Number(b.requestOrdinal))
  const referenced = new Set<string>()
  for (const row of requests) {
    const input = row.input && typeof row.input === 'object' ? row.input as Row : {}
    for (const key of ['systemPromptSnapshotId', 'businessPromptSnapshotId', 'toolSchemaSnapshotId']) if (typeof input[key] === 'string') referenced.add(input[key] as string)
  }
  const snapshots = all.filter(row => row.type !== 'request_trace' && referenced.has(String(row.snapshotId ?? row.id)))
  return { entries, requests, snapshots: new Map(snapshots.map(row => [String(row.snapshotId ?? row.id), row])), runStatus: text(run.status) }
}

export async function readBookTrace(workspace: ReturnType<typeof createWorkspace>, bookId: string, runId?: string, options: { limit?: number; offset?: number } = {}) {
  const db = workspace.openBook(bookId)
  if (workspace.disk) {
    const page = await workspace.disk<{ rows: Row[]; total: number }>({ action: 'tracePage', scope: `book:${bookId}`, options: { ...options, runId } })
    const snapshots = await diskTraceSnapshots(db, page.rows)
    const leases = await db.table('pipelineRuns').where('recordType').equals('lease').toArray()
    return { requests: page.rows, snapshots, total: page.total, leaseActive: leases.some(row => (!runId || row.runId === runId) && Number(row.expiresAt ?? 0) > Date.now()), warning: '' }
  }
  const rows = (await db.table('storySessionEntries').toArray()).filter(row => row.bookId === bookId && typeof row.type === 'string' && observationTypes.has(row.type))
  const requests = rows.filter(row => row.type === 'request_trace' && typeof row.requestId === 'string' && (!runId || row.runId === runId)).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
  const limit = Math.max(1, options.limit ?? 50), offset = Math.max(0, options.offset ?? 0)
  const page = requests.slice(Math.max(0, requests.length - limit - offset), requests.length - offset)
  const referenced = new Set<string>()
  for (const row of page) {
    const input = row.input && typeof row.input === 'object' ? row.input as Row : {}
    for (const key of ['systemPromptSnapshotId', 'businessPromptSnapshotId', 'toolSchemaSnapshotId']) if (typeof input[key] === 'string') referenced.add(input[key] as string)
  }
  const snapshots = new Map(rows.filter(row => row.type !== 'request_trace' && referenced.has(String(row.snapshotId ?? row.id))).map(row => [String(row.snapshotId ?? row.id), row]))
  const leases = (await db.table('pipelineRuns').where('recordType').equals('lease').toArray()).filter(row => row.bookId === bookId && (!runId || row.runId === runId))
  return { requests: page, snapshots, total: requests.length, leaseActive: leases.some(row => Number(row.expiresAt ?? 0) > Date.now()), warning: '' }
}

async function diskTraceSnapshots(db: ReturnType<ReturnType<typeof createWorkspace>['openBook']>, requests: Row[]) {
  const ids = new Set<string>()
  for (const row of requests) {
    const input = (row.input ?? {}) as Row
    for (const field of ['systemPromptSnapshotId', 'businessPromptSnapshotId', 'toolSchemaSnapshotId']) if (typeof input[field] === 'string') ids.add(input[field] as string)
  }
  const rows = await db.table('storySessionEntries').bulkGet([...ids])
  return new Map(rows.filter((row): row is Row => !!row).map(row => [String(row.snapshotId ?? row.id), row]))
}
