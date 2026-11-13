import { agentStream } from './agent-protocol'

type Item = Record<string, unknown>
const contentOf = (value: unknown) => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => part.text ?? '').join('') : ''
export function storyTask(body: Item) {
  const messages = body.messages as { role: string; content: unknown }[]
  let index = messages.findLastIndex(row => row.role === 'user' && /"queue":"(window_nodes|orphans|event_lines|review_notes)"/.test(contentOf(row.content)))
  const content = contentOf(messages[index].content)
  let input = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1))
  if (input.page) {
    for (let at = index + 1; at < messages.length; at++) {
      if (messages[at].role !== 'tool') continue
      try {
        const result = JSON.parse(contentOf(messages[at].content))
        if (result.page && result.ok && result.page.workItems) {
          input = result.page.page ? result.page : { ...result.page, page: result.page }
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
  const nodes = results.flatMap(row => row.data ?? []).filter((row: Item) => row.chapterIndex)
  const line = results.flatMap(row => row.data ?? []).find((row: Item) => row.memberCount !== undefined)
  const candidate = results.flatMap(row => row.data ?? []).find((row: Item) => row.kind === 'eventLine')
  if (input.page) {
    const next = () => agentStream([{ name: 'navigate_story_pages', args: { direction: 'next', currentPageId: input.page.id, reason: '当前页已核对，继续阅读。' } }])
    if (input.phase === 'global_review' || options.readOnly || !input.workItems.length) return next()
    if (commit) return next()
    if (candidate && !line) return agentStream([{ name: 'get_story_detail', args: { kind: 'eventLine', ids: [candidate.id] } }])
    if (nodes.length) return agentStream([{ name: 'save_story_lines', args: { operations: [{ action: line ? 'append' : 'create', ...(line ? { lineId: line.id, processAppend: `继续传递信件，涉及${input.workItems.map((item: Item) => item.id).join('、')}` } : { title: '信件流转', cause: '信件待转交', process: '交信、传信与归还', lineStatus: 'open' }), nodeIds: input.workItems.map((item: Item) => item.id), result: '按原文继续核对', reason: '原文说明同一封信的连续事件', evidenceNodeIds: input.workItems.map((item: Item) => item.id) }] } }])
    return agentStream([
      ...Array.from({ length: Math.ceil(input.workItems.length / 10) }, (_, i) => ({ name: 'get_story_detail', args: { kind: 'node', ids: input.workItems.slice(i * 10, i * 10 + 10).map((item: Item) => item.id) } })),
      { name: 'search_story_context', args: { kind: 'eventLine', terms: ['信件流转'], limit: 20 } },
    ])
  }
  const finish = (changed: boolean) => agentStream([{ name: 'finish_story_batch', args: { summary: '按原文核对连续事件。', items: input.workItems.map((item: Item) => ({ kind: item.kind, id: item.id, outcome: changed && !(nodes.find((row: Item) => row.id === item.id)?.eventLineIds ?? []).includes(line?.id) ? 'changed' : 'no_change', reason: '按实际归属和本批保存结果核对。' })) } }])
  if (input.phase === 'global_review' || options.readOnly) {
    if (results.length) return finish(false)
    return agentStream(Array.from({ length: Math.ceil(input.workItems.length / 10) }, (_, i) => ({ name: 'get_story_detail', args: { kind: input.workItems[0].kind, ids: input.workItems.slice(i * 10, i * 10 + 10).map((item: Item) => item.id) } })))
  }
  if (commit) return finish(true)
  if (candidate && !line) return agentStream([{ name: 'get_story_detail', args: { kind: 'eventLine', ids: [candidate.id] } }])
  if (nodes.length) return agentStream([{ name: 'save_story_lines', args: { operations: [{ action: line ? 'append' : 'create', ...(line ? { lineId: line.id } : { title: '信件流转' }), nodeIds: input.workItems.map((item: Item) => item.id), cause: '信件待转交', process: '交信、传信与归还', result: '按原文继续核对', lineStatus: 'open', confidence: 1, reason: '原文说明同一封信的连续事件', evidenceNodeIds: input.workItems.map((item: Item) => item.id) }] } }])
  return agentStream([
    ...Array.from({ length: Math.ceil(input.workItems.length / 10) }, (_, i) => ({ name: 'get_story_detail', args: { kind: 'node', ids: input.workItems.slice(i * 10, i * 10 + 10).map((item: Item) => item.id) } })),
    { name: 'search_story_context', args: { kind: 'eventLine', terms: ['信件流转'], limit: 20 } },
  ])
}
