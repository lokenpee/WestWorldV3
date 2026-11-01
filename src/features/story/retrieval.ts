import { estimateTextTokens } from '../agents/context'
import { strings, text } from '../agents/contracts'
import type { AgentStore, Row } from '../agents/repository'

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
  const source = text(row.summary ?? row.statement ?? row.cause)
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
const searchable = (row: Row) => [row.name, row.title, row.summary, row.statement, row.cause, row.result, row.process, ...strings(row.actors), ...strings(row.targets), ...strings(row.world_delta), ...strings(row.new_facts)].map(text).join(' ').toLowerCase()

export async function searchStoryContext(store: AgentStore, bookId: string, sessionId: string | undefined, args: Row) {
  const nodes = (await store.rows('nodes')).filter(row => row.bookId === bookId)
  const lines = (await store.rows('eventLines')).filter(row => row.bookId === bookId)
  const notes = (await store.rows('storyEditorNotes')).filter(row => row.bookId === bookId && row.sessionId === sessionId && (row.status === 'active' || args.include_resolved === true))
  const focus = nodes.filter(row => strings(args.node_ids).includes(text(row.id)))
  const explicit = strings(args.terms).map(value => value.trim().toLowerCase().slice(0, 128)).filter(Boolean)
  const names = focus.flatMap(row => [...strings(row.actors), ...strings(row.targets)]).filter(value => value.length >= 2).map(value => value.slice(0, 64))
  const terms = [...new Set([...explicit, ...names, ...focus.flatMap(row => termsOf([row.name, row.summary, ...strings(row.world_delta), ...strings(row.new_facts)].map(text).join(' ').slice(0, 2000)))])].slice(0, 64)
  const ids = new Set(focus.map(row => text(row.id)))
  const latestChapter = focus.map(row => text(row.chapterIndex)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1)
  const candidates = [...nodes.map(row => ({ row, kind: 'node' })), ...lines.map(row => ({ row, kind: 'eventLine' })), ...notes.map(row => ({ row, kind: 'note' }))].filter(item => !ids.has(text(item.row.id)) && (!args.kind || item.kind === args.kind) && (args.include_future === true || !latestChapter || item.kind !== 'node' || text(item.row.chapterIndex).localeCompare(latestChapter, undefined, { numeric: true }) <= 0))
  const documents = candidates.map(item => ({ ...item, content: searchable(item.row) }))
  const frequency = new Map(terms.map(term => [term, documents.filter(item => item.content.includes(term)).length]))
  const ranked = documents.map(item => {
    const matched = terms.filter(term => item.content.includes(term))
    const linked = strings(item.row.nodeIds).some(id => ids.has(id))
    const score = matched.reduce((sum, term) => sum + (explicit.includes(term) ? 6 : 1) * Math.log2(2 + documents.length / Math.max(1, frequency.get(term)!)), 0) + (linked ? 30 : 0)
    return { ...item, matched, score }
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || text(a.row.id).localeCompare(text(b.row.id)))
  const offset = Number(args.offset ?? 0), limit = Math.min(Number(args.limit ?? 12), 20)
  const data: Row[] = ranked.slice(offset, offset + limit).map(item => ({ ...storyDigest(item.row, item.kind), matchedTerms: item.matched.slice(0, 8) }))
  const truncated = offset + data.length < ranked.length
  return { data, totalCount: ranked.length, truncated, nextOffset: truncated ? offset + data.length : null }
}

export async function buildStoryContext(store: AgentStore, bookId: string, sessionId: string, rows: Row[], kind: string, includeFuture = false) {
  const nodeIds = kind === 'node' ? rows.map(row => text(row.id)) : [...new Set(rows.flatMap(row => strings(row.nodeIds)))].slice(0, 20)
  const terms = rows.flatMap(row => termsOf([row.name, row.title, row.summary, row.statement, row.cause].map(text).join(' ').slice(0, 800))).slice(0, 12)
  const result = await searchStoryContext(store, bookId, sessionId, { node_ids: nodeIds, terms, limit: 12, include_future: includeFuture })
  const assigned = rows.map(row => storyDigest(row, kind))
  const related: Row[] = []; let used = 0
  for (const row of result.data) {
    const cost = estimateTextTokens(JSON.stringify(row))
    if (used + cost > 3000) break
    related.push(row); used += cost
  }
  return { assigned, related, totalRelated: result.totalCount, truncated: result.truncated || related.length < result.data.length }
}

export function lineDigest(row: Row): Row {
  return { id: text(row.id), title: excerpt(row.title, 120), lineStatus: row.lineStatus, nodeIds: strings(row.nodeIds).slice(0, 20), chapters: strings(row.chapters).slice(0, 20), cause: excerpt(row.cause, 160), result: excerpt(row.result, 160), revision: row.revision, nodeCount: strings(row.nodeIds).length, truncated: strings(row.nodeIds).length > 20 || strings(row.chapters).length > 20 || text(row.cause).length > 160 || text(row.result).length > 160 }
}
