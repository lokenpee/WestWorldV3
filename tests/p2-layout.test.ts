import 'fake-indexeddb/auto'
import { afterEach, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createWorkspace } from '../src/lib/storage/workspace'
import { completedCharacters, currentCharacter, pruneOrganizationHistory } from '../src/features/agents/p2History'
import { executionStats } from '../src/features/agents/executionStats'
import { projectRequestConversation } from '../src/features/agents/executionChain'
import { ExecutionChainView } from '../src/features/agents/ExecutionChainView'
import { mergeHistoryRecords } from '../src/features/world/mergeHistoryRecords'
import { readOrganizationStepIndex, type OrganizationStepIndexEntry, type ExecutionChain } from '../src/features/agents/trace'
import type { Row } from '../src/features/agents/repository'
import type { WorldRun } from '../src/features/world/types'

const opened: ReturnType<typeof createWorkspace>[] = []
afterEach(async () => { for (const workspace of opened.splice(0)) { await workspace.openBook('b').delete(); await workspace.settings.delete(); workspace.close() } })
const item = (id: string, status = 'checked') => ({ id, name: id, status, outcome: status === 'checked' ? 'no_change' : null, commitIds: [] })
const run = (id: string, startedAt: string, status = 'completed'): Row => ({ id, bookId: 'b', stage: 'P2', status, workflow: 'character_organization_v1', sessionId: `s-${id}`, startedAt, organization: { profileItems: [item('A')], relationItems: [item('A')] }, appliedCommands: [{ commitId: 'saved-business' }], report: { assetEdits: [{ id: 'A', commitId: 'saved-business' }] } })
const entry = (id: string, runId: string, unitId: string, type = 'request_trace', extra: Row = {}): Row => ({ id, bookId: 'b', runId, sessionId: `s-${runId}`, unitId, type, final: true, complete: true, ...extra })
async function fixture() {
  const id = crypto.randomUUID(), workspace = createWorkspace({ settingsName: `layout-${id}`, bookPrefix: `layout-${id}-` }); opened.push(workspace)
  const db = workspace.openBook('b')
  await db.table('pipelineRuns').bulkPut([run('old', '2026-01-01'), run('new', '2026-01-02')])
  await db.table('storySessions').put({ id: 's-old', bookId: 'b', leafId: 'old-message', nextOrdinal: 3 })
  await db.table('storySessionEntries').bulkPut([
    entry('old-trace', 'old', 'profile:A', 'request_trace', { input: { systemPromptSnapshotId: 'shared' } }),
    entry('old-message', 'old', 'profile:A', 'message', { parentId: null, message: { role: 'user', content: 'OLD' } }),
    entry('shared', 'old', 'profile:A', 'prompt_snapshot', { content: 'SHARED' }),
    entry('relation-trace', 'old', 'relations:A', 'request_trace', { input: { systemPromptSnapshotId: 'shared' } }),
    entry('other-person', 'old', 'profile:B', 'message', { parentId: 'old-message' }),
    entry('new-trace', 'new', 'profile:A'),
    { ...entry('p3', 'p3', 'profile:A'), sessionId: 'p3-session' },
  ])
  return { workspace, db }
}

it('完成且新日志落库后替换同人物同类型旧日志，保留另一类型/人物/共享快照/业务凭证，并修复父链', async () => {
  const { workspace, db } = await fixture()
  await pruneOrganizationHistory(workspace, 'b')
  expect((await db.table('storySessionEntries').toArray()).map(row => row.id).sort()).toEqual(['new-trace', 'other-person', 'p3', 'relation-trace', 'shared'])
  expect((await db.table('storySessionEntries').get('other-person')).parentId).toBeNull()
  expect((await db.table('storySessions').get('s-old')).leafId).toBeUndefined()
  expect((await db.table('pipelineRuns').get('old')).appliedCommands).toEqual([{ commitId: 'saved-business' }])
  const before = await db.table('storySessionEntries').toArray()
  await pruneOrganizationHistory(workspace, 'b')
  expect(await db.table('storySessionEntries').toArray()).toEqual(before)
})

it.each(['paused', 'failed'])('新人物未完成且任务%s时保留旧完成详情及新续跑记录', async status => {
  const { workspace, db } = await fixture()
  const next = await db.table('pipelineRuns').get('new')
  await db.table('pipelineRuns').put({ ...next, status, organization: { ...next.organization, profileItems: [item('A', 'pending')] } })
  await pruneOrganizationHistory(workspace, 'b')
  expect(await db.table('storySessionEntries').get('old-trace')).toBeDefined()
  expect(await db.table('storySessionEntries').get('new-trace')).toBeDefined()
})

it.each(['missing', 'partial', 'unflushed', 'active-old'])('新链路%s时不删除旧完成内容', async condition => {
  const { workspace, db } = await fixture()
  if (condition === 'missing') await db.table('storySessionEntries').delete('new-trace')
  if (condition === 'partial') await db.table('storySessionEntries').update('new-trace', { complete: false })
  if (condition === 'unflushed') await db.table('storySessionEntries').put(entry('new-pending', 'new', 'profile:A', 'request_trace', { final: false }))
  if (condition === 'active-old') await db.table('storySessions').update('s-old', { leaseOwner: 'other-owner', leaseUntil: Date.now() + 60000 })
  await pruneOrganizationHistory(workspace, 'b')
  expect(await db.table('storySessionEntries').get('old-trace')).toBeDefined()
  if (condition !== 'active-old') {
    const list = completedCharacters(await readOrganizationStepIndex(workspace, 'b', 'profiles'))
    expect(list.find(row => row.characterId === 'A')?.runId).toBe('old')
  }
})

it('历史已完成人物跨轮去重，未完成不进入搜索；当前人物独立保留', () => {
  const index = (runId: string, time: string, step: string, status: string) => ({ runId, runStartedAt: time, step, characterId: 'A', label: '甲（A）', status, outcome: 'no_change' }) as OrganizationStepIndexEntry
  const list = completedCharacters([index('old', '1', 'profiles', 'checked'), index('new', '2', 'profiles', 'checked'), index('running', '3', 'profiles', 'pending'), index('relations', '1', 'relations', 'checked')])
  expect(list.map(row => row.runId).sort()).toEqual(['new', 'relations'])
  const active = { ...run('r', '3', 'running'), organization: { profileItems: [item('A', 'pending')], relationItems: [], activeWork: { id: 'profile:A', kind: 'profile', characterId: 'A', requestCount: 2 } } } as unknown as WorldRun
  expect(currentCharacter([active])?.objectKey).toBe('profile:A')
})

it('主卡和详情用量按requestId去重，未返回用量保持未知', () => {
  expect(executionStats([{ id: 'r', usage: null }])).toMatchObject({ requests: 1, input: null, output: null, pendingUsage: true })
  expect(executionStats([{ requestId: 'r', usage: { input: 1, output: 2 } }, { requestId: 'r', usage: { input: 10, output: 20 } }])).toMatchObject({ requests: 1, input: 10, output: 20 })
})

it('实际消息保留额外角色与中途系统变更，不强制角色顺序；连续请求不重复前文', () => {
  const initial = [{ role: 'system', content: 'RULE' }, { role: 'developer', content: 'EXTRA' }, { role: 'user', content: 'ASK' }]
  const calls = [{ toolCallId: 'c', name: 'read', arguments: { id: 'A' }, result: { content: [{ type: 'text', text: 'RESULT' }] }, state: 'succeeded' }]
  const chain: ExecutionChain = { entries: [], snapshots: new Map(), requests: [
    { requestId: 'r1', input: { messageFormat: 'provider-request/v1', messages: initial }, toolCalls: calls },
    { requestId: 'r2', input: { messageFormat: 'provider-request/v1', messages: [...initial, { role: 'assistant', content: null, tool_calls: [{ id: 'c', function: { name: 'read', arguments: '{"id":"A"}' } }] }, { role: 'tool', tool_call_id: 'c', content: 'RESULT' }, { role: 'system', content: 'NEW RULE' }] }, text: 'DONE' },
  ] }
  const events = projectRequestConversation(chain)
  expect(events.map(row => row.role)).toEqual(['system', 'developer', 'user', 'assistant', 'toolResult', 'system', 'assistant'])
  expect(events.filter(row => row.content === 'RESULT')).toHaveLength(1)
  const html = renderToStaticMarkup(createElement(ExecutionChainView, { chain, edits: [], folded: true }))
  expect(html).toContain('DEVELOPER')
  expect(html).not.toContain('<pre>')
  expect(html).not.toContain(' open=""')
})

it('自动合并与人工/AI合并分区，队列报告的重复合并不重复展示', () => {
  const group = { kind: 'character', memberIds: ['A', 'B'], keepId: 'A', memberNames: ['甲', '甲'] }
  const rows = mergeHistoryRecords([
    { id: 'manual', stage: 'manual_merge', report: { groups: [{ ...group, method: 'manual' }] } },
    { id: 'queue', mechanicalQueue: { items: [{ commitId: 'manual', confirmation: 'exact_name' }] }, report: { groups: [{ ...group, method: 'mechanical' }] } },
    { id: 'ai', stage: 'P2', report: { groups: [{ ...group, memberIds: ['C', 'D'], keepId: 'C', method: 'ai_identity' }] } },
  ])
  expect(rows).toHaveLength(2)
  expect(rows.find(row => row.keepId === 'A')?.automatic).toBe(true)
  expect(rows.find(row => row.keepId === 'C')?.automatic).toBe(false)
})
