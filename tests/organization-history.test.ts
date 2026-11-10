import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { readExecutionChain, readOrganizationRequests, readOrganizationStepIndex } from '../src/features/agents/trace'
import { applyOrganizationTool } from '../src/features/agents/organizationCommands'
import { createMemoryAgentRepository } from '../src/features/agents/repository'
import type { Scope } from '../src/features/agents/queries'

const opened: ReturnType<typeof createWorkspace>[] = []
const setup = async () => {
  const id = crypto.randomUUID(), workspace = createWorkspace({ settingsName: `trace-${id}`, bookPrefix: `trace-book-${id}-` }); opened.push(workspace)
  const db = workspace.openBook('a')
  return { workspace, db }
}
afterEach(async () => { for (const workspace of opened.splice(0)) { workspace.close(); for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name) } })

const item = (id: string, status = 'checked') => ({ id, name: `人物${id}`, status, outcome: status === 'checked' ? 'no_change' : null, reason: '', contentFingerprint: '', readRefs: [], commitIds: [] })
const message = (id: string, ordinal: number, unitId: string, role: string, content: unknown, extra: Record<string, unknown> = {}) => ({ id, bookId: 'a', sessionId: 'session:1', type: 'message', ordinal, unitId, message: { role, content, timestamp: ordinal, ...extra } })
const trace = (runId: string, requestId: string, unitId: string, startedAt: string, contextId = 'profiles') => ({ id: `entry:${requestId}`, bookId: 'a', runId, requestId, type: 'request_trace', contextId, unitId, startedAt, status: 'succeeded', input: { messages: [] }, toolCalls: [], usage: { input: 1, output: 1, totalTokens: 2 } })
const run = (organization: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: 'run:1', bookId: 'a', recordType: 'run', stage: 'P2', phase: 'character_organization', workflow: 'character_organization_v1', status: 'completed', startedAt: '2026-11-08T00:00:00.000Z', finishedAt: '2026-11-08T00:10:00.000Z', organization, report: { assetEdits: [] }, ...extra })

it('第二步索引展示所有人物，不依赖最近请求页', async () => {
  const { workspace, db } = await setup()
  const items = Array.from({ length: 138 }, (_, index) => item(`P${String(index + 1).padStart(3, '0')}`))
  await db.table('pipelineRuns').put(run({ version: 1, step: 'done', revision: 1, mode: 'full', scanPages: [], candidateGroups: [], candidateDecisions: [], profileItems: items, relationItems: [], pairChecks: [], statisticsPending: false }))
  for (let index = 1; index <= 60; index++) await db.table('storySessionEntries').put(trace('run:1', `r${index}`, `profile:P${String(index).padStart(3, '0')}`, `2026-11-08T00:${String(index).padStart(2, '0')}:00.000Z`))
  const index = await readOrganizationStepIndex(workspace, 'a', 'profiles')
  expect(index).toHaveLength(138)
  expect(index.some(row => row.objectKey === 'profile:P001')).toBe(true)
  expect(index.some(row => row.objectKey === 'profile:P138')).toBe(true)
})

it('对象请求使用稳定游标，新请求不改变更早页', async () => {
  const { workspace, db } = await setup()
  const organization = { version: 1, step: 'done', revision: 1, mode: 'full', scanPages: [], candidateGroups: [], candidateDecisions: [], profileItems: [item('P001')], relationItems: [], pairChecks: [], statisticsPending: false }
  await db.table('pipelineRuns').put(run(organization))
  for (let index = 1; index <= 60; index++) await db.table('storySessionEntries').put(trace('run:1', `r${index}`, 'profile:P001', `2026-11-08T00:${String(index).padStart(2, '0')}:00.000Z`))
  const first = await readOrganizationRequests(workspace, 'a', { runId: 'run:1', step: 'profiles', objectKey: 'profile:P001', limit: 50 })
  expect(first.requests).toHaveLength(50)
  expect(first.hasEarlier).toBe(true)
  expect(first.nextBefore).toEqual({ startedAt: '2026-11-08T00:11:00.000Z', requestId: 'r11' })
  await db.table('storySessionEntries').put(trace('run:1', 'r61', 'profile:P001', '2026-11-08T00:61:00.000Z'))
  const older = await readOrganizationRequests(workspace, 'a', { runId: 'run:1', step: 'profiles', objectKey: 'profile:P001', before: first.nextBefore, limit: 50 })
  expect(older.requests.map(row => row.requestId)).toEqual(Array.from({ length: 10 }, (_, index) => `r${index + 1}`))
  expect(older.requests.some(row => first.requests.some(current => current.requestId === row.requestId))).toBe(false)
  expect(older.hasEarlier).toBe(false)
})

it('单人物运行的临时候选请求仍归当前人物对象', async () => {
  const { workspace, db } = await setup()
  const organization = { version: 1, step: 'done', revision: 1, mode: 'profile', targetCharacterId: 'P001', scanPages: [], candidateGroups: [{ id: 'g1', memberIds: ['P001', 'P002'], reason: '', status: 'resolved', revision: 2, createdAt: '', updatedAt: '', originStep: 'profiles' }], candidateDecisions: [{ groupId: 'g1', memberIds: ['P001', 'P002'], memberNames: ['甲', '乙'], outcome: 'merged', reason: '', basis: [], commitIds: [], createdAt: '', originStep: 'profiles' }], profileItems: [item('P001')], relationItems: [], pairChecks: [], statisticsPending: false }
  await db.table('pipelineRuns').put(run(organization, { scope: 'character' }))
  await db.table('storySessionEntries').bulkPut([
    trace('run:1', 'r1', 'profile:P001', '2026-11-08T00:01:00.000Z'),
    trace('run:1', 'r2', 'candidate:g1', '2026-11-08T00:02:00.000Z'),
  ])
  const index = await readOrganizationStepIndex(workspace, 'a', 'profiles')
  expect(index.some(row => row.objectKey === 'profile:P001')).toBe(true)
  expect(index.some(row => row.objectKey === 'candidate:g1')).toBe(false)
  const requests = await readOrganizationRequests(workspace, 'a', { runId: 'run:1', step: 'profiles', objectKey: 'profile:P001' })
  expect(requests.requests.map(row => row.requestId)).toEqual(['r1', 'r2'])
})

it('完整运行的后续候选按来源步骤归属，不按 candidate 前缀进入第一步', async () => {
  const { workspace, db } = await setup()
  const organization = { version: 1, step: 'done', revision: 1, mode: 'full', scanPages: [], candidateGroups: [{ id: 'g1', memberIds: ['P001', 'P002'], reason: '', status: 'resolved', revision: 1, createdAt: '', updatedAt: '', originStep: 'profiles' }], candidateDecisions: [], profileItems: [item('P001')], relationItems: [], pairChecks: [], statisticsPending: false }
  await db.table('pipelineRuns').put(run(organization))
  await db.table('storySessionEntries').put(trace('run:1', 'r1', 'candidate:g1', '2026-11-08T00:01:00.000Z'))
  const scan = await readOrganizationStepIndex(workspace, 'a', 'scan')
  const profiles = await readOrganizationStepIndex(workspace, 'a', 'profiles')
  expect(scan.some(row => row.objectKey === 'candidate:g1')).toBe(false)
  expect(profiles.some(row => row.objectKey === 'candidate:g1')).toBe(true)
})

it('旧运行没有请求明细时保留对象索引并标记无明细', async () => {
  const { workspace, db } = await setup()
  const organization = { version: 1, step: 'done', revision: 1, scanPages: [{ pageId: 'scan:0', ids: ['P001'], nextCursor: null, status: 'checked' }], candidateGroups: [], candidateDecisions: [], profileItems: [item('P001')], relationItems: [], pairChecks: [], statisticsPending: false }
  await db.table('pipelineRuns').put(run(organization))
  const scan = await readOrganizationStepIndex(workspace, 'a', 'scan')
  const profiles = await readOrganizationStepIndex(workspace, 'a', 'profiles')
  expect(scan.find(row => row.objectKey === 'directory:scan:0')?.hasTrace).toBe(false)
  expect(profiles.find(row => row.objectKey === 'profile:P001')?.hasTrace).toBe(false)
})

it('保存疑似组时写入当前工作项来源步骤', async () => {
  const repo = createMemoryAgentRepository('a', {
    characters: [{ id: 'P001', bookId: 'a', name: '甲', revision: 1 }, { id: 'P002', bookId: 'a', name: '乙', revision: 1 }],
    pipelineRuns: [{ id: 'run:1', bookId: 'a', recordType: 'run', status: 'running', organization: { version: 1, step: 'profiles', revision: 1, mode: 'profile', scanPages: [], candidateGroups: [], candidateDecisions: [], profileItems: [], relationItems: [], pairChecks: [], statisticsPending: false } }],
  })
  const scope: Scope = { bookId: 'a', profile: 'asset_editor', phase: 'character_organization', runId: 'run:1', taskId: 'task', owner: 'owner', workItemIds: [], organizationStep: 'profiles' }
  await repo.transaction(true, store => applyOrganizationTool(store, scope, 'save_candidate_group', { memberIds: ['P001', 'P002'], reason: '疑似同人' }, { queries: [], records: [{ table: 'characters', id: 'P001', resolvedId: 'P001', revision: 1, factFingerprint: 'x' }, { table: 'characters', id: 'P002', resolvedId: 'P002', revision: 1, factFingerprint: 'x' }] }, 'commit', '2026-11-08T00:00:00.000Z'))
  const run = await repo.transaction(false, store => store.get('pipelineRuns', 'run:1'))
  const organization = (run?.organization ?? {}) as { candidateGroups: Array<{ originStep?: string }> }
  expect(organization.candidateGroups[0]).toMatchObject({ originStep: 'profiles' })
})

it('执行链按工作项隔离，并包含最后 toolResult', async () => {
  const { workspace, db } = await setup()
  await db.table('pipelineRuns').put({ ...run({ version: 1, step: 'done', revision: 1 }, { sessionId: 'session:1' }), id: 'run:1' })
  await db.table('storySessionEntries').bulkPut([
    message('s', 1, 'profile:P001', 'system', 'system'),
    message('u', 2, 'profile:P001', 'user', 'task'),
    message('a', 3, 'profile:P001', 'assistant', [{ type: 'toolCall', id: 'c1', name: 'submit_profile_review', arguments: {} }]),
    message('t', 4, 'profile:P001', 'toolResult', [{ type: 'text', text: 'saved' }], { toolCallId: 'c1', toolName: 'submit_profile_review', isError: false }),
    message('other', 5, 'relations:P002', 'user', 'other unit'),
  ])
  const chain = await readExecutionChain(workspace, 'a', 'run:1', { unitId: 'profile:P001' })
  expect(chain.entries.map(entry => entry.id)).toEqual(['s', 'u', 'a', 't'])
  expect(chain.entries.at(-1)?.message).toMatchObject({ role: 'toolResult', toolCallId: 'c1' })
})
