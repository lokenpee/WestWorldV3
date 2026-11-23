import { strings, text } from '../agents/contracts'
import type { AgentStore, Row } from '../agents/repository'
import type { EventNode } from '../assets/types'
import { outlineStatistics } from './outline'
import { storyView } from './views'
import { storyNodeFields } from './outlineToolSchema'

export async function readOutlineDetail(store: AgentStore, { bookId, sessionId }: { bookId: string; sessionId?: string }, args: Row, maxResults = 20) {
  const kind = text(args.kind)
  const table = ({ node: 'nodes', event: 'storyEvents', eventLine: 'eventLines', note: 'storyEditorNotes' } as Record<string, string>)[kind]
  if (!table || args.members === 'parent_lines' && kind !== 'event' || args.members === 'legacy_nodes' && kind !== 'eventLine') throw new Error('INVALID_ARGS:详情类型与成员选项不匹配。')
  const fields = args.fields
  if (kind === 'node' && (!Array.isArray(fields) || !fields.length || fields.some(field => !storyNodeFields.includes(field)) || new Set(fields).size !== fields.length)) {
    throw new Error('INVALID_ARGS:查节点须在 fields 明确选择一个或多个字段：' + storyNodeFields.join('、'))
  }
  if (kind !== 'node' && fields !== undefined) throw new Error('INVALID_ARGS:fields 仅用于选择节点字段。')
  const data: Row[] = [], missingIds: string[] = []
  const memberOffset = Number(args.memberOffset ?? 0), memberLimit = Number(args.memberLimit ?? 20)
  let sessionNotes: Row[] | undefined
  for (const id of strings(args.ids).slice(0, maxResults)) {
    let row = await store.get(table, id)
    if (!row && kind === 'note' && sessionId) {
      sessionNotes ??= (await store.rows('storyEditorNotes')).filter(note => note.bookId === bookId && note.sessionId === sessionId)
      row = sessionNotes.find(note => note.key === id)
    }
    if (!row || row.bookId !== bookId || kind === 'note' && row.sessionId !== sessionId) { missingIds.push(id); continue }
    if (kind === 'node') {
      const selected: Row = { kind, id }
      for (const field of fields as string[]) {
        if (field === 'process') {
          const process = text(row.process), offset = Number(args.char_offset ?? 0)
          const end = Math.min(offset + Number(args.maxChars ?? 1000), process.length)
          Object.assign(selected, { process: process.slice(offset, end), charOffset: offset, nextCharOffset: end < process.length ? end : null })
        } else if (['actors', 'locationNames', 'clues'].includes(field)) selected[field] = strings(row[field])
        else selected[field] = text(row[field])
      }
      data.push(selected)
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
    const pageIds = members.slice(memberOffset, end)
    const children = key === 'eventIds' || key === 'nodeIds' ? (await Promise.all(pageIds.map(id => store.get(key === 'eventIds' ? 'storyEvents' : 'nodes', id)))).flatMap(child => child ? [{ id: child.id, name: text(child.title ?? child.name).slice(0, 80), ...(key === 'eventIds' ? { summary: text(child.summary).slice(0, 120) } : { chapterIndex: child.chapterIndex }) }] : []) : []
    data.push({ ...view, [key]: pageIds, ...(children.length ? (key === 'nodeIds' ? { evidenceNodes: children } : { events: children }) : {}), ...(kind === 'event' && key !== 'lineIds' ? { lineIds: parents.slice(0, 12).map(line => line.id) } : {}), ...(kind === 'event' ? { lineCount: parents.length } : {}),
      chapterCount: statistics.chapters.length, chapters: statistics.chapters.slice(0, 20), characterIds: statistics.characterIds.slice(0, 20), characterNames: statistics.characterNames.slice(0, 20), locationNames: statistics.locationNames.slice(0, 20), memberCount: members.length, memberOffset, nextMemberOffset: end < members.length ? end : null })
  }
  return { data, missingIds }
}
