import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createModelService } from '../src/features/models/service'
import { defaultConfig } from '../src/features/models/types'
import { createStoryService } from '../src/features/story/service'
import { agentStream } from './support/agent-protocol'
import { storyResponse, storyTask } from './support/story-protocol'
import { createBookAgentRepository, createMemoryAgentRepository } from '../src/features/agents/repository'
import { appendEntry } from '../src/features/agents/commands'
import { sessionProjection } from '../src/features/agents/compaction'
import { navigateStoryReading, readingBrief, refreshReading, saveReading } from '../src/features/story/reading'

type Row = Record<string, unknown>
const opened: ReturnType<typeof createWorkspace>[] = []
afterEach(async () => {
  for (const workspace of opened.splice(0)) {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name)
  }
})

async function setup(count = 25, fetcher: typeof fetch = vi.fn(async (_url, init) => storyResponse(JSON.parse(init?.body as string)))) {
  const key = crypto.randomUUID(), workspace = createWorkspace({ settingsName: `reading-${key}`, bookPrefix: `reading-${key}-book-` })
  opened.push(workspace)
  await workspace.settings.books.put({ id: 'a', title: '分页信件', sourceFileName: '信件.txt', createdAt: new Date().toISOString() })
  const db = workspace.openBook('a'), source = '同一封信逐步传递，后来揭示了早先疑问。'
  await db.chapters.bulkPut(Array.from({ length: count }, (_, i) => ({ bookId: 'a', chapterIndex: String(i + 1), chapterName: `第${i + 1}章`, order: i, charCount: source.length })))
  await db.table('chapterTexts').bulkPut(Array.from({ length: count }, (_, i) => ({ bookId: 'a', chapterIndex: String(i + 1), text: source })))
  await db.table('extractionReceipts').bulkPut(Array.from({ length: count }, (_, i) => ['worldAssets', 'narrativeAssets'].map(substep => ({ key: `${i + 1}:${substep}`, bookId: 'a', chapterIndex: String(i + 1), substep, originIds: [] }))).flat())
  await db.table('nodes').bulkPut(Array.from({ length: count }, (_, i) => ({ id: `N${String(i + 1).padStart(3, '0')}`, bookId: 'a', name: `信件事件${i + 1}`, summary: '同一封信继续流转', process: source, actors: [], quote: source, confidence: 1, revision: 1, createdBy: 'P1', chapterIndex: String(i + 1), chapterName: `第${i + 1}章`, order: 0, eventLineIds: [] })))
  const models = createModelService(workspace, { fetch: fetcher, wait: async (_ms, signal) => signal.throwIfAborted() })
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://reading-fixture.invalid/v1', aggregationContextWindow: 65536 }, 'fixture-only')
  return { workspace, db, models, service: createStoryService(workspace, models), fetcher }
}
const bodyOf = (init?: RequestInit) => JSON.parse(init?.body as string)
const reading = async (service: ReturnType<typeof createStoryService>) => (await service.read('a')).reading
const messageText = (value: unknown) => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => typeof part?.text === 'string' ? part.text : '').join('') : ''

it('翻页回执重放不会跳过下一页，过期页号返回当前页而不丢进度', async () => {
  const nodes = Array.from({ length: 21 }, (_, i) => ({ id: `N${i}`, bookId: 'a', name: `信件${i}`, summary: '独立进展', chapterIndex: '1', revision: 1, order: i }))
  const repo = createMemoryAgentRepository('a', { nodes, chapters: [{ bookId: 'a', chapterIndex: '1', order: 0 }], pipelineRuns: [{ id: 'r', bookId: 'a' }] })
  const scope = { bookId: 'a', runId: 'r', taskId: 't', sessionId: 's', phase: 'window_link' }
  const first = await repo.transaction(true, async store => {
    const state = await refreshReading(store, 'r', 's', 'window_link'); await saveReading(store, 'r', 'window_link', state)
    return state.currentPageId
  })
  const move = (callId: string, currentPageId?: string) => repo.transaction(true, store => navigateStoryReading(store, scope, { direction: 'next', ...(currentPageId ? { currentPageId } : {}) }, callId))
  const advanced = await move('next-1', first!)
  expect(advanced.page).toMatchObject({ page: { pageNumber: 2 } })
  const replay = await move('next-1', first!)
  expect(replay.page).toMatchObject({ page: { pageNumber: 2 } })
  const stale = await move('next-2', first!)
  expect(stale).toMatchObject({ ok: true, complete: false })
  expect(stale.page).toMatchObject({ page: { pageNumber: 2 } })
})

it('当前页增加节点时先返回更新后的本页，重放同次翻页不会把新内容标为已读', async () => {
  const nodes = Array.from({ length: 11 }, (_, i) => ({ id: `N${i}`, bookId: 'a', name: `信件${i}`, summary: '独立进展', chapterIndex: '1', revision: 1, order: i }))
  const repo = createMemoryAgentRepository('a', { nodes, chapters: [{ bookId: 'a', chapterIndex: '1', order: 0 }], pipelineRuns: [{ id: 'r', bookId: 'a' }] })
  const scope = { bookId: 'a', runId: 'r', taskId: 't', sessionId: 's', phase: 'window_link' }
  const first = await repo.transaction(true, async store => {
    const state = await refreshReading(store, 'r', 's', 'window_link'); await saveReading(store, 'r', 'window_link', state)
    await store.put('nodes', { ...nodes[0], id: 'N-new', name: '补出的伏笔', order: 0.5 })
    return state.currentPageId
  })
  const move = (callId: string) => repo.transaction(true, store => navigateStoryReading(store, scope, { direction: 'next' }, callId))
  const updated = await move('same-navigation')
  expect(updated).toMatchObject({ ok: true, complete: false, page: { page: { id: first, pageNumber: 1, ids: expect.arrayContaining(['N-new']) } } })
  const replay = await move('same-navigation')
  expect(replay).toMatchObject({ complete: false, page: { page: { id: first, pageNumber: 1 } } })
  const state = await repo.transaction(false, store => refreshReading(store, 'r', 's', 'window_link'))
  expect(state.pages.every(page => page.checkedFingerprint !== page.fingerprint)).toBe(true)
  expect(await move('read-updated-page')).toMatchObject({ complete: false, page: { page: { pageNumber: 2 } } })
})

it.each([true, false])('孤立节点挂入事件线后不跳过新出现的阅读页（提供页号：%s）', async withPageId => {
  const nodes = [1, 2].map(i => ({ id: `N${i}`, bookId: 'a', name: `信件${i}`, summary: '独立进展', chapterIndex: '1', revision: 1, order: i }))
  const line = { id: 'L1', bookId: 'a', title: '信件流转', nodeIds: ['N1'], cause: '收到匿名信', process: '信件流传', result: '继续流转', lineStatus: 'open', revision: 1 }
  const repo = createMemoryAgentRepository('a', { nodes, chapters: [{ bookId: 'a', chapterIndex: '1', order: 0 }], eventLines: [line], pipelineRuns: [{ id: 'r', bookId: 'a' }] })
  const scope = { bookId: 'a', runId: 'r', taskId: 't', sessionId: 's', phase: 'global_review' }
  const first = await repo.transaction(true, async store => {
    const state = await refreshReading(store, 'r', 's', 'global_review'); await saveReading(store, 'r', 'global_review', state)
    await store.put('eventLines', { ...line, nodeIds: ['N1', 'N2'], revision: 2 }); return state.currentPageId
  })
  const move = (callId: string, pageId?: string) => repo.transaction(true, store => navigateStoryReading(store, scope, { direction: 'next', ...(withPageId ? { currentPageId: pageId } : {}) }, callId))
  const refreshed = await move('orphan-finished', first!)
  expect(refreshed).toMatchObject({ complete: false, page: { page: { type: 'line_segment', ids: ['N1', 'N2'] } } })
  const currentId = (refreshed.page!.page as Row).id as string
  const saved = await repo.transaction(false, async store => ((await store.get('pipelineRuns', 'r'))!.storyReading as Row).global_review as Row)
  expect(saved.currentPageId).toBe(currentId)
  expect((saved.pages as Row[]).every(page => page.checkedFingerprint !== page.fingerprint)).toBe(true)
  expect(await move('orphan-finished', first!)).toMatchObject({ complete: false, page: { page: { id: currentId } } })
  expect(await move('line-segment-finished', currentId)).toMatchObject({ complete: false, page: { page: { type: 'line_summary' } } })
})

it('复核依次阅读孤立节点、长线分段、整线及本会话疑点，未解线索保留也能完成', async () => {
  const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `N${i + 1}`, bookId: 'a', name: `信件${i + 1}`, summary: '独立进展', chapterIndex: '1', revision: 1, order: i }))
  const note = { id: 'note-a', bookId: 'a', sessionId: 's', title: '来信者仍未揭晓', status: 'active', nodeIds: ['N1'], lineIds: ['L1'], revision: 1 }
  const repo = createMemoryAgentRepository('a', {
    nodes, chapters: [{ bookId: 'a', chapterIndex: '1', order: 0 }], pipelineRuns: [{ id: 'r', bookId: 'a' }],
    eventLines: [{ id: 'L1', bookId: 'a', title: '信件流转', nodeIds: nodes.slice(0, 11).map(node => node.id), cause: '收到匿名信', process: '信件流传', result: '来信者未知', lineStatus: 'open', revision: 1 }],
    storyEditorNotes: [note, { ...note, id: 'note-other', sessionId: 'other-session' }],
  })
  const scope = { bookId: 'a', runId: 'r', taskId: 't', sessionId: 's', phase: 'global_review' }
  const state = await repo.transaction(true, async store => {
    const value = await refreshReading(store, 'r', 's', 'global_review'); await saveReading(store, 'r', 'global_review', value); return value
  })
  expect(state.pages.map(page => page.type)).toEqual(['node_page', 'line_segment', 'line_segment', 'line_summary', 'note_page'])
  expect(state.pages[0].ids).toEqual(['N12'])
  expect(state.pages.at(-1)?.ids).toEqual(['note-a'])
  const briefs: Row[] = [await repo.transaction(false, store => readingBrief(store, 'a', 's', 'global_review', state)) as Row]
  let complete = false
  for (const [index, page] of state.pages.entries()) {
    const result = await repo.transaction(true, store => navigateStoryReading(store, scope, { direction: 'next', currentPageId: page.id, reason: '原文尚未揭晓，保留线索。' }, `review-${index}`))
    complete = result.complete
    if (result.page) briefs.push(result.page)
  }
  expect(complete).toBe(true)
  expect(briefs[1].page).toMatchObject({ segment: 1, totalSegments: 2 })
  expect((briefs[3].workItems as Row[])[0]).toMatchObject({ kind: 'eventLine', id: 'L1' })
  expect(await repo.transaction(false, store => store.get('storyEditorNotes', note.id))).toEqual(note)
})

it('AI未翻页而提前结束时只保留当前页，程序不自动送入后页', async () => {
  const bodies: Row[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    bodies.push(bodyOf(init))
    return agentStream([{ name: 'finish_story_batch', args: { summary: '这页尚需查证，先保留进度。' } }])
  })
  const { service, db } = await setup(25, fetcher)
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect(bodies).toHaveLength(1)
  const { input } = storyTask(bodies[0])
  expect(input.page).toMatchObject({ pageNumber: 1, totalPages: 3 })
  expect(input.workItems.map((item: Row) => item.id)).toEqual(Array.from({ length: 10 }, (_, i) => `N${String(i + 1).padStart(3, '0')}`))
  expect(await reading(service)).toMatchObject({ pageNumber: 1, checked: 0, complete: false })
  expect(await db.table('eventLines').count()).toBe(0)
})

it('同一条模型回复调用两次下一页，只推进一次并返回尚未阅读的第二页', async () => {
  const pages: number[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const { input } = storyTask(bodyOf(init)); pages.push(input.page.pageNumber)
    return pages.length === 1
      ? agentStream([{ name: 'navigate_story_pages', args: { direction: 'next' } }, { name: 'navigate_story_pages', args: { direction: 'next' } }])
      : agentStream([{ name: 'finish_story_batch', args: { summary: '已收到下一页，暂存进度。' } }])
  })
  const { service } = await setup(25, fetcher)
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect(pages).toEqual([1, 2])
  expect(await reading(service)).toMatchObject({ checked: 1, pageNumber: 2, complete: false })
})

it('同一会话由AI翻过三页，多次保存持续续接原线且不重写旧经过', async () => {
  const bodies: Row[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => { const body = bodyOf(init); bodies.push(body); return storyResponse(body) })
  const { service, db } = await setup(25, fetcher)
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  const lines = await db.table('eventLines').toArray()
  expect(lines).toHaveLength(1)
  expect(lines[0].nodeIds).toHaveLength(25)
  expect(lines[0].cause).toBe('信件待转交')
  expect(lines[0].process).toContain('交信、传信与归还')
  expect(lines[0].process).toContain('N011')
  expect(lines[0].process).toContain('N025')
  expect(await reading(service)).toMatchObject({ checked: 3, totalPages: 3, complete: true })
  expect([...new Set(bodies.map(body => storyTask(body).input.page.pageNumber))]).toEqual([1, 2, 3])
  const lastMessages = bodies.at(-1)!.messages as { role: string; content?: unknown }[]
  expect(lastMessages.filter(row => row.role === 'user' && /"queue":"window_nodes"/.test(messageText(row.content)))).toHaveLength(1)
  expect(await db.table('storySessions').count()).toBe(1)
  const progress = await db.table('compileProgress').get('P3'), run = await db.table('pipelineRuns').get(progress.runId)
  expect(run.appliedCommands).toHaveLength(3)
}, 30000)

it('第二页上下文超长且翻页回执被压缩掉后，重建精确当前页并继续到第三页', async () => {
  let rejected = false, compactions = 0
  const workRequests: Row[] = [], recoveredRequests: Row[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = bodyOf(init), messages = body.messages as { role: string; content?: unknown }[]
    if (messages.some(row => messageText(row.content).includes('【需要压缩的原始会话数据】'))) {
      compactions++
      return agentStream([{ name: 'submit_result', args: { summary: '此前已核对部分资料，后续请根据程序提供的当前资料继续。' } }])
    }
    workRequests.push(body)
    const { input } = storyTask(body)
    if (input.page.pageNumber === 2 && !rejected) {
      rejected = true
      await repository.transaction(true, async store => {
        const session = (await store.rows('storySessions'))[0]
        await appendEntry(store, { bookId: 'a', profile: 'story_editor', phase: 'window_link', runId: '', taskId: '', sessionId: String(session.id), owner: '', workItemIds: [] }, {
          type: 'message', message: { role: 'user', content: `第二页长历史标记：${'本段核对旧信的来由与去向，详细内容见原记录。'.repeat(2500)}`, timestamp: Date.now() },
        })
      })
      return new Response(JSON.stringify({ error: { message: 'maximum context length exceeded', type: 'invalid_request_error', code: 'context_length_exceeded' } }), { status: 400 })
    }
    if (rejected) recoveredRequests.push(body)
    return agentStream([{ name: 'navigate_story_pages', args: { direction: 'next', currentPageId: input.page.id } }])
  })
  const { service, workspace } = await setup(25, fetcher)
  const repository = createBookAgentRepository(workspace, 'a')
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect(rejected).toBe(true)
  expect(compactions).toBeGreaterThan(0)
  expect(workRequests.map(body => storyTask(body).input.page.pageNumber)).toEqual([1, 2, 2, 3])
  const restoredMessages = recoveredRequests[0].messages as { role: string; content?: unknown }[]
  const restoredTasks = restoredMessages.filter(row => row.role === 'user' && messageText(row.content).startsWith('【当前阅读页】')).map(row => {
    const content = messageText(row.content); return JSON.parse(content.slice(content.indexOf('{')))
  })
  expect(restoredTasks).toHaveLength(1)
  expect(restoredTasks[0].page).toMatchObject({ pageNumber: 2, totalPages: 3, ids: Array.from({ length: 10 }, (_, i) => `N${String(i + 11).padStart(3, '0')}`) })
  expect(restoredMessages.filter(row => row.role === 'tool')).toHaveLength(0)
  expect(JSON.stringify(restoredMessages)).not.toContain('本段核对旧信的来由与去向，详细内容见原记录。'.repeat(100))
  expect(await reading(service)).toMatchObject({ checked: 3, totalPages: 3, complete: true })
  const state = await service.read('a')
  const projection = await sessionProjection(repository, state.session.id!)
  expect(projection.messages.some(row => row.role === 'user' && messageText(row.content).startsWith('【当前阅读页】') && messageText(row.content).includes('"pageNumber":2'))).toBe(true)
}, 30000)

it('可以回看上一页，没有修改也可往返翻页，不制造写入', async () => {
  let returned = false, movingBack = false
  const pages: number[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const { input } = storyTask(bodyOf(init)); pages.push(input.page.pageNumber)
    if (input.page.pageNumber === 2 && !returned) { returned = true; movingBack = true; return agentStream([{ name: 'navigate_story_pages', args: { direction: 'previous' } }]) }
    if (movingBack) { expect(input.page.pageNumber).toBe(1); movingBack = false }
    return agentStream([{ name: 'navigate_story_pages', args: { direction: 'next', reason: '这些独立事件已核对。' } }])
  })
  const { service, db } = await setup(15, fetcher)
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect(pages).toEqual([1, 2, 1, 2])
  expect(await reading(service)).toMatchObject({ checked: 2, complete: true })
  const progress = await db.table('compileProgress').get('P3'), run = await db.table('pipelineRuns').get(progress.runId)
  expect(run.appliedCommands).toEqual([])
})

it('取消后从未完成页恢复，同书旧线和已保存段落不重复创建', async () => {
  let interrupted = false, restoring = false
  const restoredPages: number[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = bodyOf(init), { input } = storyTask(body)
    if (!restoring && input.page.pageNumber === 2) {
      interrupted = true
      return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('取消', 'AbortError')), { once: true }) })
    }
    if (restoring) restoredPages.push(input.page.pageNumber)
    return storyResponse(body)
  })
  const { service, workspace, models, db } = await setup(25, fetcher)
  const pending = service.start('a')
  await vi.waitFor(() => expect(interrupted).toBe(true), { timeout: 10000 })
  service.cancel('a'); await pending
  const line = (await db.table('eventLines').toArray())[0]
  expect(line.nodeIds).toHaveLength(10)
  const sessionId = (await db.table('storySessions').toArray())[0].id
  restoring = true
  const resumed = createStoryService(workspace, models)
  await resumed.start('a')
  expect(resumed.state('a')?.error).toBeUndefined()
  expect(restoredPages[0]).toBe(2)
  expect(restoredPages).not.toContain(1)
  expect(await reading(resumed)).toMatchObject({ complete: true })
  expect(await db.table('eventLines').toArray()).toMatchObject([{ id: line.id, nodeIds: expect.any(Array) }])
  expect((await db.table('eventLines').get(line.id)).nodeIds).toHaveLength(25)
  expect((await db.table('storySessions').toArray())[0].id).toBe(sessionId)
}, 30000)

it('全书复核对长线逐段阅读后再核对整线，使用独立复核提示词', async () => {
  const reviewPages: Row[] = [], systems: string[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = bodyOf(init), { input } = storyTask(body)
    if (input.phase === 'global_review') {
      reviewPages.push(input.page)
      systems.push((body.messages as { role: string; content: string }[]).filter(row => row.role === 'system').map(row => row.content).join('\n'))
    }
    return storyResponse(body)
  })
  const { service } = await setup(25, fetcher)
  await service.start('a'); await service.review('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect(reviewPages.filter(page => page.type === 'line_segment')).toHaveLength(3)
  expect(reviewPages.filter(page => page.type === 'line_summary')).toHaveLength(1)
  expect(reviewPages.at(-1)?.type).toBe('line_summary')
  expect(systems.every(system => system.includes('复核'))).toBe(true)
  expect((await service.read('a')).progress).toMatchObject({ phase: 'global_review', status: 'completed' })
}, 30000)
