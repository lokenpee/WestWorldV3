import type { ExecutionRow as Row, ExecutionData as ExecutionChain } from './executionTypes.ts'
import { displayContent, messageRows, toolResultContent } from './requestPresentation.ts'

const text = (value: unknown) => typeof value === 'string' ? value : ''
const record = (value: unknown): Row => value && typeof value === 'object' ? value as Row : {}
const list = (value: unknown): Row[] => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') as Row[] : []
const contentText = (value: unknown) => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => text((part as Row).text) || text((part as Row).thinking)).join('') : ''
const parts = (value: unknown) => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') as Row[] : []
const keyOf = (entry: Row) => text(entry.id) || `${text(entry.ordinal)}:${text((entry.message as Row)?.role)}`

export type ExecutionEventKind = 'system' | 'user' | 'assistant' | 'toolResult' | 'compaction' | 'other'
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
    } else {
      events.push({ key: keyOf(entry), kind: 'other', role, content: displayContent(message.content ?? message), thinking: '', toolCalls: [], isError: false, entry })
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

/** 从实际请求和响应重建阅读顺序；仅省略下一请求重带的同一段上下文。 */
export function projectRequestConversation(chain: ExecutionChain): ExecutionEvent[] {
  if (!chain.requests.length || chain.requests.some(row => record(row.input).messageFormat !== 'provider-request/v1')) return projectExecution(chain).events
  const events: ExecutionEvent[] = []
  let context: ExecutionEvent[] = []
  const signature = (event: ExecutionEvent) => JSON.stringify([event.role, event.content, event.toolCallId, event.toolCalls.map(call => [call.id, call.name, call.arguments])])
  const convert = (message: Row, key: string, apiIndex: number): ExecutionEvent => {
    const role = ['tool', 'toolResult'].includes(text(message.role)) ? 'toolResult' : text(message.role) || text(message.type) || 'message'
    const contentParts = parts(message.content)
    const toolCalls = [...contentParts.filter(part => part.type === 'toolCall'), ...list(message.tool_calls).map(call => ({ id: call.id, name: record(call.function).name, arguments: record(call.function).arguments }))].map(call => {
      let args = call.arguments
      if (typeof args === 'string') { try { args = JSON.parse(args) } catch { /* 保留实际参数 */ } }
      return { ...call, arguments: args }
    })
    const content = message.content == null ? '' : displayContent(Array.isArray(message.content) ? contentParts.filter(part => !['toolCall', 'thinking'].includes(text(part.type))) : message.content)
    return { key, kind: ['system', 'user', 'assistant', 'toolResult'].includes(role) ? role as ExecutionEventKind : 'other', role, content, thinking: text(message.reasoning_content) || contentParts.filter(part => part.type === 'thinking').map(part => text(part.thinking)).join(''), toolCalls, toolCallId: text(message.tool_call_id ?? message.toolCallId) || undefined, toolName: text(message.name ?? message.toolName), isError: message.isError === true, apiIndex, entry: message }
  }
  chain.requests.forEach((request, index) => {
    const apiIndex = index + 1, requestKey = text(request.requestId ?? request.id)
    const input = messageRows(list(record(request.input).messages)).map((message, at) => convert(message, `${requestKey}:input:${at}`, apiIndex))
    let common = 0
    while (common < input.length && common < context.length && signature(input[common]) === signature(context[common])) common++
    events.push(...input.slice(common))
    context = [...input]
    const calls = list(request.toolCalls)
    if (request.text || request.thinking || calls.length) {
      const assistant = convert({ role: 'assistant', content: [{ type: 'text', text: text(request.text) }, ...calls.map(call => ({ type: 'toolCall', id: call.toolCallId, name: call.name, arguments: call.arguments }))], reasoning_content: request.thinking }, `${requestKey}:assistant`, apiIndex)
      events.push(assistant); context.push(assistant)
    }
    for (const call of calls) if (call.result !== undefined || call.resultPreview !== undefined || call.state === 'failed') {
      const result = convert({ role: 'toolResult', toolCallId: call.toolCallId, toolName: call.name, content: toolResultContent(call.result ?? call.resultPreview), isError: call.isError === true || call.state === 'failed' }, `${requestKey}:result:${text(call.toolCallId)}`, apiIndex)
      result.execution = call
      events.push(result); context.push(result)
    }
  })
  return events
}
