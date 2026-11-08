import { createElement } from 'react'
import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RequestCard } from '../src/features/agents/AgentRunPanel'
import type { Row } from '../src/features/agents/repository'

const request = (id: string, tool: string, result: unknown = `${tool}-result`): Row => ({
  requestId: id, requestOrdinal: id === 'r1' ? 1 : 2, status: 'succeeded', purpose: 'work', startedAt: '2026-11-08T00:00:00.000Z',
  executionId: 'exec', sessionId: 'session', input: { completeness: 'complete', messages: [] },
  toolCalls: [{ toolCallId: `${id}-tool`, name: tool, state: 'succeeded', arguments: { request: id }, result }],
})

const render = (row: Row) => renderToStaticMarkup(createElement(RequestCard, { row, snapshots: new Map() }))

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
