import { estimateTextTokens } from '../agents/context'
import { records, strings, text } from '../agents/contracts'
import type { AgentStore, Row } from '../agents/repository'
import { storyCatalogView, storyView } from './views'

const excerpt = (value: unknown, size: number) => text(value).slice(0, size)
export const storyBatchBudget = (contextWindow = 65536) => Math.min(8000, Math.max(512, Math.floor(contextWindow * 0.12)))
export function selectStoryBatch<T extends Row>(rows: T[], budget = 8000): T[] {
  const selected: T[] = []; let used = 0
  for (const row of rows) {
    const cost = estimateTextTokens(JSON.stringify(row))
    if (selected.length && (selected.length >= 20 || used + cost > budget)) break
    selected.push(row); used += cost
  }
  return selected
}

export function storyDigest(row: Row, kind: string): Row {
  const source = text(row.summary ?? row.statement)
  return { id: text(row.id), kind, title: excerpt(row.name ?? row.title ?? row.key, 80), summary: source.slice(0, 160),
    chapters: (row.chapterIndex ? [text(row.chapterIndex)] : strings(row.chapters)).slice(0, 8),
    nodeIds: strings(row.nodeIds).slice(0, 12), actors: strings(row.actors).slice(0, 8).map(value => value.slice(0, 64)),
    status: text(row.status ?? row.lineStatus), truncated: source.length > 160 || text(row.name ?? row.title ?? row.key).length > 80 || strings(row.actors).length > 8 || strings(row.actors).some(value => value.length > 64) || strings(row.nodeIds).length > 12 || strings(row.chapters).length > 8,
    estimatedDetailTokens: estimateTextTokens(JSON.stringify(row)) }
}

const stopWords = new Set(['这个', '那个', '自己', '他们', '我们', '已经', '没有', '然后', '一个', '两个', '此时', '因为', '所以', '说道', '说着', '来到', '开始', '时候', '继续', '事件', '节点', '原文', '本章', '进行', '之后', '之前'])
function termsOf(value: string) {
  return [...new Set([...new Intl.Segmenter('zh', { granularity: 'word' }).segment(value)].filter(part => part.isWordLike && part.segment.length >= 2 && !stopWords.has(part.segment)).map(part => part.segment.toLowerCase().slice(0, 64)))]
}
export async function searchStoryContext(store: AgentStore, bookId: string, sessionId: string | undefined, args: Row, lightweight = false, outline = false) {
  const searchable = (row: Row) => [row.name, row.title, row.summary, row.coreClue, row.statement, row.process, ...strings(row.actors), ...strings(row.world_delta),
    ...(outline ? [...strings(row.clues), ...strings(row.locationNames)] : [...strings(row.new_facts)])].map(text).join(' ').toLowerCase()
  const nodes = (await store.rows('nodes')).filter(row => row.bookId === bookId)
  const lines = (await store.rows('eventLines')).filter(row => row.bookId === bookId)
  const events = outline ? (await store.rows('storyEvents')).filter(row => row.bookId === bookId) : []
  const notes = (await store.rows('storyEditorNotes')).filter(row => row.bookId === bookId && row.sessionId === sessionId && (row.status === 'active' || args.include_resolved === true || args.status === 'resolved'))
  const focus = nodes.filter(row => strings(args.node_ids).includes(text(row.id)))
  const explicit = strings(args.terms).map(value => value.trim().toLowerCase().slice(0, 128)).filter(Boolean)
  const names = focus.flatMap(row => [...strings(row.actors)]).filter(value => value.length >= 2).map(value => value.toLowerCase().slice(0, 64))
  const clues = outline ? focus.flatMap(row => strings(row.clues).map(value => value.trim().toLowerCase().slice(0, 128))).filter(Boolean) : []
  const terms = [...new Set([...explicit, ...clues, ...names, ...focus.flatMap(row => termsOf([row.name, row.summary, ...strings(row.world_delta), ...(!outline ? strings(row.new_facts) : [])].map(text).join(' ').slice(0, 2000)))])].slice(0, 64)
  const ids = new Set(focus.map(row => text(row.id)))
  const latestChapter = focus.map(row => text(row.chapterIndex)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1)
  const nodeById = new Map(nodes.map(node => [text(node.id), node]))
  const members = (row: Row) => strings(row.nodeIds).flatMap(id => nodeById.has(id) ? [nodeById.get(id)!] : [])
  const linkedNodes = new Set([...events, ...lines.filter(line => !Array.isArray(line.eventIds) || line.outlinePending)].flatMap(row => strings(row.nodeIds)))
  const candidates = [...nodes.map(row => ({ row, kind: 'node' })), ...lines.map(row => ({ row, kind: 'eventLine' })), ...events.map(row => ({ row, kind: 'event' })), ...notes.map(row => ({ row, kind: 'note' }))].filter(item => !ids.has(text(item.row.id)) && (!args.kind || item.kind === args.kind) && (args.unassignedOnly !== true || item.kind === 'node' && !linkedNodes.has(text(item.row.id))) && (args.include_future === true || !latestChapter || item.kind !== 'node' || text(item.row.chapterIndex).localeCompare(latestChapter, undefined, { numeric: true }) <= 0))
  const range = strings(args.chapter_range)
  const documents = candidates.filter(({ row, kind }) => {
    if (args.status && (kind === 'eventLine' ? row.lineStatus : row.status) !== args.status) return false
    if (range.length) {
      const chapters = row.chapterIndex ? [text(row.chapterIndex)] : strings(row.chapters).length ? strings(row.chapters) : [...strings(row.nodeIds).flatMap(id => nodes.filter(node => node.id === id).map(node => text(node.chapterIndex))), ...records(row.evidence).map(item => text(item.chapterIndex))]
      if (!chapters.some(chapter => chapter.localeCompare(range[0], undefined, { numeric: true }) >= 0 && chapter.localeCompare(range[1], undefined, { numeric: true }) <= 0)) return false
    }
    return true
  }).map(item => ({ ...item, content: [searchable(item.row), ...(item.kind === 'event' ? members(item.row).map(searchable) : [])].join(' ') }))
  const frequency = new Map(terms.map(term => [term, documents.filter(item => item.content.includes(term)).length]))
  const ranked = documents.map(item => {
    const matched = terms.filter(term => item.content.includes(term))
    const linked = strings(item.row.nodeIds).some(id => ids.has(id))
    const score = matched.reduce((sum, term) => sum + (explicit.includes(term) ? 6 : clues.includes(term) ? 3 : outline && names.includes(term) ? 0.5 : 1) * Math.log2(2 + documents.length / Math.max(1, frequency.get(term)!)), 0) + (linked ? 30 : 0)
    return { ...item, matched, score }
  }).filter(item => !terms.length || item.score > 0).sort((a, b) => b.score - a.score || text(a.row.id).localeCompare(text(b.row.id)))
  const offset = Number(args.offset ?? 0), limit = Math.min(Number(args.limit ?? 12), 20)
  const data: Row[] = ranked.slice(offset, offset + limit).map(item => {
    if (item.kind === 'node') return storyView({ ...item.row, unassigned: !linkedNodes.has(text(item.row.id)) }, 'node', outline)
    if (!outline) return lightweight ? storyCatalogView(item.row, item.kind, ids) : ({ ...storyDigest(item.row, item.kind), matchedTerms: item.matched.slice(0, 8) })
    const { row, kind, matched } = item
    const evidenceNodes = () => members(row).map(node => ({ node, score: matched.filter(term => searchable(node).includes(term)).length }))
      .sort((a, b) => b.score - a.score).slice(0, 3).map(({ node }) => storyView(node, 'node', true))
    if (kind === 'event') {
      const parents = lines.filter(line => strings(line.eventIds).includes(text(row.id)))
      return storyView({ ...row, nodeIds: undefined, lineIds: parents.slice(0, 12).map(line => line.id), lineCount: parents.length, lineId: parents[0]?.id, lineTitle: parents[0]?.title, eventId: row.id, eventTitle: row.title, memberCount: strings(row.nodeIds).length, evidenceNodes: evidenceNodes() }, kind, true)
    }
    if (kind === 'eventLine') return { ...storyView(row, kind, true), nodeIds: strings(row.nodeIds).slice(0, 12), eventIds: strings(row.eventIds).slice(0, 12), memberCount: strings(row.eventIds).length, evidenceNodes: row.outlinePending || !Array.isArray(row.eventIds) ? evidenceNodes() : [] }
    return storyView(row, kind, true)
  })
  const truncated = offset + data.length < ranked.length
  return { data, totalCount: ranked.length, truncated, nextOffset: truncated ? offset + data.length : null }
}

export async function buildStoryContext(store: AgentStore, bookId: string, sessionId: string, rows: Row[], kind: string, includeFuture = false, lightweight = false) {
  const nodeIds = kind === 'node' ? rows.map(row => text(row.id)) : [...new Set(rows.flatMap(row => strings(row.nodeIds)))].slice(0, 20)
  const terms = rows.flatMap(row => termsOf([row.name, row.title, row.summary, row.statement].map(text).join(' ').slice(0, 800))).slice(0, 12)
  const result = await searchStoryContext(store, bookId, sessionId, { node_ids: nodeIds, terms, limit: 12, include_future: includeFuture }, lightweight)
  const assigned = rows.map(row => lightweight || kind === 'node' ? storyView(row, kind) : storyDigest(row, kind))
  const related: Row[] = []; let used = 0
  for (const row of result.data) {
    const cost = estimateTextTokens(JSON.stringify(row))
    if (used + cost > 3000) continue
    related.push(row); used += cost
  }
  return { assigned, related, totalRelated: result.totalCount, truncated: result.truncated || related.length < result.data.length }
}

export function lineDigest(row: Row): Row {
  return { id: text(row.id), title: excerpt(row.title, 120), lineStatus: row.lineStatus, nodeIds: strings(row.nodeIds).slice(0, 20), chapters: strings(row.chapters).slice(0, 20), summary: excerpt(row.summary, 160), revision: row.revision, nodeCount: strings(row.nodeIds).length, truncated: strings(row.nodeIds).length > 20 || strings(row.chapters).length > 20 || text(row.summary).length > 160 }
}
