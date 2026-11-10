import { expect, it } from 'vitest'
import { appendRequestLedger } from '../src/features/agents/ledger'
import type { AgentStore, Row } from '../src/features/agents/repository'
import type { Scope } from '../src/features/agents/queries'

const scope: Scope = { bookId: 'a', profile: 'asset_editor', phase: 'character_organization', runId: 'run-ledger', taskId: 'task-ledger', owner: 'owner-ledger', workItemIds: [] }

function storeFor(run: Row): AgentStore {
  return {
    async get(table, id) { return table === 'pipelineRuns' && id === scope.runId ? structuredClone(run) : undefined },
    async put(table, row) { if (table === 'pipelineRuns') Object.assign(run, row) },
    async rows() { return [] },
    async remove() { /* no-op */ },
    async wait(promise) { return promise },
  }
}

it('账本保存逐请求时间与真实顺序', async () => {
  const run: Row = { id: scope.runId, bookId: 'a', requestLedger: [] }
  const store = storeFor(run)
  const cost = { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 }
  await appendRequestLedger(store, scope, [
    { ordinal: 1, turn: 1, elapsedMs: 1000, attemptId: 'a1', requestId: 'r1', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', usage: { input: 6, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 18, cost } },
    { ordinal: 2, turn: 2, elapsedMs: 2000, attemptId: 'a2', requestId: 'r2', startedAt: '2026-01-01T00:00:02.000Z', finishedAt: '2026-01-01T00:00:04.000Z', usage: { input: 6, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 18, cost } },
  ] as never, { pricingStatus: 'estimated', pricingCurrency: 'USD' })
  const rows = run.requestLedger as Row[]
  expect(rows).toHaveLength(2)
  expect(rows.map(row => row.finishedAt)).toEqual(['2026-01-01T00:00:01.000Z', '2026-01-01T00:00:04.000Z'])
  expect(rows.map(row => row.ordinal)).toEqual([1, 2])
  expect(rows.map(row => row.turn)).toEqual([1, 2])
  expect(rows.map(row => row.traceEntryId)).toEqual(['trace:r1', 'trace:r2'])
  expect(rows.every(row => row.cost === 1)).toBe(true)
})

it('旧 attempt 没有时间字段时仍能回退', async () => {
  const run: Row = { id: scope.runId, bookId: 'a', requestLedger: [] }
  const store = storeFor(run)
  await appendRequestLedger(store, scope, [{ ordinal: 3, turn: 1, elapsedMs: 500, attemptId: 'a3' }] as never, { pricingStatus: 'estimated', pricingCurrency: 'USD' })
  const row = (run.requestLedger as Row[])[0]
  expect(typeof row.startedAt).toBe('string')
  expect(typeof row.finishedAt).toBe('string')
  expect(row.ordinal).toBe(3)
})
