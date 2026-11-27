import { DatabaseSync, backup } from 'node:sqlite'
import { mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { StorageConflict, type CredentialProtector, type RecordAddress, type RecordPage, type RecordWrite, type StorageStatus, type StoredRecord, type StoredValue } from './contracts.ts'
import type { RecordQuery } from './schema.ts'
import { executionBody, executionPage } from './executionQueries.ts'
import type { ExecutionQuery } from '../agents/executionPagingTypes.ts'
import { assetPageFields, makeAssetPage, pageTables, type AssetPageOptions, type PageKind } from '../assets/assetPage.ts'
import { searchRelationTables, type SearchRelations } from '../assets/narrativeSearch.ts'
import { migrateStoredNarrativeFields } from './migrateNarrativeFields.ts'
import type { SearchAsset } from '../assets/search.ts'

const schemaVersion = 2
const uniqueFields: Record<string, string[][]> = {
  pipelineRuns: [['lockKey']], storyEditorNotes: [['sessionId', 'key']], storySessionEntries: [['sessionId', 'ordinal']],
}
interface RawRecord { recordKey: string; body: string; version: number }

/** 只在Node本机服务加载。每次业务批次在同一SQLite事务完成，HTTP层不接受SQL或磁盘路径。 */
export class SqliteRecordStore {
  readonly dataDirectory: string
  private readonly database: DatabaseSync
  private readonly protector?: CredentialProtector
  private transactionActive = false
  private backupPending?: Promise<string>

  constructor(directory: string, protector?: CredentialProtector) {
    this.dataDirectory = resolve(directory)
    this.protector = protector
    mkdirSync(this.dataDirectory, { recursive: true })
    this.database = new DatabaseSync(join(this.dataDirectory, 'workspace.sqlite'), { timeout: 5000 })
    try {
      const version = Number((this.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      if (version > schemaVersion) throw new Error('本机数据库由较新版本创建，请使用对应版本打开。')
      this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;')
      if (!version) this.upgradeInitialSchema()
      if (version < 2) {
        this.database.exec('BEGIN IMMEDIATE')
        try {
          if (Number(this.database.prepare('PRAGMA user_version').get()?.user_version) < 2) {
            migrateStoredNarrativeFields(this.database)
            this.database.exec('PRAGMA user_version=2')
          }
          this.database.exec('COMMIT')
        } catch (error) { this.database.exec('ROLLBACK'); throw error }
      }
      this.database.exec(`
        CREATE INDEX IF NOT EXISTS records_session ON records(scope,tableName,json_extract(body,'$.sessionId'));
        CREATE INDEX IF NOT EXISTS records_type ON records(scope,tableName,json_extract(body,'$.type'));
        CREATE INDEX IF NOT EXISTS records_trace ON records(scope,tableName,json_extract(body,'$.runId'),json_extract(body,'$.startedAt'));
      `)
    } catch (error) { this.database.close(); throw error }
  }

  private upgradeInitialSchema() {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.exec(`
        CREATE TABLE records (
          scope TEXT NOT NULL, tableName TEXT NOT NULL, recordKey TEXT NOT NULL,
          body TEXT NOT NULL CHECK(json_valid(body)), version INTEGER NOT NULL,
          PRIMARY KEY(scope, tableName, recordKey)
        );
        CREATE TABLE unique_values (
          scope TEXT NOT NULL, tableName TEXT NOT NULL, indexName TEXT NOT NULL,
          indexValue TEXT NOT NULL, recordKey TEXT NOT NULL,
          PRIMARY KEY(scope, tableName, indexName, indexValue),
          FOREIGN KEY(scope, tableName, recordKey) REFERENCES records(scope, tableName, recordKey) ON DELETE CASCADE
        );
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO metadata(key,value) VALUES ('revision','0');
        PRAGMA user_version=1;
      `)
      this.database.exec('COMMIT')
    } catch (error) { this.database.exec('ROLLBACK'); throw error }
  }

  status(): StorageStatus {
    const values = Object.fromEntries((this.database.prepare('SELECT key,value FROM metadata').all() as { key: string; value: string }[]).map(row => [row.key, row.value]))
    return { dataDirectory: this.dataDirectory, schemaVersion, revision: Number(values.revision), ...(values.lastSavedAt ? { lastSavedAt: values.lastSavedAt } : {}), ...(values.lastBackupAt ? { lastBackupAt: values.lastBackupAt } : {}) }
  }

  private raw({ scope, table, key }: RecordAddress) {
    return this.database.prepare('SELECT recordKey,body,version FROM records WHERE scope=? AND tableName=? AND recordKey=?').get(scope, table, key) as RawRecord | undefined
  }

  private decode(table: string, row: RawRecord): StoredRecord {
    const value = JSON.parse(row.body) as StoredValue
    if (table === 'credentials' && value.key !== undefined) {
      if (!this.protector) throw new Error('本机凭据保护尚未配置。')
      value.key = this.protector.unprotect(String(value.key))
    }
    return { key: row.recordKey, value, version: row.version }
  }

  get(address: RecordAddress): StoredRecord | undefined {
    const row = this.raw(address)
    return row ? this.decode(address.table, row) : undefined
  }

  page(scope: string, table: string, options: { afterKey?: string; limit?: number } = {}): RecordPage {
    const limit = options.limit ?? 100
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('分页数量须为1至1000。')
    const rows = (options.afterKey === undefined
      ? this.database.prepare('SELECT recordKey,body,version FROM records WHERE scope=? AND tableName=? ORDER BY recordKey LIMIT ?').all(scope, table, limit + 1)
      : this.database.prepare('SELECT recordKey,body,version FROM records WHERE scope=? AND tableName=? AND recordKey>? ORDER BY recordKey LIMIT ?').all(scope, table, options.afterKey, limit + 1)) as unknown as RawRecord[]
    const hasMore = rows.length > limit
    const records = rows.slice(0, limit).map(row => this.decode(table, row))
    return { records, ...(hasMore ? { nextKey: records.at(-1)!.key } : {}) }
  }

  count(scope: string, table: string, query: RecordQuery = {}): number {
    const { index, args, filter, direction, limit, offset } = this.queryParts(scope, table, query)
    return Number(this.database.prepare(`SELECT count(*) AS count FROM (SELECT recordKey FROM records WHERE scope=? AND tableName=?${filter} ORDER BY ${index} ${direction},recordKey ${direction} LIMIT ? OFFSET ?)`).get(...args, limit, offset)!.count)
  }

  private queryParts(scope: string, table: string, query: RecordQuery) {
    const field = (name: string) => {
      if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name)) throw new Error('无效查询字段。')
      return `json_extract(body,'$.${name}')`
    }
    const index = !query.index || query.index === ':id' ? 'recordKey'
      : query.index.startsWith('[') ? `json_array(${query.index.slice(1, -1).split('+').map(field).join(',')})` : field(query.index)
    const args: (string | number)[] = [scope, table]
    const values = (query.values ?? []).map(value => Array.isArray(value) ? JSON.stringify(value) : value)
    let filter = ''
    if (query.operator === 'startsWith') { filter = ` AND substr(${index},1,?)=?`; args.push(String(values[0]).length, String(values[0])) }
    else if (query.operator) {
      const positive = query.operator !== 'noneOf'
      filter = values.length ? ` AND ${index} ${positive ? 'IN' : 'NOT IN'} (${values.map(() => '?').join(',')})` : positive ? ' AND 0' : ''
      args.push(...values)
    }
    const direction = query.reverse ? 'DESC' : 'ASC'
    const limit = query.limit ?? -1, offset = query.offset ?? 0
    if (!Number.isSafeInteger(limit) || limit < -1 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('无效分页参数。')
    return { index, args, filter, direction, limit, offset }
  }
  query(scope: string, table: string, query: RecordQuery = {}): StoredRecord[] {
    const { index, args, filter, direction, limit, offset } = this.queryParts(scope, table, query)
    const columns = query.keysOnly ? "recordKey,'{}' AS body,version" : 'recordKey,body,version'
    const rows = this.database.prepare(`SELECT ${columns} FROM records WHERE scope=? AND tableName=?${filter} ORDER BY ${index} ${direction},recordKey ${direction} LIMIT ? OFFSET ?`).all(...args, limit, offset) as unknown as RawRecord[]
    return rows.map(row => query.keysOnly ? { key: row.recordKey, value: {}, version: row.version } : this.decode(table, row))
  }
  bulkGet(scope: string, table: string, keys: string[]): (StoredRecord | null)[] {
    if (!keys.length) return []
    const rows = this.database.prepare(`SELECT recordKey,body,version FROM records WHERE scope=? AND tableName=? AND recordKey IN (${keys.map(() => '?').join(',')})`).all(scope, table, ...keys) as unknown as RawRecord[]
    const byKey = new Map(rows.map(row => [row.recordKey, this.decode(table, row)]))
    return keys.map(key => structuredClone(byKey.get(key) ?? null))
  }

  scopeExists(scope: string) { return !!this.database.prepare('SELECT 1 FROM records WHERE scope=? LIMIT 1').get(scope) }

  executionPage(scope: string, options: ExecutionQuery) { return executionPage(this.database, scope, options, this.status().revision) }
  assetPage(scope: string, kind: PageKind, options: AssetPageOptions) {
    if (!Object.hasOwn(pageTables, kind)) throw new Error('未知资产栏目。')
    const columns = assetPageFields(kind, !!options.query?.trim()).map(field => `'${field}',json_extract(body,'$.${field}')`).join(',')
    const rows = this.database.prepare(`SELECT json_object(${columns}) AS value FROM records WHERE scope=? AND tableName=?`).all(scope, pageTables[kind]).map(row => JSON.parse(String(row.value))) as (SearchAsset & StoredValue)[]
    // 缺失字段不投影成null，保持原搜索的字段分支与数组默认值。
    for (const row of rows) for (const key of Object.keys(row)) if (row[key] === null) delete row[key]
    const chapters = kind === 'node' || options.query?.trim() ? this.database.prepare("SELECT json_extract(body,'$.chapterIndex') AS chapterIndex,json_extract(body,'$.order') AS 'order' FROM records WHERE scope=? AND tableName='chapters'").all(scope) as unknown as { chapterIndex: string; order: number }[] : []
    const related: SearchRelations = {}
    if (options.query?.trim()) {
      for (const table of searchRelationTables(kind, options.field)) {
        const fields = table === 'characters' ? ['id', 'name', 'aliases', 'verifiedAliases']
          : table === 'storyEvents' ? ['id', 'title', 'nodeIds']
          : ['id', 'name', 'actors', 'actorIds', 'actorBindings']
        const projection = fields.map(key => `'${key}',json_extract(body,'$.${key}')`).join(',')
        related[table] = this.database.prepare(`SELECT json_object(${projection}) AS value FROM records WHERE scope=? AND tableName=?`).all(scope, table).map(row => JSON.parse(String(row.value)))
      }
    }
    return makeAssetPage(kind, rows, chapters, options, related)
  }
  notificationFields(scope: string, table: string, key: string): StoredValue | undefined { return this.database.prepare("SELECT json_extract(body,'$.type') AS type,json_extract(body,'$.recordType') AS recordType,json_extract(body,'$.stage') AS stage FROM records WHERE scope=? AND tableName=? AND recordKey=?").get(scope, table, key) }
  executionBody(scope: string, options: ExecutionQuery & { requestId: string; eventKey?: string }) { return executionBody(this.database, scope, options) }

  tracePage(scope: string, options: { runId?: string; unitId?: string; before?: { startedAt: string; requestId: string }; offset?: number; limit?: number }) {
    const args: (string | number)[] = [scope]
    let where = "scope=? AND tableName='storySessionEntries' AND json_extract(body,'$.type')='request_trace'"
    if (options.runId) { where += " AND json_extract(body,'$.runId')=?"; args.push(options.runId) }
    if (options.unitId) { where += " AND coalesce(nullif(json_extract(body,'$.unitId'),''),json_extract(body,'$.workId'),'')=?"; args.push(options.unitId) }
    const total = Number(this.database.prepare(`SELECT count(*) AS n FROM records WHERE ${where}`).get(...args)?.n)
    const date = "coalesce(json_extract(body,'$.startedAt'),'')", id = "coalesce(nullif(json_extract(body,'$.requestId'),''),recordKey)"
    if (options.before) { where += ` AND (${date}<? OR (${date}=? AND ${id}<?))`; args.push(options.before.startedAt, options.before.startedAt, options.before.requestId) }
    const limit = Math.min(1000, Math.max(1, Number(options.limit) || 50)), offset = Math.max(0, Number(options.offset) || 0)
    const rows = this.database.prepare(`SELECT recordKey,body,version FROM records WHERE ${where} ORDER BY ${date} DESC,${id} DESC LIMIT ? OFFSET ?`).all(...args, limit + 1, offset) as unknown as RawRecord[]
    return { rows: rows.slice(0, limit).reverse().map(row => this.decode('storySessionEntries', row).value), total, hasEarlier: rows.length > limit }
  }

  /** 预期版本及整批写入在锁内检查；缺少记录用null，省略则由调用事务内的业务检查决定。 */
  commit(writes: readonly RecordWrite[]): StorageStatus {
    if (this.transactionActive) throw new Error('本机存储事务不能重入。')
    if (!writes.length) return this.status()
    this.transactionActive = true
    let began = false
    try {
      this.database.exec('BEGIN IMMEDIATE'); began = true
      const before = this.status(), version = before.revision + 1
      // 先核对整批，再写入，保证失败项不会留下前面已经写入的部分。
      for (const write of writes) {
        if (!write.scope || !write.table || !write.key) throw new Error('缺少存储范围、表名或主键。')
        if (write.expectedVersion !== undefined && (this.raw(write)?.version ?? null) !== write.expectedVersion) throw new StorageConflict()
      }
      for (const write of writes) this.write(write, version)
      this.database.prepare('UPDATE metadata SET value=? WHERE key=?').run(String(version), 'revision')
      this.database.prepare('INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('lastSavedAt', new Date().toISOString())
      const status = this.status()
      this.database.exec('COMMIT'); began = false
      return status
    } catch (error) { if (began) this.database.exec('ROLLBACK'); throw error }
    finally { this.transactionActive = false }
  }

  private write(write: RecordWrite, version: number) {
    const { scope, table, key } = write
    this.database.prepare('DELETE FROM unique_values WHERE scope=? AND tableName=? AND recordKey=?').run(scope, table, key)
    if (write.value === undefined) {
      this.database.prepare('DELETE FROM records WHERE scope=? AND tableName=? AND recordKey=?').run(scope, table, key)
      return
    }
    const value = structuredClone(write.value)
    if (table === 'credentials') {
      if (!this.protector || typeof value.key !== 'string') throw new Error('本机凭据保护尚未配置或密钥格式错误。')
      value.key = this.protector.protect(value.key)
    }
    this.database.prepare('INSERT INTO records(scope,tableName,recordKey,body,version) VALUES (?,?,?,?,?) ON CONFLICT(scope,tableName,recordKey) DO UPDATE SET body=excluded.body,version=excluded.version').run(scope, table, key, JSON.stringify(value), version)
    for (const fields of uniqueFields[table] ?? []) {
      const values = fields.map(field => value[field])
      if (values.some(item => item === undefined || item === null)) continue
      this.database.prepare('INSERT INTO unique_values(scope,tableName,indexName,indexValue,recordKey) VALUES (?,?,?,?,?)').run(scope, table, fields.join('+'), JSON.stringify(values), key)
    }
  }

  backup(retain = 5): Promise<string> {
    if (this.backupPending) return this.backupPending
    if (!Number.isInteger(retain) || retain < 1) return Promise.reject(new Error('至少保留一份恢复副本。'))
    const directory = join(this.dataDirectory, 'backups')
    mkdirSync(directory, { recursive: true })
    const target = join(directory, `workspace-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.sqlite`)
    const temporary = target + '.pending'
    this.backupPending = (async () => {
      try {
        await backup(this.database, temporary)
        const check = new DatabaseSync(temporary, { readOnly: true })
        try {
          const result = check.prepare('PRAGMA quick_check').get() as { quick_check: string }
          if (result.quick_check !== 'ok') throw new Error('自动恢复副本完整性检查失败。')
        } finally { check.close() }
        renameSync(temporary, target)
        this.database.prepare('INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('lastBackupAt', new Date().toISOString())
        const files = readdirSync(directory).filter(name => /^workspace-.*\.sqlite$/.test(name)).sort().reverse()
        for (const name of files.slice(retain)) unlinkSync(join(directory, name))
        return target
      } catch (error) {
        try { unlinkSync(temporary) } catch { /* 未完成文件可能尚未创建。 */ }
        throw error
      } finally { this.backupPending = undefined }
    })()
    return this.backupPending
  }

  close() {
    if (this.backupPending) throw new Error('恢复副本正在生成，请完成后再关闭存储。')
    this.database.close()
  }
}
