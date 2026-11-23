import { agentStream } from './agent-protocol'

type Item = Record<string, unknown>
const contentOf = (value: unknown) => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => part.text ?? '').join('') : ''
function pageInput(input: any) {
  if (input?.阶段 === '全书复核') {
    const page = input.本页, type = ({ 全书目录初查: 'directory_open', 全书目录复查: 'directory_final', 批量成员核对: 'member_batch', 故事线归属: 'line_structure', 散落节点: 'node_page', 成员复核: 'line_segment', 事件说明: 'event_summary', 故事线说明: 'line_summary', 待复核事项: 'note_page' } as Record<string, string>)[page.类型]
    const item = (row: any, kind: string) => row && { kind, id: row.编号, title: row.名称, summary: row.概况, coreClue: row.核心关键线索,
      ...(kind === 'eventLine' ? { outlinePending: !!row.待切换旧线, ...(row.待切换旧线 ? {} : { eventIds: (input.所属事件 ?? []).map((event: any) => event.编号) }) } : {}) }
    const event = item(input.当前事件, 'event'), line = item(input.当前故事线, 'eventLine')
    const eventGroup = input.本页事件说明?.map((row: any) => item(row, 'event'))
    const workItems = type === 'event_summary' ? eventGroup ?? [event] : ['line_summary', 'line_structure'].includes(type) ? [line]
      : type === 'note_page' ? (input.本页待判断事项 ?? input.待复核事项).map((row: any) => ({ kind: 'note', id: row.编号, key: row.标识 }))
      : (input.本页待阅读节点 ?? []).flatMap((chapter: any) => chapter.节点.map((node: any) => ({ kind: 'node', id: node.编号, name: node.名称, summary: node.概述, process: node.详细经过, clues: node.线索, chapterIndex: chapter.章节索引 })))
    return { phase: 'global_review', queue: type === 'node_page' ? 'orphans' : type === 'note_page' ? 'review_notes' : 'event_lines',
      page: { id: page.页编号, type, pageNumber: page.页码, totalPages: page.总页数, ids: workItems.map((row: Item) => row.id), segment: page.成员分段, totalSegments: page.总分段数 },
      workItems, eventGroup, event, line, reviewNotes: input.本页待判断事项, lineEvents: (input.所属事件 ?? []).map((row: any) => item(row, 'event')), related: [] }
  }
  if (input?.阶段 !== '事件串联') return input
  const directory = input.已保存的大纲 ?? input.本页已有归属
  const workItems = input.本页待阅读节点.flatMap((chapter: any) => chapter.节点.map((node: any) => ({
    kind: 'node', id: node.编号, name: node.名称, summary: node.概述, process: node.详细经过, clues: node.线索, chapterIndex: chapter.章节索引,
  })))
  const related = [...directory.故事线.flatMap((line: any) => line.事件), ...directory.未归线事件]
    .map((event: any) => ({ kind: 'event', id: event.编号, title: event.名称, nodeIds: event.节点编号 }))
  const page = input.本页
  return { phase: 'window_link', queue: 'window_nodes', page: { id: page.页编号, type: 'node_page', pageNumber: page.页码, totalPages: page.总页数, ids: workItems.map((row: Item) => row.id) },
    workItems, related, moreRelated: false, directory, quick: input.阅读方式 === '快速核对' }
}
export function storyTask(body: Item) {
  const messages = body.messages as { role: string; content: unknown }[]
  let index = messages.findLastIndex(row => row.role === 'user' && /"queue":"(window_nodes|orphans|event_lines|review_notes)"|"阶段":\s*"(事件串联|全书复核)"/.test(contentOf(row.content)))
  const content = contentOf(messages[index].content)
  let input = pageInput(JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)))
  if (input.page) {
    for (let at = index + 1; at < messages.length; at++) {
      if (messages[at].role !== 'tool') continue
      try {
        const result = JSON.parse(contentOf(messages[at].content))
        const next = pageInput(result.page)
        if (result.ok && next?.workItems) {
          input = next.page ? next : { ...next, page: next }
          index = at
        }
      } catch { /* 失败工具结果由测试中的模型下一轮处理。 */ }
    }
  }
  // 测试读取旧便捷字段；实际请求仍使用新的业务投影。
  input.window ??= input.chapterRange ? { start: Number(input.chapterRange[0]) - 1, end: Number(input.chapterRange[1]) } : null
  input.contextHints ??= { assigned: input.workItems, related: input.related, truncated: input.moreRelated }
  input.existingLines ??= input.related?.filter((row: Item) => row.kind === 'eventLine') ?? []
  return { input, messages: messages.slice(index) }
}
export function storyResponse(body: Item, options: { inputMemory?: boolean; reuseOldMembers?: boolean; readOnly?: boolean } = {}): Response {
  if ((body.messages as { role: string; content: unknown }[]).some(row => contentOf(row.content).includes('【需要压缩的原始会话数据】'))) return agentStream([{ name: 'submit_result', args: { summary: '已核对本书节点与信件流转，按当前任务资料查询余项。' } }])
  const { input, messages } = storyTask(body)
  const results = messages.filter(row => row.role === 'tool').flatMap(row => { try { return [JSON.parse(contentOf(row.content))] } catch { return [] } })
  const commit = results.find(row => row.ok && row.commitId)
  const nodes = results.flatMap(row => row.data ?? []).filter((row: Item) => row.kind === 'node')
  const line = results.flatMap(row => row.data ?? []).find((row: Item) => row.memberCount !== undefined)
  const candidate = results.flatMap(row => row.data ?? []).find((row: Item) => row.kind === 'eventLine')
  if (input.page) {
    const next = () => agentStream([{ name: 'navigate_story_pages', args: { direction: 'next', currentPageId: input.page.id, reason: '当前页已核对，继续阅读。', ...(input.reviewNotes ? { noteResults: input.reviewNotes.map((row: any) => ({ id: row.编号, conclusion: '现有章节尚未交代来信者，保留疑点。' })) } : {}) } }])
    if (input.phase === 'global_review' && !commit && ['event_summary', 'line_summary'].includes(input.page.type)) {
      const event = input.page.type === 'event_summary'
      if (input.eventGroup) {
        const missing = input.eventGroup.filter((item: any) => !item.summary || !item.coreClue)
        if (missing.length) return agentStream([{ name: 'save_story_outline', args: { operations: missing.map((item: any) => ({ op: 'update_event', eventId: item.id, summary: '来信已由沈青转交。', coreClue: '信的去向推动了下一次交接。' })) } }])
      }
      const item = event ? input.event : input.line
      if (item && (event || Array.isArray(item.eventIds) && !item.outlinePending) && (!item.summary?.trim() || !item.coreClue?.trim())) {
        return agentStream([{ name: 'save_story_outline', args: { operations: [{ op: event ? 'update_event' : 'update_line',
          [event ? 'eventId' : 'lineId']: item.id, summary: '人物接信、传信和归还信件，推进了信件的流转。', coreClue: '同一封信的去向牵动了人物的接收与转交。',
        }] } }])
      }
    }
    if (input.phase === 'global_review' || input.quick || options.readOnly || !input.workItems.length) return next()
    if (commit) return next()
    if ((body.tools as { function: { name: string } }[]).some(tool => tool.function.name === 'save_story_outline')) {
      if (results.some(result => result.ok === false)) throw new Error(JSON.stringify(results.find(result => result.ok === false)))
      const eventId = input.related?.find((item: Item) => item.kind === 'event')?.id
      const nodeIds = input.workItems.map((item: Item) => item.id)
      return agentStream([{ name: 'save_story_outline', args: { operations: eventId ? [{ op: 'attach_nodes', eventId, nodeIds }] : [
        { op: 'create_line', ref: 'letter', title: '信件流转' },
        { op: 'create_event', ref: 'delivery', title: '传递信件', lineId: '$letter', nodeIds },
      ] } }])
    }
    if (candidate && !line) return agentStream([{ name: 'get_story_detail', args: { kind: 'eventLine', ids: [candidate.id] } }])
    if (nodes.length) return agentStream([{ name: 'save_story_lines', args: { operations: [{ action: line ? 'append' : 'create', ...(line ? { lineId: line.id } : { title: '信件流转' }), nodeIds: input.workItems.map((item: Item) => item.id), summary: '交信、传信与归还，信件持续流转。', reason: '同一封信的连续事件' }] } }])
    return agentStream([
      ...Array.from({ length: Math.ceil(input.workItems.length / 10) }, (_, i) => ({ name: 'get_story_detail', args: { kind: 'node', fields: ['summary'], ids: input.workItems.slice(i * 10, i * 10 + 10).map((item: Item) => item.id) } })),
      { name: 'search_story_context', args: { kind: 'eventLine', terms: ['信件流转'], limit: 20 } },
    ])
  }
  const finish = (changed: boolean) => agentStream([{ name: 'finish_story_batch', args: { summary: '按原文核对连续事件。', items: input.workItems.map((item: Item) => ({ kind: item.kind, id: item.id, outcome: changed && !(line?.nodeIds ?? []).includes(item.id) ? 'changed' : 'no_change', reason: '按实际归属和本批保存结果核对。' })) } }])
  if (input.phase === 'global_review' || options.readOnly) {
    if (results.length) return finish(false)
    return agentStream(Array.from({ length: Math.ceil(input.workItems.length / 10) }, (_, i) => ({ name: 'get_story_detail', args: { kind: input.workItems[0].kind, ...(input.workItems[0].kind === 'node' ? { fields: ['summary'] } : {}), ids: input.workItems.slice(i * 10, i * 10 + 10).map((item: Item) => item.id) } })))
  }
  if (commit) return finish(true)
  if (candidate && !line) return agentStream([{ name: 'get_story_detail', args: { kind: 'eventLine', ids: [candidate.id] } }])
  if (nodes.length) return agentStream([{ name: 'save_story_lines', args: { operations: [{ action: line ? 'append' : 'create', ...(line ? { lineId: line.id } : { title: '信件流转' }), nodeIds: input.workItems.map((item: Item) => item.id), cause: '信件待转交', process: '交信、传信与归还', result: '按原文继续核对', lineStatus: 'open', confidence: 1, reason: '原文说明同一封信的连续事件', evidenceNodeIds: input.workItems.map((item: Item) => item.id) }] } }])
  return agentStream([
    ...Array.from({ length: Math.ceil(input.workItems.length / 10) }, (_, i) => ({ name: 'get_story_detail', args: { kind: 'node', fields: ['summary'], ids: input.workItems.slice(i * 10, i * 10 + 10).map((item: Item) => item.id) } })),
    { name: 'search_story_context', args: { kind: 'eventLine', terms: ['信件流转'], limit: 20 } },
  ])
}
