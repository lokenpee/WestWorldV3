import type { Message } from '@earendil-works/pi-ai'
import { records, strings, text } from '../agents/contracts'

type Call = Extract<Extract<Message, { role: 'assistant' }>['content'][number], { type: 'toolCall' }>
type Reply = Extract<Message, { role: 'toolResult' }>
const catalogNames: Record<string, string> = {
  events: '事件目录',
  lines: '故事线目录',
  unassigned_nodes: '未归属节点',
  unassigned_events: '未归线事件',
}

function summarizeFields(rows: ReturnType<typeof records>, result: boolean) {
  const groups = new Map<string, string[]>()
  for (const row of rows) {
    const fields = result ? Object.keys(row.values ?? {}) : strings(row.fields)
    const unavailable = strings(row.unavailable)
    const label =
      fields.join('、') +
      (unavailable.length ? '；缺少 ' + unavailable.join('、') : '') +
      (row.offset ? '；偏移 ' + row.offset : '')
    const ids = groups.get(label) ?? []
    ids.push(text(row.id))
    groups.set(label, ids)
  }
  return [...groups].map(([label, ids]) => ids.join('、') + '（' + label + '）').join('；')
}

function describeCall(call: Call) {
  const args = call.arguments
  if (call.name === 'get_detail') return summarizeFields(records(args.requests), false)
  if (call.name === 'get_outline')
    return [catalogNames[text(args.kind)] ?? args.kind, args.id, args.offset ? '偏移 ' + args.offset : '']
      .filter(Boolean)
      .join(' · ')
  if (Array.isArray(args.operations))
    return records(args.operations)
      .map((op) =>
        [op.op, op.ref, op.title, op.eventId, op.lineId, ...strings(op.nodeIds), ...strings(op.eventIds)]
          .filter(Boolean)
          .join(' ')
      )
      .join('；')
  return (
    [args.action, args.id, ...strings(args.nodeIds), ...strings(args.eventIds)].filter(Boolean).join(' ') ||
    '确认任务'
  )
}

function describeResult(call: Call, reply: Reply) {
  const body = reply.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join(' ')
  if (reply.isError) return '失败：' + body.split('Received arguments:')[0].trim().slice(0, 320)
  let result
  try {
    result = JSON.parse(body)
  } catch {
    return '已返回，正文已省略'
  }
  if (call.name === 'get_detail')
    return '已返回 ' + summarizeFields(records(result), true) + '，字段正文已省略'
  if (call.name === 'get_outline')
    return '本页 ' + records(result.rows).length + ' 项，共 ' + result.total + ' 项，目录正文已省略'
  if (Array.isArray(result)) return '已返回 ' + result.length + ' 项，正文已省略'
  if (result?.changes)
    return (
      '已保存 ' +
      records(result.changes).length +
      ' 项变更' +
      Object.entries(result.created ?? {})
        .map(([ref, id]) => '，' + ref + '=' + id)
        .join('')
    )
  return [result?.action, result?.id, result?.confirmed ? '已确认' : '执行成功，返回正文已省略']
    .filter(Boolean)
    .join(' ')
}

export function narrativeContext(messages: Message[], keep: number, saved: Record<string, string>) {
  // 请求准备器可能传回上一轮已投影的消息；恢复运行时则会传入原始记录。
  const fixed = new Set(Object.values(saved))
  const isPlaceholder = (m: Message) =>
    m.role === 'user' && typeof m.content === 'string' && fixed.has(m.content)
  const total = messages.filter((m) => m.role === 'assistant' || isPlaceholder(m)).length
  const prefix: Message[] = []
  const additions: Record<string, string> = {}
  let round = 0
  for (let index = 0; index < messages.length; index++) {
    const assistant = messages[index]
    if (assistant.role !== 'assistant') {
      if (isPlaceholder(assistant)) round++
      prefix.push(assistant)
      continue
    }
    round++
    const replies: Extract<Message, { role: 'toolResult' }>[] = []
    while (index + 1 < messages.length) {
      const next = messages[index + 1]
      if (next.role !== 'toolResult') break
      replies.push(next)
      index++
    }
    const calls = assistant.content.filter((part) => part.type === 'toolCall')
    if (
      round > total - keep ||
      calls.some((call) => !replies.some((reply) => reply.toolCallId === call.id))
    ) {
      prefix.push(assistant, ...replies)
      continue
    }
    const key = String(round)
    let compact = saved[key]
    if (compact === undefined) {
      const parts = calls.flatMap((call) => {
        const reply = replies.find((r) => r.toolCallId === call.id)!
        return [
          '【占位符·模型调用】' + call.name + ' ' + describeCall(call),
          '【占位符·工具返回】' + call.name + ' ' + describeResult(call, reply),
        ]
      })
      if (!parts.length) {
        const reply = assistant.content
          .flatMap((part) => (part.type === 'text' ? [part.text] : []))
          .join(' ')
          .trim()
        if (assistant.stopReason === 'aborted' || assistant.stopReason === 'error')
          parts.push(assistant.stopReason === 'aborted' ? '请求中断。' : '请求失败。')
        if (reply) parts.push(reply.slice(0, 220) + (reply.length > 220 ? '…' : ''))
        if (!parts.length) parts.push('本轮没有正文或工具返回。')
      }
      compact = '[第 ' + key + ' 轮] ' + parts.join('\n')
      additions[key] = compact
    }
    prefix.push({ role: 'user', content: compact, timestamp: assistant.timestamp })
  }
  return { messages: prefix, additions }
}
