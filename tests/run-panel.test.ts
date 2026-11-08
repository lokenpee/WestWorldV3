import { createElement } from 'react'
import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiRequest, Changes } from '../src/features/agents/AgentRunPanel'
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
  expect(render(request('r4', 'long_tool', long))).toContain('END_MARKER')
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
