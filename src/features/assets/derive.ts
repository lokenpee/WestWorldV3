import type { Character, EventNode, Fact, LocationAsset, References, RoleWeight } from './types'
import { characterMatchNames, isContextualName } from './characterNames'

export function resolveReferences(nodes: EventNode[], characters: Character[]): Record<string, References> {
  const index = new Map<string, Set<string>>()
  const byId = new Map(characters.map(person => [person.id, person]))
  const knownNames = new Map(characters.map(person => [person.id, new Set([person.name, ...(person.aliases ?? [])])]))
  for (const character of characters) for (const name of characterMatchNames(character)) {
    const normalized = name.trim()
    if (!index.has(normalized)) index.set(normalized, new Set())
    index.get(normalized)!.add(character.id)
  }
  return Object.fromEntries(nodes.map(node => {
    const result: References = { actorIds: [], ambiguities: [], missingNames: [] }
    const bound = [...(node.actorIds ?? []), ...(node.targetCharacterIds ?? [])].filter(id => byId.has(id))
    result.actorIds.push(...bound)
    for (const name of new Set([...node.actors, ...(node.targets ?? [])])) {
      if (bound.some(id => knownNames.get(id)!.has(name))) continue
      const ids = [...(index.get(name.trim()) ?? [])].sort()
      if (bound.some(id => ids.includes(id))) continue
      if (ids.length === 1 && node.actorIds === undefined) result.actorIds.push(ids[0])
      else if (ids.length > 1) result.ambiguities.push({ name, candidateIds: ids })
      else result.missingNames.push(name)
    }
    result.actorIds = [...new Set(result.actorIds)]
    return [node.id, result]
  }))
}

export function factId(field: string, text: string) {
  let hash = 2166136261
  for (const character of `${field}\0${text}`) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619)
  return `F${(hash >>> 0).toString(16)}`
}

export function rebuildFacts(facts: Fact[], updates: Record<string, string>, chapters: string[]) {
  const retained = facts.filter(fact => !(fact.field in updates))
  const ids = new Set(retained.map(fact => fact.id))
  for (const [field, value] of Object.entries(updates)) for (const text of new Set(value.split(/[；;\n]/).map(part => part.trim()).filter(Boolean))) {
    const base = factId(field, text)
    let id = base
    for (let suffix = 1; ids.has(id); suffix++) id = `${base}_${suffix}`
    retained.push({ id, field, text, chapters: [...chapters] }); ids.add(id)
  }
  return retained.sort((a, b) => a.id.localeCompare(b.id))
}

export function createFrequencyCounter<T extends Character | LocationAsset>(assets: T[], characters: boolean) {
  const occurrences = new Map<string, number>()
  for (const asset of assets) { const name = asset.name.trim().toLowerCase(); occurrences.set(name, (occurrences.get(name) ?? 0) + 1) }
  const names = [...occurrences].filter(([name, count]) => count === 1 && (!characters || !isContextualName(name))).map(([name]) => name).sort((a, b) => b.length - a.length || a.localeCompare(b))
  const stats = new Map(names.map(name => [name, { mentions: 0, chapters: new Set<string>() }]))
  const scope = new Set<string>()
  const expression = names.length ? new RegExp(names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gu') : undefined
  function add(row: { chapterIndex: string; text: string }) {
    scope.add(row.chapterIndex.split('.')[0])
    if (expression) for (const match of row.text.toLowerCase().matchAll(expression)) {
      const stat = stats.get(match[0])!
      stat.mentions += 1; stat.chapters.add(row.chapterIndex.split('.')[0])
    }
  }
  function result(): T[] {
    const scopeChapters = scope.size
    const measured = assets.map(asset => {
      const stat = stats.get(asset.name.trim().toLowerCase())
      return { asset, chapters: stat?.chapters.size ?? 0, mentions: stat?.mentions ?? 0 }
    })
    const flat = measured.length > 1 && measured.every(row => row.chapters === measured[0].chapters && row.mentions === measured[0].mentions)
    const ranked = [...measured].sort((a, b) => b.chapters - a.chapters || b.mentions - a.mentions)
    const percentiles = new Map<string, number>()
    for (let start = 0; start < ranked.length;) {
      let end = start + 1
      while (end < ranked.length && ranked[end].chapters === ranked[start].chapters && ranked[end].mentions === ranked[start].mentions) end++
      percentiles.set(`${ranked[start].chapters}:${ranked[start].mentions}`, (start + (end - start - 1) / 2) / Math.max(1, measured.length - 1))
      start = end
    }
    return measured.map(row => {
      const percentile = percentiles.get(`${row.chapters}:${row.mentions}`)!
      const result = { ...row.asset, frequency: { chapters: row.chapters, mentions: row.mentions, scopeChapters, percentile } }
      if (characters && (!('roleWeightSource' in result) || result.roleWeightSource !== 'manual')) {
        const roleWeight: RoleWeight = flat ? 'NPC' : percentile < 0.1 ? '主要人物' : percentile < 0.3 ? '重要配角' : percentile < 0.8 ? 'NPC' : '路人'
        Object.assign(result, { roleWeight, roleWeightSource: 'frequency' })
      }
      return result
    })
  }
  return { add, result }
}

export function updateFrequencies<T extends Character | LocationAsset>(assets: T[], texts: { chapterIndex: string; text: string }[], characters: boolean): T[] {
  const counter = createFrequencyCounter(assets, characters)
  for (const row of texts) counter.add(row)
  return counter.result()
}
