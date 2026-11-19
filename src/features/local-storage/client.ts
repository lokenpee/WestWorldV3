import type Dexie from 'dexie'
import { bookSchema, settingsSchema, type RecordQuery, type QueryValue } from './schema'
import type { StorageStatus, StoredRecord, StoredValue, StorageNotice, StorageInterest, StorageTarget } from './contracts'

export type StorageCall = <T>(body: Record<string, unknown>) => Promise<T>
const encoder = new TextEncoder()
/** 为请求外壳预留1KiB；单条大记录独占一包，沿HTTP原上限处理。 */
export function storageBatches<T>(items: T[]): T[][] {
  const batches: T[][] = []; let batch: T[] = [], bytes = 1024
  for (const item of items) {
    const size = encoder.encode(JSON.stringify(item)).length + 1
    if (batch.length && (batch.length >= 200 || bytes + size > 1024 * 1024)) { batches.push(batch); batch = []; bytes = 1024 }
    batch.push(item); bytes += size
  }
  if (batch.length) batches.push(batch)
  return batches
}
export function httpStorageCall(endpoint = '/api/storage'): StorageCall {
  return async <T>(body: Record<string, unknown>): Promise<T> => {
    let response: Response
    try { response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }
    catch { throw new Error('无法连接本机存储服务。请启动本地服务后重试，尚未确认的修改不会显示为已保存。') }
    let payload: { ok: boolean; result: T; error?: string }
    try { payload = await response.json() } catch { throw new Error('本机存储服务未就绪，请重新启动本地服务。') }
    if (!response.ok || !payload.ok) throw new Error(payload.error ?? '本机保存失败，请重试。')
    return payload.result
  }
}
type StorageChange = { targets: StorageTarget[] }
const listeners = new Set<(change?: StorageChange) => void>()
export const storageChanged = (change?: StorageChange) => { if (!change || change.targets.length) for (const listener of listeners) listener(change) }
export const onStorageChanged = (listener: () => void, interests?: readonly StorageInterest[]) => {
  const receive = (change?: StorageChange) => {
    if (!change || !interests || interests.some(interest => change.targets.some(target => interest.scope === target.scope && (!interest.tables || !target.table || interest.tables.includes(target.table)) && (!interest.category || !target.category || interest.category === target.category)))) listener()
  }
  listeners.add(receive); return () => { listeners.delete(receive) }
}
const seenNotices = new WeakMap<StorageCall, Set<string>>()
function noticeTargets(call: StorageCall, notices: StorageNotice[]) {
  let seen = seenNotices.get(call)
  if (!seen) { seen = new Set(); seenNotices.set(call, seen) }
  const targets = new Map<string, StorageTarget>()
  for (const notice of notices) {
    const key = `${notice.epoch}:${notice.revision}`
    if (seen.has(key) || !notice.targets.length) continue
    seen.add(key); if (seen.size > 512) seen.delete(seen.values().next().value!)
    for (const target of notice.targets) targets.set(JSON.stringify(target), target)
  }
  return [...targets.values()]
}

class RemoteCollection {
  readonly table: RemoteTable
  readonly query: RecordQuery
  readonly predicates: ((row: StoredValue) => boolean)[]
  constructor(table: RemoteTable, query: RecordQuery = {}, predicates: ((row: StoredValue) => boolean)[] = []) { this.table = table; this.query = query; this.predicates = predicates }
  private next(query: Partial<RecordQuery>) { return new RemoteCollection(this.table, { ...this.query, ...query }, this.predicates) }
  equals(value: QueryValue) { return this.next({ operator: 'equals', values: [value] }) }
  anyOf(...values: QueryValue[]) { return this.next({ operator: 'anyOf', values: (values.length === 1 && Array.isArray(values[0]) && !this.query.index?.startsWith('[') ? values[0] : values) as QueryValue[] }) }
  noneOf(values: QueryValue[]) { return this.next({ operator: 'noneOf', values }) }
  startsWith(value: string) { return this.next({ operator: 'startsWith', values: [value] }) }
  reverse() { return this.next({ reverse: !this.query.reverse }) }
  offset(offset: number) { return this.next({ offset }) }
  limit(limit: number) { return this.next({ limit }) }
  filter(predicate: (row: StoredValue) => boolean) { return new RemoteCollection(this.table, this.query, [...this.predicates, predicate]) }
  and(predicate: (row: StoredValue) => boolean) { return this.filter(predicate) }
  async records(keysOnly = false): Promise<StoredRecord[]> {
    const query = this.predicates.length ? { ...this.query, offset: undefined, limit: undefined, keysOnly: false } : { ...this.query, keysOnly }
    const rows = await this.table.db.request<StoredRecord[]>({ action: 'query', table: this.table.name, query })
    if (!this.predicates.length) return rows
    const start = this.query.offset ?? 0
    return rows.filter(row => this.predicates.every(test => test(row.value))).slice(start, this.query.limit === undefined ? undefined : start + this.query.limit)
  }
  async toArray() { return (await this.records()).map(row => row.value) }
  async primaryKeys() { return (await this.records(true)).map(row => row.key) }
  async count(): Promise<number> { return this.predicates.length ? (await this.records(true)).length : this.table.db.request<number>({ action: 'count', table: this.table.name, query: this.query }) }
  async first() { return (await this.limit(1).toArray())[0] }
  async last() { return this.reverse().first() }
  async sortBy(field: string) { return (await this.toArray()).sort((a, b) => a[field] === b[field] ? 0 : (a[field] as number) < (b[field] as number) ? -1 : 1) }
  async modify(changes: StoredValue) { return this.table.db.atomic(async db => {
    const rows = await new RemoteCollection(db.table(this.table.name), this.query, this.predicates).toArray()
    await db.table(this.table.name).bulkPut(rows.map(row => ({ ...row, ...changes })))
    return rows.length
  }) }
  async delete() {
    return this.table.db.atomic(async db => {
      const collection = new RemoteCollection(db.table(this.table.name), this.query, this.predicates)
      const keys = await collection.primaryKeys()
      await db.table(this.table.name).bulkDelete(keys)
      return keys.length
    })
  }
}
class RemoteTable extends RemoteCollection {
  readonly name: string
  readonly db: RemoteDatabase
  constructor(db: RemoteDatabase, name: string) {
    super(undefined as unknown as RemoteTable)
    this.name = name; this.db = db
    Object.defineProperty(this, 'table', { value: this })
  }
  get schema() { return { name: this.name, primKey: { name: this.db.schema[this.name], keyPath: this.db.schema[this.name] } } }
  where(index: string) { return new RemoteCollection(this, { index }) }
  orderBy(index: string) { return new RemoteCollection(this, { index }) }
  toCollection() { return new RemoteCollection(this) }
  async get(key: string) { return (await this.db.request<StoredRecord | null>({ action: 'get', table: this.name, key: String(key) }))?.value }
  async bulkGet(keys: string[]) {
    const rows: (StoredValue | undefined)[] = []
    for (const batch of storageBatches(keys.map(String))) rows.push(...(await this.db.request<(StoredRecord | null)[]>({ action: 'bulkGet', table: this.name, keys: batch })).map(row => row?.value))
    return rows
  }
  async put(value: StoredValue) { return this.write('put', value) }
  async add(value: StoredValue) { return this.write('add', value) }
  private async write(action: string, value: StoredValue) {
    const key = value[this.db.schema[this.name]]
    if (key === undefined || key === null) throw new Error('缺少记录主键。')
    return this.db.atomic(db => db.request<string>({ action, table: this.name, key: String(key), value }))
  }
  private async bulk(values: StoredValue[], add: boolean) { return this.db.atomic(async db => {
    for (const batch of storageBatches(values)) await db.request({ action: 'bulk', table: this.name, rows: batch, add })
    return values.length ? String(values.at(-1)![db.schema[this.name]]) : undefined
  }) }
  async bulkPut(values: StoredValue[]) { return this.bulk(values, false) }
  async bulkAdd(values: StoredValue[]) { return this.bulk(values, true) }
  async bulkDelete(keys: string[]) { return this.db.atomic(async db => { for (const batch of storageBatches(keys.map(String))) await db.request({ action: 'bulkRemove', table: this.name, keys: batch }) }) }
  async delete(key?: string): Promise<number> { if (key === undefined) return super.delete(); await this.bulkDelete([key]); return 1 }
  async clear() { await super.delete() }
  async update(key: string, changes: StoredValue) {
    return this.db.atomic(async db => {
      const row = await db.table(this.name).get(key)
      if (!row) return 0
      await db.table(this.name).put({ ...row, ...changes }); return 1
    })
  }
  async bulkUpdate(updates: { key: string; changes: StoredValue }[]) { return this.db.atomic(async db => {
    let count = 0
    for (const batch of storageBatches(updates)) count += await db.request<number>({ action: 'bulkUpdate', table: this.name, updates: batch })
    return count
  }) }
}

export class RemoteDatabase {
  readonly schema: Record<string, string>
  readonly call: StorageCall
  readonly scope: string
  readonly name: string
  readonly transactionId?: string
  readonly allowedTables?: string[]
  private opened = false
  private readonly cachedTables = new Map<string, RemoteTable>()
  constructor(call: StorageCall, scope: string, name: string, transactionId?: string, allowedTables?: string[]) {
    this.call = call; this.scope = scope; this.name = name; this.transactionId = transactionId; this.allowedTables = allowedTables
    this.schema = scope === 'settings' ? settingsSchema : bookSchema
  }
  request<T>(body: Record<string, unknown>): Promise<T> { return this.call<T>({ ...body, scope: this.scope, transaction: this.transactionId }) }
  table(name: string) {
    if (!Object.hasOwn(this.schema, name) || this.allowedTables && !this.allowedTables.includes(name)) throw new Error('当前事务不包含此表。')
    if (!this.cachedTables.has(name)) this.cachedTables.set(name, new RemoteTable(this, name))
    return this.cachedTables.get(name)!
  }
  get tables() { return Object.keys(this.schema).map(name => this.table(name)) }
  get chapters() { return this.table('chapters') }
  get books() { return this.table('books') }
  get appSettings() { return this.table('appSettings') }
  async open() { await this.call({ action: 'status' }); this.opened = true; return this }
  isOpen() { return this.opened }
  close() { this.opened = false }
  async atomic<T>(work: (db: RemoteDatabase) => Promise<T>): Promise<T> {
    if (this.transactionId) return work(this)
    return this.transaction('rw', this.tables, tx => work(tx.db))
  }
  async transaction<T>(mode: string, tables: RemoteTable[], work: (tx: { db: RemoteDatabase; table: (name: string) => RemoteTable; storeNames: string[] }) => Promise<T>): Promise<T> {
    const names = tables.flat().map(table => table.name)
    if (this.transactionId) return work({ db: this, table: name => this.table(name), storeNames: names })
    let id: string | null = null, delay = 20
    while (!id) {
      id = await this.call<string | null>({ action: 'begin', scope: this.scope, tables: names, write: mode.startsWith('rw') })
      if (!id) { await new Promise(resolve => setTimeout(resolve, delay)); delay = Math.min(200, delay * 2) }
    }
    const db = new RemoteDatabase(this.call, this.scope, this.name, id, names)
    try {
      const result = await work({ db, table: name => db.table(name), storeNames: names })
      const committed = await db.request<StorageStatus>({ action: 'commit' })
      if (mode.startsWith('rw')) { if (committed?.change) storageChanged({ targets: noticeTargets(this.call, [committed.change]) }); else storageChanged() }
      return result
    } catch (error) { await db.request({ action: 'abort' }).catch(() => undefined); throw error }
  }
}

/** Compatibility boundary for the existing Table query surface; native Dexie remains the legacy reader. */
export function remoteDatabase<D extends Dexie>(call: StorageCall, scope: string, name: string): D {
  return new RemoteDatabase(call, scope, name) as unknown as D
}

/** 读取正文缓存所需的存储版本；保留传入数据库句柄的事务视图。 */
export function versionedTable(db: unknown, table: string) {
  if (!(db instanceof RemoteDatabase)) return undefined
  const rows = db.table(table)
  return {
    async versions(): Promise<Pick<StoredRecord, 'key' | 'version'>[]> {
      return (await rows.records(true)).map(({ key, version }) => ({ key, version }))
    },
    async get(key: string): Promise<StoredRecord | undefined> {
      return (await db.request<StoredRecord | null>({ action: 'get', table, key })) ?? undefined
    },
  }
}

export function watchDiskRevision(call: StorageCall) {
  let signature: string | undefined, stopped = false, connected = false, failed = false
  let revision: number | undefined, epoch: string | undefined
  let timer: ReturnType<typeof setTimeout>
  const poll = async () => {
    try {
      const state = await call<StorageStatus>({ action: 'status', since: revision, epoch }), next = JSON.stringify([state.lastBackupAt, state.backupError])
      if (stopped) return
      if (!connected || state.reset || !state.epoch && state.revision !== revision) storageChanged()
      else {
        const targets = noticeTargets(call, state.notices ?? [])
        if (signature !== next && !targets.some(target => target.scope === 'status')) targets.push({ scope: 'status' })
        storageChanged({ targets })
      }
      signature = next; revision = state.revision; epoch = state.epoch; connected = true; failed = false
    }
    catch { if (!stopped && !failed) storageChanged(); connected = false; failed = true }
    if (!stopped) timer = setTimeout(() => void poll(), 1500)
  }
  void poll()
  return () => { stopped = true; clearTimeout(timer) }
}
