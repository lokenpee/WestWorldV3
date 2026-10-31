import type { Character, EventNode, Fact, LocationAsset, References, RoleWeight } from './types'

export function resolveReferences(nodes: EventNode[], characters: Character[]): Record<string, References> {
  const index = new Map<string, Set<string>>()
  for (const character of characters) for (const name of [character.name, ...(character.aliases ?? [])]) {
    const normalized = name.trim()
    if (!index.has(normalized)) index.set(normalized, new Set())
    index.get(normalized)!.add(character.id)
  }
  return Object.fromEntries(nodes.map(node => {
    const result: References = { actorIds: [], ambiguities: [], missingNames: [] }
    const bound = [...(node.actorIds ?? []), ...(node.targetCharacterIds ?? [])].filter(id => characters.some(person => person.id === id))
    result.actorIds.push(...bound)
    for (const name of new Set([...node.actors, ...(node.targets ?? [])])) {
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

export function updateFrequencies<T extends Character | LocationAsset>(assets: T[], texts: { chapterIndex: string; text: string }[], characters: boolean): T[] {
  const occurrences = new Map<string, number>()
  for (const asset of assets) { const name = asset.name.trim().toLowerCase(); occurrences.set(name, (occurrences.get(name) ?? 0) + 1) }
  const names = [...occurrences].filter(([, count]) => count === 1).map(([name]) => name).sort((a, b) => b.length - a.length || a.localeCompare(b))
  const stats = new Map(names.map(name => [name, { mentions: 0, chapters: new Set<string>() }]))
  const scopeChapters = new Set(texts.map(row => row.chapterIndex.split('.')[0])).size
  if (names.length) {
    const expression = new RegExp(names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gu')
    for (const row of texts) for (const match of row.text.toLowerCase().matchAll(expression)) {
      const stat = stats.get(match[0])!
      stat.mentions += 1; stat.chapters.add(row.chapterIndex.split('.')[0])
    }
  }
  const measured = assets.map(asset => {
    const stat = stats.get(asset.name.trim().toLowerCase())
    return { asset, chapters: stat?.chapters.size ?? 0, mentions: stat?.mentions ?? 0 }
  })
  const flat = measured.length > 1 && measured.every(row => row.chapters === measured[0].chapters && row.mentions === measured[0].mentions)
  return measured.map(row => {
    const higher = measured.filter(other => other.chapters > row.chapters || (other.chapters === row.chapters && other.mentions > row.mentions)).length
    const same = measured.filter(other => other.chapters === row.chapters && other.mentions === row.mentions).length
    const percentile = (higher + (same - 1) / 2) / Math.max(1, measured.length - 1)
    const result = { ...row.asset, frequency: { chapters: row.chapters, mentions: row.mentions, scopeChapters, percentile } }
    if (characters && (!('roleWeightSource' in result) || result.roleWeightSource !== 'manual')) {
      const roleWeight: RoleWeight = flat ? 'NPC' : percentile < 0.1 ? '主要人物' : percentile < 0.3 ? '重要配角' : percentile < 0.8 ? 'NPC' : '路人'
      Object.assign(result, { roleWeight, roleWeightSource: 'frequency' })
    }
    return result
  })
}
