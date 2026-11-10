import type { Row } from './repository'
import type { ExecutionChain } from './trace'

const text = (value: unknown) => typeof value === 'string' ? value : ''
const record = (value: unknown): Row => value && typeof value === 'object' ? value as Row : {}
const list = (value: unknown): Row[] => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') as Row[] : []
const contentText = (value: unknown) => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => text((part as Row).text) || text((part as Row).thinking)).join('') : ''
const parts = (value: unknown) => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') as Row[] : []
const keyOf = (entry: Row) => text(entry.id) || `${text(entry.ordinal)}:${text((entry.message as Row)?.role)}`

export type ExecutionEventKind = 'system' | 'user' | 'assistant' | 'toolResult' | 'compaction'
export interface ExecutionEvent {
  key: string
  kind: ExecutionEventKind
  role: string
  content: string
  thinking: string
  toolCalls: Row[]
  toolCallId?: string
  toolName?: string
  isError: boolean
  apiIndex?: number
  execution?: Row
  entry: Row
}

export interface ProjectedExecution {
  events: ExecutionEvent[]
  apiByToolCall: Map<string, number>
  requests: Row[]
}

function apiIndexFor(textValue: string, toolCalls: Row[], requestByToolCall: Map<string, number>, requests: Row[]) {
  const mapped = toolCalls.map(call => requestByToolCall.get(text(call.id))).filter((value): value is number => typeof value === 'number')
  if (mapped.length) return Math.min(...mapped)
  if (!textValue) return undefined
  const matching = requests.filter(request => text(request.text) === textValue)
  return matching.length === 1 ? Number(matching[0].requestOrdinal) : undefined
}

export function projectExecution(chain: ExecutionChain): ProjectedExecution {
  const requestByToolCall = new Map<string, number>()
  for (const request of chain.requests) for (const tool of list(request.toolCalls)) {
    const id = text(tool.toolCallId)
    if (id) requestByToolCall.set(id, Number(request.requestOrdinal))
  }
  const executionByToolCall = new Map<string, Row>()
  for (const request of chain.requests) for (const tool of list(request.toolCalls)) {
    const id = text(tool.toolCallId)
    if (id) executionByToolCall.set(id, tool)
  }
  const events: ExecutionEvent[] = []
  for (const entry of chain.entries) {
    if (entry.type === 'compaction') {
      events.push({ key: keyOf(entry), kind: 'compaction', role: 'compaction', content: contentText(entry.summary ?? entry.content), thinking: '', toolCalls: [], isError: false, entry })
      continue
    }
    const message = record(entry.message)
    const role = text(message.role)
    if (!role) continue
    const contentParts = parts(message.content)
    const content = role === 'assistant' ? contentParts.filter(part => part.type === 'text').map(part => text(part.text)).join('') : contentText(message.content)
    const thinking = role === 'assistant' ? contentParts.filter(part => part.type === 'thinking').map(part => text(part.thinking) || text(part.text)).join('') : ''
    const toolCalls = parts(message.content).filter(part => part.type === 'toolCall')
    if (role === 'system') {
      events.push({ key: keyOf(entry), kind: 'system', role, content, thinking: '', toolCalls: [], isError: false, entry })
    } else if (role === 'user') {
      events.push({ key: keyOf(entry), kind: 'user', role, content, thinking: '', toolCalls: [], isError: false, entry })
    } else if (role === 'assistant') {
      events.push({ key: keyOf(entry), kind: 'assistant', role, content, thinking, toolCalls, isError: false, apiIndex: apiIndexFor(content, toolCalls, requestByToolCall, chain.requests), entry })
    } else if (role === 'toolResult') {
      const toolCallId = text(message.toolCallId)
      events.push({ key: keyOf(entry), kind: 'toolResult', role, content, thinking: '', toolCalls: [], toolCallId, toolName: text(message.toolName), isError: message.isError === true, execution: executionByToolCall.get(toolCallId), entry })
    }
  }
  if (!events.some(event => event.kind === 'system')) {
    const first = chain.requests.find(request => record(request.input).systemPromptSnapshotId)
    if (first) {
      const snapshotId = text(record(first.input).systemPromptSnapshotId)
      const snapshot = chain.snapshots.get(snapshotId)
      if (snapshot && text(snapshot.content)) events.unshift({ key: `snapshot:${snapshotId}`, kind: 'system', role: 'system', content: text(snapshot.content), thinking: '', toolCalls: [], isError: false, entry: snapshot })
    }
  }
  return { events, apiByToolCall: requestByToolCall, requests: chain.requests }
}
