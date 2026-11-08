import { agentStream } from './agent-protocol'

type Row = Record<string, unknown>
const contentOf = (content: unknown) => typeof content === 'string' ? content : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? '').join('') : ''
const parse = (value: unknown) => { try { return JSON.parse(contentOf(value)) as Row } catch { return {} } }
const key = () => crypto.randomUUID()
const isInput = (message: { role: string; content: unknown }) => { if (message.role !== 'user') return false; const value = parse(message.content); return value.phase === 'character_organization' && Array.isArray(value.workItems) }
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const rows = (value: unknown) => Array.isArray(value) ? value as Row[] : []

export interface OrganizationStreamOptions {
  onProfile?: (detail: Row) => { name: string; args: Row }[]
  onRelation?: (pair: { pairKey: string; fromId: string; toId: string; fingerprint: string }) => { name: string; args: Row }[]
}

function groupOf(list: Row[]): Row[][] {
  const parent = new Map(list.map(row => [String(row.id), String(row.id)]))
  const find = (id: string): string => { const value = parent.get(id)!; return value === id ? id : find(value) }
  const union = (a: string, b: string) => { const x = find(a), y = find(b); if (x !== y) parent.set(x, y) }
  const textOf = (row: Row) => [String(row.name ?? ''), ...strings(row.aliases), String(row.identity ?? ''), String(row.description ?? '')].filter(Boolean)
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j], names = [String(a.name), String(b.name)]
    const identityA = String(a.identity ?? a.description ?? ''), identityB = String(b.identity ?? b.description ?? '')
    if (a.name === b.name && identityA && identityB) {
      const left = [identityA], right = [identityB]
      if (left.some(value => right.some(other => value.includes(other) || other.includes(value)))) union(String(a.id), String(b.id))
    }
    if (textOf(a).some(value => value !== String(a.name) && value.includes(names[1])) || textOf(b).some(value => value !== String(b.name) && value.includes(names[0]))) union(String(a.id), String(b.id))
  }
  const groups = new Map<string, Row[]>()
  for (const row of list) { const root = find(String(row.id)); if (!groups.has(root)) groups.set(root, []); groups.get(root)!.push(row) }
  return [...groups.values()].filter(members => members.length > 1)
}

export function organizationResponse(body: { messages: { role: string; content: unknown }[] }, options: OrganizationStreamOptions = {}): Response | undefined {
  const messages = body.messages
  if (messages.some(message => contentOf(message.content).includes('【需要压缩的原始会话数据】'))) return agentStream([{ name: 'submit_result', args: { summary: '人物整理历史已压缩，保留当前步骤和未完成项。' } }])
  const promptIndex = messages.findLastIndex(isInput)
  if (promptIndex < 0) return undefined
  const input = parse(messages[promptIndex].content)
  const work = input.work as Row
  if (!work || typeof work.kind !== 'string') return undefined
  const results = messages.slice(promptIndex).filter(message => message.role === 'tool').map(message => parse(message.content))
  if (process.env.ORG_DEBUG) console.error('UNIT', work.kind, results.length, results.map(result => result.summary ?? result.step ?? result.kind ?? Object.keys(result).slice(0, 3).join(',')))
  const commitIds = results.filter(result => result.ok === true && typeof result.commitId === 'string').map(result => result.commitId as string)
  const submit = (outcome: 'changed' | 'no_change' | 'uncertain' = 'changed') => agentStream([{ name: 'submit_result', args: { status: 'completed', commitIds, summary: '当前人物整理工作项已处理。', remainingWorkIds: [], reviewedItems: [{ workItemId: String((input.workItems as Row[])[0].workItemId), outcome, reason: '按当前工作项完成' }] } }])
  const data = rows(results.flatMap(result => rows(result.data)))
  const detail = (id: string) => data.find(row => String(row.id) === id && typeof row.revision === 'number')
  if (work.kind === 'directory') {
    const page = Number(String((work.data as Row).pageId).split(':')[1] ?? 0)
    const catalog = results.find(result => typeof result.pageId === 'string' && Array.isArray(result.data))
    if (!catalog) return agentStream([{ name: 'query_character_catalog', args: { cursor: JSON.stringify({ page, offset: 0 }), limit: 100 } }])
    const locationList = results.find(result => Array.isArray(result.data) && typeof result.totalCount === 'number' && typeof result.pageId === 'undefined')
    if (!locationList) return agentStream([{ name: 'query_locations', args: {} }])
    const locationRows = data.filter(row => typeof row.revision === 'number' && row.description !== undefined)
    const locationIds = rows(locationList.data).map(row => String(row.id))
    if (locationRows.length < locationIds.length) return agentStream([{ name: 'get_location_detail', args: { ids: locationIds } }])
    const locationGroups = groupOf(locationRows)
    const mergedLocations = results.filter(result => !!(result.asset as Row | undefined)?.id)
    if (locationGroups.length && mergedLocations.length < locationGroups.length) return agentStream(locationGroups.slice(mergedLocations.length).map(members => ({ name: 'merge_assets', args: {
      operationKey: key(), kind: 'location', memberIds: members.map(row => String(row.id)), keepId: String(members[0].id),
      expectedRevisions: Object.fromEntries(members.map(row => [String(row.id), Number(row.revision)])), reason: '原文说明指向同一地点',
      basis: members.map(row => ({ summary: '名称、别名或描述一致', source: { kind: 'asset', assetKind: 'location', id: String(row.id) } })),
      resultPatch: { name: String(members[0].name) },
    } })))
    const pageRows = rows(catalog.data)
    const groups = groupOf(pageRows)
    const saved = results.filter(result => typeof result.groupId === 'string')
    if (!results.some(result => result.summary === '整理进度已更新。')) return agentStream([
      ...groups.filter((_, index) => !saved[index]).map(members => ({ name: 'save_candidate_group', args: { operationKey: key(), memberIds: members.map(row => String(row.id)), reason: '姓名、别名或身份指向同一人物' } })),
      { name: 'record_organization_progress', args: { operationKey: key(), action: 'check_item', kind: 'scan_page', id: String((work.data as Row).pageId) } },
    ])
    return submit('no_change')
  }
  if (work.kind === 'candidate') {
    const group = (work.data as Row).group as Row
    const members = strings(group.memberIds)
    if (members.some(id => !detail(id))) return agentStream([{ name: 'get_character_detail', args: { ids: members, include_facts: true } }])
    const resolved = results.some(result => result.summary === '疑似组结论已记录。')
    if (!resolved) {
      const details = members.map(id => detail(id)!)
      const mergeable = groupOf(details).some(component => component.length === members.length)
      const merge = results.find(result => !!(result.asset as Row | undefined)?.id)
      if (mergeable && !merge) return agentStream([{ name: 'merge_assets', args: {
        operationKey: key(), kind: 'character', memberIds: members, keepId: members[0],
        expectedRevisions: Object.fromEntries(details.map(row => [String(row.id), Number(row.revision)])), reason: '原文说明指向同一人物',
        basis: members.map(id => ({ summary: '姓名、别名或身份一致', source: { kind: 'asset', assetKind: 'character', id } })),
        resultPatch: { name: String(details[0].name) },
      } }])
      return agentStream([{ name: 'resolve_candidate_group', args: {
        operationKey: key(), groupId: String(group.id), expectedRevision: Number(group.revision),
        outcome: mergeable ? 'merged' : 'uncertain', reason: mergeable ? '已合并为同一人物' : '资料不足，保留分开',
        basis: members.map(id => ({ summary: '姓名、别名或身份一致', source: { kind: 'asset', assetKind: 'character', id } })),
        commitIds: merge?.commitId ? [merge.commitId] : [],
      } }])
    }
    return submit('changed')
  }
  if (work.kind === 'profile') {
    const id = String((work.data as Row).id)
    const complete = results.some(result => result.complete === true)
    const edited = results.find(result => result.summary === '资产字段修改已提交。')
    const calls = options.onProfile?.({ ...(work.data as Row), id }) ?? []
    if (!complete && !edited && calls.length) return agentStream(calls)
    if (!complete) return agentStream([{ name: 'submit_profile_review', args: { patch: {}, done: true, reason: edited ? '已按原文整理资料' : '资料与依据一致，无需修改', ...(edited ? { basis: [{ summary: '根据当前人物资料整理', source: { kind: 'asset', assetKind: 'character', id } }] } : {}) } }])
    return submit('changed')
  }
  if (work.kind === 'relations') {
    const id = String((work.data as Row).id)
    const pairs = rows((work.data as Row).relations)
    if (options.onRelation) {
      for (const pair of pairs) {
        if (pair.checked) continue
        const targetId = String(pair.targetId)
        const already = results.some(result => ['人物对关系已保存。', '人物对关系已删除。'].includes(String(result.summary)) && rows(result.affected).some(row => String(row.id) === id))
        const calls = !already && pair.fingerprint ? options.onRelation({ pairKey: String(pair.pairKey), fromId: id, toId: targetId, fingerprint: String(pair.fingerprint) }) : []
        if (calls.length) return agentStream(calls)
      }
    }
    if (!results.some(result => result.complete === true)) return agentStream([{ name: 'submit_relation_review', args: { changes: [], done: true, reason: '关系与现有资料一致', basis: [{ summary: '根据当前人物关系整理', source: { kind: 'asset', assetKind: 'character', id } }] } }])
    return submit('no_change')
  }
  return submit('no_change')
}