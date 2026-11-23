import { strings, text } from '../agents/contracts'
import type { AgentStore, Row } from '../agents/repository'
import { usesOutline } from './outline'

/** 目录与阶段快照共用顺序；快照保留节点引用，复核目录展开成员节点标题。 */
export async function storyDirectory(store: AgentStore, includeMembers = false) {
  const [lines, events, nodes, chapters] = await Promise.all(['eventLines', 'storyEvents', 'nodes', 'chapters'].map(table => store.rows(table)))
  const chapterOrder = new Map(chapters.map(row => [text(row.chapterIndex), Number(row.order)]))
  const order = (row: Row) => chapterOrder.get(text(row.chapterIndex)) ?? 0
  nodes.sort((a, b) => order(a) - order(b) || Number(a.order ?? 0) - Number(b.order ?? 0) || text(a.id).localeCompare(text(b.id)))
  const rank = new Map(nodes.map((row, i) => [text(row.id), i]))
  const members = (row: Row) => strings(row.nodeIds).sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity))
  const eventRows = events.map(row => {
    const ids = members(row), start = rank.get(ids[0]), end = rank.get(ids.at(-1) ?? '')
    return { id: text(row.id), title: text(row.title), nodeIds: ids,
      ...(includeMembers ? { evidenceNodes: ids.flatMap(id => {
        const index = rank.get(id)
        return index === undefined ? [] : [{ id, name: nodes[index].name }]
      }) } : {}), firstChapter: start === undefined ? '' : nodes[start].chapterIndex, lastChapter: end === undefined ? '' : nodes[end].chapterIndex }
  }).sort((a, b) => (rank.get(a.nodeIds[0]) ?? Infinity) - (rank.get(b.nodeIds[0]) ?? Infinity) || a.id.localeCompare(b.id))
  const eventOrder = new Map(eventRows.map((row, i) => [row.id, i]))
  const lineRows = lines.map(row => ({ id: text(row.id), title: text(row.title),
    eventIds: strings(row.eventIds).sort((a, b) => (eventOrder.get(a) ?? Infinity) - (eventOrder.get(b) ?? Infinity)),
    ...(!usesOutline(row) ? { nodeIds: members(row) } : {}) })).sort((a, b) => a.id.localeCompare(b.id))
  const linked = new Set([...eventRows.flatMap(row => row.nodeIds), ...lineRows.flatMap(row => row.nodeIds ?? [])])
  return { lines: lineRows, events: eventRows, orphans: nodes.filter(row => !linked.has(text(row.id))).map(row => ({ kind: 'node', id: row.id, name: row.name, chapterIndex: row.chapterIndex })) }
}
