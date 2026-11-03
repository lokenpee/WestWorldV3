import type { Chapter } from '../../lib/storage/workspace'
import { assetName, type Asset, type Character } from './types'

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

const roleOrder: Record<string, number> = { 主要人物: 0, 重要配角: 1, NPC: 2, 路人: 3 }
const pinyinCollator = new Intl.Collator('zh-CN-u-co-pinyin')
const nameCollator = new Intl.Collator('zh-CN')
const idCollator = new Intl.Collator('zh-CN', { numeric: true })

/** 人物专用搜索：只匹配主名和别名；空查询按层级、拼音和编号排序。 */
export function searchCharacters(rows: Character[], queryText: string, chapters: Chapter[] = []): Character[] {
  const query = normalize(queryText)
  const byName = (a: Character, b: Character) => pinyinCollator.compare(a.name, b.name) || nameCollator.compare(a.name, b.name)
  if (!query) return [...rows].sort((a, b) => (roleOrder[a.roleWeight ?? 'NPC'] ?? 2) - (roleOrder[b.roleWeight ?? 'NPC'] ?? 2) || byName(a, b) || idCollator.compare(a.id, b.id))
  const chapterOrder = new Map(chapters.map(chapter => [chapter.chapterIndex, chapter.order]))
  const firstChapter = (row: Character) => Math.min(Infinity, ...[...(row.sourceChapters ?? []), ...(row.chapterIndex ? [row.chapterIndex] : [])].map(id => chapterOrder.get(id) ?? Infinity))
  const rankOf = (row: Character): Rank | undefined => {
    const name = normalize(row.name)
    if (name === query) return [0, 0, 0, 0]
    const aliases = (row.aliases ?? []).map(normalize)
    if (aliases.includes(query)) return [1, 1, 0, 0]
    const matches: Rank[] = []
    for (const [field, value] of [[0, name], ...aliases.map(alias => [1, alias] as const)] as const) {
      const offset = value.indexOf(query)
      if (offset >= 0) matches.push([offset === 0 ? 2 : 3, field, offset, value.length - query.length])
    }
    return matches.sort(compareRank)[0]
  }
  return rows.flatMap(row => {
    const rank = rankOf(row)
    return rank ? [{ row, rank, chapter: firstChapter(row) }] : []
  }).sort((a, b) => compareRank(a.rank, b.rank) || byName(a.row, b.row) || a.chapter - b.chapter || idCollator.compare(a.row.id, b.row.id)).map(item => item.row)
}
