import { agentStream } from './agent-protocol'

export const worldText = '第一章 镇上来客\n沈青是青石镇的船夫。老沈就是船夫沈青。药师陆川与镖师陆川是两个人，彼此并不认识。青石客栈也叫青石栈。青石客栈后院是客栈内的一处院子。张三与张三丰是不同的人。'
export const worldExtraction = {
  characters: [{ name: '沈青', identity: '船夫', aliases_mentioned: ['老沈'], confidence: 1 }, { name: '沈青', identity: '青石镇的船夫', confidence: 1 }, { name: '老沈', identity: '船夫沈青的别名', confidence: 1 }, { name: '陆川', identity: '药师', confidence: 1 }, { name: '陆川', identity: '镖师', confidence: 1 }, { name: '张三', confidence: 1 }, { name: '张三丰', confidence: 1 }],
  locations: [{ name: '青石客栈', aliases_mentioned: [], description: '镇上的客栈', confidence: 1 }, { name: '青石栈', description: '青石客栈的别名', confidence: 1 }, { name: '青石客栈后院', description: '客栈内的院子', confidence: 1 }],
}
export function worldResponse(body: { tools: { function: { parameters: { properties: Record<string, unknown> } } }[]; messages: { role: string; content: unknown }[] }): Response {
  const content = (value: unknown) => typeof value === 'string' ? value : (value as { text: string }[]).map(part => part.text).join('')
  const user = body.messages.find(row => row.role === 'user' && content(row.content).trim().startsWith('{'))
  let reviewInput: { phase?: string; workItems?: { workItemId: string; kind: string; id: string; fromId?: string; toId?: string }[] } = {}
  try { if (user) reviewInput = JSON.parse(content(user.content)) } catch { /* 提取提示词不是JSON */ }
  if (reviewInput.phase === 'asset_review') {
    const replies = body.messages.filter(row => row.role === 'tool').flatMap(row => { try { return [JSON.parse(content(row.content))] } catch { return [] } })
    if (!replies.length) {
      const calls: { name: string; args: Record<string, unknown> }[] = []
      const groups = new Map<string, { id: string; fromId?: string; toId?: string }[]>()
      for (const item of reviewInput.workItems ?? []) { if (!groups.has(item.kind)) groups.set(item.kind, []); groups.get(item.kind)!.push(item) }
      const tool = (kind: string) => ({ character: 'get_character_detail', location: 'get_location_detail', node: 'get_node_detail', eventLine: 'get_event_line_detail' } as Record<string, string>)[kind]
      for (const [kind, items] of groups) {
        if (kind === 'relation') for (const item of items) calls.push({ name: 'get_character_relation', args: { fromId: item.fromId, toId: item.toId } })
        else for (let index = 0; index < items.length; index += 20) calls.push({ name: tool(kind), args: { ids: items.slice(index, index + 20).map(item => item.id) } })
      }
      return agentStream(calls)
    }
    return agentStream([{ name: 'submit_result', args: { status: 'completed', summary: '全部资产与关系已核对，本批无需修改。', commitIds: [], remainingWorkIds: [], reviewedItems: (reviewInput.workItems ?? []).map(item => ({ workItemId: item.workItemId, outcome: 'no_change', reason: '原文依据与现有资料一致。' })) } }])
  }
  if (body.tools.length === 1) {
    const schema = body.tools[0].function.parameters
    if (schema.properties.approved) return agentStream([{ name: 'submit_result', args: { approved: true, summary: '独有事实保留，重复表述已归并。', issues: [] } }])
    if (schema.properties.entities || schema.properties.coveredFactIds) {
      const input = JSON.parse(content(body.messages.find(row => row.role === 'user')!.content))
      if (input.entities) {
        const row = input.entities[0]
        const fields = Object.fromEntries([...new Set(row.facts.map((fact: { field: string }) => fact.field))].map(field => [String(field), row.facts.filter((fact: { field: string }) => fact.field === field).map((fact: { text: string }) => fact.text).join('；')]))
        return agentStream([{ name: 'submit_result', args: { entities: { [row.id]: { entity: { name: row.name, aliases: row.aliases, ...fields }, covered_fact_ids: row.facts.map((fact: { id: string }) => fact.id), merge_notes: [] } } } }])
      }
      return agentStream([{ name: 'submit_result', args: { description: input.facts.map((fact: { text: string }) => fact.text).join('；'), coveredFactIds: input.facts.map((fact: { id: string }) => fact.id), conflicts: [] } }])
    }
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
