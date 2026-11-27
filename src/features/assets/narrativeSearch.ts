import type { SearchAsset } from './search.ts'

export const narrativeFields = {
  node: { id: '编号', name: '名称', summary: '概述', process: '详细经过', people: '涉及人物', locationNames: '地点', chapter: '章节', clues: '线索', quote: '原文引文' },
  event: { id: '编号', title: '名称', summary: '概况', latestProgress: '最新进展', unresolved: '待解决问题', clues: '关键线索', status: '状态', people: '涉及人物', members: '成员节点名称' },
  eventLine: { id: '编号', title: '名称', summary: '概况', coreClue: '核心线索', people: '涉及人物', members: '成员事件名称' },
}
type Kind = keyof typeof narrativeFields
export type SearchRow = SearchAsset & Record<string, unknown>
export type SearchRelations = Partial<Record<'characters' | 'nodes' | 'storyEvents', SearchRow[]>>
const values = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase()

export function searchRelationTables(kind: string, field?: string): (keyof SearchRelations)[] {
  const tables: (keyof SearchRelations)[] = []
  if (!field || !Object.hasOwn(narrativeFields, kind)) return tables
  if (field === 'people' || field === 'all') tables.push('characters')
  if (kind === 'event' && ['people', 'members', 'all'].includes(field)) tables.push('nodes')
  if (kind === 'eventLine' && ['people', 'members', 'all'].includes(field)) {
    tables.push('storyEvents')
    if (field !== 'members') tables.push('nodes')
  }
  return tables
}

export function filterNarrativeAssets(kind: Kind, rows: SearchRow[], field: string, query: string, related: SearchRelations) {
  const index = (items?: SearchRow[]) => new Map(items?.map(row => [row.id, row]))
  const nodes = index(related.nodes), events = index(related.storyEvents), people = index(related.characters)
  const names = (row: SearchRow) => [...values(row.name), ...values(row.aliases), ...values(row.verifiedAliases)]
  const lookup = (ids: unknown, map: Map<string, SearchRow>) => values(ids).flatMap(id => map.get(id) ?? [])
  const peopleByNode = new Map<string, string[]>()
  function nodePeople(node: SearchRow) {
    const cached = peopleByNode.get(node.id)
    if (cached) return cached
    const mentions = [...values(node.actors)]
    const ids = [...values(node.actorIds)]
    for (const bindings of [node.actorBindings]) {
      if (!Array.isArray(bindings)) continue
      for (const binding of bindings) {
        if (binding && values(binding.ids).length) {
          mentions.push(...values(binding.mention))
          ids.push(...values(binding.ids))
        }
      }
    }
    const result = [...mentions, ...lookup(ids, people).flatMap(names)]
    peopleByNode.set(node.id, result)
    return result
  }
  function fieldValues(row: SearchRow, key: string): string[] {
    if (key === 'chapter') return [...values(row.chapterIndex), ...values(row.chapterName)]
    if (key === 'clues' && kind === 'event') return values(row.clues)
    if (key === 'members') return kind === 'event' ? lookup(row.nodeIds, nodes).flatMap(n => values(n.name)) : lookup(row.eventIds, events).flatMap(e => values(e.title))
    if (key !== 'people') return values(row[key])
    if (kind === 'node') return nodePeople(row)
    const memberIds = kind === 'eventLine' && Array.isArray(row.eventIds) && !row.outlinePending
      ? lookup(row.eventIds, events).flatMap(event => values(event.nodeIds)) : row.nodeIds
    return lookup(memberIds, nodes).flatMap(nodePeople)
  }
  const needle = normalize(query)
  const fields = field === 'all' ? Object.keys(narrativeFields[kind]) : Object.hasOwn(narrativeFields[kind], field) ? [field] : []
  const matches = rows.filter(row => fields.some(key => fieldValues(row, key).some(item => normalize(item).includes(needle))))
  return matches
}
