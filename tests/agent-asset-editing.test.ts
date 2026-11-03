import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createAssetService } from '../src/features/assets/service'
import { createBookAgentRepository } from '../src/features/agents/repository'
import { commitCommand, type ReadSet } from '../src/features/agents/commands'
import { readTool, type Scope } from '../src/features/agents/queries'
import { hash } from '../src/features/agents/contracts'
import { emptyReport } from '../src/features/world/types'
import { extractedRelation } from '../src/features/assets/relations'
import type { Character, CharacterRelation, Lifecycle } from '../src/features/assets/types'

const opened: ReturnType<typeof createWorkspace>[] = []
const text = '船夫张三是长女张蕾的父亲。张三暗恋赵六，但赵六并不知情。李沁是张三的妻子。'
async function setup() {
  const prefix = `agent-edit-${crypto.randomUUID()}`
  const workspace = createWorkspace({ settingsName: `${prefix}-settings`, bookPrefix: `${prefix}-book-` }); opened.push(workspace)
  await workspace.settings.books.put({ id: 'a', title: 'AI编辑样本', sourceFileName: 'a.txt', createdAt: '2026-11-03T00:00:00.000Z' })
  const db = workspace.openBook('a')
  await db.chapters.put({ bookId: 'a', chapterIndex: '1', chapterName: '第一章', order: 0, charCount: text.length })
  await db.table('chapterTexts').put({ bookId: 'a', chapterIndex: '1', text })
  const assets = createAssetService(workspace)
  const a = await assets.create('a', 'character', { name: '张三', chapterIndex: '1', identity: '船夫' })
  const b = await assets.create('a', 'character', { name: '张蕾', chapterIndex: '1', identity: '长女' })
  const d = await assets.create('a', 'character', { name: '赵六', manualSourceNote: '过客' })
  const place = await assets.create('a', 'location', { name: '北京城', chapterIndex: '1', description: '西门' })
  const node = await assets.create('a', 'node', { name: '会面', summary: '张三与张蕾会面', chapterIndex: '1', quote: '船夫张三是长女张蕾的父亲。' })
  const line = await assets.create('a', 'eventLine', { title: '信件', nodeIds: [node.id] })
  const chars = await db.table<Character>('characters').toArray()
  const lifecycle = await db.table<Lifecycle>('assetLifecycle').toArray()
  await db.table<CharacterRelation>('characterRelations').put(extractedRelation(a, { target: '张蕾', relationType: 'parent_child', forwardLabel: '父亲', reverseLabel: '女儿', direction: 'directed', chapterIndex: '1', quote: '船夫张三是长女张蕾的父亲' }, chars, lifecycle))
  const runId = 'run', taskId = 'task', owner = 'owner', timestamp = new Date().toISOString()
  await db.table('pipelineRuns').bulkPut([
    { id: runId, recordType: 'run', bookId: 'a', stage: 'P2', phase: 'asset_review', status: 'running', startedAt: timestamp, planVersion: '2.2', report: emptyReport({ characters: 3, locations: 1 }), tasks: [{ taskId, phase: 'asset_review', status: 'running', workItemIds: [], input: { workItems: [] }, readSet: { records: [], queries: [] }, appliedCommitIds: [] }], commandIntents: [], appliedCommands: [], coverageItems: [] },
    { id: 'lease:world', recordType: 'lease', bookId: 'a', lockKey: 'world', owner, runId, expiresAt: Date.now() + 60000 },
  ])
  const repo = createBookAgentRepository(workspace, 'a')
  const scope: Scope = { bookId: 'a', profile: 'asset_editor', phase: 'asset_review', runId, taskId, owner, workItemIds: [] }
  return { workspace, db, assets, repo, scope, a, b, d, place, node, line, runId, taskId, owner }
}
type Fixture = Awaited<ReturnType<typeof setup>>
const readSet = (): ReadSet => ({ records: [], queries: [] })
async function recordRead(fixture: Fixture, set: ReadSet, table: string, id: string) {
  const row = await fixture.repo.transaction(false, store => store.get(table, id))
  set.records.push({ table, id, resolvedId: row ? id : null, revision: Number(row?.revision ?? 0), factFingerprint: await hash(row ?? null) })
}
async function queryRead(fixture: Fixture, set: ReadSet, tool: string, args: Record<string, unknown>) {
  const value = await fixture.repo.transaction(false, store => readTool(store, fixture.scope, tool, args))
  set.queries.push({ tool, args, resultFingerprint: await hash(value) })
  return value
}
async function evidenceRead(fixture: Fixture, set: ReadSet) { await queryRead(fixture, set, 'read_original', { chapter_indices: ['1'] }) }
function editArgs(operationKey: string, id: string, expectedRevision: number, patch: Record<string, unknown>, quote = '船夫张三是长女张蕾的父亲') {
  return { operationKey, id, expectedRevision, patch, reason: '原文依据要求修改', evidence: [{ chapterIndex: '1', quote }] }
}
afterEach(async () => {
  for (const workspace of opened.splice(0)) {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name)
  }
})

describe('P2 资产专用工具', () => {
  it('人物与地点字段补丁落库，未传字段保留，人工层级改由 agent 来源', async () => {
    const fixture = await setup()
    const set = readSet(); await recordRead(fixture, set, 'characters', fixture.a.id); await evidenceRead(fixture, set)
    const result = await commitCommand(fixture.repo, fixture.scope, 'edit_character', 'c1', editArgs('k1', fixture.a.id, 1, { name: '张三丰', identity: '船夫', roleWeight: '主要人物' }), set)
    expect(result).toMatchObject({ ok: true, changed: true, affected: [{ kind: 'character', id: fixture.a.id, revision: 2 }] })
    const row = await fixture.db.table('characters').get(fixture.a.id)
    expect(row).toMatchObject({ name: '张三丰', identity: '船夫', roleWeight: '主要人物', roleWeightSource: 'agent', nameSource: 'automatic', revision: 2 })
    const { updateFrequencies } = await import('../src/features/assets/derive')
    expect(updateFrequencies([row], [{ chapterIndex: '1', text }], true)[0].roleWeightSource).toBe('agent')
    const report = await fixture.db.table('pipelineRuns').get(fixture.runId)
    expect(report.report.assetEdits).toEqual([expect.objectContaining({ tool: 'edit_character', kind: 'character', id: fixture.a.id, actor: 'agent' })])

    const locationSet = readSet(); await recordRead(fixture, locationSet, 'locations', fixture.place.id); await evidenceRead(fixture, locationSet)
    await commitCommand(fixture.repo, fixture.scope, 'edit_location', 'c2', editArgs('k2', fixture.place.id, 1, { description: '东门' }), locationSet)
    expect(await fixture.db.table('locations').get(fixture.place.id)).toMatchObject({ description: '东门', name: '北京城' })
  })

  it('节点与事件线补丁更新派生关联', async () => {
    const fixture = await setup()
    const nodeRevision = Number((await fixture.db.table('nodes').get(fixture.node.id)).revision)
    const set = readSet(); await recordRead(fixture, set, 'nodes', fixture.node.id); await evidenceRead(fixture, set)
    await commitCommand(fixture.repo, fixture.scope, 'edit_event_node', 'n1', editArgs('k3', fixture.node.id, nodeRevision, { summary: '张三与张蕾在码头会面', quote: '', participantIds: [fixture.a.id, fixture.b.id] }), set)
    const node = await fixture.db.table('nodes').get(fixture.node.id)
    expect(node).toMatchObject({ summary: '张三与张蕾在码头会面', quote: '', quoteStatus: 'empty' })
    expect([...node.actorIds].sort()).toEqual([fixture.a.id, fixture.b.id].sort())
    expect(node).not.toHaveProperty('offset')

    const lineSet = readSet(); await recordRead(fixture, lineSet, 'eventLines', fixture.line.id); await evidenceRead(fixture, lineSet)
    await commitCommand(fixture.repo, fixture.scope, 'edit_event_line', 'l1', editArgs('k4', fixture.line.id, 1, { title: '码头会面', lineStatus: 'closed' }), lineSet)
    expect(await fixture.db.table('eventLines').get(fixture.line.id)).toMatchObject({ title: '码头会面', lineStatus: 'closed', nodeIds: [fixture.node.id] })
  })

  it('人物对保存、删除与恢复使用同一核心，并记录前后值', async () => {
    const fixture = await setup()
    const relationArgs = (key: string, fingerprint: string) => ({ operationKey: key, fromId: fixture.a.id, toId: fixture.b.id, expectedFingerprint: fingerprint, forwardLabels: ['师父'], reverseLabels: ['徒弟'], directionUnclear: false, reason: '原文确认师徒', evidence: [{ chapterIndex: '1', quote: '船夫张三是长女张蕾的父亲' }] })
    const set = readSet()
    await recordRead(fixture, set, 'characters', fixture.a.id); await recordRead(fixture, set, 'characters', fixture.b.id)
    const pair = await queryRead(fixture, set, 'get_character_relation', { fromId: fixture.a.id, toId: fixture.b.id }) as { data: { fingerprint: string } }
    await evidenceRead(fixture, set)
    const saved = await commitCommand(fixture.repo, fixture.scope, 'set_character_relation', 'r1', relationArgs('rk1', pair.data.fingerprint), set)
    expect(saved).toMatchObject({ ok: true, changed: true, pair: { state: 'active' } })
    expect(await fixture.assets.getRelationPair('a', fixture.a.id, fixture.b.id)).toMatchObject({ forwardLabels: ['师父'], reverseLabels: ['徒弟'] })

    const deleteSet = readSet()
    await recordRead(fixture, deleteSet, 'characters', fixture.a.id); await recordRead(fixture, deleteSet, 'characters', fixture.b.id)
    const activePair = await queryRead(fixture, deleteSet, 'get_character_relation', { fromId: fixture.a.id, toId: fixture.b.id }) as { data: { fingerprint: string } }
    await evidenceRead(fixture, deleteSet)
    const deleted = await commitCommand(fixture.repo, fixture.scope, 'delete_character_relation', 'r2', { operationKey: 'rk2', fromId: fixture.a.id, toId: fixture.b.id, expectedFingerprint: activePair.data.fingerprint, reason: '原文不支持师徒', evidence: [{ chapterIndex: '1', quote: '李沁是张三的妻子' }] }, deleteSet)
    expect(deleted).toMatchObject({ changed: true, pair: { state: 'deleted' } })
    expect(await fixture.assets.getRelationPair('a', fixture.a.id, fixture.b.id)).toMatchObject({ state: 'deleted' })
  })

  it('未知字段、过期版本和同键换工具拒绝且不留下部分写入', async () => {
    const fixture = await setup()
    const set = readSet(); await recordRead(fixture, set, 'characters', fixture.a.id); await evidenceRead(fixture, set)
    await expect(commitCommand(fixture.repo, fixture.scope, 'edit_character', 'bad', editArgs('bad-key', fixture.a.id, 1, { unknown: 'x' }), set)).rejects.toThrow('INVALID_ARGS')
    expect(await fixture.db.table('characters').get(fixture.a.id)).toMatchObject({ revision: 1, name: '张三' })
    await expect(commitCommand(fixture.repo, fixture.scope, 'edit_character', 'stale', editArgs('stale-key', fixture.a.id, 99, { identity: '新身份' }), set)).rejects.toThrow('资料已更新')
    const goodSet = readSet(); await recordRead(fixture, goodSet, 'characters', fixture.a.id); await evidenceRead(fixture, goodSet)
    await commitCommand(fixture.repo, fixture.scope, 'edit_character', 'good', editArgs('same-key', fixture.a.id, 1, { identity: '新身份' }), goodSet)
    const staleSet = readSet(); await recordRead(fixture, staleSet, 'characters', fixture.a.id); await evidenceRead(fixture, staleSet)
    await expect(commitCommand(fixture.repo, fixture.scope, 'edit_location', 'other', editArgs('same-key', fixture.place.id, 1, { description: '另一工具' }), staleSet)).rejects.toThrow('IDEMPOTENCY_CONFLICT')
  })
})
