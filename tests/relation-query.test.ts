import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { readTool, toolBytes, type Scope } from '../src/features/agents/queries'
import { relationWork } from '../src/features/agents/organizationData'
import { createBookAgentRepository } from '../src/features/agents/repository'
import { applyOrganizationTool } from '../src/features/agents/organizationCommands'
import type { Character } from '../src/features/assets/types'

const opened: ReturnType<typeof createWorkspace>[] = []
const sourceId = 'C1-P001'
const targetIds = Array.from({ length: 44 }, (_, index) => `C1-P${String(index + 2).padStart(3, '0')}`)
const person = (id: string, name: string, identity: string): Character => ({ id, bookId: 'a', name, aliases: [], identity, confidence: 1, revision: 1, createdBy: 'P1', chapterIndex: '1', chapterName: '第1章' })
const scope: Scope = { bookId: 'a', profile: 'asset_editor', phase: 'character_organization', runId: 'run-relations', taskId: 'task-relations', owner: 'owner-relations', workItemIds: [] }

afterEach(async () => {
  for (const workspace of opened.splice(0)) {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name)
  }
})

async function setup() {
  const id = crypto.randomUUID()
  const workspace = createWorkspace({ settingsName: `relation-query-${id}`, bookPrefix: `relation-query-book-${id}-` })
  opened.push(workspace)
  await workspace.settings.books.put({ id: 'a', title: '关系查询样本', sourceFileName: 'relations.txt', createdAt: new Date().toISOString() })
  const db = workspace.openBook('a')
  const people = [person(sourceId, '沈青', '青石渡船夫'), ...targetIds.map((targetId, index) => person(targetId, `人物${String(index + 2).padStart(2, '0')}`, index === 0 ? `第${index + 2}位同乡，${'常年在外跑船并照应乡邻。'.repeat(8)}` : `第${index + 2}位同乡，常年在青石渡活动`))]
  await db.table('characters').bulkPut(people)
  const chapterText = targetIds.map((_, index) => [1, 2, 3].map(step => `第${index + 2}位同乡的证据${step}：${'原文'.repeat(80)}`).join('\n')).join('\n')
  await db.chapters.put({ bookId: 'a', chapterIndex: '1', chapterName: '第1章', order: 0, charCount: chapterText.length })
  await db.table('chapterTexts').put({ bookId: 'a', chapterIndex: '1', text: chapterText })
  const now = new Date().toISOString()
  await db.table('characterRelations').bulkPut([
    ...targetIds.map((targetId, index) => ({
      id: `R-${targetId}`, bookId: 'a', originCharacterId: sourceId, sourceName: '沈青',
      targetName: `人物${String(index + 2).padStart(2, '0')}`, relationType: '朋友', forwardLabel: '朋友', reverseLabel: '朋友',
      direction: 'bidirectional',
      evidence: [1, 2, 3].map(step => ({ chapterIndex: '1', quote: `第${index + 2}位同乡的证据${step}：${'原文'.repeat(80)}` })),
      sourceId, targetIds: [targetId], revision: 1, createdAt: now, updatedAt: now,
    })),
    { id: 'U-1', bookId: 'a', originCharacterId: sourceId, sourceName: '沈青', targetName: '未绑定人物', relationType: '朋友', forwardLabel: '朋友', reverseLabel: '未知', direction: 'unspecified', evidence: [{ chapterIndex: '1', quote: '未解析依据' }], sourceId, targetIds: [], revision: 1, createdAt: now, updatedAt: now },
  ])
  await db.table('pipelineRuns').put({
    id: scope.runId, bookId: 'a', workflow: 'character_organization_v1', status: 'running', report: { assetEdits: [] },
    organization: {
      step: 'relations', revision: 1, pairChecks: [],
      relationItems: [{ id: sourceId, name: '沈青', status: 'pending', outcome: null, reason: '', commitIds: [] }],
      activeWork: { kind: 'relations', id: `relations:${sourceId}`, characterId: sourceId, targetIds: [sourceId], commitIds: [] },
    },
  })
  const repo = createBookAgentRepository(workspace, 'a')
  return { db, repo }
}

it('关系工作项初始数据为全部关系的精简概览且不含证据原文', async () => {
  const { repo } = await setup()
  const overview = await repo.transaction(false, store => relationWork(store, sourceId, [], true))
  expect(overview?.relations).toHaveLength(44)
  expect(toolBytes(overview)).toBeLessThan(65536)
  for (const relation of overview!.relations) {
    expect(relation).not.toHaveProperty('evidence')
    expect(relation).not.toHaveProperty('pairKey')
    expect(String(relation.identity).length).toBeLessThanOrEqual(50)
    expect(relation.forward).toContain('朋友')
    expect(relation.fingerprint).toBeTruthy()
  }
  expect(overview!.unlinkedRelations).toEqual([{ sourceName: '沈青', targetName: '未绑定人物', forward: '朋友', reverse: '未知', direction: 'unspecified' }])
  const long = overview!.relations.find(relation => relation.targetId === targetIds[0])!
  expect(String(long.identity)).toHaveLength(50)
})

it('关系查询默认返回精简分页数据，支持目标、字段和按需证据', async () => {
  const { repo } = await setup()
  const first = await repo.transaction(true, store => readTool(store, scope, 'query_relation_work', { characterId: sourceId, limit: 20 }))
  const page = first.data as Record<string, unknown> & { relations: Record<string, unknown>[]; nextCursor: string | null }
  expect(page.relations).toHaveLength(20)
  expect(page.total).toBe(44)
  expect(page.nextCursor).toBe('20')
  expect(page.relations[0]).not.toHaveProperty('evidence')
  expect(toolBytes(first)).toBeLessThan(65536)

  const second = await repo.transaction(true, store => readTool(store, scope, 'query_relation_work', { characterId: sourceId, cursor: '20', limit: 20 }))
  expect((second.data as { relations: unknown[] }).relations).toHaveLength(20)
  expect((second.data as { nextCursor: string | null }).nextCursor).toBe('40')
  expect((second.data as { relations: Record<string, unknown>[] }).relations[0].targetId).not.toBe(page.relations[0].targetId)

  const selected = await repo.transaction(true, store => readTool(store, scope, 'query_relation_work', { characterId: sourceId, targetIds: [targetIds[3], targetIds[7]], fields: ['targetId', 'forward'] }))
  const rows = (selected.data as { relations: Record<string, unknown>[] }).relations
  expect(rows).toHaveLength(2)
  expect(rows.map(row => row.targetId).sort()).toEqual([targetIds[3], targetIds[7]].sort())
  expect(Object.keys(rows[0])).toEqual(['targetId', 'forward'])

  const single = await repo.transaction(true, store => readTool(store, scope, 'query_relation_work', { characterId: sourceId, targetIds: [targetIds[1]], fields: ['targetName'] }))
  expect(Object.keys((single.data as { relations: Record<string, unknown>[] }).relations[0])).toEqual(['targetName'])

  const evidence = await repo.transaction(true, store => readTool(store, scope, 'query_relation_work', { characterId: sourceId, targetIds: [targetIds[0]], fields: ['targetId', 'evidence'], evidenceLimit: 2 }))
  const evidencePage = evidence.data as { relations: Record<string, unknown>[]; nextEvidenceCursor: string | null }
  const evidenceRow = evidencePage.relations[0]
  expect(evidenceRow.targetId).toBe(targetIds[0])
  expect((evidenceRow.evidence as unknown[]).length).toBe(2)
  expect(evidenceRow.evidenceTruncated).toBe(true)
  expect(evidencePage.nextEvidenceCursor).toBe('2')

  const evidenceNext = await repo.transaction(true, store => readTool(store, scope, 'query_relation_work', { characterId: sourceId, targetIds: [targetIds[0]], fields: ['targetId', 'evidence'], evidenceLimit: 2, evidenceCursor: '2' }))
  const nextPage = evidenceNext.data as { relations: Record<string, unknown>[]; nextEvidenceCursor: string | null }
  expect((nextPage.relations[0].evidence as unknown[]).length).toBe(1)
  expect(nextPage.relations[0].evidenceTruncated).toBeUndefined()
  expect(nextPage.nextEvidenceCursor).toBeNull()

  const bounded = await repo.transaction(true, store => readTool(store, scope, 'query_relation_work', { characterId: sourceId, targetIds, limit: 100, fields: ['targetId', 'evidence'], evidenceLimit: 3 }))
  expect(toolBytes(bounded)).toBeLessThan(65536)
  expect((bounded.data as { relations: Record<string, unknown>[] }).relations.some(row => row.evidenceOmitted)).toBe(true)

  await expect(repo.transaction(true, store => readTool(store, scope, 'query_relation_work', { characterId: sourceId, fields: ['evidence'] }))).rejects.toThrow('targetIds')

  const missing = await repo.transaction(true, store => readTool(store, scope, 'query_relation_work', { characterId: sourceId, targetIds: ['C1-P999'] }))
  expect((missing.data as { missingTargetIds: string[] }).missingTargetIds).toEqual(['C1-P999'])
})

it('一次提交44组已确认关系修改可在同一事务内全部写入', async () => {
  const { db, repo } = await setup()
  const changes = targetIds.map((targetId, index) => ({ targetId, action: 'set', forwardLabels: ['朋友', '同乡'], reverseLabels: ['朋友', '同乡'], reason: '原文确认同乡关系', evidence: [{ chapterIndex: '1', quote: `第${index + 2}位同乡的证据1：${'原文'.repeat(80)}` }] }))
  const readSet = { records: [], queries: [{ tool: 'read_original', args: { chapter_indices: ['1'] }, resultFingerprint: 'fixture' }] }
  const result = await repo.transaction(true, store => applyOrganizationTool(store, scope, 'submit_relation_review', { changes, done: true, reason: '批量确认同乡关系' }, readSet, 'commit-batch-44', new Date().toISOString()))
  expect(result).toMatchObject({ changed: true, done: true, complete: true, outcome: 'changed' })
  const stored = await db.table('characterRelationEdits').toArray() as { evidence?: unknown[] }[]
  expect(stored).toHaveLength(44)
  expect(stored.every(row => (row.evidence?.length ?? 0) > 0)).toBe(true)
  const run = await db.table('pipelineRuns').get(scope.runId) as Record<string, unknown>
  expect(run.organization).toMatchObject({ activeWork: null })
  const records = ((run.report as Record<string, unknown>).assetEdits as { writeSeq?: number }[])
  expect(records.map(row => row.writeSeq)).toEqual(Array.from({ length: 44 }, (_, index) => index + 1))
})

it('批量提交遇到不存在的目标时隔离失败项，合法组仍写入', async () => {
  const { db, repo } = await setup()
  const changes = targetIds.map((targetId, index) => ({ targetId, action: 'set', forwardLabels: ['朋友', '同乡'], reverseLabels: ['朋友', '同乡'], reason: '原文确认同乡关系', evidence: [{ chapterIndex: '1', quote: `第${index + 2}位同乡的证据1：${'原文'.repeat(80)}` }] }))
  changes.push({ targetId: 'C1-P999', action: 'set', forwardLabels: ['朋友'], reverseLabels: ['朋友'], reason: '不存在的人物', evidence: [{ chapterIndex: '1', quote: `第2位同乡的证据1：${'原文'.repeat(80)}` }] })
  const readSet = { records: [], queries: [{ tool: 'read_original', args: { chapter_indices: ['1'] }, resultFingerprint: 'fixture' }] }
  const result = await repo.transaction(true, store => applyOrganizationTool(store, scope, 'submit_relation_review', { changes, done: true, reason: '批量确认同乡关系' }, readSet, 'commit-batch-conflict', new Date().toISOString()))
  expect(result).toMatchObject({ changed: true, done: false })
  expect((result as unknown as { failed?: { targetId: string; code: string }[] }).failed?.map(item => ({ targetId: item.targetId, code: item.code }))).toEqual([{ targetId: 'C1-P999', code: 'NOT_FOUND' }])
  expect(await db.table('characterRelationEdits').count()).toBe(targetIds.length)
  const run = await db.table('pipelineRuns').get(scope.runId) as Record<string, unknown>
  expect((run.organization as Record<string, unknown>).activeWork).toBeTruthy()
})
