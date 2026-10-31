import Dexie from 'dexie'
import type { createWorkspace } from '../../lib/storage/workspace'

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
export function createBookAgentRepository(workspace: ReturnType<typeof createWorkspace>, bookId: string): AgentRepository {
  const db = workspace.openBook(bookId)
  return { bookId, async transaction(write, work) {
    return Dexie.ignoreTransaction(async () => {
      if (!await workspace.settings.books.get(bookId)) throw new Error('SCOPE:书籍不存在。')
      return db.transaction(write ? 'rw' : 'r', db.tables, transaction => Dexie.waitFor(work({
      rows: table => transaction.table(table).toArray(), get: (table, id) => transaction.table(table).get(id),
      async put(table, row) { if (row.bookId !== bookId) throw new Error('SCOPE:资料归属与当前书籍不一致。'); await transaction.table(table).put(row) },
      async remove(table, id) { await transaction.table(table).delete(id) }, wait: promise => promise,
      })))
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
