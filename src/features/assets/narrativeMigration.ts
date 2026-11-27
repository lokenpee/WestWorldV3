import reviewedClues from './migrations/reviewedEventClues.json' with { type: 'json' }
import { characterMatchNames } from './characterNames.ts'

type Row = Record<string, unknown>
export type NarrativeTables = { nodes: Row[]; storyEvents: Row[]; eventLines: Row[]; characters: Row[] }
const names = (value: unknown): string[] => Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []
const unique = (items: string[]) => [...new Set(items)]
const oldParticipantFields = ['targets','targetBindings','targetCharacterIds','manualTargetCharacterIds','legacyActorIds','legacyTargetCharacterIds']
const content = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const joinText = (existing: unknown, additions: string[]) => {
  let result = content(existing)
  for (const text of additions) if (text && !result.includes(text)) result = [result, text].filter(Boolean).join('\n\n')
  return result
}

function personIndex(characters: Row[]) {
  const aliases = new Map<string, string[]>()
  const labels = new Map<string, string>()
  for (const character of characters) {
    const id = String(character.id), name = String(character.name)
    labels.set(id, name)
    for (const mention of unique([name, ...characterMatchNames({ name, aliases: names(character.aliases) })]))
      aliases.set(mention, [...(aliases.get(mention) ?? []), id])
  }
  return { aliases, labels }
}

function migrateParticipants(row: Row, people: ReturnType<typeof personIndex>) {
  const groups = new Map<string, string[]>()
  function add(mention: string, ids: string[]) {
    groups.set(mention, unique([...(groups.get(mention) ?? []), ...ids]))
  }
  for (const binding of Array.isArray(row.actorBindings) ? row.actorBindings : [])
    add(binding.mention, names(binding.ids))
  if (!Array.isArray(row.actorBindings))
    for (const mention of names(row.actors)) add(mention, people.aliases.get(mention) ?? [])
  const targets = new Map<string, string[]>()
  for (const binding of Array.isArray(row.targetBindings) ? row.targetBindings : [])
    targets.set(binding.mention, names(binding.ids))
  for (const mention of unique([...targets.keys(), ...names(row.targets)])) {
    const ids = unique([...(targets.get(mention) ?? []), ...(people.aliases.get(mention) ?? [])])
    if (ids.length) add(mention, ids)
  }
  const bound = unique([...groups.values()].flat())
  const manual = unique([...names(row.manualActorIds), ...names(row.manualTargetCharacterIds), ...names(row.legacyActorIds),
    ...names(row.legacyTargetCharacterIds), ...[...names(row.actorIds), ...names(row.targetCharacterIds)].filter(id => !bound.includes(id))])
  row.actorIds = unique([...names(row.actorIds), ...bound, ...manual])
  row.actorBindings = [...groups].map(([mention, ids]) => ({ mention, ids }))
  row.actors = unique([...names(row.actors), ...names(row.actorIds).flatMap(id => people.labels.get(id) ?? [])])
  if (manual.length) row.manualActorIds = manual
  else delete row.manualActorIds
  for (const key of oldParticipantFields) delete row[key]
}

// 仅对同一事件、同一版旧文复用人工校对结果。
function reviewedKey(row: Row, note: string) {
  const value = String(row.title) + '\n' + note
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619)
  return String(row.id) + ':' + (hash >>> 0).toString(16)
}

function migrateClues(row: Row, note: string, nodes: Map<string, Row>, people: ReturnType<typeof personIndex>) {
  if (!note) return []
  const reviewed: Record<string, string[]> = reviewedClues
  const exact = reviewed[reviewedKey(row, note)]
  if (exact) return exact
  const members = names(row.nodeIds).map(id => nodes.get(id)).filter((node): node is Row => !!node)
  const terms = unique([...members.flatMap(n => [...names(n.actors), ...names(n.locationNames), ...names(n.clues)]), ...people.aliases.keys()])
  return terms.filter(term => term && note.includes(term) && !/[，。！？；]/u.test(term))
}

export function migrateNarrativeFields(tables: NarrativeTables) {
  const people = personIndex(tables.characters)
  for (const row of tables.nodes) {
    const before = JSON.stringify(row)
    if (oldParticipantFields.some(field => Object.hasOwn(row,field)) || !Array.isArray(row.actorBindings) && names(row.actorIds).length) {
      migrateParticipants(row,people)
    }
    delete row.started_actions
    if (JSON.stringify(row) !== before && typeof row.revision === 'number') row.revision++
  }
  const nodes = new Map(tables.nodes.map(node => [String(node.id), node]))
  for (const row of tables.storyEvents) {
    if (!Object.hasOwn(row,'coreClue') && row.clues !== undefined) continue
    if (row.clues !== undefined && (!Array.isArray(row.clues) || row.clues.some(v => typeof v !== 'string')))
      throw new Error('事件线索数组格式错误：' + row.id)
    if (row.coreClue != null && typeof row.coreClue !== 'string') throw new Error('旧事件线索格式错误：' + row.id)
    const old = content(row.coreClue)
    const items = migrateClues(row, old, nodes, people)
    row.clues = unique([...names(row.clues), ...items].map(s => s.trim()).filter(Boolean))
    delete row.coreClue
    if (typeof row.revision === 'number') row.revision++
  }
  for (const row of tables.eventLines) {
    if (!['cause','process','result'].some(field => Object.hasOwn(row,field))) continue
    const text = joinText(row.summary,[content(row.cause),content(row.process),content(row.result)])
    if (text) row.summary = text
    delete row.cause
    delete row.process
    delete row.result
    if (typeof row.revision === 'number') row.revision++
  }
}
