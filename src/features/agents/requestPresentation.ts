import type { Row } from './repository'

export const requestRecord = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
export const requestRows = (value: unknown): Row[] => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') as Row[] : []
const text = (value: unknown) => typeof value === 'string' ? value : ''

// 从各协议实际发送的消息中提取阅读顺序；不从业务提示词另拼一条消息。
export function sentMessages(body: Row): Row[] {
  const system = body.system ?? body.instructions
  const input = body.messages ?? body.input
  return [
    ...(system ? [{ role: 'system', content: system }] : []),
    ...(typeof input === 'string' ? [{ role: 'user', content: input }] : requestRows(input)),
  ]
}

export function toolDeclaration(value: Row): Row {
  const { function: wrapped, type: _type, ...outer } = value
  const tool = wrapped && typeof wrapped === 'object' ? { ...outer, ...requestRecord(wrapped) } : outer
  const { label: _label, outputSchema: _output, execute: _execute, input_schema: inputSchema, ...declaration } = tool
  return { ...declaration, ...(inputSchema === undefined ? {} : { parameters: inputSchema }) }
}

export function displayContent(value: unknown): string {
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value }
  }
  if (Array.isArray(value)) return value.map(part => {
    const row = requestRecord(part)
    if (['text', 'input_text', 'output_text'].includes(text(row.type))) return text(row.text)
    if (row.type === 'thinking') return text(row.thinking)
    return displayContent(part)
  }).join('\n')
  if (value === undefined) return '未记录'
  return JSON.stringify(value, null, 2) ?? '未记录'
}

export function messageRows(messages: Row[]): Row[] {
  return messages.flatMap(message => {
    if (message.type === 'function_call') return [{ role: 'assistant', content: [{ type: 'toolCall', name: message.name, arguments: message.arguments }] }]
    if (message.type === 'function_call_output') return [{ role: 'tool', content: message.output }]
    const blocks = requestRows(message.content)
    if (blocks.some(block => block.type === 'tool_result' || block.type === 'tool_use')) return blocks.map(block => block.type === 'tool_result'
      ? { role: 'tool', content: block.content }
      : block.type === 'tool_use' ? { role: 'assistant', content: [{ type: 'toolCall', name: block.name, arguments: block.input }] }
      : { role: message.role, content: [block] })
    return [message]
  })
}

export function toolResultContent(value: unknown): string {
  const result = requestRecord(value)
  // Pi执行结果同时含content、details和structuredContent；只有content进入模型消息。
  return displayContent(result.content !== undefined ? result.content : value)
}
