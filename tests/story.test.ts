import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspace, type Chapter } from '../src/lib/storage/workspace'
import { createModelService } from '../src/features/models/service'
import { createStoryService } from '../src/features/story/service'
import { createStoryWindows } from '../src/features/story/windows'
import { createAssetService } from '../src/features/assets/service'
import { defaultConfig } from '../src/features/models/types'
import { storyResponse, storyTask } from './support/story-protocol'
import { emptyTables, tableNames, validateBookData } from '../src/features/backup/data'
import { noteFingerprint } from '../src/features/agents/queries'
import { createBookAgentRepository } from '../src/features/agents/repository'
import { agentStream } from './support/agent-protocol'
import { appendEntry } from '../src/features/agents/commands'

const opened: ReturnType<typeof createWorkspace>[] = []
const chapter = (chapterIndex: string, order: number): Chapter => ({ bookId: 'a', chapterIndex, chapterName: `第${chapterIndex}章`, order, charCount: 7 })
async function setup(count = 240, positions = [81, 100, 101, 180, 181, 240], fetcher: typeof fetch = vi.fn(async (_url, init) => storyResponse(JSON.parse(init?.body as string)))) {
  const id = crypto.randomUUID(); const workspace = createWorkspace({ settingsName: `story-${id}`, bookPrefix: `story-${id}-book-` }); opened.push(workspace)
  const book = { id: 'a', title: '信件流转', sourceFileName: 'story.txt', createdAt: new Date().toISOString() }; await workspace.settings.books.put(book)
  const db = workspace.openBook('a'); const text = '同一封信继续流转。'
  await db.chapters.bulkPut(Array.from({ length: count }, (_, i) => ({ ...chapter(String(i + 1), i), charCount: text.length })))
  await db.table('chapterTexts').bulkPut(Array.from({ length: count }, (_, i) => ({ bookId: 'a', chapterIndex: String(i + 1), text })))
  await db.table('extractionReceipts').bulkPut(Array.from({ length: count }, (_, i) => ['worldAssets', 'narrativeAssets'].map(substep => ({ key: `${i + 1}:${substep}`, bookId: 'a', chapterIndex: String(i + 1), substep, inputFingerprint: 'fixture', originIds: [], committedAt: book.createdAt, runId: 'extract-fixture' }))).flat())
  await db.table('nodes').bulkPut(positions.map((position, index) => ({ id: `C${position}-N${String(index + 1).padStart(3, '0')}`, bookId: 'a', name: `信件事件${index + 1}`, summary: '同一封信继续流转', actors: [], quote: text, offset: 0, confidence: 1, revision: 1, createdBy: 'P1', chapterIndex: String(position), chapterName: `第${position}章`, order: index, eventLineIds: [] })))
  const models = createModelService(workspace, { fetch: fetcher, wait: async (_ms, signal) => signal.throwIfAborted() })
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://story-fixture.invalid/v1', aggregationContextWindow: 65536 }, 'fixture-story-key')
  return { book, workspace, db, models, service: createStoryService(workspace, models), fetcher }
}
afterEach(async () => { for (const workspace of opened.splice(0)) { workspace.close(); for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name) } })
it('100原章窗口重叠20，切块跟随原章，240章只生成三个窗口', () => {
  const chapters = Array.from({ length: 240 }, (_, i) => chapter(String(i + 1), i))
  expect(createStoryWindows(chapters).map(row => [row.start, row.end])).toEqual([[0, 100], [80, 180], [160, 240]])
  expect(createStoryWindows([])).toEqual([])
  expect(createStoryWindows(chapters.slice(0, 100))).toHaveLength(1)
  const chunks = chapters.flatMap(row => row.chapterIndex === '100' ? [chapter('100.1', 99), chapter('100.2', 99.5)] : [row])
  const windows = createStoryWindows(chunks)
  expect(windows[0].chapterIndices).toContain('100.2'); expect(windows[1].chapterIndices).toContain('100.1')
  expect(windows[2].chapterIndices).toHaveLength(80)
})
it('Pi跨三个窗口追加同一事件线，重叠节点复用，检查点和会话可备份', async () => {
  const windows: number[][] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => { const body = JSON.parse(init?.body as string); const { input } = storyTask(body); windows.push([input.window.start, input.window.end]); return storyResponse(body) })
  const { book, db, service } = await setup(240, undefined, fetcher)
  await service.start('a')
  expect(service.state('a')?.error, JSON.stringify(fetcher.mock.calls.map(([, init]) => { const body = JSON.parse(init?.body as string); const { input } = storyTask(body); return { window: input.window.start, errors: body.messages.filter((row: { role: string; content: string }) => row.role === 'tool' && !row.content.startsWith('{')).map((row: { content: string }) => row.content) } }))).toBeUndefined()
  expect([...new Set(windows.map(value => value.join('-')))]).toEqual(['0-100', '80-180', '160-240'])
  const lines = await db.table('eventLines').toArray()
  expect(lines).toHaveLength(1); expect(lines[0].nodeIds).toHaveLength(6)
  expect(lines[0].chapters).toEqual(['81', '100', '101', '180', '181', '240'])
  for (const node of await db.table('nodes').toArray()) expect(node.eventLineIds).toEqual([lines[0].id])
  const progress = await service.read('a')
  expect(progress.completed).toBe(3); expect(progress.progress?.phase).toBe('window_link_complete')
  expect(await db.table('storySessions').count()).toBe(1)
  expect(await db.table('pipelineRuns').get('lease:narrative')).toBeUndefined()
  const calls = windows.length; await service.start('a'); expect(windows).toHaveLength(calls)
  const tables = emptyTables(); for (const name of tableNames) tables[name] = await db.table(name).toArray()
  expect(await validateBookData({ book, tables })).toEqual([])
})
it('单窗超过100节点分任务读取，全部页覆盖后才完成窗口', async () => {
  const { service, db } = await setup(1, Array(105).fill(1))
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  const progress = await service.read('a')
  expect(progress.completed).toBe(1); expect(progress.tasks).toHaveLength(2)
  expect((await db.table('eventLines').toArray())[0].nodeIds).toHaveLength(105)
})
it('叙事锁按书生效，取消在途请求后释放锁并保留已有成果', async () => {
  const base = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => storyResponse(JSON.parse(init?.body as string)))
  const fetcher = vi.fn<typeof fetch>().mockImplementation((url, init) => fetcher.mock.calls.length > 3 ? new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('取消', 'AbortError')), { once: true }) }) : base(url, init))
  const { workspace, db, service } = await setup(240, undefined, fetcher)
  const running = service.start('a')
  await vi.waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(3))
  const assets = createAssetService(workspace)
  const node = (await db.table('nodes').toArray())[0]
  await expect(assets.update('a', 'node', node.id, node.revision, { summary: '人工修改' })).rejects.toMatchObject({ code: 'ASSET_DOMAIN_LOCKED' })
  await assets.create('a', 'character', { name: '仍可编辑人物', manualSourceNote: '人工' })
  service.cancel('a'); await running
  expect(await db.table('eventLines').count()).toBe(1)
  expect((await service.read('a')).completed).toBe(1)
  expect(await db.table('pipelineRuns').get('lease:narrative')).toBeUndefined()
})


it('已有事件线超过50条仍核对目录后页，相同成员重复创建保持一条', async () => {
  const { service, db, fetcher } = await setup(1, [1, 1])
  const nodes = await db.table('nodes').toArray(); const timestamp = new Date().toISOString()
  await db.table('eventLines').bulkPut(Array.from({ length: 55 }, (_, index) => ({ id: `line-${String(index).padStart(3, '0')}`, bookId: 'a', title: '既有线', nodeIds: [nodes[0].id], chapters: ['1'], cause: '已有原因', process: '', result: '', lineStatus: 'open', revision: 1, createdBy: 'manual', updatedAt: timestamp })))
  await db.table('nodes').update(nodes[0].id, { eventLineIds: Array.from({ length: 55 }, (_, i) => `line-${String(i).padStart(3, '0')}`) })
  await service.start('a')
  expect(service.state('a')?.error, JSON.stringify((fetcher as ReturnType<typeof vi.fn<typeof fetch>>).mock.calls.map(([, init]) => JSON.parse(init?.body as string).messages.filter((row: { role: string; content: string }) => row.role === 'tool' && !row.content.startsWith('{'))))).toBeUndefined()
  const calls = (fetcher as ReturnType<typeof vi.fn<typeof fetch>>).mock.calls.map(([, init]) => JSON.parse(init?.body as string).messages).flat()
  expect(JSON.stringify(calls)).toContain('line-054')
  expect(await db.table('eventLines').count()).toBe(55)
})

it('空节点窗口无需模型请求仍保存检查点，提取未完成则拒绝启动', async () => {
  const { service, db, fetcher } = await setup(240, [])
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect((await service.read('a')).completed).toBe(3)
  expect(fetcher).not.toHaveBeenCalled()
  await db.table('extractionReceipts').delete('1:narrativeAssets')
  await service.start('a')
  expect(service.state('a')?.error).toContain('请先完成')
})


it('完成后修改叙事资料会重新核对，重复创建相同成员仍只有一条事件线', async () => {
  const { workspace, service, db, fetcher } = await setup(1, [1, 1])
  await service.start('a')
  const beforeCalls = (fetcher as ReturnType<typeof vi.fn<typeof fetch>>).mock.calls.length
  const assets = createAssetService(workspace)
  const node = (await db.table('nodes').toArray())[0]
  await assets.update('a', 'node', node.id, node.revision, { summary: '人工补充事件经过' })
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect((fetcher as ReturnType<typeof vi.fn<typeof fetch>>).mock.calls.length).toBeGreaterThan(beforeCalls)
  expect(await db.table('eventLines').count()).toBe(1)
  expect(await db.table('nodes').get(node.id)).toMatchObject({ summary: '人工补充事件经过' })
})


it('任务输入的工作记忆直接作为版本依据，追加时复用已读线的旧成员', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => storyResponse(JSON.parse(init?.body as string), { inputMemory: true, reuseOldMembers: true }))
  const { service, db } = await setup(240, undefined, fetcher)
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect((await service.read('a')).completed).toBe(3)
  expect((await db.table('eventLines').toArray())[0].nodeIds).toHaveLength(6)
  expect(fetcher.mock.calls).toHaveLength(9)
  const inputs = fetcher.mock.calls.map(([, init]) => JSON.parse(init?.body as string))
  expect(inputs.flatMap(body => body.messages.filter((row: { role: string; tool_calls?: { function: { name: string } }[] }) => row.role === 'assistant').flatMap((row: { tool_calls?: { function: { name: string } }[] }) => row.tool_calls?.map(call => call.function.name) ?? []))).not.toContain('get_editor_memory')
})

it('全书复核逐页覆盖孤点、超过30条事件线与未解决和过期事项，重建服务仍续原会话', async () => {
  const queues: { queue: string; count: number }[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string)
    if (!JSON.stringify(body).includes('【需要压缩的原始会话数据】')) { const { input } = storyTask(body); if (input.phase === 'global_review') queues.push({ queue: input.queue, count: input.workItems.length }) }
    return storyResponse(body, { readOnly: true })
  })
  const { workspace, models, book, db, service } = await setup(1, [1, 1], fetcher)
  const nodes = await db.table('nodes').toArray(), now = book.createdAt
  await db.table('eventLines').bulkPut(Array.from({ length: 35 }, (_, i) => ({ id: `line-${String(i).padStart(3, '0')}`, bookId: 'a', title: '独立支线', nodeIds: [nodes[0].id], chapters: ['1'], cause: '', process: '', result: '', lineStatus: 'open', revision: 1, createdBy: 'P3', updatedAt: now })))
  await db.table('nodes').update(nodes[0].id, { eventLineIds: Array.from({ length: 35 }, (_, i) => `line-${String(i).padStart(3, '0')}`) })
  const repo = createBookAgentRepository(workspace, 'a')
  for (const [index, status] of ['active', 'resolved'].entries()) {
    const note = { id: `note-${index}`, key: `review-${index}`, bookId: 'a', revision: 1, stage: 'P3', kind: 'review', status, statement: '核对独立事件', nodeIds: [nodes[1].id], lineIds: [], evidence: [], createdAt: now, updatedAt: now }
    await db.table('storyEditorNotes').put({ ...note, basisFingerprint: index ? 'expired' : await repo.transaction(false, store => noteFingerprint(store, note)) })
  }
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  const originalSession = (await service.read('a')).session.id!
  await db.table('storyEditorNotes').toCollection().modify({ sessionId: originalSession })
  const resumed = createStoryService(workspace, models)
  await resumed.review('a')
  expect(resumed.state('a')?.error).toBeUndefined()
  const value = await resumed.read('a')
  expect(value.progress).toMatchObject({ status: 'completed', phase: 'global_review', editorSessionId: originalSession })
  expect(value.review).toMatchObject({ total: 38, pending: 0 })
  expect(value.review.conclusions).toHaveLength(38)
  expect(queues.some(row => row.queue === 'orphans')).toBe(true)
  expect(queues.filter(row => row.queue === 'event_lines').every(row => row.count <= 30)).toBe(true)
  expect(queues.some(row => row.queue === 'review_notes')).toBe(true)
  const calls = fetcher.mock.calls.length
  await resumed.review('a'); expect(fetcher.mock.calls).toHaveLength(calls)
  expect(await db.table('storySessions').count()).toBe(1)
  const tables = emptyTables(); for (const name of tableNames) tables[name] = await db.table(name).toArray()
  expect(await validateBookData({ book, tables })).toEqual([])
})

it('全书复核连续三个子任务无进展时暂停，保留清单并释放锁', async () => {
  let partial = false, reviewCalls = 0
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string); const { input } = storyTask(body)
    if (partial && input.phase === 'global_review') { reviewCalls++; return agentStream([{ name: 'submit_result', args: { status: 'partial', commitIds: [], summary: '需要更多依据', reviewedItems: [], remainingWorkIds: input.workItems.map((row: { workItemId: string }) => row.workItemId) } }]) }
    return storyResponse(body)
  })
  const { service, db } = await setup(1, [1, 1], fetcher)
  await service.start('a'); partial = true
  await service.review('a')
  expect(reviewCalls).toBe(3)
  expect(service.state('a')?.error).toContain('连续尝试未取得进展')
  expect((await service.read('a')).progress?.status).toBe('paused')
  expect((await service.read('a')).review.pending).toBe(1)
  expect(await db.table('pipelineRuns').get('lease:narrative')).toBeUndefined()
  partial = false; await service.review('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect((await service.read('a')).review.pending).toBe(0)
})

it('长历史通过真实Pi模型适配压缩，刷新重建后沿用原会话与摘要，原始记录可备份', async () => {
  const { workspace, models, service, db, book, fetcher } = await setup(1, [1, 1])
  await service.start('a')
  const sessionId = (await service.read('a')).session.id!
  const repo = createBookAgentRepository(workspace, 'a')
  await repo.transaction(true, store => appendEntry(store, { bookId: 'a', profile: 'story_editor', phase: 'global_review', runId: '', taskId: '', sessionId, owner: '', workItemIds: [] }, { type: 'message', message: { role: 'user', content: `独立旧历史标记：${'原文核对记录。'.repeat(12000)}`, timestamp: Date.now() } }))
  const before = (await service.history('a')).total
  const resumed = createStoryService(workspace, models)
  await resumed.review('a')
  expect(resumed.state('a')?.error).toBeUndefined()
  const state = await resumed.read('a')
  expect(state.session.id).toBe(sessionId)
  expect(state.session.compactions).toBeGreaterThan(0)
  expect(state.session.entryCount).toBeGreaterThan(before)
  expect(state.progress?.status).toBe('completed')
  const calls = (fetcher as ReturnType<typeof vi.fn<typeof fetch>>).mock.calls.map(([, init]) => JSON.parse(init?.body as string))
  const last = calls.at(-1)
  expect(JSON.stringify(last)).toContain('历史会话压缩摘要')
  expect(last.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(expect.arrayContaining(['get_event_line_detail', 'get_node_detail', 'commit_story_changes', 'submit_result']))
  expect(JSON.stringify(last)).not.toContain('原文核对记录。'.repeat(100))
  expect((await db.table('storySessionEntries').toArray()).some(row => JSON.stringify(row).includes('独立旧历史标记'))).toBe(true)
  const tables = emptyTables(); for (const name of tableNames) tables[name] = await db.table(name).toArray()
  expect(await validateBookData({ book, tables })).toEqual([])
})

it('模型返回上下文超长时强制压缩恢复一次，后续请求继续当前精确任务', async () => {
  let rejected = false
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string)
    if (!JSON.stringify(body).includes('【需要压缩的原始会话数据】')) {
      const { input } = storyTask(body)
      if (input.phase === 'global_review' && !rejected) { rejected = true; return new Response(JSON.stringify({ error: { message: 'maximum context length exceeded', type: 'invalid_request_error', code: 'context_length_exceeded' } }), { status: 400 }) }
    }
    return storyResponse(body)
  })
  const { service } = await setup(1, [1, 1], fetcher)
  await service.start('a'); await service.review('a')
  expect(rejected).toBe(true)
  expect(service.state('a')?.error).toBeUndefined()
  expect((await service.read('a')).progress?.status).toBe('completed')
  expect((await service.read('a')).session.compactions).toBe(1)
  const last = JSON.parse(fetcher.mock.calls.at(-1)![1]?.body as string)
  expect(last.tools.map((tool: { function: { name: string } }) => tool.function.name)).toContain('get_event_line_detail')
})
