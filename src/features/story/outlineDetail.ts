import { strings, text } from '../agents/contracts'
import type { AgentStore, Row } from '../agents/repository'
import type { EventNode } from '../assets/types'
import { outlineStatistics } from './outline'
import { storyView } from './views'

export async function readOutlineDetail(store: AgentStore, bookId: string, args: Row, maxResults = 20) {
  const kind = text(args.kind)
  const table = ({ node: 'nodes', event: 'storyEvents', eventLine: 'eventLines', note: 'storyEditorNotes' } as Record<string, string>)[kind]
  if (!table || args.members === 'parent_lines' && kind !== 'event' || args.members === 'legacy_nodes' && kind !== 'eventLine') throw new Error('INVALID_ARGS:详情类型与成员选项不匹配。')
  const data: Row[] = [], missingIds: string[] = []
  const memberOffset = Number(args.memberOffset ?? 0), memberLimit = Number(args.memberLimit ?? 20)
  for (const id of strings(args.ids).slice(0, maxResults)) {
    const row = await store.get(table, id)
    if (!row || row.bookId !== bookId) { missingIds.push(id); continue }
    if (kind === 'node') {
      const process = text(row.process), charOffset = Number(args.char_offset ?? 0), maxChars = Number(args.maxChars ?? 1000)
      const end = Math.min(charOffset + maxChars, process.length)
      data.push({ ...storyView(row, kind, true), locationNames: strings(row.locationNames), process: process.slice(charOffset, end), charOffset, nextCharOffset: end < process.length ? end : null })
      continue
    }
    if (kind === 'note') { data.push(storyView(row, kind, true)); continue }
    const view = storyView(row, kind, true)
    delete view.nodeIds
    delete view.eventIds
    const parents = kind === 'event' ? (await store.rows('eventLines')).filter(line => line.bookId === bookId && strings(line.eventIds).includes(id)) : []
    const key = args.members === 'parent_lines' ? 'lineIds' : args.members === 'legacy_nodes' ? 'legacyNodeIds' : kind === 'event' ? 'nodeIds' : 'eventIds'
    const members = key === 'lineIds' ? parents.map(line => text(line.id)) : key === 'legacyNodeIds' ? strings(row.legacyNodeIds ?? row.nodeIds) : strings(row[key])
    const statistics = outlineStatistics((await Promise.all(strings(row.nodeIds).map(nodeId => store.get('nodes', nodeId)))).filter(Boolean) as unknown as EventNode[])
    const end = Math.min(memberOffset + memberLimit, members.length)
    data.push({ ...view, [key]: members.slice(memberOffset, end), ...(kind === 'event' && key !== 'lineIds' ? { lineIds: parents.slice(0, 12).map(line => line.id) } : {}), ...(kind === 'event' ? { lineCount: parents.length } : {}),
      chapterCount: statistics.chapters.length, chapters: statistics.chapters.slice(0, 20), characterIds: statistics.characterIds.slice(0, 20), characterNames: statistics.characterNames.slice(0, 20), locationNames: statistics.locationNames.slice(0, 20), memberCount: members.length, memberOffset, nextMemberOffset: end < members.length ? end : null })
  }
  return { data, missingIds }
}
