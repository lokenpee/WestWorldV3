import { expect, it } from 'vitest'
import { createMemoryAgentRepository, type Row } from '../src/features/agents/repository'
import { readTool, type Scope } from '../src/features/agents/queries'
import { resultContracts, validate } from '../src/features/agents/contracts'

const scope: Scope = { bookId: 'book', profile: 'asset_editor', phase: 'ai_identity', owner: 'owner', runId: 'run', taskId: 'task', workItemIds: [] }
const source = (count: number) => createMemoryAgentRepository('book', {
  chapters: Array.from({ length: count }, (_, i) => ({ bookId: 'book', chapterIndex: String(i + 1), order: i, charCount: 100 })),
  chapterTexts: Array.from({ length: count }, (_, i) => ({ bookId: 'book', chapterIndex: String(i + 1), text: '甲'.repeat(100) })),
  characters: [{ bookId: 'book', id: 'person', sourceChapters: ['1', '21'] }],
})

it('二十章之后使用游标前进，续读只加载当前位置及后续正文', async () => {
  const repo = source(21), loaded: string[] = []
  const read = (args: Row) => repo.transaction(false, store => readTool({ ...store,
    rows: table => { if (table === 'chapterTexts') throw new Error('禁止加载全文'); return store.rows(table) },
    get: (table, id) => { if (table === 'chapterTexts') loaded.push(id); return store.get(table, id) },
  }, scope, 'read_original', { chapter_range: ['1', '21'], maxChars: 8000, ...args }))
  const first = await read({})
  expect(first.nextCursor).toEqual({ chapterIndex: '21', offset: 0 })
  expect(first.text).toHaveLength(2000)
  loaded.length = 0
  const last = await read({ cursor: first.nextCursor })
  expect(last).toMatchObject({ truncated: false, nextCursor: null, chapters: ['21'] })
  expect(loaded).toEqual(['21'])
  expect(last.text).toHaveLength(100)
  expect(() => validate(resultContracts.get('read_original')!, last)).not.toThrow()
  expect(await read({ offset: 2000 })).toMatchObject({ text: '甲'.repeat(100), truncated: false })
})

it('离散章节与资产来源取交集，返回片段保留章内位置', async () => {
  const repo = source(21)
  const result = await repo.transaction(false, store => readTool(store, scope, 'read_original', { asset_ids: ['person'], chapter_indices: ['21'], maxChars: 20 }))
  expect(result).toMatchObject({ chapters: ['21'], nextCursor: { chapterIndex: '21', offset: 20 }, segments: [{ chapterIndex: '21', offset: 0, text: '甲'.repeat(20) }] })
})
