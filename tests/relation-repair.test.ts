import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createAssetService } from '../src/features/assets/service'
import { bindNodeCharacters, setNodeParticipants } from '../src/features/assets/characterLinks'
import { extractedRelation, pairKeyOf } from '../src/features/assets/relations'
import { legacyRelationLabels } from '../src/features/assets/migrate'
import { relationRepairKind } from '../src/features/assets/repair'
import { checksumOf, encodeBackup, inspectBackup, restoredTables } from '../src/features/backup/codec'
import { emptyTables, tableNames, validateBookData, type BookData, type Row } from '../src/features/backup/data'
import type { Character, CharacterRelationEdit, EventNode } from '../src/features/assets/types'

const opened: ReturnType<typeof createWorkspace>[] = []
const timestamp = '2026-11-03T00:00:00.000Z'
async function setup() {
  const prefix = `repair-${crypto.randomUUID()}`
  const workspace = createWorkspace({ settingsName: `${prefix}-settings`, bookPrefix: `${prefix}-book-` }); opened.push(workspace)
  const book = { id: 'a', title: '旧资料修复', sourceFileName: 'a.txt', createdAt: timestamp }
  await workspace.settings.books.put(book)
  const db = workspace.openBook('a'), assets = createAssetService(workspace)
  const text = '张三记得张蕾。'
  await db.chapters.put({ bookId: 'a', chapterIndex: '1', chapterName: '第一章', order: 0, charCount: text.length })
  await db.table('chapterTexts').put({ bookId: 'a', chapterIndex: '1', text })
  const a = await assets.create('a', 'character', { name: '张三', chapterIndex: '1' })
  const b = await assets.create('a', 'character', { name: '张蕾', chapterIndex: '1' })
  const relation = extractedRelation(a, { target: '张蕾', relationType: 'parent_child', forwardLabel: '父亲', reverseLabel: '父亲', direction: 'directed', chapterIndex: '1', quote: text }, [a, b], [], timestamp)
  relation.sourceId = null; relation.targetIds = []; relation.revision = 2
  relation.legacyPayload = { target: '张蕾', relation_type: 'parent_child', relation_label: '父亲', direction: 'directed' }
  await db.table('characterRelations').put(relation)
  const node = bindNodeCharacters({ id: 'N1', bookId: 'a', name: '回忆', summary: '张三回忆', actors: ['张三'], chapterIndex: '1', chapterName: '第一章', order: 0, revision: 1, confidence: 1, createdBy: 'P1', quote: '', eventLineIds: [] }, [a, b])
  const manual: EventNode = { ...node, id: 'N2', actorBindings: [], actorIds: [a.id], manualActorIds: [a.id], order: 1 }
  await db.table('nodes').bulkPut([node, manual])
  const c: Character = { ...a, id: 'C2-P001' }
  await db.table('characters').put(c)
  await db.table('assetLifecycle').put({ key: `character:${c.id}`, bookId: 'a', kind: 'character', originId: c.id, currentId: c.id, state: 'live', revision: 1, updatedAt: timestamp })
  const edits = [[a.id, b.id, 'deleted'], [a.id, c.id, 'active']].map(([x, y, state]) => {
    const [aId, bId] = [x, y].sort()
    return { pairKey: pairKeyOf(x, y), bookId: 'a', aId, bId, state, aToBLabels: state === 'active' ? ['同事'] : [], bToALabels: [], directionUnclear: false, evidence: [], sourceRelationIds: [relation.id], revision: 3, updatedAt: timestamp, updatedBy: state === 'active' ? 'agent' : 'manual', commitId: 'existing-edit' } as CharacterRelationEdit
  })
  await db.table('characterRelationEdits').bulkPut(edits)
  const snapshot = async (): Promise<BookData> => {
    const tables = emptyTables(); for (const name of tableNames) tables[name] = await workspace.openBook('a').table(name).toArray()
    return { book, tables }
  }
  return { workspace, db, book, a, b, c, relation, node, manual, edits, snapshot }
}
afterEach(async () => {
  for (const workspace of opened.splice(0)) {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name)
  }
})

it.each([6, 7])('版本 %i 书库打开时恢复端点、反向与后到绑定，记录前后值且重复打开不递增', async version => {
  const { workspace, db, relation, node, manual, a, b, c, edits, snapshot } = await setup()
  const before = await snapshot(), name = db.name
  if (version === 6) {
    const stores = Object.fromEntries(db.tables.filter(table => table.name !== 'characterRelationEdits').map(table => [table.name, [table.schema.primKey.src, ...table.schema.indexes.map(index => index.src)].join(',')]))
    workspace.closeBook('a'); await Dexie.delete(name)
    const old = new Dexie(name); old.version(6).stores(stores); await old.open()
    await old.transaction('rw', old.tables, async () => { for (const table of old.tables) await table.bulkPut(before.tables[table.name as keyof typeof before.tables]) })
    old.close()
  } else workspace.closeBook('a')
  const reopened = workspace.openBook('a'); await reopened.open()
  expect(await reopened.table('characterRelations').get(relation.id)).toMatchObject({ id: relation.id, sourceId: a.id, targetIds: [b.id], forwardLabel: '父亲', reverseLabel: '子女', revision: 3 })
  expect(await reopened.table('nodes').get(node.id)).toMatchObject({ actorIds: [a.id, c.id], revision: 2 })
  expect(await reopened.table('nodes').get(manual.id)).toEqual(manual)
  const logs = await reopened.table('pipelineRuns').toArray()
  expect(logs).toHaveLength(1)
  expect(logs[0].result).toMatchObject({ kind: relationRepairKind, before: { characterRelations: [relation], nodes: [node] }, after: { characterRelations: [{ id: relation.id, revision: 3 }], nodes: [{ id: node.id, revision: 2 }] } })
  expect(await reopened.table('characterRelationEdits').toArray()).toEqual(version === 7 ? [...edits].sort((x, y) => x.pairKey.localeCompare(y.pairKey)) : [])
  const after = await snapshot()
  expect(await validateBookData(after)).toEqual([])
  workspace.closeBook('a'); await workspace.openBook('a').open()
  expect(await snapshot()).toEqual(after)
})

it('活动租约暂缓修复，租约释放后重新打开执行', async () => {
  const { workspace, db, relation, a } = await setup()
  await db.table('pipelineRuns').put({ id: 'lease:world', bookId: 'a', recordType: 'lease', lockKey: 'world', expiresAt: Date.now() + 30000 })
  workspace.closeBook('a'); const busy = workspace.openBook('a'); await busy.open()
  expect(await busy.table('characterRelations').get(relation.id)).toEqual(relation)
  await busy.table('pipelineRuns').delete('lease:world')
  workspace.closeBook('a'); const reopened = workspace.openBook('a'); await reopened.open()
  expect(await reopened.table('characterRelations').get(relation.id)).toMatchObject({ sourceId: a.id, revision: 3 })
})

it('修复记录保存失败时事务整体回滚，重试后一次性完成', async () => {
  const { workspace, db, relation, node } = await setup()
  workspace.closeBook('a'); const failing = workspace.openBook('a')
  failing.table('pipelineRuns').hook('creating', (_key, row) => { if (row.result?.kind === relationRepairKind) throw new Error('模拟修复记录写失败') })
  await expect(failing.open()).rejects.toThrow('模拟修复记录写失败')
  const raw = new Dexie(db.name); await raw.open()
  expect(await raw.table('characterRelations').get(relation.id)).toEqual(relation)
  expect(await raw.table('nodes').get(node.id)).toEqual(node)
  raw.close(); workspace.closeBook('a')
  await workspace.openBook('a').open()
  expect(await workspace.openBook('a').table('pipelineRuns').count()).toBe(1)
})

it('实际变化使读取该节点的 P3 核对失效，保留无关核对与已有提交', async () => {
  const { workspace, db, a } = await setup()
  const dependencies = (id: string) => ({ records: [{ table: 'nodes', id, resolvedId: id }] })
  await db.table('pipelineRuns').put({ id: 'P3-run', bookId: 'a', recordType: 'run', stage: 'P3', status: 'completed', startedAt: timestamp, planVersion: '2.2', appliedCommands: [{ commitId: 'previous' }], coverageItems: [
    { id: 'L1', kind: 'eventLine', status: 'checked', invalidations: 0, updatedAt: timestamp, dependencies: dependencies('N1') },
    { id: 'L2', kind: 'eventLine', status: 'checked', invalidations: 0, updatedAt: timestamp, dependencies: dependencies('N2') },
    { id: a.id, kind: 'character', status: 'pending', invalidations: 0, updatedAt: timestamp },
  ] })
  await db.table('compileProgress').put({ bookId: 'a', stage: 'P3', status: 'completed', validity: 'current', updatedAt: timestamp })
  workspace.closeBook('a'); const reopened = workspace.openBook('a'); await reopened.open()
  const run = await reopened.table('pipelineRuns').get('P3-run')
  expect(run.coverageItems.map((item: Row) => item.status)).toEqual(['stale', 'checked', 'pending'])
  expect(run.appliedCommands).toEqual([{ commitId: 'previous' }])
  expect(await reopened.table('compileProgress').get('P3')).toMatchObject({ validity: 'stale', status: 'completed' })
})

it.each([6, 7])('格式 %i 备份恢复与导出使用相同修复，保留编辑状态和修复前值', async version => {
  const { relation, edits, snapshot } = await setup()
  const backup = await encodeBackup(await snapshot())
  const files = unzipSync(backup.bytes), manifest = JSON.parse(strFromU8(files['manifest.json']))
  // 重新制造旧版本曾经导出的有效校验和损坏样本。
  files['data/characterRelations.json'] = strToU8(JSON.stringify([relation]))
  files['data/pipelineRuns.json'] = strToU8('[]')
  manifest.formatVersion = version
  if (version === 6) { delete files['data/characterRelationEdits.json']; delete manifest.checksums['data/characterRelationEdits.json']; manifest.contents = manifest.contents.filter((name: string) => name !== 'characterRelationEdits') }
  delete files['data/legacyRelationRecords.json']
  delete manifest.checksums['data/legacyRelationRecords.json']
  manifest.contents = manifest.contents.filter((name: string) => name !== 'legacyRelationRecords')
  for (const name of ['data/characterRelations.json', 'data/pipelineRuns.json']) manifest.checksums[name] = await checksumOf(files[name])
  files['manifest.json'] = strToU8(JSON.stringify(manifest))
  const inspected = await inspectBackup(zipSync(files))
  expect(inspected.errors).toEqual([])
  expect(inspected.data!.tables.characterRelations[0]).toMatchObject({ id: relation.id, reverseLabel: '子女', revision: 3 })
  expect(inspected.data!.tables.characterRelationEdits).toEqual(version === 7 ? expect.arrayContaining(edits) : [])
  const report = inspected.data!.tables.pipelineRuns.find(row => (row.result as Row)?.kind === relationRepairKind)!
  expect((report.result as { before: { characterRelations: unknown[] } }).before.characterRelations).toEqual([relation])
  const restored = await restoredTables(inspected.data!, 'restored-book')
  const restoredReport = restored.pipelineRuns.find(row => (row.result as Row)?.kind === relationRepairKind)!
  expect(JSON.stringify(restoredReport)).not.toContain('"bookId":"a"')
  const roundtrip = await inspectBackup((await encodeBackup({ book: { ...inspected.data!.book, id: 'restored-book' }, tables: restored })).bytes)
  expect(roundtrip.errors).toEqual([])
  expect(roundtrip.data!.tables.pipelineRuns).toEqual(restored.pipelineRuns)
})

it.each(['unknown-source', 'unknown-target', 'foreign-book'])('备份拒绝 %s，不能借修复抹掉非法引用', async damage => {
  const { relation, snapshot } = await setup()
  const data = await snapshot(), row = data.tables.characterRelations[0]
  if (damage === 'unknown-source') row.originCharacterId = 'unknown'
  else if (damage === 'unknown-target') row.targetIds = ['unknown']
  else row.bookId = 'other-book'
  await expect(encodeBackup(data)).rejects.toThrow('备份资料校验失败')
  expect(data.tables.characterRelations[0].id).toBe(relation.id)
})

it('明确反向与对称称呼保持原样；旧编号与另一个称呼来源可独立移除', () => {
  const base = { target: '乙', relation_type: 'parent_child', relation_label: '父亲', direction: 'directed' }
  expect(legacyRelationLabels({ ...base, reverse_label: '女儿' })).toMatchObject({ reverseLabel: '女儿', direction: 'directed' })
  expect(legacyRelationLabels({ ...base, relation_label: '朋友', direction: 'bidirectional' })).toMatchObject({ reverseLabel: '朋友', direction: 'bidirectional' })
  expect(legacyRelationLabels({ ...base, relation_label: '女儿' })).toMatchObject({ reverseLabel: '父母', direction: 'directed' })
  expect(legacyRelationLabels({ ...base, relation_label: 'constructor' })).toMatchObject({ reverseLabel: 'constructor', direction: 'unspecified' })
  const person: Character = { id: 'P1', bookId: 'a', name: '沈青', aliases: ['老沈'], revision: 1, confidence: 1, createdBy: 'P1' }
  const node = bindNodeCharacters({ id: 'N1', bookId: 'a', actors: ['沈青', '老沈'], legacyActorIds: ['P1'] } as EventNode, [person])
  const kept = setNodeParticipants(node, [person], [], ['老沈'])
  expect(kept.legacyActorIds).toEqual([])
  expect(kept.actorIds).toEqual(['P1'])
  expect(kept.actorBindings).toEqual([{ mention: '老沈', ids: ['P1'] }])
})
