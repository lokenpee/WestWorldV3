import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createAssetService } from '../src/features/assets/service'
import { extractedRelation, relationView } from '../src/features/assets/relations'
import { migrateCharacterRelations, migrateNodeBindings } from '../src/features/assets/migrate'
import { createModelService } from '../src/features/models/service'
import { defaultConfig } from '../src/features/models/types'
import { createExtractionService } from '../src/features/extraction/service'
import { agentStream } from './support/agent-protocol'
import { emptyTables, tableNames } from '../src/features/backup/data'
import { encodeBackup } from '../src/features/backup/codec'
import type { Character, CharacterRelation, EventNode } from '../src/features/assets/types'

const opened: ReturnType<typeof createWorkspace>[] = []
async function setup(texts = ['张三记得张蕾。']) {
  const prefix = `foundation-${crypto.randomUUID()}`
  const workspace = createWorkspace({ settingsName: `${prefix}-settings`, bookPrefix: `${prefix}-book-` }); opened.push(workspace)
  const book = { id: 'a', title: '基础回归', sourceFileName: 'a.txt', createdAt: new Date().toISOString() }
  await workspace.settings.books.put(book)
  const db = workspace.openBook('a')
  for (const [order, text] of texts.entries()) {
    const chapterIndex = String(order + 1)
    await db.chapters.put({ bookId: 'a', chapterIndex, chapterName: `第${chapterIndex}章`, order, charCount: text.length })
    await db.table('chapterTexts').put({ bookId: 'a', chapterIndex, text })
  }
  return { book, workspace, db, assets: createAssetService(workspace) }
}
afterEach(async () => {
  for (const workspace of opened.splice(0)) {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name)
  }
})

it('地点合并保留人物关系端点、修订号与可导出的备份', async () => {
  const { book, db, assets } = await setup()
  const a = await assets.create('a', 'character', { name: '张三', chapterIndex: '1' })
  await assets.create('a', 'character', { name: '张蕾', chapterIndex: '1' })
  const relation = extractedRelation(a, { target: '张蕾', relationType: 'friend', forwardLabel: '朋友', reverseLabel: '朋友', direction: 'bidirectional', chapterIndex: '1', quote: '张三记得张蕾。' }, await db.table('characters').toArray(), await db.table('assetLifecycle').toArray())
  await db.table('characterRelations').put(relation)
  const x = await assets.create('a', 'location', { name: '码头', chapterIndex: '1' }), y = await assets.create('a', 'location', { name: '渡口', chapterIndex: '1' })
  const preview = await assets.previewMerge('a', 'location', { memberIds: [x.id, y.id], keepId: x.id, canonicalName: '码头' })
  await assets.confirmMerge('a', 'location', preview.request)
  expect(await db.table('characterRelations').get(relation.id)).toEqual(relation)
  const tables = emptyTables(); for (const name of tableNames) tables[name] = await db.table(name).toArray()
  await expect(encodeBackup({ book, tables })).resolves.toHaveProperty('bytes')
})

it.each(['relation', 'node', 'rollback'])('P1 后续章节无新关系时补齐已有 %s 的全部同名人物', async target => {
  const { workspace, db, assets } = await setup(['张三记得张蕾。', '张三和张蕾到来。'])
  let worldCount = 0
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const world = JSON.parse(init?.body as string).tools[0].function.parameters.properties.characters
    const value = world ? (++worldCount === 1 ? { characters: [{ name: '张三', confidence: 1, relations: [{ target: '张蕾', relation_type: 'friend', relation_label: '朋友', reverse_label: '朋友', direction: 'bidirectional', quote: '张三记得张蕾。' }] }], locations: [] } : { characters: [{ name: '张三', confidence: 1 }, { name: '张蕾', confidence: 1 }], locations: [] }) : { nodes: worldCount === 1 ? [{ name: '回忆', summary: '张三记得张蕾', actors: ['张三'], quote: '张三记得张蕾。', confidence: 1 }] : [] }
    return agentStream([{ name: 'submit_result', args: value }])
  })
  const models = createModelService(workspace, { fetch: fetcher })
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://foundation.invalid/v1', extractionModel: 'test' }, 'fake-key')
  const extraction = createExtractionService(workspace, models)
  if (target === 'rollback') {
    let once = true
    db.table('nodes').hook('updating', () => { if (once) { once = false; throw new DOMException('模拟补齐节点失败', 'DataError') } })
  }
  await extraction.start('a')
  expect(extraction.state('a')?.error).toBeUndefined()
  if (target === 'rollback') {
    expect((await extraction.progress('a'))?.status).toBe('failed')
    expect(await db.table('characters').get('C2-P001')).toBeUndefined()
    expect(await db.table('extractionReceipts').get('2:worldAssets')).toBeUndefined()
    expect((await db.table('nodes').get('C1-N001')).actorIds).toEqual(['C1-P001'])
    expect((await db.table<CharacterRelation>('characterRelations').toArray())[0].targetIds).toEqual([])
    await extraction.retry('a', '2', 'worldAssets')
  }
  expect((await extraction.progress('a'))?.status).toBe('completed')
  if (target === 'relation') {
    expect((await db.table<CharacterRelation>('characterRelations').toArray())[0].targetIds).toEqual(['C2-P002'])
  } else {
    expect((await db.table('nodes').get('C1-N001')).actorIds).toEqual(['C1-P001', 'C2-P001'])
    const line = await assets.create('a', 'eventLine', { title: '回忆线', nodeIds: ['C1-N001'] })
    expect((await assets.read('a')).lineCharacterIds[line.id]).toEqual(['C1-P001', 'C2-P001'])
  }
  const before = await db.table('nodes').toArray(), calls = fetcher.mock.calls.length
  await extraction.start('a')
  expect(fetcher).toHaveBeenCalledTimes(calls)
  expect(await db.table('nodes').toArray()).toEqual(before)
})

it('旧父亲关系迁移为父亲与子女，无法确定反向的父子关系保留方向未明确', () => {
  const characters: Character[] = ['张三', '张蕾'].map((name, i) => ({ id: `P${i}`, bookId: 'a', name, revision: 1, confidence: 1, createdBy: 'P1' }))
  characters[0].relations = [{ target: '张蕾', relation_type: 'parent_child', relation_label: '父亲', direction: 'directed' }]
  const relations = migrateCharacterRelations(characters, [])
  expect(relations[0]).toMatchObject({ forwardLabel: '父亲', reverseLabel: '子女', direction: 'directed' })
  expect(relationView(relations, characters).edges.find(edge => edge.fromId === 'P1')).toMatchObject({ labels: ['子女'], directionUnclear: false })
  characters[0].relations[0].relation_label = '父子'
  expect(migrateCharacterRelations(characters, [])[0].direction).toBe('unspecified')
})

it('人工清空旧节点人物时可以移除迁移保留的旧资料编号', async () => {
  const { db, assets } = await setup()
  const person = await assets.create('a', 'character', { name: '张三', chapterIndex: '1' })
  const old = { id: 'N1', bookId: 'a', name: '回忆', summary: '回忆', actors: ['张三'], actorIds: [person.id], chapterIndex: '1', chapterName: '第1章', order: 0, revision: 1, confidence: 1, createdBy: 'P1', quote: '', eventLineIds: [] } as EventNode
  await db.table('nodes').put(migrateNodeBindings([old], [person])[0])
  await assets.update('a', 'node', old.id, 1, { participantIds: [], unlinkedParticipants: [] })
  expect((await db.table('nodes').get(old.id)).actorIds).toEqual([])
})
