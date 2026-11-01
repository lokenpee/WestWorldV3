import type { Chapter } from '../../lib/storage/workspace'
import { assetName, type Asset } from './types'

const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase()
type Rank = [tier: number, field: number, offset: number, excess: number]
const compareRank = (a: Rank, b: Rank) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]

function rankAsset(row: Asset, query: string): Rank | undefined {
  const name = normalize(assetName(row)), id = normalize(row.id)
  if (name === query || id === query) return [0, 0, 0, 0]
  const aliases = 'aliases' in row ? (row.aliases ?? []).map(normalize) : []
  if (aliases.includes(query)) return [1, 0, 0, 0]
  const matches: Rank[] = []
  for (const [field, values] of [[0, [name]], [1, [id]], [2, aliases]] as const) for (const value of values) {
    const offset = value.indexOf(query)
    if (offset >= 0) matches.push([offset === 0 ? 2 : 3, field, offset, value.length - query.length])
  }
  if (matches.length) return matches.sort(compareRank)[0]
  const body = 'title' in row ? [row.cause, row.process, row.result] : 'summary' in row ? [row.summary] : 'identity' in row ? [row.identity ?? ''] : 'description' in row ? [row.description ?? ''] : []
  if (body.some(value => normalize(value).includes(query))) return [4, 0, 0, 0]
  return undefined
}

export function searchAssets<T extends Asset>(rows: T[], queryText: string, chapters: Chapter[] = []): T[] {
  const query = normalize(queryText)
  const byName = (a: T, b: T) => assetName(a).localeCompare(assetName(b), 'zh-CN')
  if (!query) return [...rows].sort((a, b) => byName(a, b) || a.id.localeCompare(b.id))
  const chapterOrder = new Map(chapters.map(chapter => [chapter.chapterIndex, chapter.order]))
  const firstChapter = (row: T) => {
    const ids = 'title' in row ? row.chapters : [...('sourceChapters' in row ? row.sourceChapters ?? [] : []), ...('chapterIndex' in row && row.chapterIndex ? [row.chapterIndex] : [])]
    return Math.min(Infinity, ...ids.map(id => chapterOrder.get(id) ?? Infinity))
  }
  return rows.flatMap(row => {
    const rank = rankAsset(row, query)
    return rank ? [{ row, rank, chapter: firstChapter(row) }] : []
  }).sort((a, b) => compareRank(a.rank, b.rank) || byName(a.row, b.row) || a.chapter - b.chapter || a.row.id.localeCompare(b.row.id, 'zh-CN', { numeric: true })).map(item => item.row)
}
