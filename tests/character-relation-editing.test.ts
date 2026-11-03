import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createAssetService } from '../src/features/assets/service'
import { extractedRelation } from '../src/features/assets/relations'
import type { Character, CharacterRelation, Lifecycle } from '../src/features/assets/types'

const opened: ReturnType<typeof createWorkspace>[] = []
async function setup() {
  const prefix = `pair-edit-${crypto.randomUUID()}`
  const workspace = createWorkspace({ settingsName: `${prefix}-settings`, bookPrefix: `${prefix}-book-` })
  opened.push(workspace)
  await workspace.settings.books.put({ id: 'a', title: '人物对样本', sourceFileName: 'a.txt', createdAt: '2026-11-03T00:00:00.000Z' })
  const db = workspace.openBook('a')
  await db.chapters.put({ bookId: 'a', chapterIndex: '1', chapterName: '第一章', order: 0, charCount: 40 })
  await db.table('chapterTexts').put({ bookId: 'a', chapterIndex: '1', text: '船夫张三是长女张蕾的父亲。张三暗恋赵六，但赵六并不知情。' })
  const service = createAssetService(workspace)
  const a = await service.create('a', 'character', { name: '张三', chapterIndex: '1' })
  const b1 = await service.create('a', 'character', { name: '张蕾', chapterIndex: '1', identity: '长女' })
  const b2 = await service.create('a', 'character', { name: '张蕾', manualSourceNote: '商人张蕾' })
  const b3 = await service.create('a', 'character', { name: '张蕾', manualSourceNote: '刺客张蕾' })
  const d = await service.create('a', 'character', { name: '赵六', manualSourceNote: '过客' })
  const characters = await db.table<Character>('characters').toArray()
  const lifecycle = await db.table<Lifecycle>('assetLifecycle').toArray()
  const relation = extractedRelation(a, { target: '张蕾', relationType: 'parent_child', forwardLabel: '父亲', reverseLabel: '女儿', direction: 'directed', chapterIndex: '1', quote: '船夫张三是长女张蕾的父亲' }, characters, lifecycle)
  await db.table<CharacterRelation>('characterRelations').put(relation)
  return { workspace, db, service, a, b1, b2, b3, d }
}
afterEach(async () => {
  for (const workspace of opened.splice(0)) {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name)
  }
})

describe('人物对编辑', () => {
  it('只改指定编号对，其余同名人物保持原关系，反向读取方向正确', async () => {
    const { service, db, a, b1, b2, b3 } = await setup()
    const before = await service.getRelationPair('a', a.id, b1.id)
    expect(before).toMatchObject({ state: 'active', forwardLabels: ['父亲'], reverseLabels: ['女儿'] })
    const saved = await service.saveRelationPair('a', { fromId: a.id, toId: b1.id, forwardLabels: ['师父'], reverseLabels: ['徒弟'], reason: '第二章确认师徒', expectedFingerprint: before.fingerprint })
    expect(saved.changed).toBe(true)
    const fromA = await service.getRelationPair('a', a.id, b1.id)
    const fromB = await service.getRelationPair('a', b1.id, a.id)
    expect(fromA).toMatchObject({ state: 'active', forwardLabels: ['师父'], reverseLabels: ['徒弟'] })
    expect(fromB).toMatchObject({ state: 'active', forwardLabels: ['徒弟'], reverseLabels: ['师父'] })
    expect(await service.getRelationPair('a', a.id, b2.id)).toMatchObject({ state: 'active', forwardLabels: ['父亲'], reverseLabels: ['女儿'] })
    expect(await service.getRelationPair('a', a.id, b3.id)).toMatchObject({ state: 'active', forwardLabels: ['父亲'] })
    expect(await db.table('characterRelationEdits').count()).toBe(1)
    const state = await service.read('a')
    expect(state.relationEdges[a.id].filter(edge => edge.toId === b1.id)[0].labels).toEqual(['师父'])
    expect(state.relationEdges[a.id].filter(edge => edge.toId === b2.id)[0].labels).toEqual(['父亲'])
  })

  it('删除整组后刷新仍无连接，新保存可恢复为 active', async () => {
    const { service, a, b1 } = await setup()
    const before = await service.getRelationPair('a', a.id, b1.id)
    await service.deleteRelationPair('a', { fromId: a.id, toId: b1.id, forwardLabels: [], reverseLabels: [], reason: '原文确认没有父女关系', expectedFingerprint: before.fingerprint })
    let state = await service.read('a')
    expect(state.relationEdges[a.id].some(edge => edge.toId === b1.id)).toBe(false)
    expect(await service.getRelationPair('a', a.id, b1.id)).toMatchObject({ state: 'deleted' })
    const deleted = await service.getRelationPair('a', a.id, b1.id)
    const restored = await service.saveRelationPair('a', { fromId: a.id, toId: b1.id, forwardLabels: ['父亲'], reverseLabels: ['女儿'], reason: '重新读到原文后恢复', expectedFingerprint: deleted.fingerprint })
    expect(restored.changed).toBe(true)
    state = await service.read('a')
    expect(state.relationEdges[a.id].some(edge => edge.toId === b1.id)).toBe(true)
    expect(await service.getRelationPair('a', a.id, b1.id)).toMatchObject({ state: 'active', forwardLabels: ['父亲'] })
  })

  it('允许单向关系，反向不生成推测标签；双向空拒绝保存', async () => {
    const { service, a, d } = await setup()
    const before = await service.getRelationPair('a', a.id, d.id)
    expect(before.state).toBe('absent')
    await service.saveRelationPair('a', { fromId: a.id, toId: d.id, forwardLabels: ['暗恋'], reverseLabels: [], reason: '原文只说张三暗恋', expectedFingerprint: before.fingerprint })
    let state = await service.read('a')
    expect(state.relationEdges[a.id].filter(edge => edge.toId === d.id)[0].labels).toEqual(['暗恋'])
    expect(state.relationEdges[d.id].filter(edge => edge.toId === a.id)).toHaveLength(0)
    const current = await service.getRelationPair('a', a.id, d.id)
    await expect(service.saveRelationPair('a', { fromId: a.id, toId: d.id, forwardLabels: [], reverseLabels: [], reason: '空', expectedFingerprint: current.fingerprint })).rejects.toThrow('至少一个方向')
    expect(await service.getRelationPair('a', a.id, d.id)).toMatchObject({ forwardLabels: ['暗恋'], reverseLabels: [] })
  })

  it('指纹过期拒绝提交，重复操作键返回原结果', async () => {
    const { service, a, b1 } = await setup()
    const first = await service.getRelationPair('a', a.id, b1.id)
    const second = await service.getRelationPair('a', a.id, b1.id)
    await service.saveRelationPair('a', { fromId: a.id, toId: b1.id, forwardLabels: ['师父'], reverseLabels: ['徒弟'], reason: '第一次', expectedFingerprint: first.fingerprint })
    await expect(service.saveRelationPair('a', { fromId: a.id, toId: b1.id, forwardLabels: ['父亲'], reverseLabels: ['女儿'], reason: '旧页面', expectedFingerprint: second.fingerprint })).rejects.toThrow('已被更新')
    const current = await service.getRelationPair('a', a.id, b1.id)
    const replay = await service.saveRelationPair('a', { fromId: a.id, toId: b1.id, forwardLabels: ['师父'], reverseLabels: ['徒弟'], reason: '重试', expectedFingerprint: current.fingerprint, operationKey: 'same-key' })
    const again = await service.saveRelationPair('a', { fromId: a.id, toId: b1.id, forwardLabels: ['师父'], reverseLabels: ['徒弟'], reason: '重试', expectedFingerprint: current.fingerprint, operationKey: 'same-key' })
    expect(again.changed).toBe(replay.changed)
    expect(await service.getRelationPair('a', a.id, b1.id)).toMatchObject({ forwardLabels: ['师父'] })
  })

  it('合并保留有效连接、全删除仍无连接，两个端点合为同一人不生成自连', async () => {
    const { service, db, a, b1, b2 } = await setup()
    const pair = await service.getRelationPair('a', a.id, b1.id)
    await service.deleteRelationPair('a', { fromId: a.id, toId: b1.id, forwardLabels: [], reverseLabels: [], reason: '删除长女', expectedFingerprint: pair.fingerprint })
    const preview = await service.previewMerge('a', 'character', { memberIds: [b1.id, b2.id], keepId: b2.id, canonicalName: '张蕾' })
    await service.confirmMerge('a', 'character', preview.request)
    expect(await service.getRelationPair('a', a.id, b2.id)).toMatchObject({ state: 'active', forwardLabels: ['父亲'] })
    const edits = await db.table('characterRelationEdits').toArray()
    expect(edits).toHaveLength(1)
    expect([edits[0].aId, edits[0].bId].sort()).toEqual([a.id, b2.id].sort())
    expect(edits[0].state).toBe('active')
  })
})

describe('人物对生命周期', () => {
  it('改名保留编号关系，删除来源后新同名人物不继承', async () => {
    const { service, db, a, d } = await setup()
    const before = await service.getRelationPair('a', a.id, d.id)
    await service.saveRelationPair('a', { fromId: a.id, toId: d.id, forwardLabels: ['暗恋'], reverseLabels: [], reason: '人工建立', expectedFingerprint: before.fingerprint })
    const current = (await service.read('a')).characters.find(row => row.id === a.id)!
    await service.update('a', 'character', a.id, current.revision, { name: '张老三' })
    expect(await service.getRelationPair('a', a.id, d.id)).toMatchObject({ forwardLabels: ['暗恋'] })
    const renamed = (await service.read('a')).characters.find(row => row.id === a.id)!
    await service.remove('a', 'character', a.id, renamed.revision)
    const replacement = await service.create('a', 'character', { name: '张老三', manualSourceNote: '同名新人物' })
    expect(await service.getRelationPair('a', replacement.id, d.id)).toMatchObject({ state: 'absent' })
    expect(await db.table('characterRelationEdits').count()).toBe(1)
  })

  it('两个端点合并为同一人物时移除旧编辑，不生成自连', async () => {
    const { service, db, a, b1 } = await setup()
    const before = await service.getRelationPair('a', a.id, b1.id)
    await service.saveRelationPair('a', { fromId: a.id, toId: b1.id, forwardLabels: ['师父'], reverseLabels: ['徒弟'], reason: '人工建立', expectedFingerprint: before.fingerprint })
    const preview = await service.previewMerge('a', 'character', { memberIds: [a.id, b1.id], keepId: a.id, canonicalName: '张三' })
    await service.confirmMerge('a', 'character', preview.request)
    expect((await service.read('a')).pairs.some(pair => pair.fromId === pair.toId)).toBe(false)
    expect(await db.table('characterRelationEdits').count()).toBe(0)
  })
})
