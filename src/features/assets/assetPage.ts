import { searchAssets, searchCharacters, type SearchAsset } from './search.ts'
import { filterNarrativeAssets, type SearchRelations } from './narrativeSearch.ts'

export type PageKind = 'character' | 'location' | 'node' | 'event' | 'eventLine'
export interface AssetPageOptions { query?: string; field?: string; role?: string; offset?: number; limit?: number; selectedIds?: string[] }
export interface AssetListItem { id: string; label: string; preview: string; revision: number; createdBy: string; chapterName: string }
export interface AssetPage { items: AssetListItem[]; total: number; matched: number; offset: number; limit: number; missingIds: string[] }
export const pageTables = { character: 'characters', location: 'locations', node: 'nodes', event: 'storyEvents', eventLine: 'eventLines' } as const
export const assetPageFields = (kind: PageKind, searching: boolean) => [...new Set([
  'id', 'revision', 'createdBy', 'chapterName', 'chapterIndex', 'sourceChapters',
  ...(kind === 'eventLine' ? ['title', 'summary', 'chapters'] : ['name', 'aliases']),
  ...(kind === 'character' ? ['identity', 'roleWeight'] : kind === 'location' ? ['description'] : kind === 'node' ? ['summary', 'order'] : []),
  ...(kind === 'event' ? ['title', 'summary'] : []),
  ...(searching && kind === 'node' ? ['process', 'actors', 'actorIds', 'actorBindings', 'quote', 'locationNames', 'clues'] : []),
  ...(searching && kind === 'event' ? ['nodeIds', 'latestProgress', 'unresolved', 'clues', 'status'] : []),
  ...(searching && kind === 'eventLine' ? ['coreClue', 'nodeIds', 'eventIds', 'outlinePending'] : []),
])]
const nodeIds = new Intl.Collator('zh-CN', { numeric: true })

export function makeAssetPage(kind: PageKind, rows: (SearchAsset & Record<string, unknown>)[], chapters: { chapterIndex: string; order: number }[], options: AssetPageOptions, related: SearchRelations = {}): AssetPage {
  const source = options.role && kind === 'character' ? rows.filter(row => row.roleWeight === options.role) : rows
  const query = options.query ?? ''
  const chapterOrder = new Map(chapters.map(chapter => [chapter.chapterIndex, chapter.order]))
  const chapterOf = (row: SearchAsset) => chapterOrder.get(row.chapterIndex ?? '') ?? Infinity
  const nodeOrderOf = (row: Record<string, unknown>) => typeof row.order === 'number' ? row.order : Infinity
  const fieldSearch = options.field && query.trim() && (kind === 'node' || kind === 'event' || kind === 'eventLine')
    ? filterNarrativeAssets(kind, source, options.field, query, related) : undefined
  const sorted = kind === 'node' && (!query.trim() || (fieldSearch && options.field !== 'all')) ? [...(fieldSearch ?? source)].sort((a, b) => chapterOf(a) - chapterOf(b)
    || nodeIds.compare(a.chapterIndex ?? '', b.chapterIndex ?? '') || nodeOrderOf(a) - nodeOrderOf(b) || nodeIds.compare(a.id, b.id))
    : kind === 'character' ? searchCharacters(source as (SearchAsset & { name: string })[], query, chapters) : searchAssets(fieldSearch ?? source, fieldSearch ? '' : query, chapters)
  if (options.field === 'all' && fieldSearch) {
    const ranked = searchAssets(fieldSearch, query, chapters)
    const priority = new Map(ranked.map((row, i) => [row.id, i]))
    sorted.sort((a, b) => (priority.get(a.id) ?? ranked.length) - (priority.get(b.id) ?? ranked.length))
  }
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 100)))
  const offset = Math.min(Math.max(0, Math.floor(options.offset ?? 0)), Math.max(0, Math.floor((sorted.length - 1) / limit) * limit))
  const ids = new Set(rows.map(row => row.id))
  return { total: rows.length, matched: sorted.length, offset, limit, missingIds: (options.selectedIds ?? []).filter(id => !ids.has(id)), items: sorted.slice(offset, offset + limit).map(item => {
    const row = item as SearchAsset & Record<string, unknown>
    const full = String(row.summary ?? row.identity ?? row.description ?? '')
    return { id: row.id, label: row.title ?? row.name ?? '', preview: full.length > 500 ? `${full.slice(0, 500)}…` : full, revision: Number(row.revision ?? 1), createdBy: String(row.createdBy ?? ''), chapterName: String(row.chapterName ?? '') }
  }) }
}
