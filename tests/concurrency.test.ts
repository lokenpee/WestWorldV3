import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createAssetService } from '../src/features/assets/service'
import { createWorldService } from '../src/features/world/service'
import { createStoryService } from '../src/features/story/service'
import { createExtractionService } from '../src/features/extraction/service'
import { createModelService } from '../src/features/models/service'
import { defaultConfig } from '../src/features/models/types'
import { createMemoryAgentRepository } from '../src/features/agents/repository'
import { createBookAgentRepository } from '../src/features/agents/repository'
import { createAgentTools } from '../src/features/agents/tools'
import { agentStream } from './support/agent-protocol'
import { organizationResponse } from './support/organization-streams'
import { storyResponse } from './support/story-protocol'

const opened: ReturnType<typeof createWorkspace>[] = []
afterEach(async () => { for (const workspace of opened.splice(0)) { workspace.close(); for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name) } })
const node = { id: 'N1', bookId: 'a', name: '独立事件', summary: '独立事件', actors: [], quote: '', chapterIndex: '1', chapterName: '第一章', order: 0, revision: 1, confidence: 1, createdBy: 'P1' }
function worldResponse(body: { messages: { role: string; content: string | { text: string }[] }[] }) {
  const users = body.messages.filter(row => row.role === 'user').map(row => typeof row.content === 'string' ? row.content : row.content.map(part => part.text).join(''))
  const input = JSON.parse(users.find(value => value.startsWith('{'))!)
  if (!body.messages.some(row => row.role === 'tool')) return agentStream([{ name: input.kind === 'character' ? 'get_character_detail' : 'get_location_detail', args: { ids: input.workItems.map((row: { id: string }) => row.id) } }])
  return agentStream([{ name: 'submit_result', args: { status: 'completed', commitIds: [], summary: '核实完成', remainingWorkIds: [], reviewedItems: input.workItems.map((row: { workItemId: string }) => ({ workItemId: row.workItemId, outcome: 'no_change', reason: '独立资产' })) } }])
}
async function usage(response: Response, tokens: number) {
  return new Response((await response.text()).replace('data: [DONE]', `data: ${JSON.stringify({ id: 'usage', object: 'chat.completion.chunk', model: 'fixture', choices: [], usage: { prompt_tokens: tokens, completion_tokens: 0, total_tokens: tokens } })}\n\ndata: [DONE]`), { headers: { 'Content-Type': 'text/event-stream' } })
}

it.each(['world', 'story'] as const)('同书%s运行时另一阶段启动被拒绝，结束后可启动', async first => {
  const gates = new Map<string, () => void>(), signals = new Map<string, AbortSignal>()
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string)
    const kind = body.tools.some((tool: { function: { name: string } }) => tool.function.name === 'finish_story_batch') ? 'story' : 'world'
    if (!signals.has(kind)) {
      signals.set(kind, init!.signal!)
      await new Promise<void>((resolve, reject) => { gates.set(kind, resolve); init?.signal?.addEventListener('abort', () => reject(new DOMException('取消', 'AbortError')), { once: true }) })
    }
    return usage(kind === 'story' ? storyResponse(body, { readOnly: true }) : worldResponse(body), kind === 'story' ? 7 : 4)
  })
  const key = crypto.randomUUID(), workspace = createWorkspace({ settingsName: `parallel-${key}`, bookPrefix: `parallel-${key}-book-` }); opened.push(workspace)
  await workspace.settings.books.put({ id: 'a', title: '并行样本', sourceFileName: 'a.txt', createdAt: new Date().toISOString() })
  const db = workspace.openBook('a')
  await db.chapters.put({ bookId: 'a', chapterIndex: '1', chapterName: '第一章', order: 0, charCount: 2 })
  await db.table('chapterTexts').put({ bookId: 'a', chapterIndex: '1', text: '原文' })
  await db.table('characters').put({ id: 'P1', bookId: 'a', name: '沈青', revision: 1, confidence: 1, createdBy: 'P1', sourceChapters: ['1'] })
  await db.table('locations').put({ id: 'L1', bookId: 'a', name: '客栈', revision: 1, confidence: 1, createdBy: 'P1', sourceChapters: ['1'] })
  await db.table('nodes').put(node)
  await db.table('extractionReceipts').bulkPut(['worldAssets', 'narrativeAssets'].map(substep => ({ key: `1:${substep}`, bookId: 'a', chapterIndex: '1', substep, originIds: [] })))
  const models = createModelService(workspace, { fetch: fetcher })
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://parallel.invalid/v1', aggregationContextWindow: 65536 }, 'fake-key')
  const world = createWorldService(workspace, models, createAssetService(workspace)), story = createStoryService(workspace, models)
  const firstService = first === 'world' ? world : story, otherService = first === 'world' ? story : world
  const run = firstService.start('a')
  await vi.waitFor(() => expect(gates.size).toBe(1), { timeout: 5000 })
  await otherService.start('a')
  expect(otherService.state('a')?.error).toContain('已有')
  expect(await db.table('pipelineRuns').get(`lease:${first === 'world' ? 'world' : 'narrative'}`)).toBeDefined()
  expect(await db.table('pipelineRuns').get(`lease:${first === 'world' ? 'narrative' : 'world'}`)).toBeUndefined()
  firstService.cancel('a')
  gates.get(first)!()
  await run
  expect(world.state('a')?.running).toBe(false); expect(story.state('a')?.running).toBe(false)
}, 30000)

it.each(['asset_editor', 'story_editor'] as const)('%s执行权被接管后，旧读取和总结均不写任务记录', async profile => {
  const table = profile === 'asset_editor' ? 'characters' : 'nodes', kind = profile === 'asset_editor' ? 'character' : 'node'
  const domain = profile === 'asset_editor' ? 'world' : 'narrative', id = profile === 'asset_editor' ? 'P1' : 'N1'
  const workItemId = `${kind}:${id}`
  const repo = createMemoryAgentRepository('a', { [table]: profile === 'asset_editor' ? [{ id, bookId: 'a', name: '沈青', revision: 1, confidence: 1, createdBy: 'P1' }] : [node],
    pipelineRuns: [{ id: 'run', bookId: 'a', tasks: [{ taskId: 'task', appliedCommitIds: [], input: { workItems: [{ workItemId, kind, id }] } }] }, { id: `lease:${domain}`, bookId: 'a', owner: 'old', runId: 'run', expiresAt: Date.now() + 30000 }] })
  const scope = { bookId: 'a', profile, phase: profile === 'asset_editor' ? 'ai_identity' : 'window_link', runId: 'run', taskId: 'task', owner: 'old', workItemIds: [workItemId] }
  const adapter = createAgentTools(repo, scope)
  const detail = adapter.tools.find(tool => tool.name === (profile === 'asset_editor' ? 'get_character_detail' : 'get_node_detail'))!
  await detail.execute('read', { ids: [id], ...(profile === 'story_editor' ? { fields: ['name'] } : {}) })
  await repo.transaction(true, async store => { const lease = (await store.get('pipelineRuns', `lease:${domain}`))!; await store.put('pipelineRuns', { ...lease, owner: 'new' }) })
  const before = await repo.transaction(false, store => store.get('pipelineRuns', 'run'))
  await expect(adapter.tools.find(tool => tool.name === 'submit_result')!.execute('late-summary', { status: 'completed', commitIds: [], summary: '旧执行者', remainingWorkIds: [], reviewedItems: [{ workItemId, outcome: 'no_change', reason: '旧依据' }] })).rejects.toThrow('执行权')
  await expect(detail.execute('late-read', { ids: [id], ...(profile === 'story_editor' ? { fields: ['name'] } : {}) })).rejects.toThrow('执行权')
  expect(await repo.transaction(false, store => store.get('pipelineRuns', 'run'))).toEqual(before)
})

it.each(['owner', 'expired'] as const)('P3会话租约%s变化时旧执行者不能写入', async kind => {
  const run = { id: 'run', bookId: 'a', tasks: [{ taskId: 'task', appliedCommitIds: [], input: { workItems: [{ workItemId: 'node:N1', kind: 'node', id: 'N1' }] } }], appliedCommands: [], commandIntents: [] }
  const session = { id: 'session', bookId: 'a', profile: 'story_editor', runId: 'run', leaseOwner: 'old', leaseUntil: Date.now() + 30000, nextOrdinal: 0, leafId: null }
  const repo = createMemoryAgentRepository('a', {
    nodes: [node],
    pipelineRuns: [run, { id: 'lease:narrative', bookId: 'a', recordType: 'lease', lockKey: 'narrative', owner: 'old', runId: 'run', expiresAt: Date.now() + 30000 }],
    storySessions: [session],
  })
  const scope = { bookId: 'a', profile: 'story_editor' as const, phase: 'window_link', runId: 'run', taskId: 'task', owner: 'old', sessionId: 'session', workItemIds: ['node:N1'] }
  if (kind === 'owner') await repo.transaction(true, store => store.put('storySessions', { ...session, leaseOwner: 'new' }))
  else await repo.transaction(true, store => store.put('storySessions', { ...session, leaseUntil: Date.now() - 1 }))
  const adapter = createAgentTools(repo, scope)
  await expect(adapter.tools.find(tool => tool.name === 'submit_result')!.execute('late-summary', {
    status: 'completed', commitIds: [], summary: '旧执行者总结', remainingWorkIds: [], reviewedItems: [{ workItemId: 'node:N1', outcome: 'no_change', reason: '旧依据' }],
  })).rejects.toThrow(/会话执行权/)
  const saved = await repo.transaction(false, store => store.get('pipelineRuns', 'run'))
  expect(saved?.appliedCommands).toEqual([])
  expect(saved?.tasks).toMatchObject([{ taskId: 'task', appliedCommitIds: [] }])
})

it('读取期间资料变化时重取一致快照，写入异常仍完整回滚', async () => {
  const key = crypto.randomUUID(), workspace = createWorkspace({ settingsName: `snapshot-${key}`, bookPrefix: `snapshot-${key}-book-` }); opened.push(workspace)
  await workspace.settings.books.put({ id: 'a', title: '快照样本', sourceFileName: 'a.txt', createdAt: new Date().toISOString() })
  const db = workspace.openBook('a'), repo = createBookAgentRepository(workspace, 'a')
  await db.table('characters').put({ id: 'P', bookId: 'a', name: '旧名' })
  let changed = false
  const value = await repo.transaction(false, async store => {
    const first = await store.get('characters', 'P')
    if (!changed) { changed = true; await db.table('characters').put({ id: 'P', bookId: 'a', name: '新名' }) }
    return [first?.name, (await store.rows('characters'))[0].name]
  })
  expect(value).toEqual(['新名', '新名'])
  await expect(repo.transaction(true, async store => { await store.put('characters', { id: 'P', bookId: 'a', name: '应回滚' }); throw new Error('模拟写入失败') })).rejects.toThrow('模拟写入失败')
  expect(await db.table('characters').get('P')).toMatchObject({ name: '新名' })
})

it('租约只续期 expiresAt 时读取和业务提交都不产生假冲突', async () => {
  const key = crypto.randomUUID(), workspace = createWorkspace({ settingsName: `lease-renew-${key}`, bookPrefix: `lease-renew-${key}-book-` }); opened.push(workspace)
  await workspace.settings.books.put({ id: 'a', title: '续期样本', sourceFileName: 'a.txt', createdAt: new Date().toISOString() })
  const db = workspace.openBook('a'), repo = createBookAgentRepository(workspace, 'a')
  await db.table('characters').put({ id: 'P', bookId: 'a', name: '旧名' })
  await db.table('pipelineRuns').put({ id: 'lease:world', recordType: 'lease', bookId: 'a', lockKey: 'world', owner: 'owner', runId: 'run', expiresAt: Date.now() + 30000 })
  const read = await repo.transaction(false, async store => {
    const row = await store.get('characters', 'P')
    await db.table('pipelineRuns').update('lease:world', { expiresAt: Date.now() + 60000 })
    return store.get('pipelineRuns', 'lease:world').then(value => ({ name: row?.name, lease: value }))
  })
  expect(read.name).toBe('旧名')
  await repo.transaction(true, async store => {
    await store.get('pipelineRuns', 'lease:world')
    await db.table('pipelineRuns').update('lease:world', { expiresAt: Date.now() + 90000 })
    await store.put('characters', { id: 'P', bookId: 'a', name: '新名' })
  })
  expect(await db.table('characters').get('P')).toMatchObject({ name: '新名' })
})

it('业务提交时租约执行者已变化则拒绝写入', async () => {
  const key = crypto.randomUUID(), workspace = createWorkspace({ settingsName: `lease-lost-${key}`, bookPrefix: `lease-lost-${key}-book-` }); opened.push(workspace)
  await workspace.settings.books.put({ id: 'a', title: '执行权样本', sourceFileName: 'a.txt', createdAt: new Date().toISOString() })
  const db = workspace.openBook('a'), repo = createBookAgentRepository(workspace, 'a')
  await db.table('characters').put({ id: 'P', bookId: 'a', name: '旧名' })
  await db.table('pipelineRuns').put({ id: 'lease:world', recordType: 'lease', bookId: 'a', lockKey: 'world', owner: 'owner', runId: 'run', expiresAt: Date.now() + 30000 })
  await expect(repo.transaction(true, async store => {
    await db.table('pipelineRuns').update('lease:world', { owner: 'other' })
    await store.put('characters', { id: 'P', bookId: 'a', name: '不应写入' })
  }, { lockKey: 'world', owner: 'owner', runId: 'run' })).rejects.toThrow('执行权')
  expect(await db.table('characters').get('P')).toMatchObject({ name: '旧名' })
})

it('同一本书任一阶段持锁时，P1/P2/P3 其他入口均被拒绝', async () => {
  const key = crypto.randomUUID(), workspace = createWorkspace({ settingsName: `admission-${key}`, bookPrefix: `admission-${key}-book-` }); opened.push(workspace)
  await workspace.settings.books.put({ id: 'a', title: '准入样本', sourceFileName: 'a.txt', createdAt: new Date().toISOString() })
  const db = workspace.openBook('a')
  await db.chapters.put({ bookId: 'a', chapterIndex: '1', chapterName: '第一章', order: 0, charCount: 2 })
  await db.table('chapterTexts').put({ bookId: 'a', chapterIndex: '1', text: '原文' })
  await db.table('characters').put({ id: 'P1', bookId: 'a', name: '沈青', revision: 1, confidence: 1, createdBy: 'P1', sourceChapters: ['1'] })
  await db.table('extractionReceipts').bulkPut(['worldAssets', 'narrativeAssets'].map(substep => ({ key: `1:${substep}`, bookId: 'a', chapterIndex: '1', substep, inputFingerprint: 'fixture', originIds: [], committedAt: new Date().toISOString(), runId: 'fixture' })))
  const models = createModelService(workspace, { fetch: vi.fn<typeof fetch>(), wait: async (_ms, signal) => signal.throwIfAborted() })
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://admission.invalid/v1', aggregationContextWindow: 65536 }, 'fake-key')
  const assets = createAssetService(workspace)
  for (const lockKey of ['world', 'narrative', 'extraction']) {
    await db.table('pipelineRuns').put({ id: `lease:${lockKey}`, recordType: 'lease', bookId: 'a', lockKey, owner: 'other', runId: 'other-run', expiresAt: Date.now() + 30000 })
    const world = createWorldService(workspace, models, assets, { assetReview: false })
    const story = createStoryService(workspace, models)
    const extraction = createExtractionService(workspace, models)
    await expect(world.startCharacterOrganization('a', 'P1', 'profile')).rejects.toThrow('已有')
    await expect(world.startOrganizationStep('a', 'profiles')).rejects.toThrow('已有')
    await story.start('a')
    expect(story.state('a')?.error).toContain('已有')
    await extraction.start('a')
    expect(extraction.state('a')?.error).toContain('已有')
    await db.table('pipelineRuns').delete(`lease:${lockKey}`)
  }
})

it('不同书籍的租约和任务互不影响', async () => {
  const key = crypto.randomUUID(), workspace = createWorkspace({ settingsName: `admission-books-${key}`, bookPrefix: `admission-books-${key}-book-` }); opened.push(workspace)
  for (const id of ['a', 'b']) {
    await workspace.settings.books.put({ id, title: id, sourceFileName: `${id}.txt`, createdAt: new Date().toISOString() })
    const db = workspace.openBook(id)
    await db.chapters.put({ bookId: id, chapterIndex: '1', chapterName: '第一章', order: 0, charCount: 2 })
    await db.table('chapterTexts').put({ bookId: id, chapterIndex: '1', text: '原文' })
    await db.table('characters').put({ id: `P-${id}`, bookId: id, name: id === 'a' ? '甲' : '乙', revision: 1, confidence: 1, createdBy: 'P1', sourceChapters: ['1'] })
    await db.table('extractionReceipts').bulkPut(['worldAssets', 'narrativeAssets'].map(substep => ({ key: `1:${substep}`, bookId: id, chapterIndex: '1', substep, inputFingerprint: 'fixture', originIds: [], committedAt: new Date().toISOString(), runId: 'fixture' })))
  }
  await workspace.openBook('a').table('pipelineRuns').put({ id: 'lease:world', recordType: 'lease', bookId: 'a', lockKey: 'world', owner: 'other', runId: 'other-run', expiresAt: Date.now() + 30000 })
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => organizationResponse(JSON.parse(init!.body as string))!)
  const models = createModelService(workspace, { fetch: fetcher, wait: async (_ms, signal) => signal.throwIfAborted() })
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://admission-books.invalid/v1', aggregationContextWindow: 65536 }, 'fake-key')
  const world = createWorldService(workspace, models, createAssetService(workspace), { assetReview: false })
  expect((await world.eligibility('a')).locked).toBe(true)
  expect((await world.eligibility('b')).locked).toBe(false)
  const finished = new Promise<void>((resolve, reject) => {
    let started = false
    const timeout = setTimeout(() => reject(new Error('不同书籍任务超时。')), 120000)
    const unsubscribe = world.subscribe(() => {
      const state = world.state('b')
      if (state?.running) started = true
      if (started && !state?.running) { clearTimeout(timeout); unsubscribe(); resolve() }
    })
  })
  const runId = await world.startCharacterOrganization('b', 'P-b', 'profile')
  await finished
  expect((await workspace.openBook('b').table('pipelineRuns').get(runId)).status).toBe('completed')
  expect(await workspace.openBook('a').table('pipelineRuns').get('lease:world')).toMatchObject({ owner: 'other' })
}, 120000)
