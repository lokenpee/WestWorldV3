import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { JsonValue } from '@earendil-works/pi-ai'
import type { Row } from './repository'

const personFields = ['id', 'name', 'aliases', 'identity', 'profile', 'appearance', 'personality', 'background', 'speechStyleSample', 'resolvedFrom']
const relationFields = ['fromId', 'toId', 'fromName', 'toName', 'state', 'forwardLabels', 'reverseLabels', 'directionUnclear']
const pick = (row: Row, fields: string[]): Row => Object.fromEntries(fields.filter(key => row[key] !== undefined).map(key => [key, row[key]]))

export function characterDetails(row: Row, compact = false): Row {
  if (compact) return pick(row, personFields)
  const copy = { ...row }
  for (const key of ['relations', 'relationEdges', 'unresolvedRelations', 'legacyRelationIds']) delete copy[key]
  return copy
}
export const relationOverview = (row: Row): Row => pick(row, relationFields)

/** 只投影模型上下文，不改持久消息或回放记录。 */
export function identityMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map(message => {
    if (message.role !== 'toolResult' || !['get_character_detail', 'get_character_relation', 'read_original'].includes(message.toolName)) return message
    let details: JsonValue | undefined
    const content = message.toolName === 'read_original'
      ? [{ type: 'text' as const, text: '历史原文查询结果已保存在整理详情；本步骤按人物资产归类，不再加载原文。' }]
      : message.content.map(part => {
        if (part.type !== 'text') return part
        try {
          const value = JSON.parse(part.text) as Row
          const project = message.toolName === 'get_character_detail' ? (row: Row) => characterDetails(row, true) : relationOverview
          if (Array.isArray(value.data)) value.data = value.data.map(row => project(row as Row))
          else if (value.data && typeof value.data === 'object') value.data = project(value.data as Row)
          details = value as JsonValue
          return { ...part, text: JSON.stringify(value) }
        } catch { return part }
      })
    return { ...message, content, details }
  })
}
