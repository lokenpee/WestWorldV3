import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createImportService } from '../src/lib/storage/importService'
import { DEFAULT_CHAPTER_PATTERN, splitChapters, type NovelPreview } from '../src/features/import/text'

const workspaces: ReturnType<typeof createWorkspace>[] = []
const services: ReturnType<typeof createImportService>[] = []
function setup(checkpoint?: (point: string) => Promise<void>, ownerAlive: (owner: string) => Promise<boolean> = async () => false) {
  const prefix = `import-test-${crypto.randomUUID()}`
  const workspace = createWorkspace({ settingsName: `${prefix}-settings`, bookPrefix: `${prefix}-book-` })
  workspaces.push(workspace)
  const service = createImportService(workspace, { checkpoint, ownerAlive })
  services.push(service)
  return { workspace, service }
}
function preview(text = '序文\n第一章 起点\n甲\n第二章 终点\n乙'): NovelPreview {
  return { fileName: '小说.txt', byteLength: 30, text, encoding: 'UTF-8', pattern: DEFAULT_CHAPTER_PATTERN, chapters: splitChapters(text, DEFAULT_CHAPTER_PATTERN) }
}
afterEach(async () => {
  services.splice(0).forEach(service => service.close())
  for (const workspace of workspaces.splice(0)) {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name)
  }
})

describe('阶段2：持久导入与跨库恢复', () => {
  it('全部正文、元数据和P1初始进度先提交，成功后才发布书架', async () => {
    const { workspace, service } = setup(async point => {
      if (point === 'after-book-write') expect(await workspace.listBooks()).toEqual([])
    })
    const book = await service.importNovel(preview())
    const db = workspace.openBook(book.id)
    const texts = await db.table<{ text: string }>('chapterTexts').toArray()
    expect(texts.map(row => row.text).join('')).toBe(preview().text)
    expect(await db.table('compileProgress').get('P1')).toMatchObject({ status: 'idle', totalChapters: 3, completedChapters: [] })
    expect(await workspace.listBooks()).toEqual([book])
    expect(await workspace.settings.appSettings.count()).toBe(0)
  })

  it('同时导入同名书也分配独立ID和名称，不覆盖原文', async () => {
    const { workspace, service } = setup()
    const results = await Promise.all([service.importNovel(preview()), service.importNovel(preview('不同正文'))])
    expect(new Set(results.map(book => book.id)).size).toBe(2)
    expect(results.map(book => book.title).sort()).toEqual(['小说', '小说（1）'])
    expect(await workspace.listBooks()).toHaveLength(2)
  })

  it.each(['after-book-write', 'before-publish'])('%s 失败能清理；不发布半本书；既有书不受影响', async failurePoint => {
    let fail = false
    const { workspace, service } = setup(async point => { if (fail && point === failurePoint) throw new Error('模拟写入失败') })
    const original = await service.importNovel(preview())
    fail = true
    await expect(service.importNovel(preview())).rejects.toThrow('模拟写入失败')
    expect((await workspace.listBooks()).map(book => book.id)).toEqual([original.id])
    expect(await workspace.settings.appSettings.count()).toBe(0)
    expect((await Dexie.getDatabaseNames()).filter(name => name.startsWith(workspace.scope.bookPrefix))).toEqual([workspace.scope.bookPrefix + original.id])
  })

  it('过期preparing清理；活跃租约不抢；ready完整复验后发布', async () => {
    const { workspace, service } = setup()
    const now = Date.now()
    const journal = (id: string, state: 'preparing' | 'ready', leaseUntil: number) => ({
      operationId: id, action: 'import', bookId: id, state, owner: 'old-owner', leaseUntil,
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
      ...(state === 'ready' ? { book: { id, title: '恢复书', sourceFileName: '恢复书.txt', createdAt: new Date(now).toISOString() } } : {}),
    })
    await workspace.settings.appSettings.bulkPut([
      { key: 'book.lifecycle:dead', value: journal('dead', 'preparing', 0) },
      { key: 'book.lifecycle:live', value: journal('live', 'preparing', now + 300000) },
      { key: 'book.lifecycle:ready', value: journal('ready', 'ready', 0) },
    ])
    await workspace.openBook('dead').open()
    const ready = workspace.openBook('ready')
    await ready.chapters.put({ bookId: 'ready', chapterIndex: '1', chapterName: '第1段', order: 0, charCount: 2 })
    await ready.table('chapterTexts').put({ bookId: 'ready', chapterIndex: '1', text: '正文' })
    await ready.table('compileProgress').put({ bookId: 'ready', stage: 'P1', status: 'idle', totalChapters: 1, completedChapters: [], failedChapters: [], updatedAt: new Date(now).toISOString() })
    const result = await service.recoverPending()
    expect(result).toMatchObject({ recovered: 1, cleaned: 1, pending: 1 })
    expect((await workspace.listBooks()).map(book => book.id)).toEqual(['ready'])
    expect(await Dexie.exists(workspace.scope.bookPrefix + 'dead')).toBe(false)
    expect(await workspace.settings.appSettings.get('book.lifecycle:live')).toBeDefined()
  })

  it('不接受被篡改或不完整的预览，尚未建库就失败', async () => {
    const { workspace, service } = setup()
    const value = preview()
    value.chapters[0].text = '被替换'
    await expect(service.importNovel(value)).rejects.toThrow('预览')
    expect(await workspace.listBooks()).toEqual([])
    expect((await Dexie.getDatabaseNames()).filter(name => name.startsWith(workspace.scope.bookPrefix))).toEqual([])
  })

  it('租约虽过期但owner仍活跃时不得接管或清理', async () => {
    const { workspace, service } = setup(undefined, async () => true)
    await workspace.settings.appSettings.put({ key: 'book.lifecycle:active', value: {
      operationId: 'active', action: 'import', bookId: 'active-book', state: 'preparing', owner: 'alive', leaseUntil: 0,
      createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
    } })
    await workspace.openBook('active-book').chapters.put({ bookId: 'active-book', chapterIndex: '1', chapterName: '保留', order: 0, charCount: 2 })
    expect(await service.recoverPending()).toMatchObject({ pending: 1, cleaned: 0, recovered: 0 })
    expect(await workspace.openBook('active-book').chapters.count()).toBe(1)
  })

  it('ready缺失正文不能发布；两个恢复者竞争只清理一次', async () => {
    const { workspace, service } = setup()
    await workspace.settings.appSettings.put({ key: 'book.lifecycle:broken', value: {
      operationId: 'broken', action: 'import', bookId: 'broken-book', state: 'ready', owner: 'gone', leaseUntil: 0,
      createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
      book: { id: 'broken-book', title: '坏书', sourceFileName: '坏书.txt', createdAt: '2026-10-24T00:00:00.000Z' },
    } })
    await workspace.openBook('broken-book').chapters.put({ bookId: 'broken-book', chapterIndex: '1', chapterName: '缺正文', order: 0, charCount: 10 })
    const other = createImportService(workspace, { ownerAlive: async () => false })
    services.push(other)
    const results = await Promise.all([service.recoverPending(), other.recoverPending()])
    expect(results.reduce((sum, result) => sum + result.cleaned, 0)).toBe(1)
    expect(await workspace.listBooks()).toEqual([])
    expect(await workspace.settings.appSettings.count()).toBe(0)
    expect(await Dexie.exists(workspace.scope.bookPrefix + 'broken-book')).toBe(false)
  })

  it('已有可用书籍不因异常日志被删除', async () => {
    const { workspace, service } = setup()
    const book = await service.importNovel(preview())
    await workspace.settings.appSettings.put({ key: 'book.lifecycle:unexpected', value: {
      operationId: 'unexpected', action: 'import', bookId: book.id, state: 'preparing', owner: 'gone', leaseUntil: 0,
      createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
    } })
    const result = await service.recoverPending()
    expect(result.pending).toBe(1)
    expect(result.errors.join('')).toContain('保留资料')
    expect(await workspace.openBook(book.id).chapters.count()).toBe(3)
    expect(await workspace.listBooks()).toEqual([book])
  })

  it('临时库删除被占用时保留清理日志，关闭占用后可恢复', async () => {
    let blocker: IDBDatabase | undefined
    const { workspace, service } = setup(async point => {
      if (point !== 'after-book-write') return
      const [name] = (await Dexie.getDatabaseNames()).filter(value => value.startsWith(workspace.scope.bookPrefix))
      blocker = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      throw new Error('模拟提交前失败')
    })
    try {
      await expect(service.importNovel(preview())).rejects.toThrow('待恢复清理')
      expect(await workspace.listBooks()).toEqual([])
      expect(await workspace.settings.appSettings.count()).toBe(1)
    } finally { blocker?.close() }
    const result = await service.recoverPending()
    expect(result).toMatchObject({ cleaned: 1, pending: 0 })
    expect(await workspace.settings.appSettings.count()).toBe(0)
  })
})
