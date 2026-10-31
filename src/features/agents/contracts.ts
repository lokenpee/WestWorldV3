import type { TSchema } from 'typebox'
import { Value } from 'typebox/value'
import toolText from '../../../docs/v2/resources/v2.2/tool-contracts.json?raw'
import resultText from '../../../docs/v2/resources/v2.2/tool-results.schema.json?raw'
import modelText from '../../../docs/v2/resources/v2.2/model-output-contract.json?raw'
import storageText from '../../../docs/v2/resources/v2.2/storage.schema.json?raw'

export type AgentProfile = 'asset_editor' | 'story_editor'
export interface ToolContract { name: string; description: string; parameters: TSchema; kind: string; maxResults?: number }
export const toolContracts = (JSON.parse(toolText) as { profiles: Record<AgentProfile, ToolContract[]> }).profiles
export const resultContracts = new Map((JSON.parse(resultText) as { tools: { name: string; success: TSchema }[] }).tools.map(row => [row.name, row.success]))
export const summarySchema = (JSON.parse(modelText) as { schemas: Record<string, TSchema> }).schemas.AgentTaskSummarySchema
const storageSchema = JSON.parse(storageText) as TSchema
export const inputSchema = (name: string): TSchema => ({ ...storageSchema, $ref: `#/$defs/${name}` })
export interface Summary { status: 'completed' | 'partial'; commitIds: string[]; summary: string; remainingWorkIds: string[]; reviewedItems: { workItemId: string; outcome: string; reason: string }[] }
export function validate(schema: TSchema, value: unknown, message = 'INVALID_ARGS:工具参数不符合要求。'): void {
  if (!Value.Check(schema, value)) throw new Error(message)
}
export const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value)
export async function hash(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)))
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
export const text = (value: unknown) => typeof value === 'string' ? value : ''
export const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
export const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value as Record<string, unknown>[] : []
