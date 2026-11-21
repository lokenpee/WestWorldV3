import type { Row } from '../agents/repository'

const records = (value: unknown): Row[] => Array.isArray(value) ? value as Row[] : []
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
const text = (value: unknown) => typeof value === 'string' ? value : ''

function chapterNodes(nodes: Row[], quickCheck = false) {
  const chapters = new Map<string, { 章节索引: string; 章节: unknown; 节点: Row[] }>()
  for (const node of nodes) {
    const chapter = text(node.chapterIndex), group = chapters.get(chapter) ?? { 章节索引: chapter, 章节: node.chapterName, 节点: [] }
    group.节点.push({ 编号: node.id, 名称: node.name, 概述: node.summary, ...(!quickCheck ? { 详细经过: node.process } : {}), ...(strings(node.clues).length ? { 线索: node.clues } : {}) })
    chapters.set(chapter, group)
  }
  return [...chapters.values()]
}

const reviewPageNames: Record<string, string> = { line_structure: '故事线归属', node_page: '散落节点', line_segment: '成员复核', event_summary: '事件说明', line_summary: '故事线说明', note_page: '待复核事项' }
function presentReviewPage(brief: Row, page: Row, position: Row) {
  const type = text(page.type), line = brief.line as Row | undefined, event = brief.event as Row | undefined, previous = brief.previousNode as Row | undefined
  const description = (row: Row) => ({ 编号: row.id, 名称: row.title, 概况: row.summary ?? '', 核心关键线索: row.coreClue ?? '' })
  const nodeSummary = (row: Row) => ({ 编号: row.id, 名称: row.name, 章节索引: row.chapterIndex, 概述: row.summary })
  return { 阶段: '全书复核', 本页: { ...position, 类型: reviewPageNames[type], ...(page.segment ? { 成员分段: page.segment, 总分段数: page.totalSegments } : {}) },
    ...(line ? { 当前故事线: { ...description(line), ...(line.outlinePending ? { 待切换旧线: true, 旧线节点编号: line.nodeIds } : {}) } } : {}),
    ...(event ? { 当前事件: { ...description(event), 成员数量: event.memberCount } } : {}),
    ...(previous ? { 上一段末尾节点: nodeSummary(previous) } : {}),
    ...(type === 'node_page' || type === 'line_segment' ? { 本页待阅读节点: chapterNodes(records(brief.workItems)) } : {}),
    ...(records(brief.eventGroup).length ? { 本页事件说明: records(brief.eventGroup).map(row => ({ ...description(row), 成员概述: records(row.evidenceNodes).map(nodeSummary) })) } : {}),
    ...(type === 'event_summary' && !brief.eventGroup ? { 事件成员概述: records(brief.eventMembers).map(nodeSummary) } : {}),
    ...(type === 'line_structure' || type === 'line_summary' ? { 所属事件: records(brief.lineEvents).map(description) } : {}),
    ...(type === 'line_structure' ? { 各事件首末节点: records(brief.memberEvidence).map(row => ({ 事件编号: row.eventId, 节点: records(row.members).map(nodeSummary) })) } : {}),
    ...(records(brief.otherEvents).length ? { 本页节点的其他事件归属: records(brief.otherEvents).map(row => ({ 事件编号: row.id, 名称: row.title, 节点: row.nodeIds })) } : {}),
    ...(brief.independent && event ? { 所属故事线: records(brief.parentLines).map(row => ({ 编号: row.id, 名称: row.title })) } : {}),
    ...(brief.independent && records(brief.reviewNotes).length ? { 本页待判断事项: records(brief.reviewNotes).map(note => ({ 编号: note.id, 标识: note.key, 问题: note.statement, 节点: note.nodeIds, 事件: note.eventIds, 故事线: note.lineIds })) } : {}),
    ...(!brief.independent && type === 'note_page' ? { 待复核事项: records(brief.workItems).map(note => ({ 编号: note.id, 标识: note.key, 状态: note.status, 内容: note.statement, 节点编号: note.nodeIds, 故事线编号: note.lineIds })) } : {}) }
}

export function presentStoryPage(brief: Row | null) {
  if (!brief?.outline && !brief?.outlineReview) return brief
  const page = brief.page as Row, position = { 页编号: page.id, 页码: page.pageNumber, 总页数: page.totalPages }
  if (brief.outlineReview) return presentReviewPage(brief, page, position)
  const outline = brief.outline as Row
  const lines = records(outline.lines), events = records(outline.events)
  const byEvent = new Map(events.map(event => [text(event.id), event]))
  const referenced = new Set(lines.flatMap(line => strings(line.eventIds)))
  const eventLabel = (event: Row) => ({ 编号: event.id, 名称: event.title, 节点编号: event.nodeIds })
  const directory = { 故事线数量: lines.length, 事件数量: events.length,
    故事线: lines.map(line => ({ 编号: line.id, 名称: line.title, 事件: strings(line.eventIds).flatMap(id => byEvent.has(id) ? [eventLabel(byEvent.get(id)!)] : []), ...(line.nodeIds ? { 旧线节点编号: line.nodeIds } : {}) })),
    未归线事件: events.filter(event => !referenced.has(text(event.id))).map(eventLabel) }
  return { 阶段: '事件串联', 本页: position, ...(brief.quickCheck ? { 阅读方式: '快速核对', 本页已有归属: directory } : { 已保存的大纲: directory }), 本页待阅读节点: chapterNodes(records(brief.workItems), brief.quickCheck === true) }
}

export const storyPagePrompt = (brief: Row | null) => `【当前阅读页】\n${JSON.stringify(presentStoryPage(brief), null, brief?.outline || brief?.outlineReview ? 2 : undefined)}`
