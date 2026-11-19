import { writeFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { estimateTextTokens } from '../src/features/agents/context'
import { records, strings } from '../src/features/agents/contracts'
import { resultContracts, validate } from '../src/features/agents/contracts'
import { readTool, type Scope } from '../src/features/agents/queries'
import { createMemoryAgentRepository, type Row } from '../src/features/agents/repository'
import { buildStoryContext } from '../src/features/story/retrieval'
import { storyMessages, storyView } from '../src/features/story/views'

test('opt12：2501成员长线与后续短线的关联预算、目录大小和完整成员分页', async () => {
  const bookId = 'opt12-book', sessionId = 'opt12-session', members = Array.from({ length: 2501 }, (_, index) => `N${String(index).padStart(6, '0')}`)
  const currentId = members.at(-1)!
  const nodes: Row[] = members.map((id, index) => ({ id, bookId, chapterIndex: String(index + 1), name: '背景见闻', summary: '路人散步', actors: [], order: 0, revision: 1, createdBy: 'P1' }))
  const current = { ...nodes.at(-1)!, name: '三河帮旧信', summary: '三河帮追查旧信来历' }
  nodes[nodes.length - 1] = current
  const longLine: Row = { id: 'A-long', bookId, title: '三河帮旧信', summary: '三河帮追查旧信来历', lineStatus: 'open', nodeIds: members, revision: 1 }
  const shortLine: Row = { id: 'B-short', bookId, title: '三河帮旧信', summary: '三河帮追查旧信来历', lineStatus: 'open', nodeIds: [currentId], revision: 1 }
  const repo = createMemoryAgentRepository(bookId, { nodes, eventLines: [longLine, shortLine] })
  const scope: Scope = { bookId, sessionId, profile: 'story_editor', workflow: 'story_pages_v3', phase: 'window_link', runId: 'r', taskId: 't', owner: 'o', workItemIds: [] }
  const started = performance.now()
  const directory = await repo.transaction(false, store => readTool(store, scope, 'search_story_context', { kind: 'eventLine', node_ids: [currentId], terms: ['三河帮'], limit: 12 }))
  const directoryRows = records(directory.data)
  validate(resultContracts.get('search_story_context')!, directory)
  expect(directoryRows.map(row => row.id)).toEqual(['A-long', 'B-short'])
  expect(directory.totalCount).toBe(2)
  const context = await repo.transaction(false, store => buildStoryContext(store, bookId, sessionId, [current], 'node', false, true))
  expect(context.totalRelated).toBe(2)
  expect(context.assigned).toMatchObject([{ id: currentId, name: current.name, summary: current.summary }])
  const candidateTokens = directoryRows.map(row => ({ id: row.id, tokens: estimateTextTokens(JSON.stringify(row)), nodeIds: strings(row.nodeIds).length, memberCount: row.memberCount ?? null }))

  // 走现有正式详情工具，验证精简目录不会缩短真实事件线或截断后续分页。
  let memberOffset: number | null = 0, detailPages = 0
  const restored: string[] = []
  while (memberOffset !== null) {
    const detail = await repo.transaction(false, store => readTool(store, scope, 'get_story_detail', { kind: 'eventLine', ids: ['A-long'], memberOffset, memberLimit: 100 }))
    const row = records(detail.data)[0]
    expect(row.memberCount).toBe(members.length)
    expect(row.summary).toBe(longLine.summary)
    expect(row.fields_omitted).toBeUndefined()
    restored.push(...strings(row.nodeIds)); detailPages++
    if (row.nextMemberOffset !== null) expect(Number(row.nextMemberOffset)).toBeGreaterThan(memberOffset)
    memberOffset = row.nextMemberOffset === null ? null : Number(row.nextMemberOffset)
  }
  expect(restored).toEqual(members)
  expect(detailPages).toBe(26)

  // 单独留下概述超预算的条件，避免仅缩短成员数组后仍break掉后续候选。
  const oversized = { ...longLine, nodeIds: [currentId], summary: `三河帮追查旧信来历。${'线索发展'.repeat(2000)}` }
  await repo.transaction(true, store => store.put('eventLines', oversized))
  const oversizedContext = await repo.transaction(false, store => buildStoryContext(store, bookId, sessionId, [current], 'node', false, true))
  expect(oversizedContext.totalRelated).toBe(2)
  expect(await repo.transaction(false, store => store.get('eventLines', 'A-long'))).toEqual(oversized)

  // 默认只验证稳定语义；显式before/after比较同样本，不把当前缺陷锁进常规回归。
  const expectation = process.env.WW_OPT12_EXPECT ?? 'after'
  if (expectation !== undefined) {
    expect(['before', 'after']).toContain(expectation)
    if (expectation === 'before') {
      expect(context.related).toHaveLength(0)
      expect(oversizedContext.related).toHaveLength(0)
      expect(candidateTokens[0].tokens).toBeGreaterThan(3000)
      expect(candidateTokens[0].nodeIds).toBe(2501)
    } else {
      expect(context.related.map(row => row.id)).toEqual(['A-long', 'B-short'])
      expect(oversizedContext.related.map(row => row.id)).toEqual(['A-long', 'B-short'])
      expect(candidateTokens[0].tokens).toBeLessThan(3000)
      expect(directoryRows[0].memberCount).toBe(2501)
      expect(JSON.stringify(directoryRows[0])).toContain(currentId)
      for (const related of [context.related, oversizedContext.related]) expect(related.reduce((sum, row) => sum + estimateTextTokens(JSON.stringify(row)), 0)).toBeLessThanOrEqual(3000)
    }
  }
  const result = {
    optimization: 12, sample: { nodes: nodes.length, longLineMembers: members.length, shortLineMembers: 1, relevantLines: 2, contextBudget: 3000 },
    rawLongLineTokens: estimateTextTokens(JSON.stringify(storyView(longLine, 'eventLine'))),
    directory: { candidates: candidateTokens, estimatedTokens: estimateTextTokens(JSON.stringify(directory)), responseBytes: Buffer.byteLength(JSON.stringify(directory)) },
    context: { returnedRelated: context.related.length, relatedIds: context.related.map(row => row.id), estimatedTokens: estimateTextTokens(JSON.stringify(context.related)), totalRelated: context.totalRelated, truncated: context.truncated },
    oversizedSummary: { rawTokens: estimateTextTokens(JSON.stringify(storyView(oversized, 'eventLine'))), returnedRelated: oversizedContext.related.length, relatedIds: oversizedContext.related.map(row => row.id), estimatedTokens: estimateTextTokens(JSON.stringify(oversizedContext.related)), truncated: oversizedContext.truncated },
    detail: { pages: detailPages, restoredMembers: restored.length, exact: restored.every((id, index) => id === members[index]) },
    elapsedMs: +(performance.now() - started).toFixed(2),
  }
  if (process.env.WW_OPT12_RESULT) writeFileSync(process.env.WW_OPT12_RESULT, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result))
})

test('超预算的前一候选不遮挡后续短线，消息重组保留目录截断信息', async () => {
  const node = { id: 'N', bookId: 'b', name: '三河帮旧信', summary: '三河帮追查旧信来历', chapterIndex: '1' }
  const repo = createMemoryAgentRepository('b', { nodes: [node], eventLines: [{ id: 'B-short', bookId: 'b', title: node.name, summary: node.summary, nodeIds: ['N'], lineStatus: 'open' }],
    storyEditorNotes: [{ id: 'A-note', bookId: 'b', sessionId: 's', status: 'active', statement: `${node.name}。${node.summary}。${'疑点'.repeat(10000)}`, nodeIds: ['N'], lineIds: [] }] })
  const context = await repo.transaction(false, store => buildStoryContext(store, 'b', 's', [node], 'node', false, true))
  expect(context.totalRelated).toBe(2)
  expect(context.related.map(row => row.id)).toEqual(['B-short'])
  expect(context.truncated).toBe(true)
  const data = { data: [{ id: 'L', kind: 'eventLine', title: '三河帮', summary: '部分概述', summaryTruncated: true, nodeIds: ['N'], memberCount: 2501, membersTruncated: true, lineStatus: 'open' }], totalCount: 1, truncated: false, nextOffset: null }
  const projected = storyMessages([{ role: 'toolResult', toolName: 'search_story_context', toolCallId: 'call', content: [{ type: 'text', text: JSON.stringify(data) }], isError: false, timestamp: 0 }])
  expect(JSON.parse((projected[0].content[0] as { text: string }).text)).toEqual(data)
})
