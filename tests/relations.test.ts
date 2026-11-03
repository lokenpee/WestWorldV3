import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { Value } from 'typebox/value'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createAssetService } from '../src/features/assets/service'
import { bindNodeCharacters, setNodeParticipants } from '../src/features/assets/characterLinks'
import { extractedRelation, paginateEdges, relationView } from '../src/features/assets/relations'
import { createMemoryAgentRepository } from '../src/features/agents/repository'
import { readTool, type Scope } from '../src/features/agents/queries'
import { hash, resultContracts, validate } from '../src/features/agents/contracts'
import { migrateRelationsData, emptyTables } from '../src/features/backup/data'
import type { Character, CharacterRelation, EventNode, Lifecycle } from '../src/features/assets/types'

const opened: ReturnType<typeof createWorkspace>[] = []
async function setup() {
  const prefix = `relations-${crypto.randomUUID()}`
  const workspace = createWorkspace({ settingsName: `${prefix}-settings`, bookPrefix: `${prefix}-book-` })
  opened.push(workspace)
  await workspace.settings.books.put({ id: 'a', title: '关系样本', sourceFileName: 'a.txt', createdAt: '2026-10-25T00:00:00.000Z' })
  const db = workspace.openBook('a')
  await db.chapters.put({ bookId: 'a', chapterIndex: '1', chapterName: '第一章', order: 0, charCount: 30 })
  await db.table('chapterTexts').put({ bookId: 'a', chapterIndex: '1', text: '张三说张蕾是他的女儿，张三与张蕾在码头见面。' })
  return { workspace, db, service: createAssetService(workspace) }
}
afterEach(async () => {
  for (const workspace of opened.splice(0)) {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name)
  }
})

describe('人物关系与绑定', () => {
  it('来源只按编号归属，目标全部命中，后到目标补齐，来源合并后汇聚标签', async () => {
    const { db, service } = await setup()
    const a1 = await service.create('a', 'character', { name: '张三', chapterIndex: '1' })
    const a2 = await service.create('a', 'character', { name: '张三', manualSourceNote: '另一个张三' })
    const b1 = await service.create('a', 'character', { name: '张蕾', chapterIndex: '1' })
    const b2 = await service.create('a', 'character', { name: '张蕾', manualSourceNote: '同名张蕾二' })
    const b3 = await service.create('a', 'character', { name: '张蕾', manualSourceNote: '同名张蕾三' })
    const characters = await db.table<Character>('characters').toArray()
    const lifecycle = await db.table<Lifecycle>('assetLifecycle').toArray()
    const relation = extractedRelation(a1, { target: '张蕾', relationType: 'parent_child', forwardLabel: '父亲', reverseLabel: '女儿', direction: 'directed', chapterIndex: '1', quote: '张三说张蕾是他的女儿' }, characters, lifecycle)
    await db.table<CharacterRelation>('characterRelations').put(relation)

    let state = await service.read('a')
    expect(state.relations).toHaveLength(1)
    expect(state.relations[0]).toMatchObject({ originCharacterId: a1.id, sourceId: a1.id })
    expect(state.relations[0].targetIds).toHaveLength(3)
    expect(state.relations[0].targetIds).toEqual(expect.arrayContaining([b1.id, b2.id, b3.id]))
    expect(state.relationEdges[a1.id].filter(edge => edge.fromId === a1.id)).toHaveLength(3)
    expect(state.relationEdges[a2.id]).toHaveLength(0)
    const schema = JSON.parse(readFileSync(new URL('../docs/v2/resources/v2.2/storage.schema.json', import.meta.url), 'utf8'))
    expect([...Value.Errors({ ...schema, $ref: '#/$defs/StoredRelation' }, state.relations[0])]).toEqual([])

    const b4 = await service.create('a', 'character', { name: '张蕾', manualSourceNote: '同名张蕾四' })
    state = await service.read('a')
    expect(state.relations[0].targetIds).toHaveLength(4)
    expect(state.relationEdges[a1.id].filter(edge => edge.fromId === a1.id)).toHaveLength(4)

    const group = [b1.id, b2.id, b3.id, b4.id]
    const preview = await service.previewMerge('a', 'character', { memberIds: group, keepId: b1.id, canonicalName: '张蕾' })
    await service.confirmMerge('a', 'character', preview.request)
    state = await service.read('a')
    expect(state.relationEdges[a1.id]).toHaveLength(2)
    expect(state.relations[0].targetIds).toEqual([b1.id])

    const a2Relation = extractedRelation(a2, { target: '张蕾', relationType: 'enemy', forwardLabel: '杀母仇人', reverseLabel: '仇人', direction: 'directed', chapterIndex: '1', quote: '张三与张蕾在码头见面' }, (await db.table<Character>('characters').toArray()), await db.table<Lifecycle>('assetLifecycle').toArray())
    await db.table('characterRelations').put(a2Relation)
    state = await service.read('a')
    expect(state.relationEdges[a1.id]).toHaveLength(2)
    expect(state.relationEdges[a2.id]).toHaveLength(2)
    expect(state.relationEdges[b1.id]).toHaveLength(4)

    const sourcePreview = await service.previewMerge('a', 'character', { memberIds: [a1.id, a2.id], keepId: a1.id, canonicalName: '张三' })
    await service.confirmMerge('a', 'character', sourcePreview.request)
    state = await service.read('a')
    const outgoing = state.relationEdges[a1.id].filter(edge => edge.fromId === a1.id)
    expect(outgoing).toHaveLength(1)
    expect([...outgoing[0].labels].sort()).toEqual(['杀母仇人', '父亲'])
    expect(state.relations.map(row => row.originCharacterId).sort()).toEqual([a1.id, a2.id].sort())

    await service.remove('a', 'character', a1.id, state.characters.find(row => row.id === a1.id)!.revision)
    state = await service.read('a')
    expect(state.relationEdges[a1.id]).toBeUndefined()
    expect(state.unresolvedRelations).toHaveLength(2)
    expect(state.unresolvedRelations.every(row => row.reason === 'source_missing')).toBe(true)
  })

  it('两个称呼命中同一人物时移除一个仍保留另一来源', async () => {
    const { db, service } = await setup()
    const person = await service.create('a', 'character', { name: '沈青', aliases: ['老沈'], chapterIndex: '1' })
    const characters = await db.table<Character>('characters').toArray()
    const node = { id: 'n', bookId: 'a', name: '交信', summary: '交信', chapterIndex: '1', chapterName: '第一章', actors: ['沈青', '老沈'], order: 0, revision: 1, confidence: 1, createdBy: 'manual', quote: '' } as EventNode
    const bound = bindNodeCharacters(node, characters)
    expect(bound.actorIds).toEqual([person.id])
    expect(bound.actorBindings?.map(group => group.mention)).toEqual(['沈青', '老沈'])
    const kept = setNodeParticipants(bound, characters, [person.id], ['沈青'])
    expect(kept.actorIds).toEqual([person.id])
    expect(kept.actorBindings?.map(group => group.mention)).toEqual(['沈青'])
  })

  it('关系结果按有序端点分页，总量与并集一致', () => {
    const people: Character[] = ['A1', 'B1', 'B2'].map(id => ({ id, bookId: 'a', name: id, revision: 1, confidence: 1, createdBy: 'manual' }))
    const relation: CharacterRelation = { id: 'R1', bookId: 'a', originCharacterId: 'A1', sourceName: 'A1', targetName: 'B', relationType: 'friend', forwardLabel: '朋友', reverseLabel: '朋友', direction: 'bidirectional', evidence: [], sourceId: 'A1', targetIds: ['B1', 'B2'], revision: 1, createdAt: '', updatedAt: '' }
    const view = relationView([relation], people)
    expect(view.edges).toHaveLength(4)
    expect(view.edges.map(edge => `${edge.fromId}>${edge.toId}`)).toEqual(['A1>B1', 'A1>B2', 'B1>A1', 'B2>A1'])
  })

  it('有向关系按稳定分页读取，分页并集等于总量', () => {
    const people: Character[] = ['A1', 'B1', 'B2', 'B3', 'B4', 'B5'].map(id => ({ id, bookId: 'a', name: id, revision: 1, confidence: 1, createdBy: 'manual' }))
    const relation: CharacterRelation = { id: 'R1', bookId: 'a', originCharacterId: 'A1', sourceName: 'A1', targetName: 'B', relationType: 'friend', forwardLabel: '朋友', reverseLabel: '朋友', direction: 'bidirectional', evidence: [], sourceId: 'A1', targetIds: ['B1', 'B2', 'B3', 'B4', 'B5'], revision: 1, createdAt: '', updatedAt: '' }
    const edges = relationView([relation], people).edges
    const collected: string[] = []
    let offset: number | null = 0
    while (offset !== null) {
      const page = paginateEdges(edges, offset, 3)
      collected.push(...page.items.map(edge => `${edge.fromId}>${edge.toId}`))
      offset = page.nextOffset
    }
    expect(collected).toEqual(edges.map(edge => `${edge.fromId}>${edge.toId}`))
    expect(new Set(collected).size).toBe(edges.length)
  })

  it('格式5备份数据转换为独立关系表，旧方向和原承载编号保留', () => {
    const tables = emptyTables()
    tables.characters = [
      { id: 'A1', bookId: 'a', name: '张三', revision: 1, confidence: 1, createdBy: 'P1', relations: [{ target: '张蕾', relation_type: 'parent_child', relation_label: '父亲', direction: 'directed' }] },
      { id: 'A2', bookId: 'a', name: '张三', revision: 1, confidence: 1, createdBy: 'P1', relations: [{ target: '张蕾', relation_type: 'enemy', relation_label: '仇人' }] },
      { id: 'B1', bookId: 'a', name: '张蕾', revision: 1, confidence: 1, createdBy: 'P1' },
    ]
    tables.assetLifecycle = ['A1', 'A2', 'B1'].map(id => ({ key: `character:${id}`, bookId: 'a', kind: 'character', originId: id, currentId: id, state: 'live', revision: 1, updatedAt: '' }))
    tables.nodes = [{ id: 'N1', bookId: 'a', name: '会面', summary: '会面', chapterIndex: '1', chapterName: '第一章', actors: ['张三'], actorIds: ['A2'], order: 0, revision: 1, confidence: 1, createdBy: 'P1', quote: '' }]
    const data = migrateRelationsData({ book: { id: 'a', title: '样本', sourceFileName: 'a.txt', createdAt: '' }, tables })
    expect(data.tables.characterRelations).toHaveLength(2)
    expect(data.tables.characterRelations.map(row => row.originCharacterId).sort()).toEqual(['A1', 'A2'])
    expect(data.tables.characterRelations.find(row => row.originCharacterId === 'A2')).toMatchObject({ direction: 'unspecified', sourceId: 'A2', targetIds: ['B1'], legacyPayload: { relation_label: '仇人' } })
    expect(data.tables.characters.every(row => !('relations' in row))).toBe(true)
    expect(data.tables.nodes[0]).toMatchObject({ actorIds: ['A1', 'A2'], legacyActorIds: ['A2'], actorBindings: [{ mention: '张三', ids: ['A1', 'A2'] }] })
  })

  it('人物详情工具与界面共用关系结果，关系变化改变读取指纹', async () => {
    const characters: Character[] = [
      { id: 'A1', bookId: 'a', name: '张三', revision: 1, confidence: 1, createdBy: 'manual' },
      { id: 'B1', bookId: 'a', name: '张蕾', revision: 1, confidence: 1, createdBy: 'manual' },
    ]
    const relation: CharacterRelation = { id: 'R1', bookId: 'a', originCharacterId: 'A1', sourceName: '张三', targetName: '张蕾', relationType: 'parent_child', forwardLabel: '父亲', reverseLabel: '女儿', direction: 'directed', evidence: [{ chapterIndex: '1', quote: '张三说张蕾是他的女儿' }], sourceId: 'A1', targetIds: ['B1'], revision: 1, createdAt: '', updatedAt: '' }
    const repo = createMemoryAgentRepository('a', {
      characters: characters as unknown as Record<string, unknown>[],
      characterRelations: [relation as unknown as Record<string, unknown>],
      assetLifecycle: ['A1', 'B1'].map(id => ({ key: `character:${id}`, bookId: 'a', kind: 'character', originId: id, currentId: id, state: 'live', revision: 1, updatedAt: '' })),
    })
    const scope: Scope = { bookId: 'a', profile: 'asset_editor', phase: 'ai_identity', runId: 'run', taskId: 'task', owner: 'owner', workItemIds: [] }
    const detail = await repo.transaction(false, store => readTool(store, scope, 'get_character_detail', { ids: ['A1'] }))
    validate(resultContracts.get('get_character_detail')!, detail)
    const rows = detail.data as { relationEdges: { fromId: string; toId: string; labels: string[]; directionUnclear: boolean }[]; relations: { target: string; relation_label?: string }[] }[]
    expect(rows[0]).toMatchObject({ relationEdges: [{ fromId: 'A1', toId: 'B1', labels: ['父亲'], directionUnclear: false }, { fromId: 'B1', toId: 'A1', labels: ['女儿'] }], relations: [{ target: '张蕾', relation_label: '父亲' }] })
    const before = await hash(detail)
    await repo.transaction(true, store => store.put('characterRelations', { ...relation, forwardLabel: '生父', revision: 2 }))
    const changed = await repo.transaction(false, store => readTool(store, scope, 'get_character_detail', { ids: ['A1'] }))
    expect(await hash(changed)).not.toBe(before)
    expect((changed.data as typeof rows)[0].relationEdges[0].labels).toEqual(['生父'])
  })
})
