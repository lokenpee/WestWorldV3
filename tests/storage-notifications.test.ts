import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { expect, test, vi } from 'vitest'
import { createLocalStorageServer } from '../src/features/local-storage/server'
import { RemoteDatabase, onStorageChanged, storageChanged, watchDiskRevision, type StorageCall } from '../src/features/local-storage/client'
import type { StorageNotice, StorageStatus } from '../src/features/local-storage/contracts'

test('提交通知区分业务、观测、租约、合并；删除与回滚正确，旧游标要求重读', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'westworld-notices-'))
  const server = createLocalStorageServer(directory, { protect: value => value, unprotect: value => value })
  const call: StorageCall = async body => await server.execute(body) as never
  const db = new RemoteDatabase(call, 'book:a', 'a')
  try {
    const initial = await call<StorageStatus>({ action: 'status' })
    await db.transaction('rw', db.tables, async ({ db }) => {
      await db.table('pipelineRuns').put({ id: 'lease', recordType: 'lease' })
      await db.table('pipelineRuns').put({ id: 'merge', stage: 'manual_merge' })
      await db.table('storySessionEntries').put({ id: 'message', type: 'message' })
      await db.table('storySessionEntries').put({ id: 'trace', type: 'request_trace' })
    })
    const state = await call<StorageStatus>({ action: 'status', since: initial.revision, epoch: initial.epoch })
    expect(state.reset).toBe(false)
    expect(state.notices).toHaveLength(1)
    expect(state.notices![0].targets.map(target => target.category).filter(Boolean).sort()).toEqual(['business', 'lease', 'merge', 'observation'])
    await expect(db.transaction('rw', db.tables, async ({ db }) => { await db.table('characters').put({ id: 'bad' }); throw new Error('rollback') })).rejects.toThrow('rollback')
    const unchanged = await call<StorageStatus>({ action: 'status', since: state.revision, epoch: state.epoch })
    expect(unchanged.notices).toEqual([])
    await db.table('storySessionEntries').delete('trace')
    const deletion = await call<StorageStatus>({ action: 'status', since: state.revision, epoch: state.epoch })
    expect(deletion.notices![0].targets[0]).toMatchObject({ category: 'observation' })
    await db.table('storySessionEntries').put({ id: 'message', type: 'request_trace' })
    const changedType = await call<StorageStatus>({ action: 'status', since: deletion.revision, epoch: deletion.epoch })
    expect(changedType.notices![0].targets[0].category).toBeUndefined()
    for (let i = 0; i < 256; i++) await db.table('characters').put({ id: 'A', revision: i })
    expect((await call<StorageStatus>({ action: 'status', since: state.revision, epoch: state.epoch })).reset).toBe(true)
    expect((await call<StorageStatus>({ action: 'status', since: 99999, epoch: state.epoch })).reset).toBe(true)
    expect((await call<StorageStatus>({ action: 'status', since: 0, epoch: 'previous-server' })).reset).toBe(true)
  } finally {
    await server.close()
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('westworld-notices-')) throw new Error('临时目录归属不符')
    rmSync(directory, { recursive: true, force: true })
  }
})

test('本窗口通知去重，跨窗口提交、备份、断线重连与停止轮询', async () => {
  vi.useFakeTimers()
  const counts = { a: 0, b: 0, status: 0 }
  const subscriptions = [
    onStorageChanged(() => counts.a++, [{ scope: 'book:a', tables: ['characters'] }]),
    onStorageChanged(() => counts.b++, [{ scope: 'book:b', tables: ['characters'] }]),
    onStorageChanged(() => counts.status++, [{ scope: 'status' }]),
  ]
  const local: StorageNotice = { epoch: 'E', revision: 1, targets: [{ scope: 'book:a', table: 'characters' }, { scope: 'status' }] }
  const remote: StorageNotice = { epoch: 'E', revision: 2, targets: [{ scope: 'book:b', table: 'characters' }, { scope: 'status' }] }
  let state = { epoch: 'E', revision: 0, reset: true, notices: [] } as unknown as StorageStatus
  let offline = false
  const call: StorageCall = async body => {
    if (offline) throw new Error('offline')
    if (body.action === 'status') return state as never
    if (body.action === 'begin') return 'tx' as never
    if (body.action === 'commit') return { ...state, change: local } as never
    return null as never
  }
  const stop = watchDiskRevision(call)
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(counts).toEqual({ a: 1, b: 1, status: 1 })
    await new RemoteDatabase(call, 'book:a', 'a').table('characters').put({ id: 'A' })
    expect(counts).toEqual({ a: 2, b: 1, status: 2 })
    state = { ...state, reset: false, revision: 2, notices: [local, remote] }
    await vi.advanceTimersByTimeAsync(1500)
    expect(counts).toEqual({ a: 2, b: 2, status: 3 })
    state = { ...state, lastBackupAt: '2026-11-19' }
    await vi.advanceTimersByTimeAsync(1500)
    expect(counts).toEqual({ a: 2, b: 2, status: 4 })
    offline = true
    await vi.advanceTimersByTimeAsync(4500)
    expect(counts).toEqual({ a: 3, b: 3, status: 5 })
    offline = false
    await vi.advanceTimersByTimeAsync(1500)
    expect(counts).toEqual({ a: 4, b: 4, status: 6 })
    stop(); state = { ...state, reset: true }
    await vi.advanceTimersByTimeAsync(3000)
    expect(counts).toEqual({ a: 4, b: 4, status: 6 })
  } finally { stop(); subscriptions.forEach(unsubscribe => unsubscribe()); vi.useRealTimers() }
})

test('合并和执行锁依赖互不触发，显式全量通知仍可刷新', () => {
  let merge = 0, lease = 0
  const offMerge = onStorageChanged(() => merge++, [{ scope: 'book:a', tables: ['pipelineRuns'], category: 'merge' }])
  const offLease = onStorageChanged(() => lease++, [{ scope: 'book:a', tables: ['pipelineRuns'], category: 'lease' }])
  try {
    storageChanged({ targets: [{ scope: 'book:a', table: 'pipelineRuns', category: 'lease' }] })
    expect([merge, lease]).toEqual([0, 1])
    storageChanged({ targets: [{ scope: 'book:b', table: 'pipelineRuns', category: 'merge' }] })
    expect([merge, lease]).toEqual([0, 1])
    storageChanged()
    expect([merge, lease]).toEqual([1, 2])
  } finally { offMerge(); offLease() }
})
