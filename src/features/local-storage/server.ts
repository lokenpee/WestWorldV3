import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SqliteRecordStore } from './sqliteStore.ts'
import { assertAddress, indexValue, matches, schemaFor, type RecordQuery } from './schema.ts'
import type { CredentialProtector, RecordWrite, StoredRecord, StoredValue, StorageNotice, StorageTarget } from './contracts.ts'

interface TransactionState {
  id: string; scope: string; tables: Set<string>; write: boolean; touched: number
  changes: Map<string, Map<string, StoredValue | undefined>>
}
export function createLocalStorageServer(directory: string, protector: CredentialProtector, backupInterval = 300000) {
  // HTTP服务在事务外异步处理凭据；SQLite只接收密文。
  const store = new SqliteRecordStore(directory, { protect: value => value, unprotect: value => value })
  const credentials = new Map<string, { version: number; ciphertext: string; value: Promise<string> }>()
  async function decode(table: string, row: StoredRecord | null | undefined): Promise<StoredRecord | undefined> {
    if (!row || table !== 'credentials' || row.value.key === undefined) return row ?? undefined
    const ciphertext = String(row.value.key), previous = credentials.get(row.key)
    let cached = previous?.version === row.version && previous.ciphertext === ciphertext ? previous : undefined
    if (!cached) {
      const value = Promise.resolve().then(() => protector.unprotectAsync ? protector.unprotectAsync(ciphertext) : protector.unprotect(ciphertext))
      cached = { version: row.version, ciphertext, value }; credentials.set(row.key, cached)
      const current = cached
      void value.catch(() => { if (credentials.get(row.key) === current) credentials.delete(row.key) })
    }
    return { ...row, value: { ...row.value, key: await cached.value } }
  }
  const epoch = randomUUID(), notices: StorageNotice[] = []
  const category = (table: string, value: StoredValue) => table === 'storySessionEntries'
    ? ['request_trace', 'prompt_snapshot', 'tool_snapshot'].includes(String(value.type)) ? 'observation' as const : 'business' as const
    : table === 'pipelineRuns' ? value.recordType === 'lease' ? 'lease' as const : value.recordType === 'history_index' ? 'history' as const : value.stage === 'manual_merge' ? 'merge' as const : 'run' as const : undefined
  async function commit(writes: RecordWrite[]) {
    const targets = new Map<string, StorageTarget>()
    for (const write of writes) {
      const before = ['storySessionEntries', 'pipelineRuns'].includes(write.table) ? store.notificationFields(write.scope, write.table, write.key) : undefined
      const nextCategory = write.value ? category(write.table, write.value) : before ? category(write.table, before) : undefined
      const target: StorageTarget = { scope: write.scope, table: write.table, ...(nextCategory && (!before || !write.value || category(write.table, before) === nextCategory) ? { category: nextCategory } : {}) }
      targets.set(JSON.stringify(target), target)
    }
    const encrypted: RecordWrite[] = []
    for (const write of writes) {
      if (write.table !== 'credentials' || !write.value) { encrypted.push(write); continue }
      if (typeof write.value.key !== 'string') throw new Error('本机凭据保护尚未配置或密钥格式错误。')
      const key = protector.protectAsync ? await protector.protectAsync(write.value.key) : protector.protect(write.value.key)
      encrypted.push({ ...write, value: { ...write.value, key } })
    }
    if (closed) throw new Error('存储服务已关闭。')
    const status = store.commit(encrypted)
    for (const write of writes) if (write.table === 'credentials') credentials.delete(write.key)
    if (writes.length) targets.set('status', { scope: 'status' })
    const change: StorageNotice = { epoch, revision: status.revision, targets: [...targets.values()] }
    if (writes.length) { notices.push(change); if (notices.length > 256) notices.shift() }
    return { ...status, change }
  }
  const transactions = new Map<string, TransactionState>()
  const locks = new Map<string, string>()
  const waiters = new Set<() => void>()
  let closed = false, dirty = false, lastBackupAt = store.status().lastBackupAt, backupError: string | undefined
  let backupTimer: ReturnType<typeof setTimeout> | undefined
  let backupWork: Promise<void> | undefined
  function release(tx: TransactionState) { transactions.delete(tx.id); locks.delete(tx.scope); for (const wake of waiters) wake(); waiters.clear() }
  const cleanup = setInterval(() => { for (const tx of transactions.values()) if (Date.now() - tx.touched > 60000) release(tx) }, 1000)
  cleanup.unref()
  async function makeBackup() {
    if (backupWork) await backupWork
    if (!dirty) return
    dirty = false
    backupWork = (async () => {
      try { await store.backup(); lastBackupAt = new Date().toISOString(); backupError = undefined }
      catch { dirty = true; backupError = '自动备份失败，主库已保存；请检查数据磁盘剩余空间和权限后重试。' }
    })()
    try { await backupWork } finally { backupWork = undefined }
  }
  function saved() {
    dirty = true
    if (!backupTimer) { backupTimer = setTimeout(() => { backupTimer = undefined; void makeBackup() }, lastBackupAt ? backupInterval : 0); backupTimer.unref() }
  }
  async function begin(scope: string, tables: string[], write: boolean) {
    for (const table of tables) assertAddress(scope, table)
    while (locks.has(scope)) {
      await new Promise<void>(resolve => { waiters.add(resolve) })
      if (closed) throw new Error('存储服务已关闭。')
    }
    const tx: TransactionState = { id: randomUUID(), scope, tables: new Set(tables), write, touched: Date.now(), changes: new Map() }
    transactions.set(tx.id, tx); locks.set(scope, tx.id)
    return tx.id
  }
  function transaction(id: string, scope: string, table?: string, write = false) {
    const tx = transactions.get(id)
    if (!tx || tx.scope !== scope || table && !tx.tables.has(table) || write && !tx.write) throw new Error('事务已失效或不包含当前操作，请重试。')
    tx.touched = Date.now()
    return tx
  }
  async function get(scope: string, table: string, key: string, tx?: TransactionState): Promise<StoredRecord | undefined> {
    const changes = tx?.changes.get(table)
    if (changes?.has(key)) { const value = changes.get(key); return value ? { key, value: structuredClone(value), version: 0 } : undefined }
    return decode(table, store.get({ scope, table, key }))
  }
  async function query(scope: string, table: string, options: RecordQuery, tx?: TransactionState) {
    const changes = tx?.changes.get(table)
    if (!changes?.size) return Promise.all(store.query(scope, table, options).map(async row => (await decode(table, row))!))
    const rows = new Map((await Promise.all(store.query(scope, table, { ...options, offset: 0, limit: -1, keysOnly: false }).map(async row => (await decode(table, row))!))).map(row => [row.key, row]))
    for (const [key, value] of changes) {
      if (value && matches(indexValue(value, key, options.index), options)) rows.set(key, { key, value, version: 0 })
      else rows.delete(key)
    }
    const compare = (a: unknown, b: unknown): number => Array.isArray(a) && Array.isArray(b)
      ? a.reduce((result: number, item, i) => result || compare(item, b[i]), 0) : a === b ? 0 : (a as string | number) < (b as string | number) ? -1 : 1
    const sorted = [...rows.values()].sort((a, b) => (compare(indexValue(a.value, a.key, options.index), indexValue(b.value, b.key, options.index)) || compare(a.key, b.key)) * (options.reverse ? -1 : 1))
    const start = options.offset ?? 0
    return sorted.slice(start, options.limit === undefined || options.limit === -1 ? undefined : start + options.limit).map(row => options.keysOnly ? { ...row, value: {} } : row)
  }
  async function execute(body: Record<string, unknown>): Promise<unknown> {
    if (closed) throw new Error('存储服务已关闭。')
    const action = String(body.action), scope = String(body.scope ?? ''), table = String(body.table ?? '')
    if (action === 'status') {
      const status = store.status(), since = typeof body.since === 'number' ? body.since : undefined
      const reset = since === undefined || body.epoch !== epoch || since > status.revision || since < status.revision && (!notices.length || since < notices[0].revision - 1)
      return { ...status, lastBackupAt, backupError, epoch, reset, notices: reset ? [] : notices.filter(notice => notice.revision > since!) }
    }
    if (action === 'backup') { dirty = true; await makeBackup(); if (backupError) throw new Error(backupError); return { lastBackupAt } }
    // Never hold an HTTP connection while waiting for another transaction: browser connection
    // limits would prevent the owning transaction from sending its next read/commit request.
    if (action === 'begin') return locks.has(scope) ? null : begin(scope, body.tables as string[], body.write === true)
    if (action === 'exists') { assertAddress(scope, Object.keys(schemaFor(scope))[0]); return store.scopeExists(scope) }
    if (action === 'tracePage') { assertAddress(scope, 'storySessionEntries'); return store.tracePage(scope, body.options as Parameters<typeof store.tracePage>[1]) }
    if (action === 'executionPage') { assertAddress(scope, 'storySessionEntries'); return store.executionPage(scope, body.options as Parameters<typeof store.executionPage>[1]) }
    if (action === 'assetPage') { assertAddress(scope, 'characters'); return store.assetPage(scope, body.kind as Parameters<typeof store.assetPage>[1], (body.options ?? {}) as Parameters<typeof store.assetPage>[2]) }
    if (action === 'executionBody') { assertAddress(scope, 'storySessionEntries'); return store.executionBody(scope, body.options as Parameters<typeof store.executionBody>[1]) }
    if (action === 'publishMigration') {
      const book = body.book as StoredValue, id = String(book?.id ?? ''), digest = String(body.digest ?? '')
      if (!id || !digest) throw new Error('迁移信息不完整。')
      const target = `book:${id}`, pending = `book:pending:${id}`
      const held: TransactionState[] = []
      try {
        for (const scope of ['settings', target, pending]) held.push(transaction(await begin(scope, Object.keys(schemaFor(scope)), true), scope))
        const markerKey = `migration:book:${id}`
        const marker = store.get({ scope: 'settings', table: 'appSettings', key: markerKey })
        if (store.get({ scope: 'settings', table: 'books', key: id })) {
          if ((marker?.value.value as StoredValue)?.digest === digest) return { alreadyApplied: true }
          throw new Error('磁盘已有相同编号的书籍，未覆盖；请使用整书备份恢复为副本。')
        }
        if (store.scopeExists(target)) throw new Error('磁盘已有此书的未发布资料，请先完成待恢复操作。')
        const counts = body.counts as Record<string, number>, writes: RecordWrite[] = []
        for (const table of Object.keys(schemaFor(target))) {
          const rows = store.query(pending, table)
          if (rows.length !== counts[table]) throw new Error('迁移记录数量不符，请重新复制。')
          for (const row of rows) { writes.push({ scope: target, table, key: row.key, value: row.value }); writes.push({ scope: pending, table, key: row.key }) }
        }
        writes.push({ scope: 'settings', table: 'books', key: id, value: book })
        writes.push({ scope: 'settings', table: 'appSettings', key: markerKey, value: { key: markerKey, value: { source: body.source, digest, counts, status: 'completed' } } })
        await commit(writes); saved()
        return { alreadyApplied: false }
      } finally { for (const tx of held) release(tx) }
    }
    if (action === 'migrateSettings') {
      const tx = transaction(await begin('settings', ['appSettings', 'credentials'], true), 'settings')
      try {
        const writes: RecordWrite[] = []
        for (const table of ['appSettings', 'credentials']) for (const value of (body[table] ?? []) as StoredValue[]) {
          const key = String(value[schemaFor('settings')[table]])
          if (table === 'appSettings' && /^(book\.lifecycle:|migration:|assets\.exportDirectory$)/.test(key)) continue
          if (!store.get({ scope: 'settings', table, key })) writes.push({ scope: 'settings', table, key, value })
        }
        await commit(writes); if (writes.length) saved()
        return null
      } finally { release(tx) }
    }
    const tx = body.transaction ? transaction(String(body.transaction), scope, table || undefined, ['put', 'add', 'remove', 'bulk', 'bulkRemove', 'bulkUpdate'].includes(action)) : undefined
    if (action === 'commit' || action === 'abort') {
      if (!tx) throw new Error('缺少事务。')
      try {
        if (action === 'abort') return null
        const writes: RecordWrite[] = []
        for (const [name, changes] of tx.changes) for (const [key, value] of changes) writes.push({ scope, table: name, key, value })
        const status = await commit(writes)
        if (writes.length) saved()
        return status
      } finally { release(tx) }
    }
    assertAddress(scope, table)
    if (action === 'query') return query(scope, table, (body.query ?? {}) as RecordQuery, tx)
    if (action === 'count') return tx?.changes.get(table)?.size ? (await query(scope, table, { ...(body.query ?? {}) as RecordQuery, keysOnly: true }, tx)).length : store.count(scope, table, (body.query ?? {}) as RecordQuery)
    if (action === 'bulkGet') {
      if (!Array.isArray(body.keys)) throw new Error('批量读取需要主键列表。')
      const keys = body.keys.map(String), changes = tx?.changes.get(table)
      const rows = store.bulkGet(scope, table, keys)
      return Promise.all(rows.map(async (row, index) => (changes?.has(keys[index]) ? await get(scope, table, keys[index], tx) : await decode(table, row)) ?? null))
    }
    if (action === 'bulkRemove' || action === 'bulkUpdate') {
      if (!tx?.write) throw new Error('批量修改需要写事务。')
      if (action === 'bulkRemove') {
        if (!Array.isArray(body.keys)) throw new Error('批量删除需要主键列表。')
        for (const key of body.keys) await execute({ action: 'remove', scope, table, transaction: tx.id, key: String(key) })
        return null
      }
      if (!Array.isArray(body.updates)) throw new Error('批量更新需要记录列表。')
      let count = 0
      for (const item of body.updates as { key: string; changes: StoredValue }[]) {
        const row = await get(scope, table, String(item.key), tx)
        if (!row) continue
        const value = { ...row.value, ...item.changes }
        await execute({ action: 'put', scope, table, transaction: tx.id, key: String(value[schemaFor(scope)[table]]), value }); count++
      }
      return count
    }
    if (action === 'bulk') {
      if (!tx || !tx.write || !Array.isArray(body.rows)) throw new Error('批量写入需要事务和记录。')
      for (const value of body.rows as StoredValue[]) {
        const key = value[schemaFor(scope)[table]]
        if (key === undefined || key === null) throw new Error('缺少记录主键。')
        await execute({ action: body.add ? 'add' : 'put', transaction: tx.id, scope, table, key: String(key), value })
      }
      return null
    }
    const key = String(body.key ?? '')
    if (!key) throw new Error('缺少记录主键。')
    if (action === 'credentialPresent') {
      if (table !== 'credentials') throw new Error('凭据状态只适用于凭据表。')
      const pending = tx?.changes.get(table)
      const row = pending?.has(key) ? pending.get(key) : store.get({ scope, table, key })?.value
      return typeof row?.key === 'string' && !!row.key.trim()
    }
    if (action === 'get') return await get(scope, table, key, tx) ?? null
    if (!tx || !tx.write) throw new Error('写入需要事务。')
    if (!['put', 'add', 'remove'].includes(action)) throw new Error('未知存储操作。')
    if (action === 'add' && await get(scope, table, key, tx)) throw new Error('ConstraintError:记录已存在。')
    const value = action === 'remove' ? undefined : body.value as StoredValue
    if (value && String(value[schemaFor(scope)[table]]) !== key) throw new Error('主键与记录不一致。')
    if (!tx.changes.has(table)) tx.changes.set(table, new Map())
    tx.changes.get(table)!.set(key, value)
    return key
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    try {
      const host = req.headers.host ?? ''
      // Fixed loopback host + same-origin JSON POST: other sites cannot read credentials or mutate the library.
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host) || req.headers.origin && req.headers.origin !== `http://${host}` || req.headers['sec-fetch-site'] === 'cross-site') { res.statusCode = 403; throw new Error('请求来源不受信任。') }
      if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) { res.statusCode = 405; throw new Error('仅接受JSON POST请求。') }
      const buffers: Buffer[] = []; let size = 0
      for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024 * 1024) throw new Error('本次提交过大，请分批保存。'); buffers.push(Buffer.from(chunk)) }
      let input: Record<string, unknown>
      try { input = JSON.parse(Buffer.concat(buffers).toString('utf8')) } catch { throw new Error('请求不是有效JSON。') }
      const result = await execute(input)
      res.end(JSON.stringify({ ok: true, result }))
    } catch (error) {
      if (res.statusCode === 200) res.statusCode = 500
      const message = error instanceof Error ? error.message : '本机存储操作失败。'
      // SQLite errors may include values; do not echo database diagnostics or secrets.
      res.end(JSON.stringify({ ok: false, error: /SQLITE|constraint failed|disk I\/O|database or disk is full/i.test(message) ? '磁盘保存失败，请检查空间、权限或记录冲突后重试。' : message }))
    }
  }
  return {
    handle, execute,
    async close() { closed = true; credentials.clear(); clearInterval(cleanup); clearTimeout(backupTimer); for (const tx of [...transactions.values()]) release(tx); await makeBackup(); store.close() },
  }
}
