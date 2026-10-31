import 'fake-indexeddb/auto'
import Dexie, { liveQuery } from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkspace, type Book, type DatabaseScope } from '../src/lib/storage/workspace'

const scopes: DatabaseScope[] = []
const opened: Dexie[] = []
function setup() {
  const prefix = `test-${crypto.randomUUID()}`
  const scope = { settingsName: `${prefix}-settings`, bookPrefix: `${prefix}-book-` }
  scopes.push(scope)
  const workspace = createWorkspace(scope)
  opened.push(workspace.settings)
  return workspace
}
const books: Book[] = [
  { id: 'a', title: '旧书', sourceFileName: 'a.txt', createdAt: '2026-10-23T00:00:00.000Z' },
  { id: 'b', title: '新书', sourceFileName: 'b.txt', createdAt: '2026-10-24T00:00:00.000Z' },
]

afterEach(async () => {
  opened.splice(0).forEach(db => db.close())
  for (const scope of scopes.splice(0)) {
    for (const name of await Dexie.getDatabaseNames()) {
      if (name === scope.settingsName || name.startsWith(scope.bookPrefix)) await Dexie.delete(name)
    }
  }
})

describe('阶段 1：真实数据仓储契约', () => {
  it('重复初始化不创建假书，只创建全局三表，书库按需打开', async () => {
    const workspace = setup()
    expect(await workspace.listBooks()).toEqual([])
    expect(await workspace.listBooks()).toEqual([])
    expect(workspace.settings.tables.map(table => table.name).sort()).toEqual(['appSettings', 'books', 'credentials'])
    const names = await Dexie.getDatabaseNames()
    expect(names.filter(name => name.startsWith(workspace.scope.bookPrefix))).toEqual([])
  })

  it('倒序列书；重复写同ID不重复建书；关闭后重开仍存在', async () => {
    const workspace = setup()
    await workspace.settings.books.bulkPut(books)
    await workspace.settings.books.bulkPut(books)
    expect((await workspace.listBooks()).map(book => book.id)).toEqual(['b', 'a'])
    workspace.close()
    const reopened = createWorkspace(workspace.scope)
    opened.push(reopened.settings)
    expect(await reopened.listBooks()).toEqual([books[1], books[0]])
  })

  it('每书独立统计；切书查当前书，不存在的书不创建孤立数据库', async () => {
    const workspace = setup()
    await workspace.settings.books.bulkPut(books)
    const a = workspace.openBook('a')
    const b = workspace.openBook('b')
    opened.push(a, b)
    await a.chapters.put({ bookId: 'a', chapterIndex: '1', chapterName: '第一章 旧书正文', order: 0, charCount: 12 })
    await a.table('characters').put({ id: 'a-character' })
    await b.chapters.put({ bookId: 'b', chapterIndex: '1', chapterName: '第一章 新书正文', order: 0, charCount: 34 })
    expect(await workspace.getBookSummary('a')).toMatchObject({ bookId: 'a', counts: { chapters: 1, characters: 1 }, chapters: [{ chapterName: '第一章 旧书正文' }] })
    expect(await workspace.getBookSummary('b')).toMatchObject({ bookId: 'b', counts: { chapters: 1, characters: 0 }, chapters: [{ chapterName: '第一章 新书正文' }] })
    await expect(workspace.getBookSummary('missing')).rejects.toThrow('书籍不存在')
    expect(await Dexie.exists(`${workspace.scope.bookPrefix}missing`)).toBe(false)
    workspace.close()
  })

  it('另一连接写入后，订阅收到新书列表', async () => {
    const workspace = setup()
    const other = createWorkspace(workspace.scope)
    opened.push(other.settings)
    const received: string[][] = []
    const subscription = liveQuery(() => workspace.listBooks()).subscribe(list => received.push(list.map(book => book.id)))
    try {
      await expect.poll(() => received).toContainEqual([])
      await other.settings.books.put(books[0])
      await expect.poll(() => received).toContainEqual(['a'])
    } finally { subscription.unsubscribe() }
  })

  it('新书库包含目标15表；旧v4不会被阶段1静默升级', async () => {
    const workspace = setup()
    await workspace.settings.books.bulkPut(books)
    const fresh = workspace.openBook('a')
    opened.push(fresh)
    await fresh.open()
    expect(fresh.tables).toHaveLength(15)
    const legacy = new Dexie(`${workspace.scope.bookPrefix}b`)
    legacy.version(4).stores({ characters: 'id', characterSnapshots: 'id' })
    await legacy.table('characterSnapshots').put({ id: 'keep-me', name: '旧资料' })
    legacy.close()
    const attempted = workspace.openBook('b')
    opened.push(attempted)
    await expect(attempted.open()).rejects.toThrow('旧版书库')
    attempted.close()
    const inspect = new Dexie(legacy.name)
    opened.push(inspect)
    await inspect.open()
    expect(inspect.verno).toBe(4)
    expect(await inspect.table('characterSnapshots').get('keep-me')).toMatchObject({ name: '旧资料' })
  })
})
