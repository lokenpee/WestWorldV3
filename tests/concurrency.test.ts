import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createAssetService } from '../src/features/assets/service'
import { createWorldService } from '../src/features/world/service'
import { createStoryService } from '../src/features/story/service'
import { createModelService } from '../src/features/models/service'
import { defaultConfig } from '../src/features/models/types'
import { createMemoryAgentRepository } from '../src/features/agents/repository'
import { createBookAgentRepository } from '../src/features/agents/repository'
import { createAgentTools } from '../src/features/agents/tools'
import { agentStream } from './support/agent-protocol'
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

it.each(['world', 'story'] as const)('同书并行时取消%s，只释放该阶段资源，用量保持独立', async cancelled => {
  const gates = new Map<string, () => void>(), signals = new Map<string, AbortSignal>()
  const counts = { world: 0, story: 0 }
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string)
    const kind = body.tools.some((tool: { function: { name: string } }) => tool.function.name === 'get_editor_memory') ? 'story' : 'world'
    counts[kind]++
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
  const runs = { world: world.start('a'), story: story.start('a') }
  await vi.waitFor(() => expect(gates.size).toBe(2), { timeout: 5000 })
  const other = cancelled === 'world' ? 'story' : 'world'
  ;({ world, story })[cancelled].cancel('a')
  await runs[cancelled]
  expect(signals.get(other)?.aborted).toBe(false)
  expect(await db.table('pipelineRuns').get(`lease:${cancelled === 'world' ? 'world' : 'narrative'}`)).toBeUndefined()
  expect(await db.table('pipelineRuns').get(`lease:${other === 'world' ? 'world' : 'narrative'}`)).toBeDefined()
  gates.get(other)!(); await runs[other]
  expect(({ world, story })[other].state('a')?.error).toBeUndefined()
  expect(world.state('a')?.running).toBe(false); expect(story.state('a')?.running).toBe(false)
  expect((await world.reports('a'))[0].report.usage.totalTokens).toBe(cancelled === 'world' ? 0 : counts.world * 4)
  expect((await story.read('a')).usage?.totalTokens).toBe(cancelled === 'story' ? 0 : counts.story * 7)
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
  await detail.execute('read', { ids: [id] })
  await repo.transaction(true, async store => { const lease = (await store.get('pipelineRuns', `lease:${domain}`))!; await store.put('pipelineRuns', { ...lease, owner: 'new' }) })
  const before = await repo.transaction(false, store => store.get('pipelineRuns', 'run'))
  await expect(adapter.tools.find(tool => tool.name === 'submit_result')!.execute('late-summary', { status: 'completed', commitIds: [], summary: '旧执行者', remainingWorkIds: [], reviewedItems: [{ workItemId, outcome: 'no_change', reason: '旧依据' }] })).rejects.toThrow('执行权')
  await expect(detail.execute('late-read', { ids: [id] })).rejects.toThrow('执行权')
  expect(await repo.transaction(false, store => store.get('pipelineRuns', 'run'))).toEqual(before)
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
