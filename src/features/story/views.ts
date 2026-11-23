import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { JsonValue } from '@earendil-works/pi-ai'
import { records, strings, text, hash } from '../agents/contracts'
import type { ReadSet } from '../agents/commands'
import type { AgentStore, Row } from '../agents/repository'
import { storyNodeFields } from './outlineToolSchema'
import { usesOutline } from './outline'

export const lineSummary = (row: Row) => typeof row.summary === 'string' ? row.summary : [...new Set([row.cause, row.process, row.result].map(text).filter(Boolean))].join('\n\n')
export function storyView(row: Row, kind: string, outline = false): Row {
  if (kind === 'node') return { id: row.id, kind, name: row.name ?? row.title, chapterIndex: text(row.chapterIndex) || strings(row.chapters)[0] || '', ...(outline && typeof row.unassigned === 'boolean' ? { unassigned: row.unassigned } : {}) }
  if (kind === 'event') return { id: row.id, kind, title: row.title, ...Object.fromEntries(['summary', 'coreClue', 'nodeIds', 'lineIds', 'lineId', 'lineTitle', 'lineCount', 'eventId', 'eventTitle', 'memberCount', 'evidenceNodes'].filter(key => row[key] !== undefined).map(key => [key, row[key]])) }
  if (kind === 'eventLine') {
    const active = usesOutline(row)
    return { id: row.id, kind, title: row.title, ...(outline && active ? { summary: text(row.summary), coreClue: text(row.coreClue) } : { summary: lineSummary(row), nodeIds: strings(row.nodeIds), ...(typeof row.coreClue === 'string' ? { coreClue: row.coreClue } : {}) }), lineStatus: row.lineStatus ?? row.status ?? 'open', ...(outline ? { eventIds: strings(row.eventIds), outlinePending: !active } : {}) }
  }
  return { id: row.id, kind: 'note', key: row.key ?? row.title, status: row.status, statement: row.statement ?? row.summary, ...(strings(row.eventIds).length ? { eventIds: strings(row.eventIds) } : {}), nodeIds: strings(row.nodeIds), lineIds: strings(row.lineIds) }
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
export const briefItems = (brief: Row | null | undefined): Row[] => {
  if (!brief) return []
  const outline = brief.outline as Row | undefined
  return [...records(brief.workItems), ...records(brief.reviewNotes), ...records(brief.directoryNotes), ...records(brief.parentLines).map(row => ({ id: row.id, kind: 'eventLine' })), ...records(brief.otherEvents).map(row => ({ id: row.id, kind: 'event' })), ...records(brief.memberEvidence).flatMap(row => records(row.members)), ...records(brief.related), ...records(brief.lineEvents), ...records(brief.eventMembers), ...records(outline?.lines).map(row => ({ id: row.id, kind: 'eventLine' })), ...records(outline?.events).map(row => ({ id: row.id, kind: 'event', evidenceNodes: row.evidenceNodes })), ...(brief.line ? [brief.line as Row] : []), ...(brief.event ? [brief.event as Row] : []), ...(brief.previousNode ? [brief.previousNode as Row] : [])]
}

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
  const project = (row: Row): Row => {
    if (typeof row.text === 'string' && row.charOffset !== undefined) return { id: row.id, hint: '历史分段详情可用当前详情工具重新读取。' }
    const kind = text(row.kind) || (row.statement !== undefined || row.key !== undefined ? 'note' : row.title !== undefined && row.name === undefined && row.nodeIds !== undefined ? 'eventLine' : 'node')
    return { ...storyView(row, kind),
      ...Object.fromEntries(['process', 'charOffset', 'totalChars', 'truncated', 'nextCharOffset', 'memberOffset', 'memberCount', 'membersTruncated', 'nextMemberOffset', 'summaryTruncated'].filter(key => row[key] !== undefined && (key !== 'process' || kind === 'node')).map(key => [key, row[key]])) }
  }
  if (Array.isArray(value.data)) return { ...value, data: records(value.data).map(project) }
  if (Array.isArray(value.workItems)) return { ...value, workItems: records(value.workItems).map(project), related: records(value.related).map(project), ...(value.line ? { line: project(value.line as Row) } : {}), ...(value.event ? { event: project(value.event as Row) } : {}), ...(value.previousNode ? { previousNode: project(value.previousNode as Row) } : {}) }
  if (value.page && typeof value.page === 'object') return { ...value, page: compactValue(value.page as Row, tool) }
  return value
}
// 旧页与翻页回执也可能带整段节点内容。保留大纲及标题索引，按原调用选择恢复节点详情。
function projectNodeData(value: unknown, fields: string[] = []): unknown {
  if (Array.isArray(value)) return value.map(item => projectNodeData(item, fields))
  if (!value || typeof value !== 'object') return value
  const row = value as Row
  if (row.kind === 'node' || row.id && row.chapterIndex !== undefined && row.name !== undefined) {
    const keys = fields.length ? ['id', 'kind', ...fields, ...(fields.includes('process') ? ['charOffset', 'nextCharOffset'] : [])] : ['id', 'kind', 'name', 'title', 'chapterIndex', 'unassigned']
    return Object.fromEntries(keys.filter(key => key in row).map(key => [key, row[key]]))
  }
  return Object.fromEntries(Object.entries(row).map(([key, item]) => {
    if (['节点', '成员概述', '事件成员概述', 'evidenceNodes'].includes(key) && Array.isArray(item)) {
      return [key, item.map(node => node && typeof node === 'object' ? Object.fromEntries(
        ['编号', '名称', '章节索引', 'id', 'kind', 'name', 'chapterIndex'].filter(k => k in node).map(k => [k, node[k]])) : node)]
    }
    return [key, projectNodeData(item, fields)]
  }))
}

export function storyMessages(messages: AgentMessage[], outline = false): AgentMessage[] {
  const selections = new Map<string, string[]>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.content) if (part.type === 'toolCall' && ['get_story_detail', 'get_node_detail'].includes(part.name)) {
      selections.set(part.id, strings(part.arguments.fields).filter(field => storyNodeFields.includes(field)))
    }
  }
  return messages.filter(message => message.role !== 'system').map(message => {
    if (message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('【当前阅读页】\n')) {
      const prefix = '【当前阅读页】\n'
      try {
        const page = JSON.parse(message.content.slice(prefix.length))
        return { ...message, content: prefix + JSON.stringify(projectNodeData(outline ? page : compactValue(page, 'page')), null, outline ? 2 : undefined) }
      } catch { return message }
    }
    if (message.role !== 'toolResult') return message
    if (['read_original', 'get_original'].includes(message.toolName) || outline && message.toolName === 'save_story_lines') {
      const details = { message: '历史工具结果已归档。请按当前页提供的编号查阅。' }
      return { ...message, content: [{ type: 'text' as const, text: JSON.stringify(details) }], details }
    }
    if (!['get_story_detail', 'get_node_detail', 'get_event_line_detail', 'get_editor_note_detail', 'search_story_context', 'navigate_story_pages'].includes(message.toolName)) return message
    let details: JsonValue | undefined
    const content = message.content.map(part => {
      if (part.type !== 'text') return part
      try {
        const value = JSON.parse(part.text)
        const fields = selections.get(message.toolCallId) ?? []
        details = projectNodeData(outline || fields.length ? value : compactValue(value, message.toolName), fields) as JsonValue
        return { ...part, text: JSON.stringify(details) }
      } catch { return part }
    })
    return { ...message, content, details }
  })
}
