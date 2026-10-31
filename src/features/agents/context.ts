/** Pi session-manager / compaction algorithms. Copyright (c) 2025 Mario Zechner, MIT.
 * License: docs/v2/resources/assets/PI-MIT.txt. Browser storage and CJK estimates use the book contract.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { records, strings, text } from './contracts'
import type { Row } from './repository'

export function estimateTextTokens(value: string): number {
  let weight = 0
  for (const char of value) weight += /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(char) ? 1.5 : char.codePointAt(0)! > 127 ? 1 : 0.25
  return Math.ceil(weight)
}
export const estimateMessageTokens = (message: AgentMessage) => 16 + estimateTextTokens(JSON.stringify(message, (key, value) => key === 'usage' ? undefined : value))
export function settingsForWindow(window: number) {
  const reserve = Math.min(32768, Math.max(128, Math.floor(window / 4)))
  return { reserve, keep: Math.min(150000, Math.max(64, Math.floor((window - reserve) / 3))) }
}
export function sessionPath(entries: Row[], leafId?: string): Row[] {
  const index = new Map(entries.map(row => [text(row.id), row]))
  let entry = leafId ? index.get(leafId) : [...entries].sort((a, b) => Number(a.ordinal) - Number(b.ordinal)).at(-1)
  if (leafId && !entry) throw new Error('会话存档缺少末端条目。')
  const path: Row[] = [], visited = new Set<string>()
  while (entry) {
    const id = text(entry.id)
    if (visited.has(id)) throw new Error('会话存档存在循环引用。')
    visited.add(id); path.push(entry)
    if (entry.parentId && !index.has(text(entry.parentId))) throw new Error('会话存档缺少父条目。')
    entry = entry.parentId ? index.get(text(entry.parentId)) : undefined
  }
  return path.reverse()
}
export function entryMessages(entry: Row): AgentMessage[] {
  if (entry.type === 'message') return [entry.message as AgentMessage]
  if (entry.type === 'commit') return [{ role: 'user', content: `[代码提交确认] ${text(entry.summary)}`, timestamp: Date.parse(text(entry.createdAt)) }]
  if (entry.type === 'compaction') return [
    ...(entry.systemMessage ? [entry.systemMessage as AgentMessage] : []),
    { role: 'user', content: `[历史会话压缩摘要：仅作历史参考，可按原始条目 ID 回查]\n${text(entry.summary)}`, timestamp: Date.parse(text(entry.createdAt)) },
  ]
  return []
}
export function repairToolPairs(messages: AgentMessage[], flushTail = true): AgentMessage[] {
  const out: AgentMessage[] = []; let pending = new Map<string, string>(); let deferred: AgentMessage[] = []
  const flush = () => {
    for (const [id, name] of pending) out.push({ role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text: '会话中断，工具结果未保存；写操作可能已提交，请按原命令键核实。此标记不是实际工具结果。' }], isError: true, timestamp: Date.now() })
    pending = new Map(); out.push(...deferred); deferred = []
  }
  for (const message of messages) {
    if (message.role === 'toolResult') {
      if (pending.has(message.toolCallId)) { out.push(message); pending.delete(message.toolCallId) }
      if (!pending.size && deferred.length) { out.push(...deferred); deferred = [] }
      continue
    }
    if (message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('[代码提交确认]') && pending.size) { deferred.push(message); continue }
    flush(); out.push(message)
    if (message.role === 'assistant') for (const part of message.content) if (part.type === 'toolCall') pending.set(part.id, part.name)
  }
  if (flushTail) flush()
  return out
}
export function projectSession(entries: Row[], leafId?: string) {
  const path = sessionPath(entries, leafId)
  const omitted = new Set(path.flatMap(row => row.type === 'omit' ? strings(row.omittedEntryIds) : []))
  const last = path.findLastIndex(row => row.type === 'compaction')
  let visible = path
  if (last >= 0) {
    const compact = path[last], kept = text(compact.firstKeptEntryId)
    const start = path.findIndex(row => row.id === kept)
    if (start < 0 || start > last) throw new Error('压缩记录的保留起点不存在。')
    visible = [compact, ...path.slice(start, last).filter(row => row.type !== 'compaction' && !(row.type === 'message' && (row.message as AgentMessage).role === 'system')), ...path.slice(last + 1)]
  }
  visible = visible.filter(row => row.type !== 'omit' && !omitted.has(text(row.id)))
  return { entries: visible, messages: repairToolPairs(visible.flatMap(entryMessages)), path }
}
export function estimateContextTokens(entries: Row[], messages: AgentMessage[]): number {
  const invalidAfter = Math.max(-1, ...entries.filter(row => row.type === 'compaction' || row.type === 'omit').map(row => Number(row.ordinal)))
  const usageTokens = (message: Row) => {
    const usage = message.usage as Row | undefined
    const total = Number(usage?.totalTokens) || ['input', 'output', 'cacheRead', 'cacheWrite'].reduce((sum, key) => sum + Number(usage?.[key] ?? 0), 0)
    return Number.isFinite(total) && total > 0 ? total : 0
  }
  const last = entries.findLast(row => row.type === 'message' && Number(row.ordinal) > invalidAfter && (row.message as AgentMessage).role === 'assistant' && !['error', 'aborted'].includes(text((row.message as Row).stopReason)) && usageTokens(row.message as Row) > 0)
  const estimate = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  if (!last) return estimate
  const actual = usageTokens(last.message as Row)
  const tail = entries.filter(row => Number(row.ordinal) > Number(last.ordinal)).flatMap(entryMessages).reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  return Math.max(estimate, actual + tail)
}
export function findCutPoint(entries: Row[], keep: number) {
  let tokens = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    tokens += entryMessages(entries[i]).reduce((sum, message) => sum + estimateMessageTokens(message), 0)
    if (tokens < keep) continue
    for (let at = i; at < entries.length; at++) {
      const row = entries[at]
      if (row.type !== 'message') continue
      const message = row.message as AgentMessage
      if (message.role === 'user' || message.role === 'assistant' && !records(message.content).some(part => part.type === 'toolCall')) return at
    }
    return entries.length
  }
  return 0
}
