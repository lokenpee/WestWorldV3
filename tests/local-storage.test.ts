import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SqliteRecordStore } from '../src/features/local-storage/sqliteStore'
import { StorageConflict } from '../src/features/local-storage/contracts'
import { windowsCredentialProtector } from '../src/features/local-storage/credentials'

const directories: string[] = [], stores: SqliteRecordStore[] = []
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'westworld-sqlite-test-'))
  directories.push(directory)
  const store = new SqliteRecordStore(directory)
  stores.push(store)
  return { directory, store }
}
afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close() } catch { /* 已在用例中关闭。 */ } }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const address = { scope: 'book:B1', table: 'eventLines', key: 'L1' }

it('磁盘重开保留资产与保存时间，分页游标不遗漏或重复', () => {
  const { directory, store } = fixture()
  store.commit(Array.from({ length: 5 }, (_, i) => ({ ...address, key: `L${i}`, value: { id: `L${i}`, nodeIds: ['N1'], summary: '跨章事件线' }, expectedVersion: null })))
  const saved = store.status(); store.close()
  const reopened = new SqliteRecordStore(directory); stores.push(reopened)
  expect(reopened.status()).toEqual(saved)
  const first = reopened.page(address.scope, address.table, { limit: 2 })
  const second = reopened.page(address.scope, address.table, { limit: 2, afterKey: first.nextKey })
  const third = reopened.page(address.scope, address.table, { limit: 2, afterKey: second.nextKey })
  expect([...first.records, ...second.records, ...third.records].map(row => row.key)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4'])
  expect(third.nextKey).toBeUndefined()
  expect(reopened.get(address)?.value.summary).toBe('跨章事件线')
})

it('整批中途唯一约束失败时资产与进度全部回滚，后续仍可提交', () => {
  const { store } = fixture()
  const note = { scope: address.scope, table: 'storyEditorNotes', key: 'note1', value: { id: 'note1', sessionId: 's1', key: 'clue' } }
  store.commit([note])
  const before = store.status()
  expect(() => store.commit([
    { ...address, value: { id: 'L1', nodeIds: ['N1'] } },
    { ...note, key: 'note2', value: { ...note.value, id: 'note2' } },
  ])).toThrow()
  expect(store.get(address)).toBeUndefined()
  expect(store.count(address.scope, 'storyEditorNotes')).toBe(1)
  expect(store.status()).toEqual(before)
  store.commit([{ ...address, value: { id: 'L1' } }])
  expect(store.get(address)?.value.id).toBe('L1')
})

it('另一个连接更新及删除重建后均拒绝旧版本覆盖', () => {
  const { directory, store } = fixture()
  store.commit([{ ...address, value: { id: 'L1', summary: '初始' }, expectedVersion: null }])
  const old = store.get(address)!
  const other = new SqliteRecordStore(directory); stores.push(other)
  other.commit([{ ...address, value: { id: 'L1', summary: '新值' }, expectedVersion: old.version }])
  expect(() => store.commit([{ ...address, value: { id: 'L1', summary: '旧窗口' }, expectedVersion: old.version }])).toThrow(StorageConflict)
  other.commit([{ ...address }]); other.commit([{ ...address, value: { id: 'L1', summary: '重建' }, expectedVersion: null }])
  expect(() => store.commit([{ ...address, value: { id: 'L1' }, expectedVersion: old.version }])).toThrow(StorageConflict)
  expect(store.get(address)?.value.summary).toBe('重建')
})

it('恢复副本包含一致提交且按数量轮换，不复制半写入WAL', async () => {
  const { directory, store } = fixture()
  for (let i = 0; i < 3; i++) {
    store.commit([{ ...address, value: { id: 'L1', summary: `版本${i}` } }])
    const path = await store.backup(2)
    const copy = new DatabaseSync(path, { readOnly: true })
    try { expect(JSON.parse(String(copy.prepare('SELECT body FROM records').get()!.body)).summary).toBe(`版本${i}`) }
    finally { copy.close() }
  }
  expect(readdirSync(join(directory, 'backups')).filter(name => name.endsWith('.sqlite'))).toHaveLength(2)
})

it('较新数据库版本不被重建或覆盖', () => {
  const { directory, store } = fixture(); store.close()
  const path = join(directory, 'workspace.sqlite'), db = new DatabaseSync(path)
  db.exec('PRAGMA user_version=999'); db.close()
  expect(() => new SqliteRecordStore(directory)).toThrow('较新版本')
  const check = new DatabaseSync(path)
  expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(999); check.close()
})

it.skipIf(process.platform !== 'win32')('假Key用Windows用户加密，数据库及恢复副本不含明文，重启仍可解密', async () => {
  const { directory, store } = fixture(); store.close()
  const secret = 'fake-only-for-storage-test-中文-123456'
  const secure = new SqliteRecordStore(directory, windowsCredentialProtector()); stores.push(secure)
  const credential = { scope: 'settings', table: 'credentials', key: 'sample' }
  secure.commit([{ ...credential, value: { providerId: 'sample', type: 'api_key', key: secret } }])
  const copy = await secure.backup()
  expect(readFileSync(copy).includes(Buffer.from(secret))).toBe(false)
  expect(readFileSync(join(directory, 'workspace.sqlite')).includes(Buffer.from(secret))).toBe(false)
  secure.close()
  const reopened = new SqliteRecordStore(directory, windowsCredentialProtector()); stores.push(reopened)
  expect(reopened.get(credential)?.value.key).toBe(secret)
})
