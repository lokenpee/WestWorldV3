import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createModelService } from '../src/features/models/service'
import { defaultConfig } from '../src/features/models/types'
import { createStoryService } from '../src/features/story/service'
import { agentStream, agentTextStream } from './support/agent-protocol'
import { storyResponse, storyTask } from './support/story-protocol'
import { createBookAgentRepository, createMemoryAgentRepository } from '../src/features/agents/repository'
import { appendEntry } from '../src/features/agents/commands'
import { sessionProjection } from '../src/features/agents/compaction'
import { navigateStoryReading, readingBrief, refreshReading, saveReading } from '../src/features/story/reading'
import { applyOutline } from '../src/features/story/outlineCommands'
import { presentStoryPage } from '../src/features/story/readingPresentation'
import { emptyTables, tableNames } from '../src/features/backup/data'
import { encodeBackup, inspectBackup, restoredTables } from '../src/features/backup/codec'

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
function thinkingLengthStream(thinking: string, content?: string) {
  const chunk = (delta: unknown, finish_reason: string | null, usage?: object) => ({ id: 'story-thinking-truncated', object: 'chat.completion.chunk', created: 1, model: 'test-agent', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })
  const chunks = [
    chunk({ role: 'assistant', reasoning_content: thinking, ...(content === undefined ? {} : { content }) }, null),
    chunk({}, 'length', { prompt_tokens: 7, completion_tokens: 13, total_tokens: 20 }),
  ]
  return new Response(chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
}

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

it('全书复核为共享事件只建一页概况，中文页只送真实归属与成员资料', async () => {
  const nodes = [1, 2].map(i => ({ id: `N${i}`, bookId: 'a', name: `账目进展${i}`, summary: '查账发现新的侵吞证据', process: '核对前院交回的账册', clues: ['账册钤印'], new_facts: ['旧事实'], chapterIndex: String(i), revision: 1, order: i }))
  const event = { id: 'E1', bookId: 'a', title: '清查赖家', nodeIds: ['N1', 'N2'], summary: '核查赖家账目并发现侵吞证据。', coreClue: '赖大是否侵吞公中财物。', revision: 1 }
  const lines = [
    { id: 'L1', bookId: 'a', title: '赖家线', summary: '围绕查账和追赃展开。', coreClue: '赖大贪污及其牵连范围。', eventIds: ['E1'], nodeIds: [], revision: 1 },
    { id: 'L2', bookId: 'a', title: '荣府账目线', eventIds: ['E1'], nodeIds: [], revision: 1 },
  ]
  const repo = createMemoryAgentRepository('a', { nodes, storyEvents: [event], eventLines: lines, chapters: nodes.map((node, order) => ({ bookId: 'a', chapterIndex: node.chapterIndex, order })), pipelineRuns: [{ id: 'r', bookId: 'a', storyOutlineVersion: 1 }] })
  const state = await repo.transaction(false, store => refreshReading(store, 'r', 's', 'global_review'))
  expect(state.pages.filter(page => page.type === 'event_summary')).toHaveLength(1)
  expect(state.pages.map(page => page.type)).toEqual(['line_segment', 'event_summary', 'line_summary', 'line_summary'])
  expect(state.pages.filter(page => page.type === 'line_summary')).toHaveLength(2)
  expect(state.pages.findIndex(page => page.type === 'line_summary')).toBeGreaterThan(state.pages.findLastIndex(page => page.type === 'event_summary'))
  const eventPage = state.pages.find(page => page.type === 'event_summary')!
  const brief = await repo.transaction(false, store => readingBrief(store, 'a', 's', 'global_review', { ...state, currentPageId: eventPage.id }, true))
  expect(brief?.event).toMatchObject({ id: 'E1', summary: event.summary, coreClue: event.coreClue })
  expect(presentStoryPage(brief)).toMatchObject({ 阶段: '全书复核', 本页: { 类型: '事件说明' }, 事件成员概述: [{ 编号: 'N1' }, { 编号: 'N2' }] })
  const linePage = state.pages.find(page => page.type === 'line_summary')!
  const lineBrief = await repo.transaction(false, store => readingBrief(store, 'a', 's', 'global_review', { ...state, currentPageId: linePage.id }, true))
  expect(lineBrief?.line).toMatchObject({ id: 'L1', summary: lines[0].summary, coreClue: lines[0].coreClue })
  expect(presentStoryPage(lineBrief)).toMatchObject({ 本页: { 类型: '故事线说明' }, 所属事件: [{ 编号: 'E1', 名称: event.title, 概况: event.summary, 核心关键线索: event.coreClue }] })
  expect(lineBrief).not.toHaveProperty('related')
  const members = await repo.transaction(false, store => readingBrief(store, 'a', 's', 'global_review', state, true))
  expect(presentStoryPage(members)).toMatchObject({ 本页: { 类型: '成员复核' }, 本页待阅读节点: [{ 节点: [{ 编号: 'N1', 详细经过: '核对前院交回的账册', 线索: ['账册钤印'] }] }, { 节点: [{ 编号: 'N2' }] }] })
  expect(JSON.stringify(presentStoryPage(members))).not.toContain('旧事实')
})

it('旧运行误标完成的空白说明重新待检，字段写齐才可翻页', async () => {
  const scope = { bookId: 'a', runId: 'r', taskId: 't', sessionId: 's', phase: 'global_review', outline: true }
  const node = { id: 'N1', bookId: 'a', chapterIndex: '1', name: '查账', summary: '查看公中账目' }
  const event = { id: 'E1', bookId: 'a', title: '查账', nodeIds: ['N1'], summary: '', coreClue: '' }
  const line = { id: 'L1', bookId: 'a', title: '赖家线', eventIds: ['E1'], nodeIds: ['N1'], summary: '查账引出追赃', coreClue: '  ' }
  const repo = createMemoryAgentRepository('a', { nodes: [node], storyEvents: [event], eventLines: [line], pipelineRuns: [{ id: 'r', bookId: 'a', storyOutlineVersion: 1 }] })
  await repo.transaction(true, async store => {
    const state = await refreshReading(store, 'r', 's', 'global_review')
    await saveReading(store, 'r', 'global_review', { ...state, currentPageId: null, pages: state.pages.map(page => ({ ...page, checkedFingerprint: page.fingerprint })) })
    const refreshed = await refreshReading(store, 'r', 's', 'global_review')
    expect(refreshed.currentPageId).toBe('event_summary:E1:0')
    await saveReading(store, 'r', 'global_review', refreshed)
  })
  const next = (id: string) => repo.transaction(true, store => navigateStoryReading(store, scope, { direction: 'next' }, id))
  await expect(next('empty-event')).rejects.toThrow('两项均为必填')
  await repo.transaction(true, store => store.put('storyEvents', { ...event, summary: '查看公中账目', coreClue: '公中账目的亏空引发清查' }))
  expect(await next('written-event')).toMatchObject({ complete: false, page: { page: { type: 'line_summary' } } })
  await expect(next('empty-line')).rejects.toThrow('两项均为必填')
  await repo.transaction(true, store => store.put('eventLines', { ...line, coreClue: '公中财物能否追回' }))
  expect(await next('written-line')).toMatchObject({ complete: true })
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
  expect(input.directory).toMatchObject({ 故事线数量: 0, 事件数量: 0 })
  expect(input.workItems[0]).toMatchObject({ process: expect.any(String) })
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

it('同一会话由AI翻过三页，多次保存持续续接原事件', async () => {
  const bodies: Row[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => { const body = bodyOf(init); bodies.push(body); return storyResponse(body) })
  const { service, db, workspace } = await setup(25, fetcher)
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  const lines = await db.table('eventLines').toArray()
  expect(lines).toHaveLength(1)
  expect(lines[0].nodeIds).toHaveLength(25)
  expect(lines[0].summary).toBe('')
  const events = await db.table('storyEvents').toArray()
  expect(events).toMatchObject([{ title: '传递信件', nodeIds: lines[0].nodeIds }])
  expect(lines[0].process).toBe('')
  expect(await reading(service)).toMatchObject({ checked: 3, totalPages: 3, complete: true })
  expect([...new Set(bodies.map(body => storyTask(body).input.page.pageNumber))]).toEqual([1, 2, 3])
  const lastMessages = bodies.at(-1)!.messages as { role: string; content?: unknown }[]
  expect(lastMessages.filter(row => row.role === 'user' && messageText(row.content).startsWith('【当前阅读页】'))).toHaveLength(1)
  expect(storyTask(bodies.find(body => storyTask(body).input.page.pageNumber === 2)!).input.directory).toMatchObject({ 故事线数量: 1, 事件数量: 1, 故事线: [{ 名称: '信件流转', 事件: [{ 名称: '传递信件', 节点编号: expect.arrayContaining(['N001']) }] }] })
  expect(await db.table('storySessions').count()).toBe(1)
  const progress = await db.table('compileProgress').get('P3'), run = await db.table('pipelineRuns').get(progress.runId)
  expect(run.appliedCommands).toHaveLength(3)
  const book = (await workspace.settings.books.get('a'))!
  const tables = emptyTables()
  for (const name of tableNames) if (name !== 'extractionReceipts') tables[name] = await db.table(name).toArray()
  const backup = await encodeBackup({ book, tables })
  expect(backup.manifest.formatVersion).toBe(13)
  const inspected = await inspectBackup(backup.bytes)
  expect(inspected.ok).toBe(true)
  const restored = await restoredTables(inspected.data!, 'copy')
  expect(restored.storyEvents).toMatchObject([{ id: events[0].id, bookId: 'copy', nodeIds: lines[0].nodeIds }])
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
  expect(restoredTasks[0].本页).toMatchObject({ 页码: 2, 总页数: 3 })
  expect(storyTask(recoveredRequests[0]).input.page.ids).toEqual(Array.from({ length: 10 }, (_, i) => `N${String(i + 11).padStart(3, '0')}`))
  expect(restoredMessages.filter(row => row.role === 'tool')).toHaveLength(0)
  expect(JSON.stringify(restoredMessages)).not.toContain('本段核对旧信的来由与去向，详细内容见原记录。'.repeat(100))
  expect(await reading(service)).toMatchObject({ checked: 3, totalPages: 3, complete: true })
  const state = await service.read('a')
  const projection = await sessionProjection(repository, state.session.id!)
  expect(projection.messages.some(row => row.role === 'user' && messageText(row.content).startsWith('【当前阅读页】') && messageText(row.content).includes('"页码": 2'))).toBe(true)
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

it.each(['window_link', 'global_review'])('%s普通说明后继续查询、保存及翻页，不用总结校验结束', async phase => {
  let explanations = 0, sawContinuation = false
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = bodyOf(init), { input } = storyTask(body)
    if (input.phase === phase) {
      if (explanations++ < 2) return agentTextStream('先核对这条故事线的前因后果，再继续查阅。')
      sawContinuation = true
      expect(JSON.stringify(body.messages)).toContain('先核对这条故事线的前因后果')
    }
    return storyResponse(body)
  })
  const { db, service } = await setup(2, fetcher)
  await service.start('a')
  if (phase === 'global_review') await service.review('a')
  expect(sawContinuation).toBe(true)
  expect(service.state('a')?.error).toBeUndefined()
  expect((await service.read('a')).progress?.status).toBe('completed')
  expect(await db.table('eventLines').count()).toBe(1)
  expect(JSON.stringify(await db.table('storySessionEntries').toArray())).toContain('先核对这条故事线的前因后果')
})

it.each(['window_link', 'global_review'] as const)('%s连续两次仅思考被截断后暂停，保留当前页、思考和用量，继续可以完成', async phase => {
  let resuming = false
  const interruptedBodies: Row[] = [], resumedPages: string[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = bodyOf(init), { input } = storyTask(body)
    if (input.phase === phase) {
      if (resuming) resumedPages.push(input.page.id)
      else {
        interruptedBodies.push(body)
        if (interruptedBodies.length <= 2) return thinkingLengthStream(`截断思考-${phase}-${interruptedBodies.length}：正在判断信件流转。`, phase === 'global_review' ? ' \n ' : undefined)
        return new Response(JSON.stringify({ error: { message: 'fixture stopped unexpected third request' } }), { status: 402 })
      }
    }
    return storyResponse(body)
  })
  const { db, service, workspace, models } = await setup(2, fetcher)
  const modelCalls = vi.spyOn(models, 'agent')
  if (phase === 'global_review') await service.start('a')
  await (phase === 'window_link' ? service.start('a') : service.review('a'))
  expect(interruptedBodies).toHaveLength(2)
  expect(modelCalls.mock.calls.every(([, options]) => options?.reasoning === undefined)).toBe(true)
  expect(service.state('a')?.error).toContain('THINKING_TRUNCATED')
  const pageId = storyTask(interruptedBodies[0]).input.page.id
  expect(storyTask(interruptedBodies[1]).input.page.id).toBe(pageId)
  expect(await reading(service)).toMatchObject({ checked: 0, pageNumber: 1, complete: false })
  const progress = await db.table('compileProgress').get('P3'), run = await db.table('pipelineRuns').get(progress.runId)
  expect(progress).toMatchObject({ status: 'paused', phase })
  expect(run.storyReading[phase].currentPageId).toBe(pageId)
  expect(run.storyReading[phase].pages.every((page: Row) => page.checkedFingerprint !== page.fingerprint)).toBe(true)
  expect(run.usage).toMatchObject({ input: 14, output: 26, totalTokens: 40 })
  const entries = await db.table('storySessionEntries').toArray()
  const traces = entries.filter(row => row.type === 'request_trace' && String(row.thinking).includes(`截断思考-${phase}`))
  expect(traces).toHaveLength(2)
  expect(traces.map(row => row.usage)).toEqual([expect.objectContaining({ input: 7, output: 13, totalTokens: 20 }), expect.objectContaining({ input: 7, output: 13, totalTokens: 20 })])
  const assistants = entries.filter(row => row.type === 'message' && row.message?.role === 'assistant' && row.message.stopReason === 'length')
  expect(assistants).toHaveLength(2)
  expect(JSON.stringify(assistants)).toContain(`截断思考-${phase}-1`)
  expect(JSON.stringify(assistants)).toContain(`截断思考-${phase}-2`)
  resuming = true
  const resumed = createStoryService(workspace, models)
  await (phase === 'window_link' ? resumed.start('a') : resumed.review('a'))
  expect(resumedPages[0]).toBe(pageId)
  expect(resumed.state('a')?.error).toBeUndefined()
  expect((await resumed.read('a')).progress?.status).toBe('completed')
  expect(await reading(resumed)).toMatchObject({ complete: true })
  expect(await db.table('eventLines').count()).toBe(1)
}, 30000)

it('成功保存事件线清除此前的思考截断计数，后续两次截断暂停并保留提交，继续不重复创建', async () => {
  let resuming = false, interruptedRequests = 0, savedLineId = ''
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = bodyOf(init), { input } = storyTask(body)
    if (resuming) {
      expect(JSON.stringify(body.messages)).toContain(savedLineId)
      return agentStream([{ name: 'navigate_story_pages', args: { direction: 'next', currentPageId: input.page.id } }])
    }
    interruptedRequests++
    if (interruptedRequests === 2) return agentStream([{ name: 'save_story_outline', args: { operations: [
      { op: 'create_line', ref: 'letter', title: '信件流转' },
      { op: 'create_event', ref: 'delivery', title: '传递信件', lineId: '$letter', nodeIds: input.workItems.map((item: Row) => item.id) },
    ] } }])
    if (interruptedRequests <= 4) return thinkingLengthStream(`已保存前后的截断思考-${interruptedRequests}`)
    return new Response(JSON.stringify({ error: { message: 'fixture stopped unexpected fifth request' } }), { status: 402 })
  })
  const { db, service, workspace, models } = await setup(2, fetcher)
  await service.start('a')
  expect(interruptedRequests).toBe(4)
  expect(service.state('a')?.error).toContain('THINKING_TRUNCATED')
  expect(await reading(service)).toMatchObject({ checked: 0, complete: false })
  const lines = await db.table('eventLines').toArray()
  expect(lines).toHaveLength(1)
  expect(lines[0].nodeIds).toEqual(['N001', 'N002'])
  savedLineId = lines[0].id
  const progress = await db.table('compileProgress').get('P3'), beforeRun = await db.table('pipelineRuns').get(progress.runId)
  expect(beforeRun.appliedCommands).toHaveLength(1)
  expect(beforeRun.usage).toMatchObject({ input: 21, output: 39, totalTokens: 60 })
  const commitId = beforeRun.appliedCommands[0].commitId
  resuming = true
  const resumed = createStoryService(workspace, models)
  await resumed.start('a')
  expect(resumed.state('a')?.error).toBeUndefined()
  expect(await reading(resumed)).toMatchObject({ complete: true })
  expect(await db.table('eventLines').toArray()).toEqual(lines)
  const afterRun = await db.table('pipelineRuns').get(progress.runId)
  expect(afterRun.appliedCommands).toHaveLength(1)
  expect(afterRun.appliedCommands[0].commitId).toBe(commitId)
  expect(JSON.stringify(await db.table('storySessionEntries').toArray())).toContain('已保存前后的截断思考-4')
}, 30000)

it.each([
  { name: 'navigate_story_pages', args: { direction: 'invalid-direction' }, detail: 'direction' },
  { name: 'unavailable_tool', args: {}, detail: 'not found' },
])('$name重复失败保留真实错误和未完成页，不冒充完成或继续请求', async ({ name, args, detail }) => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => agentStream([{ name, args }]))
  const { db, service } = await setup(2, fetcher)
  await service.start('a')
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(service.state('a')?.error).toContain('同一工具调用重复失败')
  expect(service.state('a')?.error).toContain(detail)
  expect(service.state('a')?.error).not.toContain('任务总结')
  expect((await service.read('a')).progress?.status).toBe('paused')
  expect((await reading(service))?.checked).toBe(0)
  expect(await db.table('eventLines').count()).toBe(0)
})

it('普通说明后API报错立即退出，保留实际错误而不是总结错误', async () => {
  let requests = 0
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => ++requests === 1
    ? agentTextStream('继续检查当前事件。')
    : new Response(JSON.stringify({ error: { message: 'Insufficient Balance', type: 'insufficient_balance_error' } }), { status: 402 }))
  const { service } = await setup(2, fetcher)
  await service.start('a')
  expect(requests).toBe(2)
  expect(service.state('a')?.error).toContain('Insufficient Balance')
  expect(service.state('a')?.error).not.toContain('完成确认')
  expect((await service.read('a')).progress?.status).toBe('paused')
  expect((await reading(service))?.checked).toBe(0)
})

it('全书复核对长线逐段阅读后再核对整线，使用独立复核提示词', async () => {
  const reviewPages: Row[] = [], systems: string[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = bodyOf(init)
    if (body.messages.some((message: Row) => messageText(message.content).includes('【需要压缩的原始会话数据】'))) return storyResponse(body)
    const { input } = storyTask(body)
    if (input.phase === 'global_review') {
      reviewPages.push(input.page)
      systems.push((body.messages as { role: string; content: string }[]).filter(row => row.role === 'system').map(row => row.content).join('\n'))
    }
    return storyResponse(body)
  })
  const { service } = await setup(25, fetcher)
  await service.start('a'); await service.review('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect([...new Map(reviewPages.map(page => [page.id, page.type])).values()]).toEqual(['line_segment', 'line_segment', 'line_segment', 'line_structure', 'event_summary', 'line_summary'])
  expect(reviewPages.at(-1)?.type).toBe('line_summary')
  expect(systems.every(system => system.includes('复核'))).toBe(true)
  expect((await service.read('a')).progress).toMatchObject({ phase: 'global_review', status: 'completed' })
}, 30000)


it('P3重新开始显式开新轮：复用不发模型请求，全量重新检查且保留事件线', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => storyResponse(bodyOf(init)))
  const { service, db } = await setup(12, fetcher)
  await service.start('a')
  const first = (await db.table('compileProgress').get('P3')).runId
  const calls = fetcher.mock.calls.length
  await service.start('a', 'reuse')
  expect(service.state('a')?.error).toBeUndefined()
  expect((await db.table('compileProgress').get('P3')).runId).not.toBe(first)
  expect(fetcher.mock.calls.length).toBe(calls)
  expect(await reading(service)).toMatchObject({ complete: true, reused: 12 })
  await service.start('a', 'all')
  expect(service.state('a')?.error).toBeUndefined()
  expect(fetcher.mock.calls.length).toBeGreaterThan(calls)
  expect(await db.table('eventLines').count()).toBe(1)
  await service.review('a')
  expect(service.state('a')?.error).toBeUndefined()
  const reviewed = fetcher.mock.calls.length
  await service.review('a', 'reuse')
  expect(service.state('a')?.error).toBeUndefined()
  expect(fetcher.mock.calls.length).toBe(reviewed)
  expect(await reading(service)).toMatchObject({ complete: true })
}, 30000)

it('快检保留大纲，覆盖重串清空大纲，两者都另起模型上下文并保留历史', async () => {
  const bodies: Row[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = bodyOf(init)
    bodies.push(body)
    return storyResponse(body)
  })
  const { service, db, workspace } = await setup(12, fetcher)
  await service.start('a')
  const initial = await db.table('compileProgress').get('P3'), originalEvents = await db.table('storyEvents').toArray()
  const nodeIds = await db.table('nodes').toCollection().primaryKeys()
  const initialBody = bodies.length
  await service.start('a', 'quick')
  const quick = await db.table('compileProgress').get('P3')
  expect(quick.editorSessionId).not.toBe(initial.editorSessionId)
  expect((bodies[initialBody].messages as Row[]).every(row => ['system', 'user'].includes(String(row.role)))).toBe(true)
  expect(bodies.slice(initialBody).map(body => storyTask(body).input.quick)).toEqual([true, true])
  expect(await db.table('storyEvents').toArray()).toEqual(originalEvents)
  const quickEnd = bodies.length
  await service.start('a', 'replace')
  expect(service.state('a')?.error).toBeUndefined()
  const restarted = await db.table('compileProgress').get('P3')
  expect(restarted.editorSessionId).not.toBe(quick.editorSessionId)
  expect((bodies[quickEnd].messages as Row[]).every(row => ['system', 'user'].includes(String(row.role)))).toBe(true)
  expect(storyTask(bodies[quickEnd]).input.directory).toMatchObject({ 故事线数量: 0, 事件数量: 0 })
  expect((await db.table('storyEvents').toArray())[0].id).not.toBe(originalEvents[0].id)
  expect(await db.table('nodes').toCollection().primaryKeys()).toEqual(nodeIds)
  expect(await db.table('storySessions').get(initial.editorSessionId)).toMatchObject({ status: 'archived' })
  expect(await db.table('storySessionEntries').where('sessionId').equals(initial.editorSessionId).count()).toBeGreaterThan(0)
  const tables = emptyTables()
  for (const table of tableNames) if (table !== 'extractionReceipts') tables[table] = await db.table(table).toArray()
  const backup = await encodeBackup({ book: (await workspace.settings.books.get('a'))!, tables })
  expect((await inspectBackup(backup.bytes)).ok).toBe(true)
}, 30000)


it('首次目录和翻页目录直接构成读取依据，不用查详情就能保存', async () => {
  let eventId = '', savedPage = '', requests = 0
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    requests++
    const { input, messages } = storyTask(bodyOf(init))
    for (const message of messages.filter(message => message.role === 'tool')) {
      try { const result = JSON.parse(messageText(message.content)); if (result.created?.delivery) eventId = result.created.delivery } catch { /* 只读取写回执 */ }
    }
    if (savedPage === input.page.id) return agentStream([{ name: 'navigate_story_pages', args: { direction: 'next' } }])
    savedPage = input.page.id
    const nodeIds = input.workItems.map((item: Row) => item.id)
    return agentStream([{ name: 'save_story_outline', args: { operations: eventId ? [{ op: 'attach_nodes', eventId, nodeIds }] : [
      { op: 'create_line', ref: 'letter', title: '连续的信件' },
      { op: 'create_event', ref: 'delivery', title: '传递信件', lineId: '$letter', nodeIds },
    ] } }])
  })
  const { service, db } = await setup(12, fetcher)
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect(requests).toBe(4)
  expect((await db.table('eventLines').toArray())[0].nodeIds).toHaveLength(12)
})


it('启动失败清除旧轮活动身份，保留原成果且修正后能重试', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => storyResponse(bodyOf(init)))
  const { service, db, models } = await setup(1, fetcher)
  await models.settings.clearCredential('custom')
  await service.start('a')
  expect(service.state('a')).toMatchObject({ running: false, error: '请先保存整理模型与密钥。' })
  expect(service.state('a')?.runId).toBeUndefined()
  expect(await db.table('compileProgress').get('P3')).toBeUndefined()
  expect(fetcher).not.toHaveBeenCalled()
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://reading-fixture.invalid/v1', aggregationContextWindow: 65536 }, 'fixture-only')
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  const progress = await db.table('compileProgress').get('P3')
  expect(service.state('a')?.runId).toBe(progress.runId)
  const before = fetcher.mock.calls.length
  await models.settings.clearCredential('custom')
  await service.start('a', 'all')
  expect(service.state('a')?.error).toBe('请先保存整理模型与密钥。')
  expect(service.state('a')?.runId).toBeUndefined()
  expect(fetcher.mock.calls.length).toBe(before)
  expect(await db.table('compileProgress').get('P3')).toEqual(progress)
  expect(await db.table('eventLines').count()).toBe(1)
})

it('复核独立接手节点、事件、故事线及无引用的疑点，保留本轮逐项结论', async () => {
  const firstRequests: Row[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = bodyOf(init)
    if (storyTask(body).input.phase === 'global_review') firstRequests.push(body)
    return storyResponse(body)
  })
  const { db, service } = await setup(2, fetcher)
  await service.start('a')
  const linking = await db.table('compileProgress').get('P3')
  const [event] = await db.table('storyEvents').toArray()
  const [line] = await db.table('eventLines').toArray()
  const secondEvent = { ...event, id: 'E-other', title: '寄信人身份', nodeIds: ['N002'] }
  await db.table('storyEvents').put(secondEvent)
  await db.table('eventLines').put({ ...line, eventIds: [...line.eventIds, secondEvent.id] })
  const original = { bookId: 'a', sessionId: linking.editorSessionId, status: 'active', revision: 1, kind: 'review', stage: 'P3', evidence: [], basisFingerprint: '', nodeIds: [], lineIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  const references = [{ nodeIds: ['N001'] }, { eventIds: [event.id] }, { lineIds: [line.id] }, {}, { nodeIds: ['N002'] }, { eventIds: [event.id] }]
  await db.table('storyEditorNotes').bulkPut(references.map((ref, i) => ({ ...original, ...ref, id: 'old-' + i, key: '信件疑点' + i, statement: '核对收信与转交的承接' + i })))
  await db.table('storyEditorMemory').put({ id: linking.editorSessionId, workingSummary: '串联私有摘要', revision: 1 })
  await service.review('a')
  expect(service.state('a')?.error).toBeUndefined()
  const review = await db.table('compileProgress').get('P3')
  expect(review.editorSessionId).not.toBe(linking.editorSessionId)
  expect(JSON.stringify(firstRequests[0].messages)).not.toMatch(/串联私有摘要|本页待阅读节点.*已保存的大纲|按页维护剧情大纲/)
  expect((firstRequests[0].messages as Row[]).some(row => row.role === 'assistant' || row.role === 'tool')).toBe(false)
  expect((await service.history('a')).sessions.map(row => row.id)).toEqual(expect.arrayContaining([linking.editorSessionId, review.editorSessionId]))
  const progress = await reading(service)
  expect(progress?.complete).toBe(true)
  expect(progress?.conclusions).toHaveLength(6)
  expect(firstRequests.some(body => storyTask(body).input.eventGroup?.length === 2)).toBe(true)
  expect((await db.table('storyEvents').toArray()).every(row => row.summary && row.coreClue)).toBe(true)
  expect(progress?.conclusions.every(row => String(row.conclusion).includes('来信者'))).toBe(true)
  const calls = firstRequests.length
  await service.review('a', 'reuse')
  expect(service.state('a')?.error).toBeUndefined()
  expect(firstRequests.length).toBe(calls)
  const changed = await db.table('nodes').get('N001')
  await db.table('nodes').put({ ...changed, summary: '后文揭示寄信人' })
  await service.review('a', 'reuse')
  expect(service.state('a')?.error).toBeUndefined()
  expect(firstRequests.length).toBeGreaterThan(calls)
  expect((await reading(service))?.conclusions).toHaveLength(6)
}, 30000)

it('复核在途暂停后，从同一会话继续已保存的步骤', async () => {
  let reached!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { reached = resolve })
  const wait = new Promise<void>(resolve => { release = resolve })
  let pauseOnce = true
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = bodyOf(init)
    if (pauseOnce && storyTask(body).input.phase === 'global_review') {
      pauseOnce = false
      reached()
      await wait
    }
    return storyResponse(body)
  })
  const { workspace, db, models, service } = await setup(2, fetcher)
  await service.start('a')
  const work = service.review('a')
  await started
  service.pause('a')
  release()
  await work
  const paused = await db.table('compileProgress').get('P3')
  expect(paused).toMatchObject({ phase: 'global_review', status: 'paused' })
  const resumed = createStoryService(workspace, models)
  await resumed.review('a')
  expect(resumed.state('a')?.error).toBeUndefined()
  expect((await resumed.read('a')).progress).toMatchObject({ editorSessionId: paused.editorSessionId, runId: paused.runId, status: 'completed' })
}, 30000)

it('仍有归属和交接问题时拒绝提前写说明，未给疑点结论时停在原页', async () => {
  const bookId = 'a', sessionId = 'review', runId = 'r', phase = 'global_review'
  const repo = createMemoryAgentRepository(bookId, {
    pipelineRuns: [{ id: runId, bookId, storyOutlineVersion: 1 }],
    nodes: [{ id: 'N1', bookId, name: '传信', chapterIndex: '1' }],
    storyEvents: [{ id: 'E1', bookId, title: '转交信件', nodeIds: ['N1'] }],
    storyEditorNotes: [{ id: 'Q1', bookId, sessionId, key: '寄信人', statement: '核对来信者身份', status: 'active', eventIds: ['E1'] }],
  })
  const scope = { bookId, sessionId, runId, phase, taskId: 't', profile: 'story_editor' as const, owner: 'test', workItemIds: [] }
  await repo.transaction(true, async store => {
    await saveReading(store, runId, phase, { independent: true, pages: [], currentPageId: null, receipts: [] })
    await saveReading(store, runId, phase, await refreshReading(store, runId, sessionId, phase))
  })
  await expect(repo.transaction(true, store => applyOutline(store, scope, { operations: [{ op: 'update_event', eventId: 'E1', summary: '转交信件', coreClue: '来信下落' }] }, { records: [], queries: [] }, new Date().toISOString()))).rejects.toThrow('归属')
  await expect(repo.transaction(true, store => navigateStoryReading(store, scope, { direction: 'next' }, 'missing'))).rejects.toThrow('noteResults')
  const after = await repo.transaction(false, store => refreshReading(store, runId, sessionId, phase))
  expect(after.pages[0].checkedFingerprint).toBeUndefined()
  expect(after.pages[0].reviewNotes).toHaveProperty('Q1')
})
