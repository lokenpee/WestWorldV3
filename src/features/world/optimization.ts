import { Value } from 'typebox/value'
import type { TSchema } from 'typebox'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { Character, LocationAsset, Fact } from '../assets/types'
import { rebuildFacts } from '../assets/derive'
import { detailTokens, type WorldKind } from '../assets/merge'
import { hash } from '../agents/contracts'
import schemasText from '../../../docs/v2/resources/schemas.json?raw'
import outputText from '../../../docs/v2/resources/v2.2/model-output-contract.json?raw'
import characterPrompt from '../../../docs/v2/resources/v2.2/prompts/active/character-optimize.md?raw'
import locationPrompt from '../../../docs/v2/resources/v2.2/prompts/active/location-optimize.md?raw'

type Entity = Character | LocationAsset
type Shape = TSchema & { properties?: Record<string, Shape>; patternProperties?: Record<string, Shape>; items?: Shape; required?: string[] }
const characterFields = ['identity', 'appearance', 'personality', 'background']
export function entityFacts(kind: WorldKind, row: Entity): Fact[] {
  const existing = row.mergeFacts ?? []
  const fields = kind === 'character' ? characterFields : ['description']
  return fields.reduce((facts, field) => facts.some(fact => fact.field === field) ? facts : rebuildFacts(facts, { [field]: String((row as unknown as Record<string, unknown>)[field] ?? '') }, row.sourceChapters ?? (row.chapterIndex ? [row.chapterIndex] : [])), existing)
}
const grams = (text: string) => { const compact = text.replace(/\s/g, ''); return new Set(Array.from({ length: Math.max(0, compact.length - 2) }, (_, i) => compact.slice(i, i + 3))) }
export function needsOptimization(kind: WorldKind, row: Entity, facts = entityFacts(kind, row)) {
  if (!facts.length) return false
  const content = row as unknown as Record<string, unknown>
  const characters = (kind === 'character' ? characterFields : ['description']).reduce((sum, field) => sum + String(content[field] ?? '').length, 0)
  if ((row.mergeNotes?.length ?? 0) > 0 || detailTokens(row) > 1200 || characters > 1800 || facts.reduce((sum, fact) => sum + fact.text.length, 0) > 1800 || facts.some(fact => facts.filter(other => other.field === fact.field).length >= 8)) return true
  if (kind === 'character' && 'roleWeight' in row && ['主要人物', '重要配角'].includes(row.roleWeight ?? '') && (row.frequency?.chapters ?? 0) >= 3) return true
  for (let i = 0; i < facts.length; i++) for (let j = i + 1; j < facts.length; j++) {
    const a = facts[i], b = facts[j]
    if (a.field !== b.field || a.text === b.text || a.text.replace(/\s/g, '').length < 20 || b.text.replace(/\s/g, '').length < 20) continue
    const x = grams(a.text), y = grams(b.text); const shared = [...x].filter(value => y.has(value)).length
    if (shared / new Set([...x, ...y]).size >= 0.85) return true
  }
  return false
}
function normalize(schema: Shape, value: unknown): unknown {
  if (Array.isArray(value)) return schema.items ? value.map(item => normalize(schema.items!, item)) : value
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const child = schema.properties?.[key]
    if (item === null && child && !schema.required?.includes(key) && !Value.Check(child, null)) return []
    return [[key, child ? normalize(child, item) : item]]
  }))
}
export async function optimizationRequest(kind: WorldKind, row: Entity) {
  const facts = entityFacts(kind, row)
  const fingerprint = await hash({ version: '2.2', names: [row.name, ...(row.aliases ?? [])].map(name => name.trim()).sort(), facts, notes: row.mergeNotes ?? [] })
  const selected = facts.filter(fact => !row.optimizedFactIds?.includes(fact.id))
  const shortFacts = (selected.length ? selected : facts).map((fact, i) => ({ ...fact, id: `F${i + 1}` }))
  const ids = shortFacts.map(fact => fact.id)
  let schema: Shape
  let input: unknown
  if (kind === 'character') {
    const base = (JSON.parse(schemasText) as Record<string, Shape>).CharacterOptimizationBatchSchema
    const item = structuredClone(base.properties!.entities.patternProperties!['^(.*)$'])
    item.properties!.entity.properties!.name = { type: 'string', enum: [row.name, ...(row.aliases ?? [])] } as Shape
    item.properties!.entity.properties!.aliases = { type: 'array', items: { type: 'string', enum: [row.name, ...(row.aliases ?? [])] } } as Shape
    item.properties!.covered_fact_ids = { type: 'array', items: { type: 'string', enum: ids }, minItems: ids.length, maxItems: ids.length, uniqueItems: true } as Shape
    schema = { type: 'object', properties: { entities: { type: 'object', properties: { [row.id]: item }, required: [row.id], additionalProperties: false } }, required: ['entities'], additionalProperties: false } as Shape
    input = { stage: 'P2', entities: [{ id: row.id, name: row.name, aliases: row.aliases ?? [], previous: Object.fromEntries(characterFields.map(field => [field, String((row as unknown as Record<string, unknown>)[field] ?? '')])), facts: shortFacts }] }
  } else {
    schema = structuredClone((JSON.parse(outputText) as { schemas: Record<string, Shape> }).schemas.LocationOptimizationSchema)
    schema.properties!.coveredFactIds = { type: 'array', items: { type: 'string', enum: ids }, minItems: ids.length, maxItems: ids.length, uniqueItems: true } as Shape
    input = { stage: 'P2', id: row.id, name: row.name, revision: row.revision, description: (row as LocationAsset).description ?? '', facts: shortFacts, conflicts: row.mergeNotes ?? [] }
  }
  const prompt = kind === 'character' ? characterPrompt : locationPrompt
  const validate = (message: AssistantMessage) => {
    const calls = message.content.filter(part => part.type === 'toolCall')
    if (calls.length !== 1 || calls[0].name !== 'submit_result') throw new Error('请使用唯一的提交工具返回整编结果。')
    const value = normalize(schema, calls[0].arguments)
    if (!Value.Check(schema, value)) throw new Error('整编结果须覆盖全部事实编号，保留人物键和既有称呼。')
    const output = value as Record<string, unknown>
    if (kind === 'location') return { fields: { description: String(output.description) }, notes: output.conflicts as string[] | undefined }
    const result = (output.entities as Record<string, Record<string, unknown>>)[row.id]
    const entity = result.entity as Record<string, unknown>
    for (const field of characterFields) if (facts.some(fact => fact.field === field) && (typeof entity[field] !== 'string' || !entity[field].trim())) throw new Error('有事实依据的字段须保留内容。')
    const fields = Object.fromEntries(characterFields.filter(field => typeof entity[field] === 'string').map(field => [field, String(entity[field])]))
    return { fields, name: String(entity.name), aliases: entity.aliases as string[], notes: result.merge_notes as string[] }
  }
  return { facts, fingerprint, input, schema, prompt, validate, estimatedTokens: Math.ceil((JSON.stringify(input).length + JSON.stringify(schema).length + prompt.length) / 2) }
}
