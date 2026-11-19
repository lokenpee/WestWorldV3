import { writeFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { createMemoryAgentRepository, type Row } from '../src/features/agents/repository'
import { sessionProjection } from '../src/features/agents/compaction'

test('opt14：正常上下文不读取观测正文，诊断入口仍保留全部记录', async () => {
  const entries: Row[] = [
    { id: 's', sessionId: 'session', bookId: 'book', ordinal: 1, type: 'message', parentId: null, unitId: 'directory:identity', message: { role: 'system', content: '任务规则', timestamp: 1 } },
    { id: 'u', sessionId: 'session', bookId: 'book', ordinal: 2, type: 'message', parentId: 's', unitId: 'directory:identity', message: { role: 'user', content: '当前页人物', timestamp: 2 } },
  ]
  const observations = Array.from({ length: 200 }, (_, i) => ({ id: `trace${i}`, bookId: 'book', sessionId: i % 2 ? 'another' : 'session', type: 'request_trace', input: { messages: [{ role: 'user', content: '长请求正文'.repeat(2000) }] }, text: '模型返回'.repeat(1000) }))
  const repo = createMemoryAgentRepository('book', { storySessions: [{ id: 'session', bookId: 'book', leafId: 'u' }], storySessionEntries: [...entries, ...observations] })
  const original = repo.traceRows.bind(repo)
  let readCalls = 0, bytes = 0
  repo.traceRows = async () => { const rows = await original(); readCalls++; bytes += Buffer.byteLength(JSON.stringify(rows)); return rows }
  const results = []
  for (const [name, unit, story] of [['identity', 'directory:identity', false], ['normal', undefined, false], ['story_pages', undefined, true]] as const) {
    readCalls = 0; bytes = 0
    const projection = await sessionProjection(repo, 'session', unit, story)
    expect(projection.messages.map(message => message.role)).toEqual(['system', 'user'])
    expect(JSON.stringify(projection.messages)).not.toContain('长请求正文')
    results.push({ name, observationReads: readCalls, observationBytes: bytes, projectedMessages: projection.messages.length })
    if (process.env.WW_OPT14_EXPECT !== 'before') expect(readCalls).toBe(0)
  }
  expect(await original()).toEqual(observations)
  const result = { optimization: 14, sample: { observationRows: 200, businessMessages: 2 }, results, observationsPreserved: (await original()).length }
  if (process.env.WW_OPT14_RESULT) writeFileSync(process.env.WW_OPT14_RESULT, JSON.stringify(result, null, 2) + '\n')
})
