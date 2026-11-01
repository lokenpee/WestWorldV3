import { agentStream } from './agent-protocol'

export const worldText = '第一章 镇上来客\n沈青是青石镇的船夫。老沈就是船夫沈青。药师陆川与镖师陆川是两个人，彼此并不认识。青石客栈也叫青石栈。青石客栈后院是客栈内的一处院子。张三与张三丰是不同的人。'
export const worldExtraction = {
  characters: [{ name: '沈青', identity: '船夫', aliases_mentioned: ['老沈'], confidence: 1 }, { name: '沈青', identity: '青石镇的船夫', confidence: 1 }, { name: '老沈', identity: '船夫沈青的别名', confidence: 1 }, { name: '陆川', identity: '药师', confidence: 1 }, { name: '陆川', identity: '镖师', confidence: 1 }, { name: '张三', confidence: 1 }, { name: '张三丰', confidence: 1 }],
  locations: [{ name: '青石客栈', aliases_mentioned: [], description: '镇上的客栈', confidence: 1 }, { name: '青石栈', description: '青石客栈的别名', confidence: 1 }, { name: '青石客栈后院', description: '客栈内的院子', confidence: 1 }],
}
export function worldResponse(body: { tools: { function: { parameters: { properties: Record<string, unknown> } } }[]; messages: { role: string; content: unknown }[] }): Response {
  const content = (value: unknown) => typeof value === 'string' ? value : (value as { text: string }[]).map(part => part.text).join('')
  if (body.tools.length === 1) {
    const schema = body.tools[0].function.parameters
    return agentStream([{ name: 'submit_result', args: schema.properties.characters ? { ...worldExtraction, locations: worldExtraction.locations.map(({ aliases_mentioned: _aliases, ...row }) => row) } : { nodes: [] } }])
  }
  const input = JSON.parse(content(body.messages.find(row => row.role === 'user')!.content))
  const replies = body.messages.filter(row => row.role === 'tool').map(row => { try { return JSON.parse(content(row.content)) } catch { return {} } })
  const details = replies.find(row => row.data)?.data as { id: string; name: string }[] | undefined
  const same = details?.filter(row => input.kind === 'character' ? ['沈青', '老沈'].includes(row.name) : ['青石客栈', '青石栈'].includes(row.name)) ?? []
  const commit = replies.find(row => row.ok)
  if (details && (!same.length || same.length < 2 || commit)) return agentStream([{ name: 'submit_result', args: { status: 'completed', summary: '已核对全部分配项，歧义对象保留分开。', commitIds: commit ? [commit.commitId] : [], remainingWorkIds: [], reviewedItems: input.workItems.map((work: { id: string; workItemId: string }) => ({ workItemId: work.workItemId, outcome: commit && same.some(row => row.id === work.id) ? 'changed' : 'no_change', reason: '依据本书原文判定' })) } }])
  if (details) return agentStream([{ name: 'commit_asset_changes', args: { operationKey: input.resume.nextOperationKey, payload: { groups: [{ kind: input.kind, keepId: same[0].id, memberIds: same.map(row => row.id), canonicalName: input.kind === 'character' ? '沈青' : '青石客栈', confidence: 1, reason: '原文明示别名', evidence: [{ chapterIndex: '1', quote: input.kind === 'character' ? '老沈就是船夫沈青。' : '青石客栈也叫青石栈。', memberIds: same.map(row => row.id) }] }] } } }])
  return agentStream([{ name: input.kind === 'character' ? 'get_character_detail' : 'get_location_detail', args: { ids: input.kind === 'character' ? Array.from({ length: 7 }, (_, i) => `C1-P${String(i + 1).padStart(3, '0')}`) : ['C1-L001', 'C1-L002', 'C1-L003'] } }, { name: 'read_original', args: { chapter_range: ['1', '1'] } }])
}
