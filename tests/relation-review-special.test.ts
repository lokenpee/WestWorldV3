import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createAssetService } from '../src/features/assets/service'
import { createModelService } from '../src/features/models/service'
import { defaultConfig } from '../src/features/models/types'
import { createWorldService } from '../src/features/world/service'
import { agentStream } from './support/agent-protocol'
import { createLegacyBook, character } from './support/legacy-book'
import { pairKeyOf } from '../src/features/assets/relations'
import { createMemoryAgentRepository } from '../src/features/agents/repository'
import { readTool, type Scope } from '../src/features/agents/queries'
import { commitCommand } from '../src/features/agents/commands'

const opened: ReturnType<typeof createWorkspace>[] = []
const ts = '2026-10-31T00:00:00.000Z'
const text = '张三与张蕾自幼相识。'
afterEach(async () => {
  for (const workspace of opened.splice(0)) {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name)
  }
})
const person = (id: string, name: string) => character(id, name, { bookId: 'a' })
async function setupWorld(seedCharacters: Record<string, unknown>[], relations: Record<string, unknown>[] = [], edits: Record<string, unknown>[] = []) {
  const prefix = `relation-review-${crypto.randomUUID()}`
  const workspace = createWorkspace({ settingsName: `${prefix}-settings`, bookPrefix: `${prefix}-book-` }); opened.push(workspace)
  const scope = workspace.scope
  await createLegacyBook(scope, { bookId: 'a', text, characters: seedCharacters, relations, edits }, 7, true)
  await workspace.settings.books.put({ id: 'a', title: '关系专项', sourceFileName: 'a.txt', createdAt: ts })
  const assets = createAssetService(workspace)
  return { workspace, assets }
}
function fetchForReview(actions: (input: { workItems: { workItemId: string; kind: string; id: string; fromId?: string; toId?: string }[] }, replies: Record<string, unknown>[]) => { name: string; args: unknown }[]) {
  const batches: { workItemId: string; kind: string; id: string }[][] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string)
    const users = body.messages.filter((row: { role: string }) => row.role === 'user').map((row: { content: string | { text: string }[] }) => typeof row.content === 'string' ? row.content : row.content.map((part: { text: string }) => part.text).join(''))
    const input = JSON.parse(users.find((value: string) => value.startsWith('{'))!)
    if (!input.workItems) return agentStream([])
    const replies = body.messages.filter((row: { role: string }) => row.role === 'tool').map((row: { content: string }) => { try { return JSON.parse(row.content) } catch { return {} } })
    if (!replies.length) batches.push(input.workItems)
    return agentStream(actions(input, replies))
  })
  return { fetcher, batches }
}
async function configureModels(workspace: ReturnType<typeof createWorkspace>, fetcher: typeof fetch) {
  const models = createModelService(workspace, { fetch: fetcher })
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://relation-review.invalid/v1', aggregationContextWindow: 65536 }, 'fake-key')
  return models
}

it('B01 人物关系先10项后等待，继续全书处理余项', async () => {
  const characters = Array.from({ length: 12 }, (_, index) => person(`C${index + 1}`, `人物${index + 1}`))
  const current = { id: 'RC', bookId: 'a', originCharacterId: 'C1', sourceName: '人物1', targetName: '人物2', relationType: 'friend', forwardLabel: '朋友', reverseLabel: '朋友', direction: 'bidirectional', evidence: [], sourceId: 'C1', targetIds: ['C2'], revision: 1, createdAt: ts, updatedAt: ts }
  const { workspace, assets } = await setupWorld(characters, [current])
  const { fetcher, batches } = fetchForReview((input, replies) => {
    if (!replies.length) return input.workItems.flatMap(item => {
      const calls: { name: string; args: unknown }[] = []
      if (item.kind === 'relation') calls.push({ name: 'get_character_relation', args: { fromId: item.fromId, toId: item.toId } })
      if (item.kind === 'character_relation_scan') calls.push({ name: 'get_character_detail', args: { ids: [item.id] } })
      if (item.kind === 'legacy_relation') calls.push({ name: 'get_legacy_relation_records', args: { ids: [item.id] } })
      return calls
    }).concat([{ name: 'read_original', args: { chapter_indices: ['1'] } }])
    return [{ name: 'submit_result', args: { status: 'completed', summary: '关系核对', commitIds: [], remainingWorkIds: [], reviewedItems: input.workItems.map(item => ({ workItemId: item.workItemId, outcome: 'no_change', reason: '依据原文核对' })) } }]
  })
  const models = await configureModels(workspace, fetcher)
  const world = createWorldService(workspace, models, assets)
  await world.start('a', { reviewScope: 'relations', reviewMode: 'sample' })
  expect(world.state('a')?.error).toBeUndefined()
  expect(batches).toHaveLength(1)
  expect(batches[0]).toHaveLength(10)
  let report = (await world.reports('a'))[0]
  expect(report).toMatchObject({ reviewScope: 'relations', reviewMode: 'sample', status: 'paused', relationReviewVersion: 1 })
  expect(report.assetReview!.items.filter(item => item.status === 'checked')).toHaveLength(10)
  expect(report.assetReview!.items.filter(item => item.status === 'pending').length).toBe(3)
  batches.length = 0
  await world.continueRelations('a')
  expect(world.state('a')?.error).toBeUndefined()
  expect(batches).toHaveLength(1)
  expect(batches[0]).toHaveLength(3)
  report = (await world.reports('a'))[0]
  expect(report).toMatchObject({ reviewScope: 'relations', reviewMode: 'full', status: 'completed' })
  expect(report.assetReview!.items.every(item => item.status === 'checked')).toBe(true)
}, 30000)

it('B05 专项按原文恢复已删除人物对，只改指定两个编号', async () => {
  const characters = [person('A', '张三'), person('B', '张蕾'), person('C', '张蕾')]
  const edit = { pairKey: pairKeyOf('A', 'B'), bookId: 'a', aId: 'A', bId: 'B', state: 'deleted', aToBLabels: [], bToALabels: [], directionUnclear: false, evidence: [], sourceRelationIds: [], revision: 2, updatedAt: ts, updatedBy: 'manual', commitId: 'manual-delete' }
  const { workspace, assets } = await setupWorld(characters, [], [edit])
  const fingerprint = (await assets.getRelationPair('a', 'A', 'B')).fingerprint
  const { fetcher } = fetchForReview((input, replies) => {
    const scan = input.workItems.find(item => item.kind === 'character_relation_scan' && item.id === 'A')!
    if (!replies.length) return [
      { name: 'get_character_detail', args: { ids: ['A', 'B', 'C'] } },
      { name: 'get_character_relation', args: { fromId: 'A', toId: 'B' } },
      { name: 'read_original', args: { chapter_indices: ['1'] } },
    ]
    const commit = replies.find(row => (row as { commitId?: string }).commitId)
    if (!commit) return [{ name: 'set_character_relation', args: { operationKey: 'restore-1', reviewItemId: scan.workItemId, fromId: 'A', toId: 'B', expectedFingerprint: fingerprint, forwardLabels: ['朋友'], reverseLabels: ['朋友'], directionUnclear: false, reason: '原文明确二人相识', evidence: [{ chapterIndex: '1', quote: '张三与张蕾自幼相识' }] } }]
    return [{ name: 'submit_result', args: { status: 'completed', summary: '恢复关系', commitIds: [(commit as { commitId: string }).commitId], remainingWorkIds: [], reviewedItems: input.workItems.map(item => ({ workItemId: item.workItemId, outcome: item.id === 'A' ? 'changed' : 'no_change', reason: '依据原文核对' })) } }]
  })
  const models = await configureModels(workspace, fetcher)
  const world = createWorldService(workspace, models, assets)
  await world.start('a', { reviewScope: 'relations', reviewMode: 'sample' })
  expect(world.state('a')?.error).toBeUndefined()
  const edits = await workspace.openBook('a').table<Record<string, unknown>>('characterRelationEdits').toArray()
  expect(edits.find(row => row.pairKey === pairKeyOf('A', 'B'))).toMatchObject({ state: 'active', aToBLabels: ['朋友'] })
  expect(edits.some(row => row.pairKey === pairKeyOf('A', 'C'))).toBe(false)
}, 30000)

it('B06 专项命令层拒绝其他写入，给出WRITE_SCOPE_DENIED', async () => {
  const repo = createMemoryAgentRepository('a', { pipelineRuns: [{ id: 'run', bookId: 'a', recordType: 'run', stage: 'P2', status: 'running', startedAt: ts, planVersion: '2.2', tasks: [{ taskId: 'task', phase: 'asset_review', workItemIds: ['w1'], input: { workItems: [{ workItemId: 'w1', kind: 'character_relation_scan', id: 'A' }] } }], commandIntents: [], appliedCommands: [] }, { id: 'lease:world', bookId: 'a', recordType: 'lease', lockKey: 'world', owner: 'o', runId: 'run', expiresAt: Date.now() + 30000 }] })
  const scope: Scope = { bookId: 'a', profile: 'asset_editor', phase: 'asset_review', runId: 'run', taskId: 'task', owner: 'o', workItemIds: ['w1'], reviewScope: 'relations' }
  await expect(commitCommand(repo, scope, 'edit_character', 'call', { operationKey: 'x', id: 'A', expectedRevision: 1, patch: {}, reason: 'x', evidence: [{ chapterIndex: '1', quote: 'x' }] }, { records: [], queries: [] })).rejects.toThrow('WRITE_SCOPE_DENIED')
})

it('B08 旧依据分页超长无损，跨书与坏游标拒绝', async () => {
  const original = { label: '长依据', quote: '甲'.repeat(200000), nested: { list: Array.from({ length: 100 }, (_, index) => `项${index}`) } }
  const row = { id: 'LONG', bookId: 'a', schema: 'legacy-left-right-v1', original, disposition: 'unresolved', pairKeys: [], issues: [], migrationVersion: 1, migratedAt: ts }
  const repo = createMemoryAgentRepository('a', { legacyRelationRecords: [row] })
  const scope: Scope = { bookId: 'a', profile: 'asset_editor', phase: 'asset_review', runId: 'r', taskId: 't', owner: 'o', workItemIds: ['w'], reviewScope: 'relations' }
  let cursor: string | null = null
  let collected = ''
  let fingerprint = ''
  let pages = 0
  do {
    const page = await repo.transaction(false, store => readTool(store, scope, 'get_legacy_relation_records', { ids: ['LONG'], cursor, limit: 50 }))
    expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThanOrEqual(65536)
    if (!fingerprint) fingerprint = String(page.fingerprint); else expect(page.fingerprint).toBe(fingerprint)
    for (const item of page.data as Record<string, unknown>[]) {
      expect(item.original === null || item.fragment).toBeTruthy()
      collected += (item.fragment as { text: string }).text
    }
    cursor = page.nextCursor as string | null
    pages++
  } while (cursor && pages < 100)
  expect(pages).toBeGreaterThan(1)
  expect(JSON.parse(collected)).toEqual(original)
  await expect(repo.transaction(false, store => readTool(store, scope, 'get_legacy_relation_records', { ids: ['MISSING'] }))).rejects.toThrow('NOT_FOUND')
  await expect(repo.transaction(false, store => readTool(store, scope, 'get_legacy_relation_records', { ids: ['LONG'], cursor: 'bad' }))).rejects.toThrow('INVALID_ARGS')
})
