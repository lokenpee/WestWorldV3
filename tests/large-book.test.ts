import { expect, it } from 'vitest'
import { emptyTables, validateBookData, type BookData } from '../src/features/backup/data'
import { encodeBackup, inspectBackup, restoredTables } from '../src/features/backup/codec'
import { layoutNetwork } from '../src/features/network/layout'
import type { EventLine, EventNode } from '../src/features/assets/types'
import type { Chapter } from '../src/lib/storage/workspace'

it('200章、2000节点、100事件线与长会话可完整导出恢复和布局', async () => {
  const now = '2026-11-01T00:00:00.000Z', bookId = 'large-book'
  const data: BookData = { book: { id: bookId, title: '大资料量样本', sourceFileName: 'large.txt', createdAt: now }, tables: emptyTables() }
  for (let i = 1; i <= 200; i++) {
    const text = `第${i}章\n${'古城中，书信与旅程继续。'.repeat(100)}`
    data.tables.chapters.push({ bookId, chapterIndex: String(i), chapterName: `第${i}章`, order: i - 1, charCount: text.length })
    data.tables.chapterTexts.push({ bookId, chapterIndex: String(i), text })
  }
  data.tables.nodes = Array.from({ length: 2000 }, (_, i) => ({ id: `N${String(i).padStart(4, '0')}`, bookId, name: `节点${i}`, summary: `第${i}个事件`, process: '完整经过和人物关系。'.repeat(50), chapterIndex: String(Math.floor(i / 10) + 1), chapterName: `第${Math.floor(i / 10) + 1}章`, actors: [], quote: '', confidence: 1, createdBy: 'P1', revision: 1, order: i % 10, eventLineIds: [] as string[] }))
  data.tables.eventLines = Array.from({ length: 100 }, (_, i) => {
    const members = data.tables.nodes.slice(i * 20, Math.min(2000, i * 20 + 21))
    return { id: `L${i}`, bookId, title: `事件线${i}`, nodeIds: members.map(row => row.id), chapters: [...new Set(members.map(row => row.chapterIndex))], cause: '线索出现', process: '事件持续发展', result: '继续核对', lineStatus: 'open', createdBy: 'P3', revision: 1, updatedAt: now }
  })
  for (const line of data.tables.eventLines) for (const id of line.nodeIds as string[]) (data.tables.nodes.find(row => row.id === id)!.eventLineIds as string[]).push(String(line.id))
  for (const [kind, rows] of [['node', data.tables.nodes], ['eventLine', data.tables.eventLines]] as const) for (const row of rows) data.tables.assetLifecycle.push({ key: `${kind}:${row.id}`, bookId, kind, originId: row.id, currentId: row.id, state: 'live', revision: 1, updatedAt: now })
  data.tables.storySessions = [{ id: 'session', bookId, profile: 'story_editor', kind: 'initial', title: '长会话', status: 'active', nextOrdinal: 100, leafId: 'entry-99', createdAt: now, updatedAt: now }]
  data.tables.storySessionEntries = Array.from({ length: 100 }, (_, i) => ({ id: `entry-${i}`, bookId, sessionId: 'session', ordinal: i, parentId: i ? `entry-${i - 1}` : null, type: 'message', message: { role: 'user', content: `历史条目${i}：${'完整原始记录。'.repeat(200)}`, timestamp: i }, createdAt: now }))
  expect(await validateBookData(data)).toEqual([])
  const backup = await encodeBackup(data), inspected = await inspectBackup(backup.bytes)
  expect(inspected.ok).toBe(true)
  const restored = await restoredTables(inspected.data!, 'restored-large')
  expect(restored.nodes).toHaveLength(2000); expect(restored.eventLines).toHaveLength(100)
  expect(restored.chapterTexts.map(row => row.text)).toEqual(data.tables.chapterTexts.map(row => row.text))
  expect(restored.storySessionEntries.map(row => row.message)).toEqual(data.tables.storySessionEntries.map(row => row.message))
  expect(await validateBookData({ book: { ...data.book, id: 'restored-large' }, tables: restored })).toEqual([])
  const layout = layoutNetwork(restored.nodes as unknown as EventNode[], restored.eventLines as unknown as EventLine[], restored.chapters as unknown as Chapter[])
  expect(layout.nodes).toHaveLength(2000)
  expect(new Set(layout.nodes.map(row => row.id)).size).toBe(2000)
  expect(layout.nodes.filter(row => row.lineIds.length > 1)).toHaveLength(99)
  expect(layout.edges.every(edge => layout.nodes.some(row => row.id === edge.source) && layout.nodes.some(row => row.id === edge.target))).toBe(true)
}, 30000)
