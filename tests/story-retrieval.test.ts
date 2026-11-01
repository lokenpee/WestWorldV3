import { expect, it } from 'vitest'
import { createMemoryAgentRepository, type Row } from '../src/features/agents/repository'
import { readTool, type Scope } from '../src/features/agents/queries'
import { resultContracts, validate } from '../src/features/agents/contracts'
import { buildStoryContext, searchStoryContext, selectStoryBatch } from '../src/features/story/retrieval'

const node = (id: string, chapterIndex: string, summary: string): Row => ({ id, bookId: 'book', name: summary, summary, process: '详细经过。'.repeat(2000), chapterIndex, chapterName: chapterIndex, actors: ['李某'], order: 0, confidence: 1, revision: 1, createdBy: 'P1', quote: '' })
it('新节点可召回百章之前的线索、旧节点和事件线，输入只含短摘要', async () => {
  const old = node('old', '8', '陈某把旧印章交给李某，去向不明'), current = node('new', '165', '李某拿出旧印章证明身份')
  const repo = createMemoryAgentRepository('book', { nodes: [old, current], eventLines: [{ id: 'line', bookId: 'book', title: '旧印章的去向', cause: '印章用途未明', nodeIds: ['old'], chapters: ['8'], lineStatus: 'open' }], storyEditorNotes: [
    { id: 'clue', bookId: 'book', sessionId: 'session', key: 'seal', status: 'active', statement: '旧印章：李某为何保管，后续用途是什么？', nodeIds: ['old'] },
    { id: 'foreign-session', bookId: 'book', sessionId: 'other', key: 'seal', status: 'active', statement: '旧印章', nodeIds: ['old'] },
  ] })
  const context = await repo.transaction(false, store => buildStoryContext(store, 'book', 'session', [current], 'node'))
  expect(context.related.map(row => row.id)).toEqual(expect.arrayContaining(['old', 'clue', 'line']))
  expect(context.related.map(row => row.id)).not.toContain('foreign-session')
  expect(JSON.stringify(context)).not.toContain('详细经过。')
  expect(context.assigned).toHaveLength(1)
  const early = await repo.transaction(false, store => buildStoryContext(store, 'book', 'session', [old], 'node'))
  expect(early.related.map(row => row.id)).not.toContain('new')
  const global = await repo.transaction(false, store => buildStoryContext(store, 'book', 'session', [old], 'node', true))
  expect(global.related.map(row => row.id)).toContain('new')
})

it('线索检索可分页，已解决事项按需读取', async () => {
  const repo = createMemoryAgentRepository('book', { storyEditorNotes: Array.from({ length: 25 }, (_, i) => ({ id: `note-${i}`, bookId: 'book', sessionId: 's', key: String(i), statement: '旧印章的线索', status: i === 24 ? 'resolved' : 'active' })) })
  const first = await repo.transaction(false, store => searchStoryContext(store, 'book', 's', { terms: ['旧印章'], limit: 20 }))
  expect(first).toMatchObject({ totalCount: 24, truncated: true, nextOffset: 20 })
  expect(() => validate(resultContracts.get('search_story_context')!, first)).not.toThrow()
  const next = await repo.transaction(false, store => searchStoryContext(store, 'book', 's', { terms: ['旧印章'], offset: first.nextOffset }))
  expect(next.data).toHaveLength(4)
  expect(new Set([...first.data, ...next.data].map(row => row.id)).size).toBe(24)
  expect((await repo.transaction(false, store => searchStoryContext(store, 'book', 's', { terms: ['旧印章'], include_resolved: true }))).totalCount).toBe(25)
})

it('长节点按内容量缩小批次，超大单项仍有处理机会', () => {
  const long = Array.from({ length: 20 }, (_, i) => node(String(i), '1', '事件'))
  expect(selectStoryBatch(long)).toHaveLength(1)
  expect(selectStoryBatch(Array.from({ length: 30 }, (_, i) => ({ id: String(i), summary: '简短节点' })))).toHaveLength(20)
})

it('长节点详情通过字符游标完整续读，每页满足工具结构和大小限制', async () => {
  const row = node('long', '1', '长事件')
  const repo = createMemoryAgentRepository('book', { nodes: [row] })
  const scope: Scope = { bookId: 'book', profile: 'story_editor', phase: 'window_link', sessionId: 's', runId: 'r', taskId: 't', owner: 'o', workItemIds: [] }
  let offset = 0, joined = '', pages = 0
  do {
    const result = await repo.transaction(false, store => readTool(store, scope, 'get_node_detail', { ids: ['long'], char_offset: offset, maxChars: 2000 }))
    validate(resultContracts.get('get_node_detail')!, result)
    const part = (result.data as Row[])[0]
    expect(String(part.text).length).toBeLessThanOrEqual(2000)
    joined += part.text; pages++
    if (!part.truncated) break
    expect(Number(part.nextCharOffset)).toBeGreaterThan(offset)
    offset = Number(part.nextCharOffset)
  } while (pages < 20)
  expect(pages).toBeGreaterThan(1)
  expect(JSON.parse(joined)).toMatchObject({ id: 'long', process: row.process })
})
