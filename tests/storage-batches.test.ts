import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createLocalStorageServer } from '../src/features/local-storage/server'
import { RemoteDatabase, storageBatches, type StorageCall } from '../src/features/local-storage/client'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'westworld-batches-'))
  const server = createLocalStorageServer(directory, { protect: value => value, unprotect: value => value })
  const requests: Record<string, unknown>[] = []
  const call: StorageCall = async body => { requests.push(body); return await server.execute(body) as never }
  const db = new RemoteDatabase(call, 'book:a', 'a')
  cleanups.push(async () => {
    await server.close()
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('westworld-batches-')) throw new Error('临时目录归属不符')
    rmSync(directory, { recursive: true, force: true })
  })
  return { db, requests }
}

test('标量计数与原查询数量一致，包含复合索引/分页/谓词和未提交修改', async () => {
  const { db } = fixture(), table = db.table('characters')
  await table.bulkPut(Array.from({ length: 30 }, (_, i) => ({ id: `P${i}`, name: `人物${i}`, roleWeight: i % 2 ? 'major' : 'minor', chapterIndex: String(i % 3) })))
  const collections = [table, table.where('roleWeight').equals('major'), table.where('name').startsWith('人物1'), table.where('roleWeight').noneOf(['major']), table.where('[roleWeight+chapterIndex]').equals(['major', '1']), table.orderBy('name').reverse().offset(3).limit(4), table.offset(100), table.limit(0), table.filter(row => String(row.name).endsWith('1')).offset(1).limit(1)]
  for (const collection of collections) expect(await collection.count()).toBe((await collection.toArray()).length)
  await db.transaction('rw', [table], async ({ db }) => {
    const table = db.table('characters')
    await table.delete('P1'); await table.put({ id: 'P30', roleWeight: 'major' }); await table.update('P2', { roleWeight: 'major' })
    for (const query of [table, table.where('roleWeight').equals('major'), table.where('roleWeight').equals('minor').offset(2).limit(7)]) expect(await query.count()).toBe((await query.toArray()).length)
  })
})

test('批量读取顺序/重复/缺失与事务视图保持，批量更新按原顺序叠加', async () => {
  const { db, requests } = fixture(), table = db.table('characters')
  await table.bulkPut(Array.from({ length: 205 }, (_, i) => ({ id: `P${i}`, name: `人物${i}` })))
  requests.length = 0
  const keys = ['P204', 'missing', 'P1', 'P204', ...Array.from({ length: 201 }, (_, i) => `P${i}`)]
  const rows = await table.bulkGet(keys)
  expect(rows.map(row => row?.id)).toEqual(keys.map(key => key === 'missing' ? undefined : key))
  expect(rows[0]).not.toBe(rows[3])
  expect(requests.filter(row => row.action === 'bulkGet')).toHaveLength(2)
  await db.transaction('rw', [table], async ({ db }) => {
    const table = db.table('characters')
    expect(await table.bulkUpdate([{ key: 'P1', changes: { name: '新名字' } }, { key: 'missing', changes: {} }, { key: 'P1', changes: { identity: '新身份' } }])).toBe(2)
    await table.delete('P2'); await table.put({ id: 'fresh', name: '新增' })
    expect(await table.bulkGet(['fresh', 'P2', 'P1'])).toEqual([{ id: 'fresh', name: '新增' }, undefined, { id: 'P1', name: '新名字', identity: '新身份' }])
  })
  expect(await table.bulkGet([])).toEqual([])
})

test('跨包添加失败和批量更新唯一约束失败均整体回滚', async () => {
  const { db } = fixture(), table = db.table('characters')
  await table.put({ id: 'existing', name: '原名' })
  await expect(table.bulkAdd([...Array.from({ length: 200 }, (_, i) => ({ id: `P${i}` })), { id: 'existing' }])).rejects.toThrow('记录已存在')
  expect(await table.count()).toBe(1)
  const notes = db.table('storyEditorNotes')
  await notes.bulkPut([{ id: 'n1', sessionId: 's', key: 'a', text: '一' }, { id: 'n2', sessionId: 's', key: 'b', text: '二' }])
  await expect(notes.bulkUpdate([{ key: 'n1', changes: { text: '应回滚' } }, { key: 'n2', changes: { key: 'a' } }])).rejects.toThrow()
  expect((await notes.get('n1'))?.text).toBe('一')
  await expect(db.transaction('rw', [table], async ({ db }) => { await db.table('characters').bulkDelete(['existing']); throw new Error('rollback') })).rejects.toThrow('rollback')
  expect((await table.get('existing'))?.name).toBe('原名')
})

test('大正文按UTF8字节分包，仍一次原子提交，单条大记录不截断', async () => {
  const { db, requests } = fixture()
  const rows = Array.from({ length: 4 }, (_, i) => ({ chapterIndex: String(i), text: '汉'.repeat(200000) }))
  await db.table('chapterTexts').bulkPut(rows)
  const writes = requests.filter(row => row.action === 'bulk')
  expect(writes).toHaveLength(4)
  expect(writes.every(row => Buffer.byteLength(JSON.stringify(row)) < 1024 * 1024)).toBe(true)
  expect(requests.filter(row => row.action === 'commit')).toHaveLength(1)
  expect(await db.table('chapterTexts').bulkGet(['3', '0'])).toEqual([rows[3], rows[0]])
  const large = { text: '汉'.repeat(400000) }
  expect(storageBatches([large, { text: '尾部' }])).toEqual([[large], [{ text: '尾部' }]])
})
