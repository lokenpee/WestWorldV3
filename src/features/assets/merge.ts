import { AssetError, type AssetByKind, type Character, type Fact } from './types'
import { factId } from './derive'

export type WorldKind = 'character' | 'location'
export interface MergeOptions { memberIds: string[]; keepId: string; canonicalName: string }
export interface MergeRequest extends MergeOptions { expectedRevisions: Record<string, number> }
export interface MergePreview<K extends WorldKind = WorldKind> {
  kind: K; members: AssetByKind[K][]; request: MergeRequest; result: AssetByKind[K]; conflicts: string[]
}
export interface MergeGroup {
  method: 'manual'; kind: WorldKind; memberIds: string[]; memberNames: string[]; keepId: string; canonicalName: string
  aliases: string[]; sourceChapters: string[]; conflicts: string[]; beforeTokens: number; afterTokens: number
}
export interface ManualMergeRun {
  id: string; recordType: 'run'; bookId: string; stage: 'manual_merge'; status: 'completed'; startedAt: string; finishedAt: string; planVersion: '2.2'
  report: {
    beforeCounts: { characters: number; locations: number }; afterCounts: { characters: number; locations: number }
    groups: MergeGroup[]; optimizedIds: string[]; skipped: string[]; failed: string[]; conflicted: string[]; status: 'completed'
    cost: number; usage: { input: number; output: number; totalTokens: number; cost: number }; externalChanges: string[]
  }
}

export const uniqueStrings = (values: string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))]
export const fuseText = (values: (string | undefined)[]) => uniqueStrings(values.flatMap(value => (value ?? '').split(/[；;\n]/))).join('；')
const chaptersOf = (row: AssetByKind[WorldKind]) => uniqueStrings([...(row.sourceChapters ?? []), ...(row.chapterIndex ? [row.chapterIndex] : [])])

export function validateMergeOptions(kind: WorldKind, options: MergeOptions) {
  if (!['character', 'location'].includes(kind) || !options || !Array.isArray(options.memberIds) || options.memberIds.some(id => typeof id !== 'string' || !id)) throw new AssetError('VALIDATION', '请选择同类人物或地点。')
  if (new Set(options.memberIds).size !== options.memberIds.length || options.memberIds.length < 2) throw new AssetError('VALIDATION', '请至少选择两条不同的资产。')
  if (!options.memberIds.includes(options.keepId)) throw new AssetError('VALIDATION', '保留条目必须属于本次选择。')
  if (typeof options.canonicalName !== 'string' || !options.canonicalName.trim()) throw new AssetError('VALIDATION', '请选择或填写合并后的主名。')
}

function combinedFacts(rows: AssetByKind[WorldKind][], fields: string[]) {
  const facts = new Map<string, Fact>()
  const ids = new Set<string>()
  const add = (fact: Fact) => {
    const key = `${fact.field}\0${fact.text}`
    const existing = facts.get(key)
    if (existing) { existing.chapters = uniqueStrings([...existing.chapters, ...fact.chapters]).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); return }
    const base = fact.id || factId(fact.field, fact.text)
    let id = base
    for (let suffix = 1; ids.has(id); suffix++) id = `${base}_${suffix}`
    facts.set(key, { ...fact, id, chapters: [...fact.chapters] }); ids.add(id)
  }
  for (const row of rows) {
    for (const fact of row.mergeFacts ?? []) add(structuredClone(fact))
    for (const field of fields) if (!row.mergeFacts?.some(fact => fact.field === field)) {
      const value = (row as unknown as Record<string, unknown>)[field]
      if (typeof value === 'string') for (const text of uniqueStrings(value.split(/[；;\n]/))) add({ id: factId(field, text), field, text, chapters: chaptersOf(row) })
    }
  }
  return [...facts.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export function fuseWorldAssets<K extends WorldKind>(kind: K, members: AssetByKind[K][], keepId: string, canonicalName: string, timestamp = new Date().toISOString()): { result: AssetByKind[K]; conflicts: string[] } {
  validateMergeOptions(kind, { memberIds: members.map(row => row.id), keepId, canonicalName })
  const keep = members.find(row => row.id === keepId)!
  const rows = [keep, ...members.filter(row => row.id !== keepId)]
  const name = canonicalName.trim()
  const conflicts: string[] = []
  const sourceChapters = uniqueStrings(rows.flatMap(chaptersOf)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const result = {
    ...structuredClone(keep), name, aliases: uniqueStrings(rows.flatMap(row => [row.name, ...(row.aliases ?? [])])).filter(alias => alias !== name),
    sourceChapters, manualSourceNote: fuseText(rows.map(row => row.manualSourceNote)), nameSource: 'manual' as const, manualKeep: true,
    revision: keep.revision + 1, updatedAt: timestamp, optimizedFactIds: [],
  }
  delete result.optimizationFingerprint
  const fields = kind === 'character' ? ['identity', 'appearance', 'personality', 'background'] : ['description']
  for (const field of [...fields, ...(kind === 'character' ? ['speechStyleSample'] : [])]) {
    Object.assign(result, { [field]: fuseText(rows.map(row => {
      const value = (row as unknown as Record<string, unknown>)[field]
      return typeof value === 'string' ? value : undefined
    })) })
  }
  if (kind === 'character') {
    const people = rows as Character[]
    const character = result as Character
    const profile = { ...character.profile }
    for (const [field, label] of [['age', '年龄'], ['gender', '性别']] as const) {
      const values = people.map(row => row.profile?.[field]).filter(value => value !== undefined && value !== '')
      const current = profile[field]
      const chosen = current === undefined || current === '' ? values[0] : current
      if (chosen !== undefined) Object.assign(profile, { [field]: chosen })
      if (new Set(values).size > 1) conflicts.push(`${label}冲突：保留${chosen}，其他值${uniqueStrings(values.filter(value => value !== chosen).map(String)).join('、')}`)
    }
    profile.ageText = fuseText(people.map(row => row.profile?.ageText))
    character.profile = profile
    const manual = people.filter(row => row.roleWeightSource === 'manual' && row.roleWeight)
    if (manual.length) {
      character.roleWeight = manual[0].roleWeight; character.roleWeightSource = 'manual'
      if (new Set(manual.map(row => row.roleWeight)).size > 1) conflicts.push(`人物层级冲突：保留${character.roleWeight}`)
    }
    const relations = new Map<string, NonNullable<Character['relations']>[number]>()
    for (const person of people) for (const relation of person.relations ?? []) {
      const key = `${relation.target}\0${relation.relation_type}\0${relation.direction ?? ''}`
      const old = relations.get(key)
      relations.set(key, old ? { ...old, relation_label: fuseText([old.relation_label, relation.relation_label]) } : { ...relation })
    }
    character.relations = [...relations.values()]
  }
  result.mergeFacts = combinedFacts(rows, fields)
  result.mergeNotes = uniqueStrings([...rows.flatMap(row => row.mergeNotes ?? []), ...conflicts])
  return { result: result as AssetByKind[K], conflicts }
}

export function detailTokens(row: AssetByKind[WorldKind]) {
  let total = 0
  const details = 'description' in row ? row.description ?? '' : ['identity', 'appearance', 'personality', 'background', 'speechStyleSample'].map(field => (row as unknown as Record<string, unknown>)[field] ?? '').join('\n')
  for (const character of details) {
    const point = character.codePointAt(0)!
    total += point <= 127 ? 0.25 : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character) ? 1.5 : 1
  }
  return Math.ceil(total)
}
