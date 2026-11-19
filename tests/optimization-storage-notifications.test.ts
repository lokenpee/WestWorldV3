import 'fake-indexeddb/auto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { liveQuery } from '../src/lib/storage/observe'
import { createLocalStorageServer } from '../src/features/local-storage/server'
import { createWorkspace } from '../src/lib/storage/workspace'
import type { StorageCall } from '../src/features/local-storage/client'

test('opt16：写入10次观测只刷新相关订阅，空事务不刷新', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'westworld-opt16-'))
  const server = createLocalStorageServer(directory, { protect: value => value, unprotect: value => value })
  const call: StorageCall = async body => await server.execute(body) as never
  const workspace = createWorkspace({ settingsName: 'opt16', bookPrefix: 'opt16-' }, call)
  const a = workspace.openBook('a'), b = workspace.openBook('b')
  const calls: Record<string, number> = { assetA: 0, assetB: 0, progressA: 0, settings: 0, observationA: 0 }
  const subscribe = liveQuery as unknown as (query: () => Promise<unknown>, interests: { scope: string; tables?: string[]; category?: string }[]) => ReturnType<typeof liveQuery>
  const queries = [
    ['assetA', () => a.table('characters').toArray(), [{ scope: 'book:a', tables: ['characters'] }]],
    ['assetB', () => b.table('characters').toArray(), [{ scope: 'book:b', tables: ['characters'] }]],
    ['progressA', () => a.table('pipelineRuns').toArray(), [{ scope: 'book:a', tables: ['pipelineRuns'] }]],
    ['settings', () => workspace.settings.appSettings.toArray(), [{ scope: 'settings', tables: ['appSettings'] }]],
    ['observationA', () => a.table('storySessionEntries').toArray(), [{ scope: 'book:a', tables: ['storySessionEntries'], category: 'observation' }]],
  ] as const
  const subscriptions = queries.map(([name, query, dependencies]) => subscribe(async () => { calls[name]++; return query() }, structuredClone(dependencies) as never).subscribe(() => {}))
  const settle = () => new Promise(resolve => setTimeout(resolve, 30))
  try {
    await settle()
    const before = { ...calls }
    for (let i = 0; i < 10; i++) { await a.table('storySessionEntries').put({ id: `trace${i}`, bookId: 'a', type: 'request_trace', text: '固定响应' }); await settle() }
    const increments = Object.fromEntries(Object.keys(calls).map(key => [key, calls[key] - before[key]]))
    const prior = { ...calls }
    await a.transaction('rw', [a.table('characters')], async () => {})
    await settle()
    const emptyTransaction = Object.fromEntries(Object.keys(calls).map(key => [key, calls[key] - prior[key]]))
    if (process.env.WW_OPT16_EXPECT !== 'before') {
      expect(increments).toEqual({ assetA: 0, assetB: 0, progressA: 0, settings: 0, observationA: 10 })
      expect(Object.values(emptyTransaction)).toEqual([0, 0, 0, 0, 0])
    }
    const result = { optimization: 16, sample: { observationCommits: 10, activeSubscriptions: 5 }, queryRefreshes: increments, emptyTransaction, storedObservations: await a.table('storySessionEntries').count() }
    expect(result.storedObservations).toBe(10)
    if (process.env.WW_OPT16_RESULT) writeFileSync(process.env.WW_OPT16_RESULT, JSON.stringify(result, null, 2) + '\n')
  } finally {
    subscriptions.forEach(subscription => subscription.unsubscribe()); workspace.close(); await server.close()
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('westworld-opt16-')) throw new Error('临时目录归属不符')
    rmSync(directory, { recursive: true, force: true })
  }
})
