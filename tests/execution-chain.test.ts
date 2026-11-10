import { expect, it } from 'vitest'
import { projectExecution } from '../src/features/agents/executionChain'
import type { ExecutionChain } from '../src/features/agents/trace'
import type { Row } from '../src/features/agents/repository'

const entry = (id: string, ordinal: number, message: Row, extra: Row = {}): Row => ({ id, ordinal, type: 'message', message, ...extra })
const request = (ordinal: number, toolCallId?: string, text = ''): Row => ({ requestId: `r${ordinal}`, requestOrdinal: ordinal, status: 'succeeded', text, toolCalls: toolCallId ? [{ toolCallId, name: 'tool', state: 'succeeded', arguments: { n: ordinal }, result: { ok: true } }] : [] })
const chain = (entries: Row[], requests: Row[]): ExecutionChain => ({ entries, requests, snapshots: new Map() })

it('37 次 API 重建为一条不重复执行链，并保留最后一次工具结果', () => {
  const entries: Row[] = [
    entry('sys', 1, { role: 'system', content: 'system rules', timestamp: 1 }),
    entry('user', 2, { role: 'user', content: 'initial input', timestamp: 2 }),
  ]
  const requests: Row[] = []
  for (let index = 1; index <= 37; index++) {
    const call = `call-${index}`
    entries.push(entry(`assistant-${index}`, 2 + index * 2 - 1, { role: 'assistant', content: [{ type: 'text', text: `step ${index}` }, { type: 'toolCall', id: call, name: 'tool', arguments: { index } }], timestamp: index * 10 }))
    entries.push(entry(`result-${index}`, 2 + index * 2, { role: 'toolResult', toolCallId: call, toolName: 'tool', content: [{ type: 'text', text: `result ${index}` }], isError: false, timestamp: index * 10 + 1 }))
    requests.push(request(index, call, `step ${index}`))
  }
  const projected = projectExecution(chain(entries, requests))
  expect(projected.events.filter(event => event.kind === 'system')).toHaveLength(1)
  expect(projected.events.filter(event => event.kind === 'user')).toHaveLength(1)
  expect(projected.events.filter(event => event.kind === 'assistant')).toHaveLength(37)
  expect(projected.events.filter(event => event.kind === 'toolResult')).toHaveLength(37)
  expect(projected.events.at(-1)).toMatchObject({ kind: 'toolResult', content: 'result 37' })
  expect(projected.events.find(event => event.kind === 'assistant')?.apiIndex).toBe(1)
  expect(new Set(projected.events.map(event => event.key)).size).toBe(projected.events.length)
})

it('相同文本的不同事件不去重，压缩和真实新增 USER 保留', () => {
  const entries: Row[] = [
    entry('sys', 1, { role: 'system', content: 'system' }),
    entry('user-1', 2, { role: 'user', content: 'same text' }),
    entry('assistant-1', 3, { role: 'assistant', content: [{ type: 'text', text: 'same answer' }] }),
    entry('user-2', 4, { role: 'user', content: 'same text' }),
    entry('assistant-2', 5, { role: 'assistant', content: [{ type: 'text', text: 'same answer' }] }),
    { id: 'compact', ordinal: 6, type: 'compaction', summary: 'compressed' },
  ]
  const projected = projectExecution(chain(entries, []))
  expect(projected.events.filter(event => event.kind === 'user')).toHaveLength(2)
  expect(projected.events.filter(event => event.kind === 'assistant')).toHaveLength(2)
  expect(projected.events.some(event => event.kind === 'compaction')).toBe(true)
})

it('工具有多个调用和错误时只按 toolCallId 展示一次，不使用文本去重', () => {
  const entries: Row[] = [
    entry('assistant', 1, { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'tool', arguments: { x: 1 } }, { type: 'toolCall', id: 'b', name: 'tool', arguments: { x: 1 } }] }),
    entry('result-a', 2, { role: 'toolResult', toolCallId: 'a', toolName: 'tool', content: [{ type: 'text', text: 'same result' }], isError: false }),
    entry('result-b', 3, { role: 'toolResult', toolCallId: 'b', toolName: 'tool', content: [{ type: 'text', text: 'same result' }], isError: true }),
  ]
  const projected = projectExecution(chain(entries, [request(1, 'a')]))
  const results = projected.events.filter(event => event.kind === 'toolResult')
  expect(results).toHaveLength(2)
  expect(results.map(event => event.toolCallId)).toEqual(['a', 'b'])
  expect(results[1].isError).toBe(true)
})
