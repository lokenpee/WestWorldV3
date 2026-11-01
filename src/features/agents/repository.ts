import Dexie from 'dexie'
import type { createWorkspace } from '../../lib/storage/workspace'
import { canonical } from './contracts'

export type Row = Record<string, unknown>
export interface AgentStore {
  rows(table: string): Promise<Row[]>
  get(table: string, id: string): Promise<Row | undefined>
  put(table: string, row: Row): Promise<void>
  remove(table: string, id: string): Promise<void>
  wait<T>(promise: Promise<T>): Promise<T>
}
export interface AgentRepository { bookId: string; transaction<T>(write: boolean, work: (store: AgentStore) => Promise<T>): Promise<T> }
const keyOf = (table: string, row: Row) => String(table === 'chapters' || table === 'chapterTexts' ? row.chapterIndex : table === 'assetLifecycle' || table === 'extractionReceipts' ? row.key : table === 'compileProgress' ? row.stage : row.id)
class MoreSnapshotData extends Error {}
class SnapshotConflict extends Error {}
async function writeSnapshot<T>(db: ReturnType<ReturnType<typeof createWorkspace>['openBook']>, bookId: string, work: (store: AgentStore) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const full = new Map<string, Row[]>(), points = new Map<string, Map<string, Row | undefined>>(), changes = new Map<string, Map<string, Row | undefined>>()
    const fences = new Map<string, Row | undefined>()
    for (const domain of ['world', 'narrative', 'extraction']) fences.set(domain, structuredClone(await db.table('pipelineRuns').get(`lease:${domain}`)))
    const base = async (table: string, id: string) => {
      if (full.has(table)) return full.get(table)!.find(row => keyOf(table, row) === id)
      if (!points.has(table)) points.set(table, new Map())
      if (!points.get(table)!.has(id)) points.get(table)!.set(id, structuredClone(await db.table(table).get(id)))
      return points.get(table)!.get(id)
    }
    const store: AgentStore = {
      async get(table, id) { return structuredClone(changes.get(table)?.has(id) ? changes.get(table)!.get(id) : await base(table, id)) },
      async rows(table) {
        if (!full.has(table)) full.set(table, structuredClone(await db.table(table).toArray()))
        const rows = new Map(full.get(table)!.map(row => [keyOf(table, row), row]))
        for (const [id, row] of changes.get(table) ?? []) { if (row) rows.set(id, row); else rows.delete(id) }
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
    const tables = [...new Set([...full.keys(), ...points.keys(), ...changes.keys(), 'pipelineRuns'])]
    try {
      await db.transaction('rw', tables.map(table => db.table(table)), async transaction => {
        for (const [table, rows] of full) if (canonical(await transaction.table(table).toArray()) !== canonical(rows)) throw new SnapshotConflict()
        for (const [table, rows] of points) for (const [id, row] of rows) if (canonical(await transaction.table(table).get(id)) !== canonical(row)) throw new SnapshotConflict()
        for (const domain of domains) {
          const current = await transaction.table('pipelineRuns').get(`lease:${domain}`)
          if (canonical(current) !== canonical(fences.get(domain))) throw new SnapshotConflict()
          const renewal = changes.get('pipelineRuns')?.get(`lease:${domain}`)
          if (current && Number(current.expiresAt) <= Date.now() && !renewal) throw new Error('CONFLICT:本任务的执行权已失效。')
        }
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
      for (const name of tables) all.set(name, structuredClone(await db.table(name).toArray()))
      for (const [name, ids] of keys) {
        const values = all.has(name) ? [...ids].map(id => all.get(name)!.find(row => keyOf(name, row) === id)) : await db.table(name).bulkGet([...ids])
        points.set(name, new Map([...ids].map((id, index) => [id, structuredClone(values[index])])))
      }
    })
    const store: AgentStore = {
      async rows(name) {
        tables.add(name)
        if (!all.has(name)) { if (attempt) throw new MoreSnapshotData(); all.set(name, structuredClone(await db.table(name).toArray())) }
        return structuredClone(all.get(name)!)
      },
      async get(name, id) {
        if (!keys.has(name)) keys.set(name, new Set()); keys.get(name)!.add(id)
        if (all.has(name)) return structuredClone(all.get(name)!.find(row => keyOf(name, row) === id))
        if (!points.has(name)) points.set(name, new Map())
        if (!points.get(name)!.has(id)) { if (attempt) throw new MoreSnapshotData(); points.get(name)!.set(id, structuredClone(await db.table(name).get(id))) }
        return structuredClone(points.get(name)!.get(id))
      },
      async put() { throw new Error('SCOPE:只读快照只用于读取资料。') }, async remove() { throw new Error('SCOPE:只读快照只用于读取资料。') }, wait: promise => promise,
    }
    try {
      const value = await work(store)
      if (attempt) return value
      const names = [...new Set([...tables, ...points.keys()])]
      if (!names.length) return value
      const valid = await db.transaction('r', names.map(name => db.table(name)), async () => {
        for (const name of tables) if (canonical(await db.table(name).toArray()) !== canonical(all.get(name))) return false
        for (const [name, values] of points) for (const [id, row] of values) if (canonical(await db.table(name).get(id)) !== canonical(row)) return false
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
  return { bookId, async transaction(write, work) {
    return Dexie.ignoreTransaction(async () => {
      if (!await workspace.settings.books.get(bookId)) throw new Error('SCOPE:书籍不存在。')
      if (!write) return readSnapshot(db, work)
      const previous = tail; let release: () => void = () => undefined
      tail = new Promise<void>(resolve => { release = resolve }); await previous
      try { return await writeSnapshot(db, bookId, work) } finally { release() }
    })
  } }
}
export function createMemoryAgentRepository(bookId: string, initial: Record<string, Row[]> = {}): AgentRepository {
  let data = new Map(Object.entries(initial).map(([table, rows]) => [table, new Map(rows.map(row => [keyOf(table, row), structuredClone(row)]))]))
  let tail = Promise.resolve()
  const tableOf = (name: string) => { if (!data.has(name)) data.set(name, new Map()); return data.get(name)! }
  const store: AgentStore = {
    async rows(table) { return structuredClone([...tableOf(table).values()]) }, async get(table, id) { return structuredClone(tableOf(table).get(id)) },
    async put(table, row) { if (row.bookId !== bookId) throw new Error('SCOPE:资料归属与当前书籍不一致。'); tableOf(table).set(keyOf(table, row), structuredClone(row)) },
    async remove(table, id) { tableOf(table).delete(id) }, wait: promise => promise,
  }
  return { bookId, async transaction(write, work) {
    const previous = tail; let release: () => void = () => undefined
    tail = new Promise<void>(resolve => { release = resolve }); await previous
    const snapshot = write ? structuredClone(data) : undefined
    try { return await work(store) } catch (error) { if (snapshot) data = snapshot; throw error } finally { release() }
  } }
}
