import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { TSchema } from 'typebox'
import { Value } from 'typebox/value'
import schemaText from '../../../docs/v2/resources/schemas.json?raw'
import worldPrompt from '../../../docs/v2/resources/v2.2/prompts/active/p1-world.md?raw'
import narrativePrompt from '../../../docs/v2/resources/v2.2/prompts/active/p1-narrative.md?raw'
import { ModelError } from '../models/types'
import { relationDirections } from '../assets/relations'
import type { Substep, ExtractionData } from './types'
const schemas = JSON.parse(schemaText) as Record<string, TSchema>
export const schemaOf = (step: Substep) => schemas[step === 'worldAssets' ? 'WorldAssetsExtractionSchema' : 'NarrativeAssetsExtractionSchema']
export const promptOf = (step: Substep) => (step === 'worldAssets' ? worldPrompt : narrativePrompt).replace(/^---[\s\S]*?---\s*/, '')

type ExtractionSchema = TSchema & { properties: Record<string, ExtractionSchema>; items: ExtractionSchema }
const worldValidation = structuredClone(schemaOf('worldAssets')) as ExtractionSchema
const narrativeValidation = structuredClone(schemaOf('narrativeAssets')) as ExtractionSchema
const personFields = worldValidation.properties.characters.items.properties
const nodeFields = narrativeValidation.properties.nodes.items.properties
const namesSchema = nodeFields.locationNames
// 模型使用精简格式，验证器仍能接收旧提取响应中的字段。
Object.assign(personFields, { confidence: {} })
Object.assign(worldValidation.properties.locations.items.properties, { confidence: {} })
Object.assign(personFields.profile.properties, { age: { type: 'number' } })
Object.assign(personFields.relations.items.properties, { direction: { anyOf: relationDirections.map(value => ({ const: value, type: 'string' })) } })
Object.assign(nodeFields, { confidence: {}, targets: namesSchema, started_actions: namesSchema })

function normalize(schema: TSchema, value: unknown): unknown {
  const shape = schema as TSchema & { items?: TSchema; properties?: Record<string, TSchema>; required?: string[] }
  if (Array.isArray(value)) return shape.items ? value.map(item => normalize(shape.items!, item)) : value
  if (!value || typeof value !== 'object') return value
  const properties = shape.properties
  const required = shape.required ?? []
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const child = properties?.[key]
    if (item === null && child && !required.includes(key) && !Value.Check(child, null)) return []
    return [[key, child ? normalize(child, item) : item]]
  }))
}
export function validateExtraction(step: Substep, message: AssistantMessage): ExtractionData {
  const calls = message.content.filter(part => part.type === 'toolCall')
  if (calls.length !== 1 || calls[0].name !== 'submit_result') throw new ModelError('validation', '请通过唯一的 submit_result 提交本章结果。')
  const schema = step === 'worldAssets' ? worldValidation : narrativeValidation
  const value = normalize(schema, calls[0].arguments)
  const schemaErrors = [...Value.Errors(schema, value)]
  if (schemaErrors.length) throw new ModelError('validation', `提取结果的字段或类型不符合要求：${schemaErrors.slice(0, 5).map(error => `${error.instancePath || error.schemaPath || '/'}：${error.message}`).join('；')}`)
  const data = value as ExtractionData
  for (const row of [...(data.characters ?? []), ...(data.locations ?? []), ...(data.nodes ?? [])]) {
    if (!row.name.trim()) throw new ModelError('validation', '人物、地点和事件名称须有内容。')
    delete row.confidence
  }
  for (const node of data.nodes ?? []) {
    for (const field of ['locationNames', 'clues'] as const) {
      const names = node[field]
      if (Array.isArray(names)) node[field] = [...new Set(names.map((name: string) => name.trim()).filter(Boolean))]
    }
    delete node.started_actions
  }
  if (step === 'worldAssets') for (const character of data.characters ?? []) {
    const profile = character.profile as { age?: number; ageText?: string } | undefined
    if (profile && profile.age !== undefined) {
      if (!profile.ageText?.trim()) profile.ageText = `${profile.age}岁`
      delete profile.age
    }
    const relations = Array.isArray(character.relations) ? character.relations as Record<string, unknown>[] : []
    for (const relation of relations) {
      const fields = ['target', 'relation_type', 'relation_label', 'reverse_label', 'quote']
      const missing = fields.filter(field => typeof relation[field] !== 'string' || !(relation[field] as string).trim())
      if (missing.length) throw new ModelError('validation', `关系${(relation.target as string)?.trim() || '(缺少target)'}的字段不完整：${missing.join('、')}；请提供非空字符串。`)
    }
  }
  return data
}
export async function fingerprint(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
