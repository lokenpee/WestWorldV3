import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { TSchema } from 'typebox'
import { Value } from 'typebox/value'
import schemaText from '../../../docs/v2/resources/schemas.json?raw'
import worldPrompt from '../../../docs/v2/resources/v2.2/prompts/active/p1-world.md?raw'
import narrativePrompt from '../../../docs/v2/resources/v2.2/prompts/active/p1-narrative.md?raw'
import { withOutputDiscipline } from '../agents/output-discipline'
import { ModelError } from '../models/types'
import type { Substep, ExtractionData } from './types'
const schemas = JSON.parse(schemaText) as Record<string, TSchema>
export const schemaOf = (step: Substep) => schemas[step === 'worldAssets' ? 'WorldAssetsExtractionSchema' : 'NarrativeAssetsExtractionSchema']
export const promptOf = (step: Substep) => withOutputDiscipline((step === 'worldAssets' ? worldPrompt : narrativePrompt).replace(/^---[\s\S]*?---\s*/, ''))

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
export function validateExtraction(step: Substep, message: AssistantMessage, chapterText = ''): ExtractionData {
  const calls = message.content.filter(part => part.type === 'toolCall')
  if (calls.length !== 1 || calls[0].name !== 'submit_result') throw new ModelError('validation', '请通过唯一的 submit_result 提交本章结果。')
  const schema = schemaOf(step)
  const value = normalize(schema, calls[0].arguments)
  if (!Value.Check(schema, value)) throw new ModelError('validation', '提取结果的字段、类型或置信度不符合要求。')
  const data = value as ExtractionData
  for (const row of [...(data.characters ?? []), ...(data.locations ?? []), ...(data.nodes ?? [])]) if (!row.name.trim()) throw new ModelError('validation', '人物、地点和事件名称须有内容。')
  if (step === 'worldAssets') for (const character of data.characters ?? []) {
    const relations = Array.isArray(character.relations) ? character.relations as Record<string, unknown>[] : []
    for (const relation of relations) {
      const fields = ['target', 'relation_type', 'relation_label', 'reverse_label', 'quote']
      if (fields.some(field => typeof relation[field] !== 'string' || !(relation[field] as string).trim())) throw new ModelError('validation', '每条人物关系须有目标、类型、正反标签和本章原文依据。')
      if (!['directed', 'bidirectional', 'unspecified'].includes(relation.direction as string)) throw new ModelError('validation', '关系方向须为 directed、bidirectional 或 unspecified。')
      if (!chapterText.includes((relation.quote as string).trim())) throw new ModelError('validation', '关系依据须为本章连续原文，请逐字复制。')
    }
  }
  return data
}
export async function fingerprint(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
