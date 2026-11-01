import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createModelService } from '../src/features/models/service'
import { defaultConfig } from '../src/features/models/types'
import { createMemoryAgentRepository, createBookAgentRepository } from '../src/features/agents/repository'
import { createAgentRuntime } from '../src/features/agents/runtime'
import { createAgentTools } from '../src/features/agents/tools'
import { agentStream, createAgentFixture, scriptedAgentFetcher } from './support/agent-streams'
import { commitCommand, type ReadSet } from '../src/features/agents/commands'
import type { Scope } from '../src/features/agents/queries'
import { emptyTables, tableNames, validateBookData } from '../src/features/backup/data'
import { emptyReport } from '../src/features/world/types'

const opened: ReturnType<typeof createWorkspace>[] = []
async function setup(fetcher: typeof fetch) {
  const id = crypto.randomUUID(); const workspace = createWorkspace({ settingsName: `agents-${id}`, bookPrefix: `agents-${id}-book-` }); opened.push(workspace)
  const models = createModelService(workspace, { fetch: fetcher, wait: async (_ms, signal) => signal.throwIfAborted() })
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://agent-fixture.invalid/v1' }, 'agent-fixture-key')
  return { workspace, models }
}
afterEach(async () => { for (const workspace of opened.splice(0)) { workspace.close(); for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name) } })

it('Pi原生循环完成两套隔离探测，声明全部工具并核对真实提交', async () => {
  const fetcher = scriptedAgentFetcher()
  const { models, workspace } = await setup(fetcher)
  const result = await models.probeTools()
  expect(result).toMatchObject({ ok: true, results: [{ suite: 'asset', ok: true, readCalls: 2, writeCalls: 1, attempts: 3 }, { suite: 'story', ok: true, readCalls: 1, writeCalls: 1, attempts: 3 }] })
  expect(result.results.every(row => row.commitIds.length === 1)).toBe(true)
  expect(fetcher).toHaveBeenCalledTimes(6)
  expect(await workspace.settings.books.count()).toBe(0)
  expect((await Dexie.getDatabaseNames()).filter(name => name.startsWith(workspace.scope.bookPrefix))).toHaveLength(0)
})

async function commandFixture(profile: 'asset_editor' | 'story_editor' = 'asset_editor', originalArgs: Record<string, unknown> = { chapter_range: ['2', '2'] }) {
  const repo = createMemoryAgentRepository('book-a', createAgentFixture('book-a'))
  const scope: Scope = { bookId: repo.bookId, profile, phase: profile === 'asset_editor' ? 'ai_identity' : 'window_link', runId: 'run-a', taskId: 'task-a', owner: 'owner-a', workItemIds: [], probe: true }
  await repo.transaction(true, async store => {
    await store.put('pipelineRuns', { id: scope.runId, bookId: scope.bookId, tasks: [{ taskId: scope.taskId, appliedCommitIds: [], readSet: { records: [], queries: [] } }], commandIntents: [], appliedCommands: [] })
    await store.put('pipelineRuns', { id: 'lease:world', bookId: scope.bookId, owner: scope.owner, runId: scope.runId, expiresAt: Date.now() + 30000 })
  })
  await repo.transaction(true, async store => { for (const row of await store.rows('characters')) await store.put('characters', { ...row, sourceChapters: [row.id === 'C1-P001' ? '1' : '2'] }) })
  const adapter = createAgentTools(repo, scope)
  await adapter.tools.find(tool => tool.name === 'get_character_detail')!.execute('read', { ids: ['C1-P001', 'C2-P001'] })
  await adapter.tools.find(tool => tool.name === 'read_original')!.execute('original', originalArgs)
  const args = { operationKey: 'merge-a', payload: { groups: [{ kind: 'character', keepId: 'C1-P001', memberIds: ['C1-P001', 'C2-P001'], canonicalName: '沈青', reason: '原文明示', confidence: 1, evidence: [{ chapterIndex: '2', quote: '第二章的沈青就是第一章的沈青。', memberIds: ['C1-P001', 'C2-P001'] }] }] } }
  return { repo, scope, adapter, args }
}

async function aliasFixture(detail = true, original = true) {
  const repo = createMemoryAgentRepository('book-a', createAgentFixture('book-a'))
  const scope: Scope = { bookId: repo.bookId, profile: 'asset_editor', phase: 'ai_identity', runId: 'run-a', taskId: 'task-a', owner: 'owner-a', workItemIds: [] }
  const quote = '老沈就是船夫沈青。顾衡是镖师，与沈青不同。'
  await repo.transaction(true, async store => {
    await store.put('pipelineRuns', { id: scope.runId, bookId: scope.bookId, tasks: [{ taskId: scope.taskId, appliedCommitIds: [], readSet: { records: [], queries: [] } }], commandIntents: [], appliedCommands: [], report: emptyReport({ characters: 2, locations: 0 }) })
    await store.put('pipelineRuns', { id: 'lease:world', bookId: scope.bookId, owner: scope.owner, runId: scope.runId, expiresAt: Date.now() + 30000 })
    const person = (await store.get('characters', 'C1-P001'))!
    await store.put('characters', { ...person, aliases: ['老沈', '顾衡'], mergeFacts: [{ id: 'f1', field: 'background', text: '原始底稿', chapters: ['1'] }] })
    const other = (await store.get('characters', 'C2-P001'))!
    await store.put('characters', { ...other, name: '顾衡' })
    await store.put('chapterTexts', { bookId: scope.bookId, chapterIndex: '1', text: quote })
    await store.put('nodes', { id: 'N1', bookId: scope.bookId, actors: ['顾衡'], actorIds: ['C1-P001'] })
  })
  const adapter = createAgentTools(repo, scope)
  await adapter.tools.find(tool => tool.name === (detail ? 'get_character_detail' : 'query_characters'))!.execute('read', detail ? { ids: ['C1-P001', 'C2-P001'] } : {})
  if (original) await adapter.tools.find(tool => tool.name === 'read_original')!.execute('original', { chapter_indices: ['1'] })
  const decisions = [{ alias: '老沈', decision: 'keep', confidence: 1, reason: '原文明示同一船夫', evidence: [{ chapterIndex: '1', quote: '老沈就是船夫沈青。' }] }, { alias: '顾衡', decision: 'remove', confidence: 1, reason: '原文明示另一人', referentId: 'C2-P001', evidence: [{ chapterIndex: '1', quote: '顾衡是镖师，与沈青不同。' }] }]
  const args = { operationKey: 'alias-a', payload: { groups: [], aliasChecks: [{ kind: 'character', id: 'C1-P001', decisions }] } }
  return { repo, scope, adapter, args }
}

it('别名确认与纠正原子保存依据和真实确认，保留底稿并提示可能受影响的节点', async () => {
  const { repo, scope, adapter, args } = await aliasFixture()
  const ack = await commitCommand(repo, scope, 'commit_asset_changes', 'alias', args, adapter.reads)
  expect(await commitCommand(repo, scope, 'commit_asset_changes', 'replay', args, adapter.reads)).toMatchObject({ alreadyApplied: true, commitId: ack.commitId })
  expect(await repo.transaction(false, store => store.get('characters', 'C1-P001'))).toMatchObject({ aliases: ['老沈'], verifiedAliases: ['老沈'], mergeFacts: [{ id: 'f1', text: '原始底稿' }], revision: 2 })
  expect(await repo.transaction(false, store => store.get('nodes', 'N1'))).toMatchObject({ actorIds: ['C1-P001'] })
  const run = await repo.transaction(false, store => store.get('pipelineRuns', scope.runId))
  expect(run?.report).toMatchObject({ aliasChecks: [{ beforeAliases: ['老沈', '顾衡'], afterAliases: ['老沈'], verifiedAliases: ['老沈'], affectedNodeIds: ['N1'], commitId: ack.commitId }] })
  const fresh = createAgentTools(repo, scope)
  await expect(fresh.tools.find(tool => tool.name === 'get_character_detail')!.execute('read', { ids: ['C1-P001'] })).resolves.toBeDefined()
})

it.each(['detail', 'original', 'quote', 'duplicate', 'referent'] as const)('别名校对拒绝缺失或错误的%s依据，并完整回滚', async failure => {
  const { repo, scope, adapter, args } = await aliasFixture(failure !== 'detail', failure !== 'original')
  if (failure === 'quote') args.payload.aliasChecks[0].decisions[1].evidence[0].quote = '顾衡和沈青是同一人。'
  if (failure === 'duplicate') args.payload.aliasChecks[0].decisions.push(args.payload.aliasChecks[0].decisions[0])
  if (failure === 'referent') args.payload.aliasChecks[0].decisions[1].referentId = 'missing'
  await expect(commitCommand(repo, scope, 'commit_asset_changes', 'alias', args, adapter.reads)).rejects.toThrow()
  expect(await repo.transaction(false, store => store.get('characters', 'C1-P001'))).toMatchObject({ aliases: ['老沈', '顾衡'], revision: 1 })
  const run = await repo.transaction(false, store => store.get('pipelineRuns', scope.runId))
  expect((run!.report as { aliasChecks?: unknown[] }).aliasChecks).toBeUndefined()
})
it('同键同内容重放返回原确认，先核凭据再核已被合并的成员', async () => {
  const { repo, scope, adapter, args } = await commandFixture()
  const first = await commitCommand(repo, scope, 'commit_asset_changes', 'write-a', args, adapter.reads)
  const replay = await commitCommand(repo, scope, 'commit_asset_changes', 'write-b', args, adapter.reads)
  expect(replay).toMatchObject({ commitId: first.commitId, alreadyApplied: true })
  const people = await repo.transaction(false, store => store.rows('characters'))
  expect(people).toHaveLength(1); expect(people[0].revision).toBe(2)
  await expect(commitCommand(repo, scope, 'commit_asset_changes', 'write-c', { ...args, payload: { groups: [] } }, adapter.reads)).rejects.toThrow('IDEMPOTENCY_CONFLICT')
})
it('已读版本变化时拒绝写入，多组合并失败时全部回滚', async () => {
  const { repo, scope, adapter, args } = await commandFixture()
  await repo.transaction(true, async store => { const row = (await store.get('characters', 'C1-P001'))!; await store.put('characters', { ...row, revision: 2, identity: '人工修改' }) })
  await expect(commitCommand(repo, scope, 'commit_asset_changes', 'write', args, adapter.reads)).rejects.toThrow('CONFLICT')
  expect(await repo.transaction(false, store => store.rows('characters'))).toHaveLength(2)
  const fixture = await commandFixture()
  const invalid = { operationKey: 'atomic', payload: { groups: [...fixture.args.payload.groups, { ...fixture.args.payload.groups[0], memberIds: ['missing', 'other'] }] } }
  await expect(commitCommand(fixture.repo, fixture.scope, 'commit_asset_changes', 'write', invalid, fixture.adapter.reads)).rejects.toThrow()
  expect(await fixture.repo.transaction(false, store => store.rows('characters'))).toHaveLength(2)
  expect(await fixture.repo.transaction(false, store => store.rows('assetLifecycle'))).toHaveLength(0)
})
it('跨书仓储和参数不能扩展作用域，最终总结不能伪造确认', async () => {
  const { repo, scope, adapter, args } = await commandFixture()
  await expect(commitCommand(repo, { ...scope, bookId: 'book-b' }, 'commit_asset_changes', 'write', args, adapter.reads)).rejects.toThrow('SCOPE')
  await expect(adapter.tools.find(tool => tool.name === 'get_character_detail')!.execute('read', { ids: ['C1-P001'], bookId: 'book-b' })).rejects.toThrow('INVALID_ARGS')
  await expect(adapter.tools.find(tool => tool.name === 'submit_result')!.execute('final', { status: 'completed', commitIds: ['fake'], summary: '伪造', remainingWorkIds: [], reviewedItems: [] })).rejects.toThrow('提交确认')
})
it('负查询结果变化参与冲突校验，回调丢失后重复命令仍只提交一次', async () => {
  const { repo, scope, adapter, args } = await commandFixture()
  const result = await adapter.tools.find(tool => tool.name === 'query_characters')!.execute('query', { name_like: '尚未出现' }).catch(() => undefined)
  // 探针只开放指定读取；生产范围用于查询依赖检查。
  const production = createAgentTools(repo, { ...scope, probe: false })
  await production.tools.find(tool => tool.name === 'query_characters')!.execute('query', { name_like: '尚未出现' })
  const reads: ReadSet = { records: adapter.reads.records, queries: [...adapter.reads.queries, ...production.reads.queries] }
  await repo.transaction(true, store => store.put('characters', { id: 'new-person', bookId: scope.bookId, name: '尚未出现', confidence: 1, revision: 1, createdBy: 'manual' }))
  await expect(commitCommand(repo, scope, 'commit_asset_changes', 'write', args, reads)).rejects.toThrow('CONFLICT')
  expect(result).toBeUndefined()
  const fresh = await commandFixture()
  const lost = createAgentTools(fresh.repo, fresh.scope, { initialReadSet: fresh.adapter.reads, afterCommit: async () => { throw new Error('反馈丢失') } })
  await expect(lost.tools.find(tool => tool.name === 'commit_asset_changes')!.execute('write', fresh.args)).rejects.toThrow('反馈丢失')
  const replay = await commitCommand(fresh.repo, fresh.scope, 'commit_asset_changes', 'replay', fresh.args, fresh.adapter.reads)
  expect(replay.alreadyApplied).toBe(true)
})

it('真实书籍仓储保存Pi消息与提交，另一书使用独立实例，可恢复原会话', async () => {
  const { workspace, models } = await setup(scriptedAgentFetcher())
  const runtime = createAgentRuntime(models.agent)
  for (const bookId of ['a', 'b']) {
    await workspace.settings.books.add({ id: bookId, title: bookId, sourceFileName: `${bookId}.txt`, createdAt: new Date().toISOString() })
    const repo = createBookAgentRepository(workspace, bookId)
    await repo.transaction(true, async store => { for (const [table, rows] of Object.entries(createAgentFixture(bookId))) for (const row of rows) await store.put(table, row) })
    const taskId = crypto.randomUUID(); const operationKey = crypto.randomUUID()
    const outcome = await runtime.run(repo, { profile: 'story_editor', phase: 'window_link', probe: true, workItems: [], input: { suite: 'story', taskId, operationKey }, taskId, prompt: `探针taskId=${taskId}。operationKey=${operationKey}。`, businessPrompt: '工作记忆探测' })
    expect(outcome.ok, outcome.error).toBe(true)
    const entries = await repo.transaction(false, store => store.rows('storySessionEntries'))
    expect(entries.some(row => row.type === 'commit')).toBe(true)
    expect(entries.every(row => row.bookId === bookId && row.sessionId === outcome.sessionId)).toBe(true)
    const tables = emptyTables(); for (const name of tableNames) tables[name] = await workspace.openBook(bookId).table(name).toArray()
    const book = (await workspace.settings.books.get(bookId))!
    expect(await validateBookData({ book, tables })).toEqual([])
  }
})


it('两个正式书籍使用独立Pi实例，重建运行器仍恢复同一会话和原始消息', async () => {
  const { workspace, models } = await setup(scriptedAgentFetcher())
  const runtime = createAgentRuntime(models.agent)
  const sessions = new Map<string, string>()
  async function runBook(bookId: string, engine = runtime) {
    const repo = createBookAgentRepository(workspace, bookId)
    const session = await engine.openSession(repo)
    const runId = crypto.randomUUID(); const taskId = crypto.randomUUID(); const operationKey = crypto.randomUUID()
    const work = { workItemId: 'node:first', kind: 'node', id: 'C1-N001', revision: 1, factFingerprint: 'fixture-node' }
    const savedMemory = await workspace.openBook(bookId).table('storyEditorMemory').get(session.id)
    const input = { bookId, runId, taskId, planVersion: '2.2', remainingCount: 1, resume: { reason: 'initial', appliedCommitIds: [], nextOperationKey: operationKey, remainingWorkIds: [work.workItemId] }, stage: 'P3', phase: 'window_link', sessionId: session.id, queue: 'window_nodes', window: { start: 0, end: 1, chapterIndices: ['1'] }, workItems: [work], existingLines: [], memory: savedMemory ?? { id: session.id, bookId, sessionId: session.id, revision: 0, workingSummary: '', dataFingerprint: '', updatedAt: '' }, afterWorkItemId: null }
    const result = await engine.run(repo, { profile: 'story_editor', phase: 'window_link', workItems: [work], input, runId, taskId, sessionId: session.id, prompt: JSON.stringify({ operationKey, workItemId: work.workItemId, marker: `PRIVATE_BOOK_${bookId}` }), businessPrompt: '核对节点后更新工作记忆，保留节点。' })
    expect(result.ok, result.error).toBe(true)
    if (sessions.has(bookId)) expect(result.sessionId).toBe(sessions.get(bookId))
    sessions.set(bookId, result.sessionId!)
    return repo
  }
  for (const bookId of ['a', 'b']) {
    await workspace.settings.books.add({ id: bookId, title: bookId, sourceFileName: 'sample.txt', createdAt: new Date().toISOString() })
    const db = workspace.openBook(bookId)
    const fixture = createAgentFixture(bookId)
    for (const [name, rows] of Object.entries(fixture)) await db.table(name).bulkPut(rows)
    await db.table('nodes').put({ id: 'C1-N001', bookId, name: '核对样本', summary: '原文样本', actors: [], quote: '', confidence: 1, chapterIndex: '1', chapterName: '第1章', order: 0, revision: 1, createdBy: 'P1' })
    await runBook(bookId)
  }
  expect(runtime.instance('a', 'story_editor')).toBeDefined()
  expect(runtime.instance('a', 'story_editor')).not.toBe(runtime.instance('b', 'story_editor'))
  const original = (await workspace.openBook('a').table('storySessionEntries').toArray()).sort((a, b) => Number(a.ordinal) - Number(b.ordinal))
  const repo = await runBook('a', createAgentRuntime(models.agent))
  const restored = (await repo.transaction(false, store => store.rows('storySessionEntries'))).sort((a, b) => Number(a.ordinal) - Number(b.ordinal))
  expect(restored.length).toBeGreaterThan(original.length)
  expect(restored.slice(0, original.length)).toEqual(original)
  expect(JSON.stringify(restored)).not.toContain('PRIVATE_BOOK_b')
  const tables = emptyTables(); for (const name of tableNames) tables[name] = await workspace.openBook('a').table(name).toArray()
  expect(await validateBookData({ book: (await workspace.settings.books.get('a'))!, tables })).toEqual([])
})

it('混合最终总结与写入批次在副作用前拒绝，普通文本无法冒充成功', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => agentStream([{ name: 'commit_story_changes', args: { operationKey: 'mixed', payload: { event_line_ops: [], new_nodes: [], memory_update: { workingSummary: '不应写入', notes: [] } } } }, { name: 'submit_result', args: { status: 'completed', commitIds: [], summary: '假的成功', remainingWorkIds: [], reviewedItems: [] } }]))
  const { models } = await setup(fetcher)
  const result = await models.probeTools()
  expect(result.ok).toBe(false)
  expect(result.results.every(row => !row.commitIds.length)).toBe(true)
  expect(fetcher.mock.calls.length).toBeLessThanOrEqual(6)
})

it('写入后取消或末轮模型失败仍保留原确认，恢复不重复写入', async () => {
  const fetcher = scriptedAgentFetcher()
  const { models } = await setup(fetcher)
  for (const cancel of [false, true]) {
    const controller = new AbortController()
    const repo = createMemoryAgentRepository(`post-commit-${cancel}`, createAgentFixture(`post-commit-${cancel}`))
    const taskId = crypto.randomUUID(); const operationKey = crypto.randomUUID()
    const engine = createAgentRuntime(models.agent)
    const outcome = await engine.run(repo, { profile: 'story_editor', phase: 'window_link', probe: true, taskId, input: { suite: 'story', taskId, operationKey }, workItems: [], businessPrompt: '记忆探测', prompt: `探针taskId=${taskId}。operationKey=${operationKey}。`, signal: controller.signal, afterCommit: async () => { if (cancel) controller.abort(); throw new Error('模拟提交后反馈丢失') } })
    expect(outcome.ok).toBe(false)
    expect(outcome.commitIds).toHaveLength(1)
    const state = await repo.transaction(false, async store => ({ memory: await store.rows('storyEditorMemory'), run: await store.get('pipelineRuns', outcome.runId) }))
    expect(state.memory[0].revision).toBe(1)
    expect((state.run!.appliedCommands as unknown[]).length).toBe(1)
  }
})


it('同任务可连续提交两组变更，第二组使用第一次提交后的依据', async () => {
  const { repo, scope, adapter, args } = await commandFixture()
  await commitCommand(repo, scope, 'commit_asset_changes', 'first', args, adapter.reads)
  await repo.transaction(true, async store => {
    for (const id of ['C3-P001', 'C4-P001']) await store.put('characters', { id, bookId: scope.bookId, name: '沈青', aliases: [], confidence: 1, revision: 1, createdBy: 'P1' })
  })
  await adapter.tools.find(tool => tool.name === 'get_character_detail')!.execute('next-read', { ids: ['C3-P001', 'C4-P001'] })
  const second = { operationKey: 'second-group', payload: { groups: [{ ...args.payload.groups[0], keepId: 'C3-P001', memberIds: ['C3-P001', 'C4-P001'], evidence: [{ chapterIndex: '2', quote: '第二章的沈青就是第一章的沈青。', memberIds: ['C3-P001', 'C4-P001'] }] }] } }
  const ack = await commitCommand(repo, scope, 'commit_asset_changes', 'second', second, adapter.reads)
  expect(ack.alreadyApplied).toBe(false)
  const people = await repo.transaction(false, store => store.rows('characters'))
  expect(people).toHaveLength(2)
  expect(people.every(row => Number(row.revision) >= 2)).toBe(true)
  expect(people.find(row => row.id === 'C3-P001')?.revision).toBe(2)
})


it('叙事命令原子新增节点和事件线，派生排序与人物关联，并保存工作事项', async () => {
  const bookId = 'story-book'; const repo = createMemoryAgentRepository(bookId, createAgentFixture(bookId))
  const scope: Scope = { bookId, profile: 'story_editor', phase: 'window_link', runId: 'story-run', taskId: 'story-task', sessionId: 'story-session', owner: 'story-owner', workItemIds: [] }
  const now = new Date().toISOString()
  await repo.transaction(true, async store => {
    await store.put('storySessions', { id: scope.sessionId, bookId, profile: 'story_editor', kind: 'initial', title: '叙事', status: 'active', nextOrdinal: 0, createdAt: now, updatedAt: now, leaseOwner: scope.owner, leaseUntil: Date.now() + 30000 })
    await store.put('nodes', { id: 'old-node', bookId, name: '已有节点', summary: '第二章节点', actors: [], quote: '', confidence: 1, chapterIndex: '2', chapterName: '第2章', order: 0, revision: 1, createdBy: 'P1' })
    await store.put('pipelineRuns', { id: scope.runId, bookId, tasks: [{ taskId: scope.taskId, appliedCommitIds: [], readSet: { records: [], queries: [] } }], commandIntents: [], appliedCommands: [] })
    await store.put('pipelineRuns', { id: 'lease:narrative', bookId, owner: scope.owner, runId: scope.runId, expiresAt: Date.now() + 30000 })
  })
  const tools = createAgentTools(repo, scope)
  await tools.tools.find(tool => tool.name === 'get_editor_memory')!.execute('memory', {})
  await tools.tools.find(tool => tool.name === 'get_node_detail')!.execute('nodes', { ids: ['old-node'] })
  const payload = { new_nodes: [{ client_id: 'new-node', chapterIndex: '1', name: '新增节点', summary: '第一章节点', actors: [], quote: '未能定位的参考引文', offset: 999 }], event_line_ops: [{ op: 'create', title: '事件线样本', node_ids: ['old-node', 'new-node'], cause: '起因', process: '经过', result: '结果', line_status: 'open', confidence: 1, reason: '原文依据', evidenceNodeIds: ['old-node'] }], memory_update: { workingSummary: '已串联', notes: [{ key: 'review-one', kind: 'review', status: 'active', statement: '待回查引文', nodeIds: ['new-node'], lineIds: [], evidence: [] }] } }
  await tools.tools.find(tool => tool.name === 'commit_story_changes')!.execute('commit', { operationKey: 'create-story', payload })
  const state = await repo.transaction(false, async store => ({ nodes: await store.rows('nodes'), lines: await store.rows('eventLines'), notes: await store.rows('storyEditorNotes'), memory: await store.rows('storyEditorMemory') }))
  const node = state.nodes.find(row => row.name === '新增节点')!
  expect(node).toMatchObject({ quoteStatus: 'unmatched', confidence: 0.6 })
  expect(node).not.toHaveProperty('offset')
  expect(state.lines[0].nodeIds).toEqual([node.id, 'old-node'])
  expect(state.nodes.every(row => (row.eventLineIds as string[]).includes(state.lines[0].id as string))).toBe(true)
  expect(state.notes[0].nodeIds).toEqual([node.id])
  expect(state.memory[0].revision).toBe(1)
  const tables = emptyTables(); for (const name of tableNames) tables[name] = await repo.transaction(false, store => store.rows(name))
  tables.pipelineRuns = []
  expect(await validateBookData({ book: { id: bookId, title: '叙事样本', sourceFileName: 'sample.txt', createdAt: now }, tables })).toEqual([])
})


it('补充节点按原文定位排序，换命令键重放相同成员创建也保持一条线', async () => {
  const bookId = 'dedup-story'; const repo = createMemoryAgentRepository(bookId, createAgentFixture(bookId))
  const scope: Scope = { bookId, profile: 'story_editor', phase: 'window_link', runId: 'run', taskId: 'task', owner: 'owner', workItemIds: [] }
  await repo.transaction(true, async store => {
    await store.put('pipelineRuns', { id: 'run', bookId, tasks: [{ taskId: 'task', appliedCommitIds: [], readSet: { records: [], queries: [] } }], commandIntents: [], appliedCommands: [] })
    await store.put('pipelineRuns', { id: 'lease:narrative', bookId, owner: 'owner', runId: 'run', expiresAt: Date.now() + 30000 })
    await store.put('chapterTexts', { bookId, chapterIndex: '1', text: '先发生。后发生。' })
    await store.put('nodes', { id: 'late', bookId, name: '后发生', summary: '后发生', actors: [], quote: '后发生。', offset: 4, chapterIndex: '1', chapterName: '第1章', order: 0, confidence: 1, revision: 1, createdBy: 'P1', eventLineIds: [] })
  })
  const tools = createAgentTools(repo, scope)
  await tools.tools.find(tool => tool.name === 'get_editor_memory')!.execute('memory', {})
  await tools.tools.find(tool => tool.name === 'get_node_detail')!.execute('node', { ids: ['late'] })
  const payload = { new_nodes: [{ client_id: 'early', chapterIndex: '1', name: '先发生', summary: '先发生', actors: [], quote: '先发生。' }], event_line_ops: [{ op: 'create', title: '完整事件', node_ids: ['late', 'early'], cause: '前因', process: '连续经过', result: '结果', line_status: 'open', confidence: 1, reason: '相邻原文', evidenceNodeIds: ['late'] }], memory_update: { workingSummary: '已排序', notes: [] } }
  await tools.tools.find(tool => tool.name === 'commit_story_changes')!.execute('create', { operationKey: 'first', payload })
  await tools.tools.find(tool => tool.name === 'commit_story_changes')!.execute('repeat', { operationKey: 'second', payload })
  const nodes = await repo.transaction(false, store => store.rows('nodes'))
  const lines = await repo.transaction(false, store => store.rows('eventLines'))
  expect(nodes).toHaveLength(2); expect(lines).toHaveLength(1)
  expect(nodes.find(row => row.name === '先发生')?.order).toBe(0)
  expect(nodes.find(row => row.id === 'late')?.order).toBe(1)
})

it('同书P2与P3使用不同实例，P2请求不携带P3私有历史和工作记忆', async () => {
  const base = scriptedAgentFetcher()
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const body = JSON.parse(init?.body as string)
    const world = !body.tools.some((tool: { function: { name: string } }) => tool.function.name === 'get_editor_memory')
    const commit = body.messages.filter((row: { role: string }) => row.role === 'tool').flatMap((row: { content: string }) => { try { return [JSON.parse(row.content)] } catch { return [] } }).find((row: { ok?: boolean; commitId?: string }) => row.ok && row.commitId)
    if (world && commit) {
      const user = body.messages.find((row: { role: string }) => row.role === 'user')
      const input = JSON.parse(typeof user.content === 'string' ? user.content : user.content.map((part: { text: string }) => part.text).join(''))
      return agentStream([{ name: 'submit_result', args: { status: 'completed', commitIds: [commit.commitId], summary: '世界资产已合并', remainingWorkIds: [], reviewedItems: input.workItems.map((work: { workItemId: string }) => ({ workItemId: work.workItemId, outcome: 'changed', reason: '原文确认同一人物' })) } }])
    }
    return base(url, init)
  })
  const { workspace, models } = await setup(fetcher)
  const bookId = 'same-book'; const now = new Date().toISOString()
  await workspace.settings.books.put({ id: bookId, title: '同书隔离', sourceFileName: 'same.txt', createdAt: now })
  const db = workspace.openBook(bookId)
  for (const [table, rows] of Object.entries(createAgentFixture(bookId))) await db.table(table).bulkPut(rows)
  await db.table('nodes').put({ id: 'C1-N001', bookId, name: '节点', summary: '节点', actors: [], quote: '', confidence: 1, chapterIndex: '1', chapterName: '第1章', order: 0, revision: 1, createdBy: 'P1' })
  const repo = createBookAgentRepository(workspace, bookId); const runtime = createAgentRuntime(models.agent)
  const session = await runtime.openSession(repo)
  const storyRun = crypto.randomUUID(), storyTask = crypto.randomUUID(), storyOperation = crypto.randomUUID()
  const nodeWork = { workItemId: 'node:first', kind: 'node', id: 'C1-N001', revision: 1, factFingerprint: 'node-fixture' }
  const storyInput = { bookId, runId: storyRun, taskId: storyTask, planVersion: '2.2', remainingCount: 1, resume: { reason: 'initial', appliedCommitIds: [], nextOperationKey: storyOperation, remainingWorkIds: [nodeWork.workItemId] }, stage: 'P3', phase: 'window_link', sessionId: session.id, queue: 'window_nodes', window: { start: 0, end: 1, chapterIndices: ['1'] }, workItems: [nodeWork], existingLines: [], memory: { id: session.id, bookId, sessionId: session.id, revision: 0, workingSummary: '', dataFingerprint: '', updatedAt: '' }, afterWorkItemId: null }
  const story = await runtime.run(repo, { profile: 'story_editor', phase: 'window_link', runId: storyRun, taskId: storyTask, sessionId: session.id, input: storyInput, workItems: [nodeWork], businessPrompt: '叙事任务', prompt: JSON.stringify({ operationKey: storyOperation, workItemId: nodeWork.workItemId, privateHistory: 'STORY_ONLY_PRIVATE' }) })
  expect(story.ok, story.error).toBe(true)
  const originalEntries = await db.table('storySessionEntries').count()
  const originalMemory = await db.table('storyEditorMemory').get(session.id)
  const previousRequests = fetcher.mock.calls.length
  const runId = crypto.randomUUID(), taskId = crypto.randomUUID(), operationKey = crypto.randomUUID()
  const workItems = ['C1-P001', 'C2-P001'].map(id => ({ workItemId: `character:${id}`, kind: 'character', id, revision: 1, factFingerprint: 'person-fixture' }))
  const input = { bookId, runId, taskId, planVersion: '2.2', remainingCount: 2, resume: { reason: 'initial', appliedCommitIds: [], nextOperationKey: operationKey, remainingWorkIds: workItems.map(row => row.workItemId) }, stage: 'P2', phase: 'ai_identity', kind: 'character', scope: 'fullBook', workItems, afterId: null, pageLimit: 100 }
  const world = await runtime.run(repo, { profile: 'asset_editor', phase: 'ai_identity', runId, taskId, input, workItems, businessPrompt: '世界资产任务', prompt: JSON.stringify({ operationKey, workItems }) })
  expect(world.ok, world.error).toBe(true)
  expect(runtime.instance(bookId, 'asset_editor')).not.toBe(runtime.instance(bookId, 'story_editor'))
  const worldRequests = fetcher.mock.calls.slice(previousRequests).map(([, init]) => JSON.parse(init?.body as string))
  expect(worldRequests).toHaveLength(3)
  expect(JSON.stringify(worldRequests)).not.toContain('STORY_ONLY_PRIVATE')
  expect(JSON.stringify(worldRequests)).not.toContain('隔离探针摘要')
  expect(await db.table('storySessionEntries').count()).toBe(originalEntries)
  expect(await db.table('storyEditorMemory').get(session.id)).toEqual(originalMemory)
})

it('按资产来源读取原文后允许跨章节合并，校验实际返回的证据片段', async () => {
  const { repo, scope, adapter, args } = await commandFixture('asset_editor', { asset_ids: ['C1-P001', 'C2-P001'] })
  expect(await commitCommand(repo, scope, 'commit_asset_changes', 'write', args, adapter.reads)).toMatchObject({ ok: true })
  expect(await repo.transaction(false, store => store.rows('characters'))).toHaveLength(1)
  const detail = await adapter.tools.find(tool => tool.name === 'get_character_detail')!.execute('redirect', { ids: ['C1-P001', 'C2-P001'] })
  expect((detail.details as { data: unknown[] }).data).toHaveLength(1)
  expect((detail.details as { data: unknown[] }).data[0]).toMatchObject({ id: 'C1-P001', resolvedFrom: ['C2-P001'] })
  const short = await commandFixture('asset_editor', { chapter_range: ['1', '2'], maxChars: 1 })
  await expect(commitCommand(short.repo, short.scope, 'commit_asset_changes', 'write', short.args, short.adapter.reads)).rejects.toThrow('证据所在原文片段')
})

it('引文连续跨页读取可以合并，缺失中间一字时给出补读位置', async () => {
  const split = await commandFixture('asset_editor', { chapter_indices: ['2'], maxChars: 6 })
  await split.adapter.tools.find(tool => tool.name === 'read_original')!.execute('page-two', { chapter_indices: ['2'], cursor: { chapterIndex: '2', offset: 6 } })
  expect(await commitCommand(split.repo, split.scope, 'commit_asset_changes', 'write', split.args, split.adapter.reads)).toMatchObject({ ok: true })
  const gap = await commandFixture('asset_editor', { chapter_indices: ['2'], maxChars: 6 })
  await gap.adapter.tools.find(tool => tool.name === 'read_original')!.execute('page-two', { chapter_indices: ['2'], cursor: { chapterIndex: '2', offset: 7 } })
  await expect(commitCommand(gap.repo, gap.scope, 'commit_asset_changes', 'write', gap.args, gap.adapter.reads)).rejects.toThrow('请调用read_original')
  expect(await gap.repo.transaction(false, store => store.rows('characters'))).toHaveLength(2)
})

it('改写的引文反馈章节和逐字核对要求', async () => {
  const fixture = await commandFixture()
  fixture.args.payload.groups[0].evidence[0].quote = '原文没有这句话。'
  await expect(commitCommand(fixture.repo, fixture.scope, 'commit_asset_changes', 'write', fixture.args, fixture.adapter.reads)).rejects.toThrow('第2章找不到连续逐字引文')
})
