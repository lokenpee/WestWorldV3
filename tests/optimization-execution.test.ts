import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { createLocalStorageServer } from '../src/features/local-storage/server'
import type { StorageCall } from '../src/features/local-storage/client'
import { createWorkspace } from '../src/lib/storage/workspace'
import { readExecutionChain } from '../src/features/agents/trace'
import { executionStats } from '../src/features/agents/executionStats'
import { projectRequestConversation } from '../src/features/agents/executionChain'
import type { Row } from '../src/features/agents/repository'

test('opt13：200次API链路首屏与无变化刷新传输量', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'westworld-opt13-'))
  const server = createLocalStorageServer(directory, { protect: value => value, unprotect: value => value })
  let collecting = false
  const requests: { action: string; table?: string; bytes: number; rows: number }[] = []
  const call: StorageCall = async body => {
    const result = await server.execute(body)
    if (collecting && ['query', 'get', 'executionPage', 'executionBody'].includes(String(body.action))) requests.push({ action: String(body.action), table: body.table as string, bytes: Buffer.byteLength(JSON.stringify(result ?? null)), rows: Array.isArray(result) ? result.length : 1 })
    return structuredClone(result) as never
  }
  const workspace = createWorkspace({ settingsName: 'opt13', bookPrefix: 'opt13-' }, call)
  try {
    const db = workspace.openBook('book'), count = 200
    await db.table('pipelineRuns').put({ id: 'run', bookId: 'book', recordType: 'run', stage: 'P2', status: 'completed', sessionId: 'session' })
    const seed = []
    for (let index = 0; index < count; index++) {
      const id = `r${String(index).padStart(4, '0')}`, date = new Date(Date.UTC(2026, 10, 19, 0, 0, index)).toISOString()
      seed.push({ id: `trace-${id}`, bookId: 'book', sessionId: 'session', runId: 'run', unitId: 'profile:A', type: 'request_trace', requestId: id, requestOrdinal: index + 1, startedAt: date, finishedAt: date, model: 'fixture', status: 'succeeded', final: true, complete: true,
        input: { messageFormat: 'provider-request/v1', messages: [{ role: 'system', content: '整理规则'.repeat(1000) }, { role: 'user', content: `第${index}次核对：${'人物资料'.repeat(1000)}` }] }, text: `处理${index}`, thinking: '核对字段'.repeat(100), toolCalls: [{ toolCallId: `call-${id}`, name: 'query', arguments: { id: 'A' }, result: { content: [{ type: 'text', text: '资料内容'.repeat(1000) }] }, state: 'succeeded' }], usage: { input: 100, output: 20, totalTokens: 120, cacheRead: 30, cost: 0.001 } })
      seed.push({ id: `message-${id}`, bookId: 'book', sessionId: 'session', runId: 'run', unitId: 'profile:A', type: 'message', ordinal: index + 1, message: { role: 'assistant', content: [{ type: 'text', text: `处理${index}` }] } })
    }
    await db.table('storySessionEntries').bulkPut(seed)
    const measurements = []
    for (const name of ['initial', 'unchanged_refresh']) {
      requests.length = 0; collecting = true
      const start = performance.now(), chain = await readExecutionChain(workspace, 'book', 'run', { unitId: 'profile:A' })
      collecting = false
      expect((chain.summary?.stats ?? executionStats(chain.requests)).requests).toBe(count)
      measurements.push({ name, requests: requests.length, returnedBytes: requests.reduce((sum, row) => sum + row.bytes, 0), returnedRows: requests.reduce((sum, row) => sum + row.rows, 0), elapsedMs: +(performance.now() - start).toFixed(2) })
    }
    const result = { optimization: 13, sample: { requests: count, sessionRows: count * 2 }, measurements }
    if (process.env.WW_OPT13_EXPECT === 'before') {
      if (process.env.WW_OPT13_RESULT) writeFileSync(process.env.WW_OPT13_RESULT, JSON.stringify(result, null, 2) + '\n')
      return
    }
    let chain = await readExecutionChain(workspace, 'book', 'run', { unitId: 'profile:A' })
    expect(chain.requests).toHaveLength(20)
    expect(chain.paging?.hasEarlier).toBe(true)
    expect(JSON.stringify(chain.paging?.events)).not.toContain('人物资料')
    expect(chain.summary?.stats).toEqual(executionStats(seed.filter(row => row.type === 'request_trace')))
    for (let index = 0; index < 9; index++) chain = await chain.paging!.loadEarlier()
    expect(chain.requests).toHaveLength(count)
    expect(chain.paging?.hasEarlier).toBe(false)
    const expected = projectRequestConversation({ entries: [], requests: seed.filter(row => row.type === 'request_trace'), snapshots: new Map() })
    expect(chain.paging?.events.map(event => [event.key, event.kind, event.apiIndex])).toEqual(expected.map(event => [event.key, event.kind, event.apiIndex]))
    for (const at of [0, 1, 59, expected.length - 1]) expect(await chain.paging!.loadEvent(chain.paging!.events[at])).toEqual(expected[at])
    const fullRequest = await chain.paging!.loadRequest(chain.requests.at(-1)!)
    expect(fullRequest.request).toEqual(seed.at(-2))
    const last = await db.table('storySessionEntries').get('trace-r0199')
    await db.table('storySessionEntries').put({ ...last!, text: '更新后的答复', thinking: '更新后的思考', usage: { input: 150, output: 40, totalTokens: 190, cacheRead: 30, cost: 0.002 } })
    requests.length = 0; collecting = true
    chain = await readExecutionChain(workspace, 'book', 'run', { unitId: 'profile:A' })
    collecting = false
    const updateBytes = requests.reduce((sum, row) => sum + row.bytes, 0)
    expect(updateBytes).toBeLessThan(6000)
    expect(chain.requests).toHaveLength(count)
    expect(chain.summary?.stats.input).toBe(20050)
    const assistant = chain.paging!.events.find(event => event.key === 'r0199:assistant')!
    expect(await chain.paging!.loadEvent(assistant)).toMatchObject({ content: '更新后的答复', thinking: '更新后的思考' })
    await db.table('storySessionEntries').delete('trace-r0198')
    chain = await readExecutionChain(workspace, 'book', 'run', { unitId: 'profile:A' })
    expect(chain.summary?.stats.requests).toBe(199)
    expect(chain.paging!.events.some(event => event.entry.requestId === 'r0198')).toBe(false)
    await db.table('storySessionEntries').put({ ...seed[0], id: 'other', requestId: 'other', unitId: 'profile:B' })
    const other = await readExecutionChain(workspace, 'book', 'run', { unitId: 'profile:B' })
    expect(other.summary?.stats.requests).toBe(1)
    await expect(other.paging!.loadRequest(chain.requests[0])).rejects.toThrow('不属于当前范围')
    await db.table('storySessionEntries').put({ ...seed[0], id: 'legacy', requestId: 'legacy', unitId: 'profile:legacy', input: { messages: [] } } as Row)
    const legacy = await readExecutionChain(workspace, 'book', 'run', { unitId: 'profile:legacy' })
    expect(legacy.paging).toBeUndefined()
    expect(legacy.requests).toHaveLength(1)
    Object.assign(result, { singleUpdateBytes: updateBytes, checks: { fullPagingRequests: count, exactEventHeaders: expected.length, bodySamples: 4, fullRequest: true, updatedThinking: true, cumulativeStats: true, deletion: true, scopeIsolation: true, legacy: true } })
    if (process.env.WW_OPT13_RESULT) writeFileSync(process.env.WW_OPT13_RESULT, JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify(result))
  } finally {
    collecting = false; workspace.close(); await server.close()
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('westworld-opt13-')) throw new Error('临时目录归属不符')
    rmSync(directory, { recursive: true, force: true })
  }
})
