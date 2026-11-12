import Dexie from 'dexie'
import type { Table, Transaction } from 'dexie'
import type { createWorkspace } from '../../lib/storage/workspace'
import { canonical } from './contracts'
import { isObservationEntry, observationTypes } from './context'

export type Row = Record<string, unknown>
export interface LeaseGuard { lockKey: string; owner: string; runId: string }
export interface AgentStore {
  rows(table: string): Promise<Row[]>
  sessionEntries?(sessionId: string): Promise<Row[]>
  get(table: string, id: string): Promise<Row | undefined>
  put(table: string, row: Row): Promise<void>
  remove(table: string, id: string): Promise<void>
  wait<T>(promise: Promise<T>): Promise<T>
}
export interface AgentRepository { bookId: string; transaction<T>(write: boolean, work: (store: AgentStore) => Promise<T>, lease?: LeaseGuard): Promise<T>; tracePut(rows: Row[]): Promise<void>; traceRows(): Promise<Row[]> }
const visible = (table: string, row: Row | undefined) => !!row && (table !== 'storySessionEntries' || !isObservationEntry(row))
const keyOf = (table: string, row: Row) => String(table === 'chapters' || table === 'chapterTexts' ? row.chapterIndex : table === 'assetLifecycle' || table === 'extractionReceipts' ? row.key : table === 'compileProgress' ? row.stage : table === 'characterRelationEdits' ? row.pairKey : row.id)
// 心跳只更新续期时间；快照比较保留执行者身份，不把续期当成业务资料变化。
const snapshotRow = (table: string, row: Row | undefined): Row | undefined => {
  if (!row) return undefined
  if (table === 'pipelineRuns' && row.recordType === 'lease') { const { expiresAt: _expiresAt, ...rest } = row; return rest }
  if (table === 'storySessions') { const { leaseUntil: _leaseUntil, ...rest } = row; return rest }
  return row
}
const snapshotRows = (table: string, rows: Row[]) => rows.map(row => snapshotRow(table, row))
const sameSnapshot = (table: string, left: Row | undefined, right: Row | undefined) => canonical(snapshotRow(table, left)) === canonical(snapshotRow(table, right))
class MoreSnapshotData extends Error {}
class SnapshotConflict extends Error {}
async function assertLeaseGuard(transaction: Transaction, changes: Map<string, Map<string, Row | undefined>>, lease: LeaseGuard) {
  const id = `lease:${lease.lockKey}`
  const renewal = changes.get('pipelineRuns')?.get(id)
  if (renewal) {
    if (renewal.owner !== lease.owner || renewal.runId !== lease.runId) throw new Error('CONFLICT:本任务的执行权已失效。')
    return
  }
  const current = await transaction.table('pipelineRuns').get(id)
  if (!current || current.owner !== lease.owner || current.runId !== lease.runId || Number(current.expiresAt) <= Date.now()) throw new Error('CONFLICT:本任务的执行权已失效。')
}
// IndexedDB返回值已是独立副本；先通过索引排除观测正文，再向调用方复制业务快照。
async function businessRows(table: Table): Promise<Row[]> {
  if (table.name !== 'storySessionEntries') return table.toArray()
  const observations = await table.where('type').anyOf([...observationTypes]).primaryKeys()
  return observations.length ? table.where(':id').noneOf(observations).toArray() : table.toArray()
}

async function writeSnapshot<T>(db: ReturnType<ReturnType<typeof createWorkspace>['openBook']>, bookId: string, work: (store: AgentStore) => Promise<T>, lease?: LeaseGuard): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const full = new Map<string, Row[]>(), points = new Map<string, Map<string, Row | undefined>>(), changes = new Map<string, Map<string, Row | undefined>>()
    const sessions = new Map<string, Row[]>()
    const fences = new Map<string, Row | undefined>()
    for (const domain of ['world', 'narrative', 'extraction']) fences.set(domain, structuredClone(await db.table('pipelineRuns').get(`lease:${domain}`)))
    const base = async (table: string, id: string) => {
      if (full.has(table)) return full.get(table)!.find(row => keyOf(table, row) === id)
      if (!points.has(table)) points.set(table, new Map())
      if (!points.get(table)!.has(id)) points.get(table)!.set(id, structuredClone(await db.table(table).get(id)))
      return points.get(table)!.get(id)
    }
    const store: AgentStore = {
      async sessionEntries(sessionId) {
        if (!sessions.has(sessionId)) sessions.set(sessionId, (await db.table('storySessionEntries').where('sessionId').equals(sessionId).toArray()).filter(row => visible('storySessionEntries', row)))
        const rows = new Map(sessions.get(sessionId)!.map(row => [String(row.id), row]))
        for (const [id, row] of changes.get('storySessionEntries') ?? []) {
          if (row?.sessionId === sessionId && visible('storySessionEntries', row)) rows.set(id, row)
          else rows.delete(id)
        }
        return structuredClone([...rows.values()])
      },
      async get(table, id) { const row = changes.get(table)?.has(id) ? changes.get(table)!.get(id) : await base(table, id); return visible(table, row) ? structuredClone(row) : undefined },
      async rows(table) {
        if (!full.has(table)) full.set(table, await businessRows(db.table(table)))
        const rows = new Map(full.get(table)!.map(row => [keyOf(table, row), row]))
        for (const [id, row] of changes.get(table) ?? []) { if (row && visible(table, row)) rows.set(id, row); else rows.delete(id) }
        return structuredClone([...rows].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, row]) => row))
      },
      async put(table, row) {
        if (row.bookId !== bookId) throw new Error('SCOPE:资料归属与当前书籍不一致。')
        const id = keyOf(table, row); await base(table, id)
        if (!changes.has(table)) changes.set(table, new Map()); changes.get(table)!.set(id, structuredClone(row))
      },
      async remove(table, id) { await base(table, id); if (!changes.has(table)) changes.set(table, new Map()); changes.get(table)!.set(id, undefined) },
      wait: promise => promise,
    }
    const value = await work(store)
    if (!changes.size) return value
    const domains = new Set<string>()
    for (const row of changes.get('pipelineRuns')?.values() ?? []) {
      if (row?.stage === 'P2') domains.add('world')
      if (row?.stage === 'P3') domains.add('narrative')
      if (row?.recordType === 'lease') domains.add(String(row.lockKey))
    }
    if (!domains.size) {
      if (changes.has('characters') || changes.has('locations')) domains.add('world')
      if (['nodes', 'eventLines', 'storySessions', 'storySessionEntries', 'storyEditorMemory', 'storyEditorNotes', 'storyEditorCheckpoints'].some(table => changes.has(table))) domains.add('narrative')
    }
    const tables = [...new Set([...full.keys(), ...points.keys(), ...changes.keys(), ...(sessions.size ? ['storySessionEntries'] : []), 'pipelineRuns'])]
    try {
      await db.transaction('rw', tables.map(table => db.table(table)), async transaction => {
        for (const [sessionId, rows] of sessions) {
          const current = (await transaction.table('storySessionEntries').where('sessionId').equals(sessionId).toArray()).filter(row => visible('storySessionEntries', row))
          if (canonical(current) !== canonical(rows)) throw new SnapshotConflict()
        }
        for (const [table, rows] of full) if (canonical(snapshotRows(table, await businessRows(transaction.table(table)))) !== canonical(snapshotRows(table, rows))) throw new SnapshotConflict()
        for (const [table, rows] of points) for (const [id, row] of rows) if (!sameSnapshot(table, (await transaction.table(table).get(id)) ?? undefined, row)) throw new SnapshotConflict()
        for (const domain of domains) {
          const current = await transaction.table('pipelineRuns').get(`lease:${domain}`)
          if (!sameSnapshot('pipelineRuns', current, fences.get(domain))) throw new SnapshotConflict()
          const renewal = changes.get('pipelineRuns')?.get(`lease:${domain}`)
          if (current && Number(current.expiresAt) <= Date.now() && !renewal) throw new Error('CONFLICT:本任务的执行权已失效。')
        }
        if (lease) await assertLeaseGuard(transaction, changes, lease)
        for (const [table, rows] of changes) for (const [id, row] of rows) { if (row) await transaction.table(table).put(row); else await transaction.table(table).delete(id) }
      })
      return value
    } catch (error) { if (!(error instanceof SnapshotConflict)) throw error; if (attempt === 3) throw new Error('CONFLICT:资料在提交前持续变化，请重新读取后继续。') }
  }
  throw new Error('CONFLICT:本次提交未完成，请继续。')
}
// 计算在事务外完成；并行变更发生时，短事务重新取得一致快照。
async function readSnapshot<T>(db: ReturnType<ReturnType<typeof createWorkspace>['openBook']>, work: (store: AgentStore) => Promise<T>): Promise<T> {
  const tables = new Set<string>(), keys = new Map<string, Set<string>>()
  for (let attempt = 0; attempt < 5; attempt++) {
    const all = new Map<string, Row[]>(), points = new Map<string, Map<string, Row | undefined>>()
    if (attempt) await db.transaction('r', [...new Set([...tables, ...keys.keys()])].map(name => db.table(name)), async () => {
      for (const name of tables) all.set(name, await businessRows(db.table(name)))
      for (const [name, ids] of keys) {
        const values = all.has(name) ? [...ids].map(id => all.get(name)!.find(row => keyOf(name, row) === id)) : await db.table(name).bulkGet([...ids])
        points.set(name, new Map([...ids].map((id, index) => [id, structuredClone(values[index])])))
      }
    })
    const store: AgentStore = {
      async rows(name) {
        tables.add(name)
        if (!all.has(name)) { if (attempt) throw new MoreSnapshotData(); all.set(name, await businessRows(db.table(name))) }
        return structuredClone(all.get(name)!.filter(row => visible(name, row)))
      },
      async get(name, id) {
        if (!keys.has(name)) keys.set(name, new Set()); keys.get(name)!.add(id)
        if (all.has(name)) return structuredClone(all.get(name)!.find(row => keyOf(name, row) === id && visible(name, row)))
        if (!points.has(name)) points.set(name, new Map())
        if (!points.get(name)!.has(id)) { if (attempt) throw new MoreSnapshotData(); points.get(name)!.set(id, structuredClone(await db.table(name).get(id))) }
        const row = points.get(name)!.get(id); return visible(name, row) ? structuredClone(row) : undefined
      },
      async put() { throw new Error('SCOPE:只读快照只用于读取资料。') }, async remove() { throw new Error('SCOPE:只读快照只用于读取资料。') }, wait: promise => promise,
    }
    try {
      const value = await work(store)
      if (attempt) return value
      const names = [...new Set([...tables, ...points.keys()])]
      if (!names.length) return value
      const valid = await db.transaction('r', names.map(name => db.table(name)), async () => {
        for (const name of tables) if (canonical(snapshotRows(name, await businessRows(db.table(name)))) !== canonical(snapshotRows(name, all.get(name)!))) return false
        for (const [name, values] of points) for (const [id, row] of values) if (!sameSnapshot(name, await db.table(name).get(id), row)) return false
        return true
      })
      if (valid) return value
    } catch (error) { if (!(error instanceof MoreSnapshotData)) throw error }
  }
  throw new Error('CONFLICT:读取范围持续变化，请稍后重新读取。')
}
export function createBookAgentRepository(workspace: ReturnType<typeof createWorkspace>, bookId: string): AgentRepository {
  const db = workspace.openBook(bookId)
  let tail = Promise.resolve()
  return { bookId, async transaction(write, work, lease) {
    return Dexie.ignoreTransaction(async () => {
      if (!await workspace.settings.books.get(bookId)) throw new Error('SCOPE:书籍不存在。')
      if (!write) return readSnapshot(db, work)
      const previous = tail; let release: () => void = () => undefined
      tail = new Promise<void>(resolve => { release = resolve }); await previous
      try { return await writeSnapshot(db, bookId, work, lease) } finally { release() }
    })
  }, async tracePut(rows) {
    if (!rows.length) return
    if (rows.some(row => row.bookId !== bookId)) throw new Error('SCOPE:观测记录归属与当前书籍不一致。')
    await Dexie.ignoreTransaction(() => db.table('storySessionEntries').bulkPut(rows))
  }, async traceRows() {
    return (await db.table('storySessionEntries').toArray()).filter(row => row.bookId === bookId && isObservationEntry(row))
  } }
}
export function createMemoryAgentRepository(bookId: string, initial: Record<string, Row[]> = {}): AgentRepository {
  let data = new Map(Object.entries(initial).map(([table, rows]) => [table, new Map(rows.map(row => [keyOf(table, row), structuredClone(row)]))]))
  let tail = Promise.resolve()
  const tableOf = (name: string) => { if (!data.has(name)) data.set(name, new Map()); return data.get(name)! }
  const store: AgentStore = {
    async rows(table) { return structuredClone([...tableOf(table).values()].filter(row => visible(table, row))) }, async get(table, id) { const row = tableOf(table).get(id); return visible(table, row) ? structuredClone(row) : undefined },
    async put(table, row) { if (row.bookId !== bookId) throw new Error('SCOPE:资料归属与当前书籍不一致。'); tableOf(table).set(keyOf(table, row), structuredClone(row)) },
    async remove(table, id) { tableOf(table).delete(id) }, wait: promise => promise,
  }
  return { bookId, async transaction(write, work, lease) {
    const previous = tail; let release: () => void = () => undefined
    tail = new Promise<void>(resolve => { release = resolve }); await previous
    const snapshot = write ? structuredClone(data) : undefined
    try {
      const value = await work(store)
      if (write && lease) {
        const row = tableOf('pipelineRuns').get(`lease:${lease.lockKey}`)
        if (!row || row.owner !== lease.owner || row.runId !== lease.runId || Number(row.expiresAt) <= Date.now()) throw new Error('CONFLICT:本任务的执行权已失效。')
      }
      return value
    } catch (error) { if (snapshot) data = snapshot; throw error } finally { release() }
  }, async tracePut(rows) {
    if (rows.some(row => row.bookId !== bookId)) throw new Error('SCOPE:观测记录归属与当前书籍不一致。')
    for (const row of rows) tableOf('storySessionEntries').set(keyOf('storySessionEntries', row), structuredClone(row))
  }, async traceRows() {
    return structuredClone([...tableOf('storySessionEntries').values()].filter(row => row.bookId === bookId && isObservationEntry(row)))
  } }
}
