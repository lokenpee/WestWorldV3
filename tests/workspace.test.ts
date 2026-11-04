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

  it('新书库包含目标17表；旧v4不会被阶段1静默升级', async () => {
    const workspace = setup()
    await workspace.settings.books.bulkPut(books)
    const fresh = workspace.openBook('a')
    opened.push(fresh)
    await fresh.open()
    expect(fresh.tables).toHaveLength(18)
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

  it('版本5书库升级到6：人物关系移入关系表，旧节点补齐绑定来源', async () => {
    const workspace = setup()
    const legacy = new Dexie(`${workspace.scope.bookPrefix}legacy`)
    legacy.version(5).stores({
      chapters: 'chapterIndex, order', chapterTexts: 'chapterIndex', characters: 'id, chapterIndex, name', locations: 'id, chapterIndex, name', nodes: 'id, chapterIndex, order', eventLines: 'id, lineStatus', compileProgress: 'stage', storyEditorMemory: 'id, sessionId', storyEditorNotes: 'id, &[sessionId+key], sessionId, kind, status, updatedAt', storyEditorCheckpoints: 'id, sessionId, stage, phase, status, updatedAt', storySessions: 'id, status, createdAt, parentSessionId', storySessionEntries: 'id, &[sessionId+ordinal], sessionId, parentId, type', extractionReceipts: 'key, chapterIndex, substep', assetLifecycle: 'key, kind, originId, currentId, state', pipelineRuns: 'id, recordType, stage, status, startedAt, &lockKey',
    })
    await legacy.open()
    await legacy.table('characters').bulkPut([
      { id: 'A1', bookId: 'legacy', name: '张三', revision: 1, confidence: 1, createdBy: 'P1', chapterIndex: '1', relations: [{ target: '张蕾', relation_type: 'parent_child', relation_label: '父亲', direction: 'directed' }] },
      { id: 'A2', bookId: 'legacy', name: '张三', revision: 1, confidence: 1, createdBy: 'P1', relations: [{ target: '张蕾', relation_type: 'enemy', relation_label: '仇人' }] },
      { id: 'B1', bookId: 'legacy', name: '张蕾', revision: 1, confidence: 1, createdBy: 'P1' },
    ])
    await legacy.table('assetLifecycle').bulkPut(['A1', 'A2', 'B1'].map(id => ({ key: `character:${id}`, bookId: 'legacy', kind: 'character', originId: id, currentId: id, state: 'live', revision: 1, updatedAt: '' })))
    await legacy.table('nodes').put({ id: 'N1', bookId: 'legacy', name: '会面', summary: '会面', chapterIndex: '1', chapterName: '第一章', actors: ['张三'], actorIds: ['A2'], order: 0, revision: 1, confidence: 1, createdBy: 'P1', quote: '' })
    legacy.close()
    const db = workspace.openBook('legacy')
    opened.push(db)
    await db.open()
    const relations = await db.table('characterRelations').toArray()
    expect(relations).toHaveLength(2)
    expect(relations.map(row => row.originCharacterId).sort()).toEqual(['A1', 'A2'])
    expect(relations.find(row => row.originCharacterId === 'A2')).toMatchObject({ direction: 'unspecified', sourceId: 'A2', targetIds: ['B1'], legacyPayload: { relation_label: '仇人' } })
    expect(await db.table('characters').get('A1')).not.toHaveProperty('relations')
    expect(await db.table('nodes').get('N1')).toMatchObject({ actorIds: ['A1', 'A2'], legacyActorIds: ['A2'], actorBindings: [{ mention: '张三', ids: ['A1', 'A2'] }] })
  })
})
