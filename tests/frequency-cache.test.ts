import 'fake-indexeddb/auto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { transact } from '../src/lib/storage/transaction'
import { createLocalStorageServer } from '../src/features/local-storage/server'
import { versionedTable, type StorageCall } from '../src/features/local-storage/client'
import { readBookFrequencies } from '../src/features/assets/frequency'
import { createFrequencyCounter, updateFrequencies } from '../src/features/assets/derive'
import type { Character } from '../src/features/assets/types'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
const people: Character[] = [
  { id: 'a', bookId: 'sample', name: '甲', confidence: 1, createdBy: 'P1', revision: 1, roleWeight: '路人', roleWeightSource: 'manual' },
  { id: 'b', bookId: 'sample', name: '乙', confidence: 1, createdBy: 'P1', revision: 1, roleWeight: '重要配角', roleWeightSource: 'agent' },
]
const sourceRows = [
  { bookId: 'sample', chapterIndex: '1.1', text: '甲甲乙' },
  { bookId: 'sample', chapterIndex: '1.2', text: '乙甲' },
  { bookId: 'sample', chapterIndex: '2', text: '乙乙' },
]

async function diskFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'westworld-frequency-'))
  const server = createLocalStorageServer(directory, { protect: text => Buffer.from(text).toString('base64'), unprotect: text => Buffer.from(text, 'base64').toString() })
  const observed: { reads: number; beforeRead?: (key: string) => void; afterRead?: (key: string) => void; afterVersions?: () => void } = { reads: 0 }
  const call: StorageCall = async body => {
    const reading = body.table === 'chapterTexts' && body.action === 'get'
    if (reading) { observed.reads++; observed.beforeRead?.(String(body.key)) }
    const result = JSON.parse(JSON.stringify(await server.execute(JSON.parse(JSON.stringify(body))) ?? null))
    if (reading) observed.afterRead?.(String(body.key))
    if (body.table === 'chapterTexts' && body.action === 'query' && (body.query as { keysOnly?: boolean } | undefined)?.keysOnly) observed.afterVersions?.()
    return result
  }
  const workspace = createWorkspace({ settingsName: 'frequency-test', bookPrefix: 'frequency-test-' }, call)
  cleanups.push(async () => { workspace.close(); await server.close(); rmSync(directory, { recursive: true, force: true }) })
  const db = workspace.openBook('sample')
  await db.table('chapterTexts').bulkPut(sourceRows)
  return { workspace, db, observed }
}

test('分章词项聚合与原扫描相同，保留长词歧义、大小写、正则符号和原章计数', () => {
  const assets: Character[] = [
    { ...people[0], name: '阿青', verifiedAliases: ['沈阿青', '娘娘', 'A+B', '🌙'] },
    { ...people[1], name: '沈青', verifiedAliases: ['沈阿青', 'ab', 'aa'] },
    { ...people[1], id: 'c', name: 'a', verifiedAliases: ['A+B'], roleWeightSource: 'frequency' },
  ]
  const texts = [
    { chapterIndex: '1.1', text: '沈阿青、阿青、沈青、娘娘：A+BaB AA a🌙🌙' },
    { chapterIndex: '1.2', text: 'aaab A+B 沈阿青' },
    { chapterIndex: '2', text: '' },
  ]
  for (const characters of [true, false]) {
    const counter = createFrequencyCounter(assets, characters)
    for (const row of texts) counter.addTerms(row.chapterIndex, counter.countTerms(row.text))
    expect(counter.result()).toEqual(updateFrequencies(assets, texts, characters))
    expect(counter.result()[0].frequency).toMatchObject({ scopeChapters: 2, chapters: 1 })
  }
})

test('热缓存不读正文；删除章、限定目录和关闭重开都得到当前完整结果', async () => {
  const { workspace, db, observed } = await diskFixture()
  expect((await readBookFrequencies(db, people, [])).people).toEqual(updateFrequencies(people, sourceRows, true))
  expect(observed.reads).toBe(3)
  observed.reads = 0
  expect((await readBookFrequencies(db, people, [])).people).toEqual(updateFrequencies(people, sourceRows, true))
  expect(observed.reads).toBe(0)
  await db.table('chapterTexts').delete('2')
  expect((await readBookFrequencies(db, people, [])).people).toEqual(updateFrequencies(people, sourceRows.slice(0, 2), true))
  expect(observed.reads).toBe(0)
  expect((await readBookFrequencies(db, people, [], { chapterIndices: ['1.2', 'missing'] })).people).toEqual(updateFrequencies(people, [sourceRows[1]], true))
  workspace.closeBook('sample')
  const reopened = workspace.openBook('sample')
  observed.reads = 0
  expect((await readBookFrequencies(reopened, people, [])).people).toEqual(updateFrequencies(people, sourceRows.slice(0, 2), true))
  expect(observed.reads).toBe(2)
})

test('待提交version=0每次读取正文，后续写入及事务回滚都不污染缓存', async () => {
  const { db, observed } = await diskFixture()
  await readBookFrequencies(db, people, [])
  await expect(transact(db, 'rw', [db.table('chapterTexts')], async scoped => {
    await scoped.table('chapterTexts').put({ ...sourceRows[0], text: '乙乙乙' })
    expect((await versionedTable(scoped, 'chapterTexts')!.get('1.1'))!.version).toBe(0)
    observed.reads = 0
    const first = await readBookFrequencies(scoped, people, [], { cacheOwner: db, yieldToUi: false })
    expect(first.people).toEqual(updateFrequencies(people, [{ ...sourceRows[0], text: '乙乙乙' }, ...sourceRows.slice(1)], true))
    expect(observed.reads).toBe(1)
    await scoped.table('chapterTexts').put({ ...sourceRows[0], text: '甲甲甲' })
    observed.reads = 0
    const second = await readBookFrequencies(scoped, people, [], { cacheOwner: db, yieldToUi: false })
    expect(second.people).toEqual(updateFrequencies(people, [{ ...sourceRows[0], text: '甲甲甲' }, ...sourceRows.slice(1)], true))
    expect(observed.reads).toBe(1)
    throw new Error('rollback fixture')
  })).rejects.toThrow('rollback fixture')
  expect((await readBookFrequencies(db, people, [])).people).toEqual(updateFrequencies(people, sourceRows, true))
})

test.each(['failure', 'cancel'] as const)('读取中%s不发布半份缓存，下一次可完整重算', async kind => {
  const { db, observed } = await diskFixture(), controller = new AbortController()
  if (kind === 'failure') observed.beforeRead = key => { if (key === '1.2') throw new Error('read fixture') }
  else observed.afterRead = () => controller.abort(new Error('cancel fixture'))
  await expect(readBookFrequencies(db, people, [], { signal: controller.signal })).rejects.toThrow(kind === 'failure' ? 'read fixture' : 'cancel fixture')
  delete observed.beforeRead; delete observed.afterRead
  observed.reads = 0
  expect((await readBookFrequencies(db, people, [])).people).toEqual(updateFrequencies(people, sourceRows, true))
  expect(observed.reads).toBe(3)
})

test('版本目录和正文处于同一读事务，等待中的跨窗口写入在下一次统计失效', async () => {
  const { workspace, db, observed } = await diskFixture()
  const second = createWorkspace({ settingsName: 'frequency-second', bookPrefix: 'frequency-second-' }, workspace.disk)
  let pending: Promise<unknown> | undefined
  observed.afterVersions = () => {
    delete observed.afterVersions
    pending = second.openBook('sample').table('chapterTexts').put({ ...sourceRows[0], text: '乙乙乙' })
  }
  try {
    expect((await readBookFrequencies(db, people, [])).people).toEqual(updateFrequencies(people, sourceRows, true))
    await pending
    observed.reads = 0
    expect((await readBookFrequencies(db, people, [])).people).toEqual(updateFrequencies(people, [{ ...sourceRows[0], text: '乙乙乙' }, ...sourceRows.slice(1)], true))
    expect(observed.reads).toBe(1)
  } finally { second.close() }
})

test('相同章节编号的不同书籍不共享计数', async () => {
  const { workspace, db } = await diskFixture()
  await readBookFrequencies(db, people, [])
  const other = workspace.openBook('other')
  await other.table('chapterTexts').put({ bookId: 'other', chapterIndex: '1.1', text: '乙乙' })
  const assets = people.map(row => ({ ...row, bookId: 'other' }))
  expect((await readBookFrequencies(other, assets, [])).people).toEqual(updateFrequencies(assets, [{ chapterIndex: '1.1', text: '乙乙' }], true))
})

test('Dexie没有可靠版本时重扫，原生写事务内也可调用', async () => {
  const prefix = `frequency-native-${crypto.randomUUID()}`
  const workspace = createWorkspace({ settingsName: prefix, bookPrefix: `${prefix}-` }), db = workspace.openBook('sample')
  cleanups.push(async () => { await db.delete(); await workspace.settings.delete(); workspace.close() })
  await db.table('chapterTexts').bulkPut(sourceRows)
  expect(versionedTable(db, 'chapterTexts')).toBeUndefined()
  expect((await readBookFrequencies(db, people, [])).people).toEqual(updateFrequencies(people, sourceRows, true))
  await transact(db, 'rw', [db.table('chapterTexts')], async scoped => {
    await scoped.table('chapterTexts').put({ ...sourceRows[0], text: '乙乙乙' })
    expect((await readBookFrequencies(scoped, people, [], { yieldToUi: false })).people).toEqual(updateFrequencies(people, [{ ...sourceRows[0], text: '乙乙乙' }, ...sourceRows.slice(1)], true))
  })
})
