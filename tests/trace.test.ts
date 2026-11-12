import { expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import type { Context } from '@earendil-works/pi-ai'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createMemoryAgentRepository } from '../src/features/agents/repository'
import { isObservationEntry, projectSession } from '../src/features/agents/context'
import { readBookTrace, TraceSession } from '../src/features/agents/trace'
import { markMissingTraceRefs } from '../src/features/backup/codec'
import type { BookTables } from '../src/features/backup/data'
import { messageRows, sentMessages } from '../src/features/agents/requestPresentation'

const bookId = 'trace-book'
const sessionId = 'session-trace'
const context = {
  systemPrompt: '系统提示词',
  messages: [
    { role: 'user' as const, content: '整理贾政', timestamp: 1 },
    { role: 'assistant' as const, content: [{ type: 'toolCall' as const, id: 'call-1', name: 'submit_profile_review', arguments: { characterId: '贾政', done: true } }], timestamp: 2 },
    { role: 'toolResult' as const, toolCallId: 'call-1', toolName: 'submit_profile_review', content: [{ type: 'text' as const, text: '已提交' }], isError: false, timestamp: 3 },
  ],
  tools: [{ name: 'submit_profile_review', description: '提交', parameters: { type: 'object', properties: { done: { type: 'boolean' } } } }],
} as unknown as Context

async function fixture() {
  const repo = createMemoryAgentRepository(bookId, { storySessions: [{ id: sessionId, bookId, profile: 'asset_editor', status: 'active', leafId: null, nextOrdinal: 1 }] })
  return repo
}

it('实际发送体覆盖SDK上下文，只保存一份模型工具声明，重试保持同一请求', async () => {
  const repo = await fixture()
  const trace = new TraceSession(repo, { bookId, runId: 'run-wire', executionId: 'exec-wire', taskId: 'task-wire', sessionId })
  const withDeclarations = { ...context, messages: [{ ...context.messages[0], toolsAdded: [{ name: 'sdk_tool', description: 'SDK声明', parameters: { type: 'object' }, outputSchema: { type: 'object' }, label: '内部标签' }] }] } as unknown as Context
  trace.hooks.start({ requestId: 'wire', purpose: 'work', model: { providerId: 'custom', modelId: 'fixture' }, context: withDeclarations, turn: 1, startedAt: '2026-11-11T00:00:00.000Z' })
  expect(JSON.stringify(trace.snapshot())).not.toMatch(/toolsAdded|outputSchema|内部标签/)
  const body = { model: 'fixture', stream: true, messages: [{ role: 'system', content: '实际SYSTEM' }, { role: 'user', content: '实际USER' }], tools: [{ type: 'function', function: { name: 'one_tool', description: '参数', parameters: { type: 'object' } } }] }
  trace.hooks.request!({ requestId: 'wire', attemptId: 'attempt-1', body })
  trace.hooks.request!({ requestId: 'wire', attemptId: 'attempt-2', body })
  const snapshot = trace.snapshot()
  expect(snapshot.records).toHaveLength(1)
  const input = snapshot.records[0].input as Record<string, unknown>
  expect(input).toMatchObject({ messageFormat: 'provider-request/v1', messages: body.messages, requestParameters: { model: 'fixture', stream: true }, transportAttemptIds: ['attempt-1', 'attempt-2'] })
  expect(snapshot.snapshots.find(row => row.snapshotId === input.toolSchemaSnapshotId)?.schema).toEqual([body.tools[0].function])
  expect(JSON.stringify(input.messages)).not.toMatch(/toolsAdded|outputSchema|整理贾政/)
  await trace.close()
})

it('Responses与Anthropic消息按实际输入角色展示，工具结果不伪装成用户正文', () => {
  expect(messageRows(sentMessages({ instructions: '规则', input: [{ type: 'function_call', name: 'read', arguments: '{}' }, { type: 'function_call_output', output: '结果' }] })).map(row => row.role)).toEqual(['system', 'assistant', 'tool'])
  expect(messageRows(sentMessages({ system: [{ type: 'text', text: '规则' }], messages: [{ role: 'user', content: [{ type: 'tool_result', content: '结果' }, { type: 'text', text: '继续' }] }] }))).toEqual([{ role: 'system', content: [{ type: 'text', text: '规则' }] }, { role: 'tool', content: '结果' }, { role: 'user', content: [{ type: 'text', text: '继续' }] }])
})

it('记录最终结构化输入、快照、工具和用量，并把观测条目排除在上下文之外', async () => {
  const repo = await fixture()
  const trace = new TraceSession(repo, { bookId, runId: 'run-1', executionId: 'exec-1', taskId: 'task-1', sessionId, workId: 'profile:贾政', characterId: '贾政' }, { businessPrompt: '业务要求' })
  let requestId = ''
  const hooks = trace.hooks
  hooks.start({ requestId: 'request-1', purpose: 'work', model: { providerId: 'custom', modelId: 'fixture' }, context, turn: 1, startedAt: '2026-11-08T00:00:00.000Z' })
  requestId = 'request-1'
  hooks.delta?.({ requestId, event: { type: 'text_delta', contentIndex: 0, delta: '处理中', partial: { role: 'assistant', content: [], timestamp: 1 } } as never })
  expect((trace.snapshot().records[0].text as string)).toContain('处理中')
  hooks.modelEnd({ requestId, message: { role: 'assistant', content: [{ type: 'text', text: '处理完成' }, { type: 'toolCall', id: 'call-1', name: 'submit_profile_review', arguments: { characterId: '贾政', done: true } }], usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', api: 'openai-completions', provider: 'custom', model: 'fixture', timestamp: 4 } as never, usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, attempts: [{ ordinal: 1, turn: 1, elapsedMs: 1, requestId, attemptId: 'attempt-1' }], status: 'succeeded' })
  trace.handleEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'submit_profile_review', args: { characterId: '贾政', done: true } })
  trace.handleEvent({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'submit_profile_review', result: { content: [{ type: 'text', text: '已提交' }] }, isError: false } as AgentEvent)
  trace.handleEvent({ type: 'turn_end', message: { role: 'assistant', content: [], timestamp: 5 } as never, toolResults: [] })
  await trace.close()
  const rows = await repo.traceRows()
  const request = rows.find(row => row.type === 'request_trace')!
  expect(request).toMatchObject({ requestId, runId: 'run-1', executionId: 'exec-1', status: 'succeeded', complete: true, final: true })
  const input = request.input as Record<string, unknown>
  expect(input.completeness).toBe('complete')
  expect((input.messages as Record<string, unknown>[])[1]).toMatchObject({ role: 'assistant' })
  expect(JSON.stringify(input.messages)).toContain('submit_profile_review')
  expect(JSON.stringify(input.messages)).toContain('toolResult')
  expect((request.toolCalls as Record<string, unknown>[])[0]).toMatchObject({ toolCallId: 'call-1', name: 'submit_profile_review', state: 'succeeded' })
  expect((request.usage as Record<string, unknown>)).toMatchObject({ input: 100, output: 20, cacheRead: 30 })
  expect(rows.some(row => row.type === 'prompt_snapshot' && row.content === '业务要求')).toBe(true)
  expect(rows.some(row => row.type === 'tool_snapshot' && Array.isArray(row.schema))).toBe(true)
  expect(rows.every(row => Number(row.ordinal) >= 0 && row.parentId === null)).toBe(true)
  const projected = projectSession([...rows, { id: 'message-1', sessionId, bookId, ordinal: 1, parentId: null, createdAt: 'x', type: 'message', message: { role: 'user', content: '业务要求', timestamp: 1 } }], 'message-1')
  expect(projected.messages).toEqual([{ role: 'user', content: '业务要求', timestamp: 1 }])
  expect(rows.some(isObservationEntry)).toBe(true)
})

it('浏览器配额紧张时降级保存并标记不完整，业务观测写入仍可用', async () => {
  const repo = await fixture()
  const trace = new TraceSession(repo, { bookId, runId: 'run-2', executionId: 'exec-2', taskId: 'task-2', sessionId }, { businessPrompt: '业务要求', estimate: async () => ({ usage: 85, quota: 100 }) })
  trace.hooks.start({ requestId: 'request-2', purpose: 'work', model: { providerId: 'custom', modelId: 'fixture' }, context, turn: 1, startedAt: '2026-11-08T00:00:00.000Z' })
  trace.hooks.request!({ requestId: 'request-2', attemptId: 'quota-attempt', body: { messages: [{ role: 'user', content: '全文' }], model: 'fixture', tools: [] } })
  trace.hooks.modelEnd({ requestId: 'request-2', attempts: [], status: 'succeeded' })
  await trace.close()
  const request = (await repo.traceRows()).find(row => row.type === 'request_trace' && row.requestId === 'request-2')!
  expect(request.complete).toBe(false)
  expect((request.input as Record<string, unknown>).completeness).toBe('partial')
  expect(request.input).not.toHaveProperty('requestParameters')
  expect(((request.input as Record<string, unknown>).messages as Record<string, unknown>[]).every(message => JSON.stringify(message).includes('存储空间不足'))).toBe(true)
  expect(trace.warning).toContain('存储空间不足')
})

it('浏览器配额到硬水位时停止新增日志，不抛回业务', async () => {
  const repo = await fixture()
  const trace = new TraceSession(repo, { bookId, runId: 'run-3', executionId: 'exec-3', taskId: 'task-3', sessionId }, { businessPrompt: '业务要求', estimate: async () => ({ usage: 95, quota: 100 }) })
  trace.hooks.start({ requestId: 'request-3', purpose: 'work', model: { providerId: 'custom', modelId: 'fixture' }, context, turn: 1, startedAt: '2026-11-08T00:00:00.000Z' })
  trace.hooks.modelEnd({ requestId: 'request-3', attempts: [], status: 'succeeded' })
  await expect(trace.close()).resolves.toBeUndefined()
  expect((await repo.traceRows()).some(row => row.requestId === 'request-3')).toBe(false)
  expect(trace.warning).toContain('存储空间不足')
})

it('备份引用缺失时标记不完整，不伪造完整回放', () => {
  const tables = { storySessionEntries: [{ id: 'trace-1', type: 'request_trace', requestId: 'r1', input: { systemPromptSnapshotId: 'missing' }, complete: true }] } as unknown as BookTables
  markMissingTraceRefs(tables)
  expect(tables.storySessionEntries[0]).toMatchObject({ complete: false, missingRefs: ['missing'] })
})

it('运行详情按最近请求分页读取，不一次返回整本书的日志', async () => {
  const id = crypto.randomUUID(), workspace = createWorkspace({ settingsName: `trace-page-${id}`, bookPrefix: `trace-page-${id}-` })
  const bookId = 'trace-book'
  await workspace.settings.books.put({ id: bookId, title: 'trace', sourceFileName: '', createdAt: new Date().toISOString() })
  const db = workspace.openBook(bookId)
  await db.table('storySessionEntries').bulkPut(Array.from({ length: 60 }, (_, index) => ({ id: `trace-${index}`, type: 'request_trace', bookId, sessionId: 's', runId: 'r', requestId: `r-${index}`, requestOrdinal: index + 1, ordinal: index + 1, parentId: null, createdAt: new Date(index * 1000).toISOString(), startedAt: new Date(index * 1000).toISOString(), input: {}, purpose: 'work', status: 'succeeded' })))
  const data = await readBookTrace(workspace, bookId, undefined, { limit: 10 })
  expect(data.requests).toHaveLength(10)
  expect(data.total).toBe(60)
  expect(data.requests.at(-1)?.requestId).toBe('r-59')
  workspace.close()
})
