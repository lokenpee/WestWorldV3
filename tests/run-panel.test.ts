import { LazyDetails } from '../src/features/agents/LazyDetails'
import { toolResultContent } from '../src/features/agents/requestPresentation'
import { createElement } from 'react'
import { expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiRequest, Changes } from '../src/features/agents/AgentRunPanel'
import { ExecutionChainView } from '../src/features/agents/ExecutionChainView'
import type { Row } from '../src/features/agents/repository'

const request = (id: string, tool: string, result: unknown = `${tool}-result`): Row => ({
  requestId: id, requestOrdinal: id === 'r1' ? 1 : 2, status: 'succeeded', purpose: 'work', startedAt: '2026-11-08T00:00:00.000Z',
  executionId: 'exec', sessionId: 'session', input: { completeness: 'complete', messages: [] },
  toolCalls: [{ toolCallId: `${id}-tool`, name: tool, state: 'succeeded', arguments: { request: id }, result }],
})

const render = (row: Row, snapshots = new Map()) => renderToStaticMarkup(createElement(ApiRequest, { row, index: 0, snapshots }))

it('每条请求只渲染自己的工具，空结果不崩溃，展开内容不截断', () => {
  const first = render(request('r1', 'old_tool'))
  const second = render(request('r2', 'new_tool'))
  expect(first).toContain('old_tool')
  expect(first).not.toContain('new_tool')
  expect(second).toContain('new_tool')
  expect(second).not.toContain('old_tool')
  expect(() => render(request('r3', 'pending_tool', undefined))).not.toThrow()
  const long = `${'长内容'.repeat(1200)}END_MARKER`
  expect(render(request('r4', 'long_tool', long))).not.toContain('END_MARKER')
  expect(toolResultContent(long)).toContain('END_MARKER')
})

it('业务提示词已在 SYSTEM 中时不重复渲染，实际修改显示字段前后值', () => {
  const snapshots = new Map([
    ['sys', { type: 'prompt_snapshot', snapshotId: 'sys', content: '系统规则\n业务职责正文\n业务提示词' }],
    ['biz', { type: 'prompt_snapshot', snapshotId: 'biz', content: '业务提示词' }],
  ])
  const row = request('r5', 'tool')
  row.input = { completeness: 'complete', systemPromptSnapshotId: 'sys', businessPromptSnapshotId: 'biz', messages: [] }
  const requestHtml = render(row, snapshots)
  expect(requestHtml).toContain('SYSTEM')
  expect(requestHtml).not.toContain('BUSINESS PROMPT')
  const changesHtml = renderToStaticMarkup(createElement(Changes, { edits: [{ id: 'c1', kind: 'character', tool: 'submit_profile_review', commitId: 'k1', reason: '依据原文', fieldChanges: [{ field: 'identity', before: '内相', after: '大明宫内相' }] }], characterNames: new Map([['c1', '戴权']]) }))
  expect(changesHtml).toContain('戴权')
  expect(changesHtml).toContain('修改前')
  expect(changesHtml).toContain('内相')
  expect(changesHtml).toContain('修改后')
  expect(changesHtml).toContain('大明宫内相')
})

it('每次请求显示该次工具定义，缺少快照时明确提示', () => {
  const snapshots = new Map([
    ['tools', { type: 'tool_snapshot', snapshotId: 'tools', toolNames: ['query_relation_work', 'submit_relation_review'], schema: [{ name: 'query_relation_work', description: '查询关系', parameters: { type: 'object' } }, { name: 'submit_relation_review', description: '提交关系', parameters: { type: 'object' } }] }],
  ])
  const row = request('r6', 'query_relation_work')
  row.input = { completeness: 'complete', toolSchemaSnapshotId: 'tools', messages: [] }
  const html = render(row, snapshots)
  expect(html).toContain('TOOLS · 可调用工具（2）')
  expect(html).toContain('query_relation_work')
  expect(html).not.toContain('submit_relation_review')
  expect(html).not.toContain('原始请求 JSON')
  const missing = render(request('r7', 'query_relation_work'))
  expect(missing).toContain('TOOLS · 可调用工具（0）')
})


it('执行链按一条会话时间线展示，历史输入只出现一次', () => {
  const entries: Row[] = [
    { id: 'sys', ordinal: 1, type: 'message', message: { role: 'system', content: 'SYSTEM_ONCE' } },
    { id: 'user', ordinal: 2, type: 'message', message: { role: 'user', content: 'PROMPT_ONCE' } },
    { id: 'assistant-1', ordinal: 3, type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'reply-one' }, { type: 'toolCall', id: 'call-1', name: 'query_relation_work', arguments: { targetIds: ['B'] } }] } },
    { id: 'result-1', ordinal: 4, type: 'message', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'query_relation_work', content: [{ type: 'text', text: 'result-one' }] } },
    { id: 'assistant-2', ordinal: 5, type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'reply-two' }] } },
  ]
  const first = { ...request('r1', 'query_relation_work'), text: 'reply-one', toolCalls: [{ toolCallId: 'call-1', name: 'query_relation_work', state: 'succeeded', arguments: { targetIds: ['B'] }, result: { content: [{ type: 'text', text: 'result-one' }] } }] }
  const second = { ...request('r2', 'query_relation_work'), text: 'reply-two', toolCalls: [] }
  const html = renderToStaticMarkup(createElement(ExecutionChainView, { chain: { entries, requests: [first, second], snapshots: new Map() }, edits: [] }))
  expect(html.match(/SYSTEM_ONCE/g)).toHaveLength(1)
  expect(html.match(/PROMPT_ONCE/g)).toHaveLength(1)
  expect(html).toContain('API 01')
  expect(html).toContain('API 02')
  expect(html).toContain('reply-one')
  expect(html).toContain('result-one')
  expect(html).toContain('reply-two')
})

it('执行链主视图逐次显示 API 请求和该次工具定义', () => {  const snapshots = new Map([
    ['tools', { type: 'tool_snapshot', snapshotId: 'tools', toolNames: ['query_relation_work', 'submit_relation_review'], schema: [{ name: 'query_relation_work', description: '查询关系', parameters: { type: 'object' } }, { name: 'submit_relation_review', description: '提交关系', parameters: { type: 'object' } }] }],
  ])
  const row = request('r8', 'query_relation_work')
  row.input = { completeness: 'complete', toolSchemaSnapshotId: 'tools', messages: [] }
  const html = renderToStaticMarkup(createElement(ExecutionChainView, { chain: { entries: [], requests: [row], snapshots, runStatus: 'cancelled' }, edits: [] }))
  expect(html).toContain('发送给 API')
  expect(html).not.toContain('execution-events')
  expect(html).not.toContain('对话事件')
  expect(html).toContain('TOOLS · 可调用工具（2）')
  expect(html).toContain('query_relation_work')
  expect(html).not.toContain('原始请求 JSON')
})

it('实际输入不拼入业务快照，工具结果只显示送回模型的content，正文即使与工具结果相同也保留', () => {
  const row = request('r9', 'query_relation_work', { content: [{ type: 'text', text: '{"ok":true,"marker":"RESULT_ONCE"}' }], details: { marker: 'HIDDEN_INTERNAL' }, structuredContent: { marker: 'HIDDEN_INTERNAL' } })
  row.input = { messageFormat: 'provider-request/v1', messages: [{ role: 'user', content: 'ACTUAL_USER' }, { role: 'assistant', content: null, reasoning_content: 'SENT_REASONING', tool_calls: [{ function: { name: 'read', arguments: '{"id":"A"}' } }] }], systemPromptSnapshotId: 'sys' }
  row.text = '模型回复正文'
  const html = render(row, new Map([['sys', { content: 'UNSENT_SYSTEM' }]]))
  expect(html).not.toContain('ACTUAL_USER')
  expect(html).not.toContain('SENT_REASONING')
  expect(html).not.toContain('UNSENT_SYSTEM')
  expect(html).not.toContain('HIDDEN_INTERNAL')
  expect(html).not.toContain('RESULT_ONCE')
  expect(toolResultContent((row.toolCalls as Row[])[0].result).match(/RESULT_ONCE/g)).toHaveLength(1)
  expect(html).toContain('模型回复正文')
  expect(html).not.toContain('原始响应 JSON')
  expect(html).not.toContain('TOOL EXECUTION')
})

it('折叠时不执行大文本内容函数，展开时生成完整内容', () => {
  const content = vi.fn(() => createElement('pre', null, '长文本'.repeat(1000) + 'END'))
  // oxlint-disable-next-line react/no-children-prop -- 此处传入的是延迟执行函数，不是ReactNode。
  const closed = renderToStaticMarkup(createElement(LazyDetails, { summary: '展开', children: content }))
  expect(content).not.toHaveBeenCalled()
  expect(closed).not.toContain('<pre>')
  // oxlint-disable-next-line react/no-children-prop -- 同上，检查展开时才执行内容函数。
  const open = renderToStaticMarkup(createElement(LazyDetails, { summary: '展开', children: content, open: true }))
  expect(content).toHaveBeenCalledOnce()
  expect(open).toContain('END')
})
