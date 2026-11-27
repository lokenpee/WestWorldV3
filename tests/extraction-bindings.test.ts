import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { expect, it, vi } from 'vitest'
import * as links from '../src/features/assets/characterLinks'
import * as relations from '../src/features/assets/relations'
import type { Character, CharacterRelation, EventNode, Lifecycle } from '../src/features/assets/types'
import { addedCharacterBindingScope } from '../src/features/extraction/affectedBindings'
import { createExtractionService } from '../src/features/extraction/service'
import { createModelService } from '../src/features/models/service'
import { defaultConfig } from '../src/features/models/types'
import { createWorkspace } from '../src/lib/storage/workspace'
import { agentStream } from './support/agent-protocol'

const timestamp = '2026-11-19T00:00:00.000Z'
const person = (id: string, name: string, aliases: string[] = []): Character => ({ id, bookId: 'a', name, aliases, confidence: 1, revision: 1, createdBy: 'P1' })
const node = (id: string, actors: string[], targets: string[] = []): EventNode => ({ id, bookId: 'a', name: id, summary: id, actors: [...actors, ...targets], chapterIndex: '1', chapterName: '第一章', order: 0, quote: '', eventLineIds: [], confidence: 1, revision: 1, createdBy: 'P1' })
const relation = (id: string, targetName: string, targetIds: string[] = [], originCharacterId = 'source'): CharacterRelation => ({ id, bookId: 'a', originCharacterId, sourceName: '张三', sourceId: originCharacterId === 'source' ? 'source' : null, targetName, targetIds, relationType: 'friend', forwardLabel: '朋友', reverseLabel: '朋友', direction: 'bidirectional', evidence: [], revision: 1, createdAt: timestamp, updatedAt: timestamp })
const mapping = (originId: string, currentId: string): Lifecycle => ({ key: `character:${originId}`, bookId: 'a', kind: 'character', originId, currentId, state: 'merged', revision: 1, updatedAt: timestamp })

function compareWithFull(before: Character[], added: Character[], nodes: EventNode[], rows: CharacterRelation[], lifecycle: Lifecycle[] = []) {
  const after = [...before, ...added]
  const scope = addedCharacterBindingScope(before, after, lifecycle)
  const selectedNodes = nodes.filter(scope.node), selectedRelations = rows.filter(scope.relation)
  const mapped = new Map(links.remapCharacterLinks(selectedNodes, before, after).map(value => [value.id, value]))
  const synced = new Map(relations.syncRelations(selectedRelations, after, lifecycle, timestamp).relations.map(value => [value.id, value]))
  const nextNodes = nodes.map(value => mapped.get(value.id) ?? value), nextRelations = rows.map(value => synced.get(value.id) ?? value)
  expect(nextNodes).toEqual(links.remapCharacterLinks(nodes, before, after))
  expect(nextRelations).toEqual(relations.syncRelations(rows, after, lifecycle, timestamp).relations)
  return { selectedNodes, selectedRelations, nextNodes, nextRelations }
}

it('新增主名和有效别名补齐未绑定与同名记录，结果逐对象等同全量绑定', () => {
  const before = [person('source', '张三'), person('shen', '沈青', ['沈公子']), person('other', '顾衡')]
  const nodes = [
    links.bindNodeCharacters(node('late', ['晚到人物']), before),
    links.bindNodeCharacters(node('same', ['沈青']), before),
    links.bindNodeCharacters(node('alias', [], ['青衣客']), before),
    links.bindNodeCharacters(node('unrelated', ['顾衡']), before),
  ]
  const rows = [relation('late', '晚到人物'), relation('same', '沈青', ['shen']), relation('alias', '青衣客'), relation('unrelated', '顾衡', ['other'])]
  const result = compareWithFull(before, [person('late', '晚到人物'), person('same', '沈青'), person('alias', '新客', ['青衣客', '娘娘'])], nodes, rows)
  expect(result.selectedNodes.map(value => value.id)).toEqual(['late', 'same', 'alias'])
  expect(result.selectedRelations.map(value => value.id)).toEqual(['late', 'same', 'alias'])
  expect(result.nextNodes[1].actorIds).toEqual(['shen', 'same'])
  expect(result.nextNodes[2].actorIds).toEqual(['alias'])
  expect(result.nextRelations[1].targetIds).toEqual(['same', 'shen'])
  expect(result.nextNodes[3]).toBe(nodes[3])
  expect(result.nextRelations[3]).toBe(rows[3])
})

it('节点保留原始称呼，关系通过旧别名绑定后仍参与主名扩展', () => {
  const before = [person('source', '张三'), person('shen', '沈青', ['沈公子']), person('other', '顾衡', ['信使'])]
  const nodes = [links.bindNodeCharacters(node('old-alias', ['沈公子']), before), links.bindNodeCharacters(node('target-alias', [], ['信使']), before)]
  expect(nodes[0].actors).toEqual(['沈青'])
  expect(nodes[1].actors).toEqual(['顾衡'])
  const rows = [relation('bound-by-alias', '沈公子', ['shen'])]
  const result = compareWithFull(before, [person('new-shen', '沈青'), person('new-alias', '新来客', ['沈公子', '信使'])], nodes, rows)
  expect(result.nextNodes[0].actorIds).toEqual(['shen', 'new-alias'])
  expect(result.nextNodes[1].actorIds).toEqual(['other', 'new-alias'])
  expect(result.nextRelations[0].targetIds).toEqual(['new-alias', 'new-shen', 'shen'])
})

it('关系来源与目标沿生命周期解析到新增编号时也重新绑定', () => {
  const before = [person('source', '张三'), person('shen', '沈青')]
  const lifecycle = [mapping('old-source', 'new-source'), mapping('old-target', 'new-target')]
  const rows = [relation('source', '沈青', ['shen'], 'old-source'), relation('target', '历史称呼', ['old-target'])]
  const result = compareWithFull(before, [person('new-source', '新来源'), person('new-target', '新目标')], [], rows, lifecycle)
  expect(result.selectedRelations).toHaveLength(2)
  expect(result.nextRelations[0].sourceId).toBe('new-source')
  expect(result.nextRelations[1].targetIds).toEqual(['new-target'])
})

it('通用别称仍不自动命中，作为人物主名时仍完整匹配', () => {
  const before = [person('source', '张三')]
  const nodes = [links.bindNodeCharacters(node('title', ['娘娘']), before), links.bindNodeCharacters(node('generic', ['爸爸']), before)]
  const rows = [relation('title', '娘娘'), relation('generic', '爸爸')]
  const result = compareWithFull(before, [person('new', '娘娘', ['爸爸'])], nodes, rows)
  expect(result.selectedNodes.map(value => value.id)).toEqual(['title'])
  expect(result.selectedRelations.map(value => value.id)).toEqual(['title'])
  expect(result.nextNodes[1]).toBe(nodes[1])
  expect(result.nextRelations[1]).toBe(rows[1])
})

it('既有编号在本批出现时保留节点的人工关联', () => {
  const before = [person('source', '张三')]
  const manual = { ...node('manual', []), actorIds: ['new'], manualActorIds: ['new'] }
  const result = compareWithFull(before, [person('new', '新人物')], [manual], [])
  expect(result.nextNodes[0]).toMatchObject({ actors: ['新人物'], manualActorIds: ['new'] })
})

it('不同新增主名和别名组合与原全量结果一致', () => {
  const before = [person('source', '张三'), person('a', '甲', ['甲公子']), person('b', '乙', ['信使']), person('c', '丙', ['信使'])]
  const mentions = ['甲', '甲公子', '乙', '丙', '信使', '未知', '娘娘', '甲 乙', ' 甲 ']
  const nodes = mentions.flatMap((mention, i) => [links.bindNodeCharacters(node(`actor-${i}`, [mention]), before), links.bindNodeCharacters(node(`target-${i}`, [], [mention]), before)])
  const rows = relations.syncRelations(mentions.map((mention, i) => relation(`R${i}`, mention)), before, [], timestamp).relations
  for (const [i, name] of mentions.entries()) {
    for (const alias of mentions) compareWithFull(before, [person(`new-${i}`, name, [alias])], nodes, rows)
  }
})

it('P1没有新增人物时不调用旧关系和节点重绑定', async () => {
  const prefix = `bindings-${crypto.randomUUID()}`
  const workspace = createWorkspace({ settingsName: prefix, bookPrefix: `${prefix}-book-` })
  const remap = vi.spyOn(links, 'remapCharacterLinks'), sync = vi.spyOn(relations, 'syncRelations')
  try {
    const db = workspace.openBook('a')
    await workspace.settings.books.put({ id: 'a', title: '空人物增量', sourceFileName: 'a.txt', createdAt: timestamp })
    await db.chapters.put({ bookId: 'a', chapterIndex: '1', chapterName: '第一章', order: 0, charCount: 3 })
    await db.table('chapterTexts').put({ bookId: 'a', chapterIndex: '1', text: '青石镇' })
    await db.table('characters').put(person('source', '张三'))
    const oldNode = node('old', ['张三']), oldRelation = relation('old', '未现身')
    await db.table('nodes').put(oldNode)
    await db.table('characterRelations').put(oldRelation)
    const fetcher = vi.fn<typeof fetch>(async () => agentStream([{ name: 'submit_result', args: { characters: [], locations: [{ name: '青石镇', confidence: 1 }] } }]))
    const models = createModelService(workspace, { fetch: fetcher, wait: async (_ms, signal) => signal.throwIfAborted() })
    await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://bindings.invalid/v1', extractionModel: 'test' }, 'fixture-only')
    const service = createExtractionService(workspace, models)
    remap.mockClear(); sync.mockClear()
    await service.retry('a', '1', 'worldAssets')
    expect(service.state('a')?.error).toBeUndefined()
    expect(await db.table('extractionReceipts').get('1:worldAssets')).toBeDefined()
    expect(remap).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(await db.table('nodes').get('old')).toEqual(oldNode)
    expect(await db.table('characterRelations').get('old')).toEqual(oldRelation)
  } finally {
    vi.restoreAllMocks()
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name === prefix || name.startsWith(`${prefix}-book-`)) await Dexie.delete(name)
  }
})
