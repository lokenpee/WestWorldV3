import { agentStream } from './agent-protocol'

type Row = Record<string, unknown>
const contentOf = (content: unknown) => typeof content === 'string' ? content : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? '').join('') : ''
const parse = (value: unknown) => { try { return JSON.parse(contentOf(value)) as Row } catch { return {} } }
const key = () => crypto.randomUUID()
const field = (value: string, label: string) => value.match(new RegExp(`^${label}：(.+)$`, 'm'))?.[1]?.trim() ?? ''
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const rows = (value: unknown) => Array.isArray(value) ? value as Row[] : []
const labels = (value: string) => value === '（无）' ? [] : value.split('、').filter(Boolean)

function relationRows(value: string, id: string): { id: string; relations: Row[]; unlinkedRelations: Row[] } {
  const relations: Row[] = []
  const lines = value.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const start = lines[index].match(/^\d+\.\s+(\S+)｜(.*)$/)
    if (!start) continue
    const row: Row = { targetId: start[1], targetName: start[2] }
    for (let next = index + 1; next < lines.length && !/^\d+\.\s/.test(lines[next]) && !/^## /.test(lines[next]); next++) {
      const line = lines[next].trim()
      if (line.startsWith('身份：')) row.identity = line.slice(3)
      if (line.startsWith('当前人物 → 目标：')) row.forward = labels(line.slice(10))
      if (line.startsWith('目标 → 当前人物：')) row.reverse = labels(line.slice(10))
      if (line.startsWith('状态：')) {
        const state = line.match(/状态：([^；]+)/)?.[1] ?? ''
        row.state = state
        if (line.includes('方向存疑：是')) row.unclear = true
        const checked = line.match(/上次结论：(.+)$/)?.[1] ?? ''
        if (checked && checked !== '未核对') row.checked = { outcome: checked, reason: '' }
      }
    }
    relations.push(row)
  }
  return { id, relations, unlinkedRelations: [] }
}

export function organizationPromptParts(content: unknown): { kind: string; id: string; data: Row; workItemId: string } | undefined {
  const value = contentOf(content)
  const legacy = parse(content)
  if (legacy.phase === 'character_organization' && Array.isArray(legacy.workItems)) {
    const work = (legacy.work ?? {}) as Row
    const data = (work.data ?? {}) as Row
    const kind = String(work.kind ?? '')
    const id = String(data.id ?? data.pageId ?? (data.group as Row | undefined)?.id ?? '')
    const workItemId = String((legacy.workItems as Row[])[0]?.workItemId ?? '')
    return kind ? { kind, id, data, workItemId } : undefined
  }
  const kind = field(value, '任务类型')
  const id = field(value, '对象编号')
  if (!kind) return undefined
  const block = value.match(/```json\s*([\s\S]*?)```/)
  let data: Row = {}
  if (block) { try { data = JSON.parse(block[1]) as Row } catch { data = {} } }
  if (kind === 'relations') data = relationRows(value, id)
  else if (id) data = { ...data, id }
  return { kind, id, data, workItemId: `organization:${kind}:${id}` }
}

const isInput = (message: { role: string; content: unknown }) => message.role === 'user' && !!organizationPromptParts(message.content)
const finalStream = (text: string) => new Response([
  `data: ${JSON.stringify({ id: 'agent-test', object: 'chat.completion.chunk', created: 1, model: 'test-agent', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`,
  `data: ${JSON.stringify({ id: 'agent-test', object: 'chat.completion.chunk', created: 1, model: 'test-agent', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
  'data: [DONE]\n\n',
].join(''), { headers: { 'Content-Type': 'text/event-stream' } })

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
  const parsed = organizationPromptParts(messages[promptIndex].content)
  if (!parsed || typeof parsed.kind !== 'string') return undefined
  const work = { kind: parsed.kind, data: parsed.data }
  const workItemId = parsed.workItemId
  const results = messages.slice(promptIndex).filter(message => message.role === 'tool').map(message => parse(message.content))
  if (process.env.ORG_DEBUG) console.error('UNIT', work.kind, results.length, results.map(result => result.summary ?? result.step ?? result.kind ?? Object.keys(result).slice(0, 3).join(',')))
  const commitIds = results.filter(result => result.ok === true && typeof result.commitId === 'string').map(result => result.commitId as string)
  const submit = (outcome: 'changed' | 'no_change' | 'uncertain' = 'changed') => agentStream([{ name: 'submit_result', args: { status: 'completed', commitIds, summary: '当前人物整理工作项已处理。', remainingWorkIds: [], reviewedItems: [{ workItemId, outcome, reason: '按当前工作项完成' }] } }])
  const data = rows(results.flatMap(result => rows(result.data)))
  const detail = (id: string) => data.find(row => String(row.id) === id && typeof row.revision === 'number')
  if (work.kind === 'directory') {
    const next = results.findLast(result => result.page)?.page as Row | undefined
    const page = next ?? work.data
    const people = rows(page.people)
    const groups = groupOf(people).map(members => ({ memberIds: members.map(row => String(row.id)), reason: '姓名、别名或身份指向同一人物' }))
    return agentStream([
      ...(groups.length ? [{ name: 'save_identity_groups', args: { groups } }] : []),
      { name: 'navigate_identity_pages', args: { currentPageId: page.pageId, direction: 'next' } },
    ])
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
    return finalStream('人物资料已检查。')
  }
  if (work.kind === 'relations') {
    const id = String((work.data as Row).id)
    const pairs = rows((work.data as Row).relations)
    if (options.onRelation) {
      for (const pair of pairs) {
        if (pair.checked) continue
        const targetId = String(pair.targetId)
        const already = results.some(result => ['人物对关系已保存。', '人物对关系已删除。'].includes(String(result.summary)) && rows(result.affected).some(row => String(row.id) === id))
        const calls = !already ? options.onRelation({ pairKey: JSON.stringify([id, targetId].sort()), fromId: id, toId: targetId, fingerprint: 'fixture' }) : []
        if (calls.length) return agentStream(calls)
      }
    }
    if (!results.some(result => result.complete === true)) return agentStream([{ name: 'submit_relation_review', args: { changes: [], done: true, reason: '关系与现有资料一致' } }])
    return finalStream('人物关系已检查。')
  }
  return submit('no_change')
}
