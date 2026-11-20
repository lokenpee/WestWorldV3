import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { JsonValue } from '@earendil-works/pi-ai'
import { records, strings, text, hash } from '../agents/contracts'
import type { ReadSet } from '../agents/commands'
import type { AgentStore, Row } from '../agents/repository'

export const lineSummary = (row: Row) => typeof row.summary === 'string' ? row.summary : [...new Set([row.cause, row.process, row.result].map(text).filter(Boolean))].join('\n\n')
export function storyView(row: Row, kind: string, outline = false): Row {
  if (kind === 'node') return { id: row.id, kind, name: row.name ?? row.title, summary: text(row.summary), chapterIndex: text(row.chapterIndex) || strings(row.chapters)[0] || '', ...(outline ? { started_actions: strings(row.started_actions), new_facts: strings(row.new_facts), ...(typeof row.unassigned === 'boolean' ? { unassigned: row.unassigned } : {}) } : {}) }
  if (kind === 'event') return { id: row.id, kind, title: row.title, ...Object.fromEntries(['nodeIds', 'lineIds', 'lineId', 'lineTitle', 'lineCount', 'eventId', 'eventTitle', 'memberCount', 'evidenceNodes'].filter(key => row[key] !== undefined).map(key => [key, row[key]])) }
  if (kind === 'eventLine') return { id: row.id, kind, title: row.title, ...(outline && Array.isArray(row.eventIds) && !row.outlinePending ? {} : { summary: lineSummary(row), nodeIds: strings(row.nodeIds) }), lineStatus: row.lineStatus ?? row.status ?? 'open', ...(outline ? { eventIds: strings(row.eventIds), outlinePending: row.outlinePending === true } : {}) }
  return { id: row.id, kind: 'note', key: row.key ?? row.title, status: row.status, statement: row.statement ?? row.summary, nodeIds: strings(row.nodeIds), lineIds: strings(row.lineIds) }
}
/** 目录只提供定位信息；完整概述和完整成员通过详情工具分页读取。 */
export function storyCatalogView(row: Row, kind: string, focusIds: ReadonlySet<string> = new Set()): Row {
  const view = storyView(row, kind)
  if (kind !== 'eventLine') return view
  view.title = text(view.title).slice(0, 120)
  const full = text(view.summary)
  view.summary = full.slice(0, 600)
  if (full.length > 600) view.summaryTruncated = true
  const members = strings(row.nodeIds)
  view.nodeIds = [...new Set([...members.filter(id => focusIds.has(id)), ...members])].slice(0, 12)
  view.memberCount = members.length
  view.membersTruncated = members.length > 12
  return view
}
export const briefItems = (brief: Row | null | undefined): Row[] => brief ? [...records(brief.workItems), ...records(brief.related), ...(brief.line ? [brief.line as Row] : []), ...(brief.event ? [brief.event as Row] : []), ...(brief.previousNode ? [brief.previousNode as Row] : [])] : []

/** 仅登记实际送出的资产；版本指纹留在程序中，不交给模型填写。 */
export async function recordStoryReads(store: AgentStore, reads: ReadSet, items: Row[]) {
  for (const item of items.flatMap<Row>(row => [row, ...records(row.evidenceNodes).map(node => ({ ...node, kind: 'node' })), ...(row.kind === 'event' ? strings(row.lineIds).map(id => ({ kind: 'eventLine', id })) : [])])) {
    const table = ({ node: 'nodes', event: 'storyEvents', eventLine: 'eventLines', note: 'storyEditorNotes' } as Record<string, string>)[text(item.kind)]
    if (!table || !item.id || item.fields_omitted) continue
    const id = text(item.id), row = await store.get(table, id)
    if (!row) continue
    const value = { table, id, resolvedId: id, revision: Number(row.revision ?? 0), factFingerprint: await store.wait(hash(row)) }
    const at = reads.records.findIndex(read => read.table === table && read.id === id)
    if (at < 0) reads.records.push(value); else reads.records[at] = value
  }
}

function compactValue(value: Row, tool: string): Row {
  if (tool === 'read_original' || tool === 'get_original') return { message: '历史原文查阅已结束。当前P3只使用节点概述、详细经过和事件线资料。' }
  const project = (row: Row): Row => {
    if (typeof row.text === 'string' && row.charOffset !== undefined) return { id: row.id, hint: '历史分段详情可用当前详情工具重新读取。' }
    const kind = text(row.kind) || (row.statement !== undefined || row.key !== undefined ? 'note' : row.title !== undefined && row.name === undefined && row.nodeIds !== undefined ? 'eventLine' : 'node')
    return { ...storyView(row, kind),
      ...Object.fromEntries(['process', 'charOffset', 'totalChars', 'truncated', 'nextCharOffset', 'memberOffset', 'memberCount', 'membersTruncated', 'nextMemberOffset', 'summaryTruncated'].filter(key => row[key] !== undefined && (key !== 'process' || kind === 'node')).map(key => [key, row[key]])) }
  }
  if (Array.isArray(value.data)) return { ...value, data: records(value.data).map(project) }
  if (Array.isArray(value.workItems)) return { ...value, workItems: records(value.workItems).map(project), related: records(value.related).map(project), ...(value.line ? { line: project(value.line as Row) } : {}), ...(value.previousNode ? { previousNode: project(value.previousNode as Row) } : {}) }
  if (value.page && typeof value.page === 'object') return { ...value, page: compactValue(value.page as Row, tool) }
  return value
}
/** 原消息不改动；续跑和压缩都只使用当前业务视图。 */
export function storyMessages(messages: AgentMessage[], outline = false): AgentMessage[] {
  if (outline) return messages.filter(message => message.role !== 'system').map(message => {
    if (message.role !== 'toolResult' || !['read_original', 'get_original', 'save_story_lines'].includes(message.toolName)) return message
    const details = { message: '旧流程的结果已保存。请通过当前剧情大纲工具查看相关资料。' }
    return { ...message, content: [{ type: 'text' as const, text: JSON.stringify(details) }], details }
  })
  return messages.filter(message => message.role !== 'system').map(message => {
    if (message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('【当前阅读页】\n')) {
      try { return { ...message, content: `【当前阅读页】\n${JSON.stringify(compactValue(JSON.parse(message.content.slice('【当前阅读页】\n'.length)), 'page'))}` } } catch { return message }
    }
    if (message.role !== 'toolResult' || !['get_story_detail', 'get_node_detail', 'get_event_line_detail', 'get_editor_note_detail', 'search_story_context', 'navigate_story_pages', 'read_original'].includes(message.toolName)) return message
    let details: JsonValue | undefined
    const content = message.content.map(part => {
      if (part.type !== 'text') return part
      try { const value = compactValue(JSON.parse(part.text), message.toolName); details = value as JsonValue; return { ...part, text: JSON.stringify(value) } } catch { return part }
    })
    return { ...message, content, details }
  })
}
