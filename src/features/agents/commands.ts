import type { AgentRepository, AgentStore, Row } from './repository'
import { canonical, hash, records, strings, text, toolContracts, validate } from './contracts'
import { assertScope, noteFingerprint, readTool, resolveAsset, type Scope } from './queries'
import { detailTokens } from '../assets/merge'
import { mergeWorldAssets } from '../assets/mergeCore'
import { bindNodeCharacters } from '../assets/characterLinks'
import type { Character, EventNode } from '../assets/types'
import { acceptIdentityMerge } from '../world/queue'
import { normalizeCharacterNames } from '../assets/characterNames'
import { rebaseStoryCoverage, saveStoryCoverage } from '../story/coverage'
import { applyAliasChecks } from './assetAliases'

export interface QueryRead { tool: string; args: Row; resultFingerprint: string }
export interface RecordRead { table: string; id: string; resolvedId: string | null; revision: number; factFingerprint: string }
export interface ReadSet { records: RecordRead[]; queries: QueryRead[] }
export interface CommitAck { ok: true; commitId: string; operationKey: string; alreadyApplied: boolean; summary: string }
export const domainOf = (scope: Scope) => scope.profile === 'asset_editor' ? 'world' : 'narrative'
export async function checkLease(store: AgentStore, scope: Scope, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const lease = await store.get('pipelineRuns', `lease:${domainOf(scope)}`)
  if (!lease || lease.bookId !== scope.bookId || lease.owner !== scope.owner || lease.runId !== scope.runId || Number(lease.expiresAt) <= Date.now()) throw new Error('CONFLICT:本任务的执行权已失效。')
  if (scope.sessionId) {
    const session = await store.get('storySessions', scope.sessionId)
    if (!session || session.bookId !== scope.bookId || session.leaseOwner !== scope.owner || Number(session.leaseUntil) <= Date.now()) throw new Error('SCOPE:会话执行权与本任务不一致。')
  }
}
export async function appendEntry(store: AgentStore, scope: Scope, value: Row) {
  if (!scope.sessionId) return
  const session = await store.get('storySessions', scope.sessionId)
  if (!session || session.bookId !== scope.bookId) throw new Error('SCOPE:消息会话不属于当前书籍。')
  const id = crypto.randomUUID(); const timestamp = new Date().toISOString()
  await store.put('storySessionEntries', { ...value, ...(value.type === 'compaction' && !value.firstKeptEntryId ? { firstKeptEntryId: id } : {}), id, sessionId: scope.sessionId, bookId: scope.bookId, ordinal: session.nextOrdinal, parentId: session.leafId ?? null, createdAt: timestamp })
  await store.put('storySessions', { ...session, leafId: id, nextOrdinal: Number(session.nextOrdinal) + 1, updatedAt: timestamp })
}
export async function taskOf(store: AgentStore, scope: Scope) {
  const run = await store.get('pipelineRuns', scope.runId)
  if (!run || run.bookId !== scope.bookId) throw new Error('SCOPE:任务运行记录不属于当前书籍。')
  const task = records(run.tasks).find(task => task.taskId === scope.taskId)
  if (!task) throw new Error('SCOPE:子任务不存在。')
  return { run, task }
}
export async function saveTask(store: AgentStore, scope: Scope, updates: Row) {
  const { run, task } = await taskOf(store, scope)
  await store.put('pipelineRuns', { ...run, tasks: records(run.tasks).map(row => row.taskId === scope.taskId ? { ...task, ...updates, updatedAt: new Date().toISOString() } : row) })
}
export async function rebaseReadSet(store: AgentStore, scope: Scope, reads: ReadSet, historyOnly = false) {
  for (const query of reads.queries) {
    if (historyOnly && query.tool !== 'query_editor_session_history' && query.tool !== 'list_editor_sessions') continue
    query.resultFingerprint = await store.wait(hash(await readTool(store, scope, query.tool, query.args, toolContracts[scope.profile].find(tool => tool.name === query.tool)?.maxResults)))
  }
  if (!historyOnly) for (const read of reads.records) {
    const asset = ['characters', 'locations', 'nodes', 'eventLines'].includes(read.table) ? await resolveAsset(store, scope, read.table, read.id) : await store.get(read.table, read.id)
    const key = asset ? text(asset.id ?? asset.chapterIndex) : ''
    const row = asset ? await store.get(read.table, key) : undefined
    read.resolvedId = row ? key : null; read.revision = Number(row?.revision ?? 0); read.factFingerprint = await store.wait(hash(row ?? null))
  }
}
export async function validateReadSet(store: AgentStore, scope: Scope, reads: ReadSet) {
  const results = new Map<QueryRead, Row>()
  for (const query of reads.queries) {
    const value = await readTool(store, scope, query.tool, query.args, toolContracts[scope.profile].find(tool => tool.name === query.tool)?.maxResults)
    if (await store.wait(hash(value)) !== query.resultFingerprint) throw new Error(`CONFLICT:${query.tool}的已读取资料或查询结果发生变化，请重新读取。`)
    results.set(query, value)
  }
  for (const read of reads.records) {
    const row = await store.get(read.table, read.resolvedId ?? read.id)
    if ((row ? Number(row.revision ?? 0) : 0) !== read.revision || await store.wait(hash(row ?? null)) !== read.factFingerprint) throw new Error('CONFLICT:已读取的资料版本发生变化，请重新读取。')
  }
  return results
}
async function assertEvidence(store: AgentStore, evidence: Row[]) {
  for (const item of evidence) {
    const original = await store.get('chapterTexts', text(item.chapterIndex))
    if (!original || !text(original.text).includes(text(item.quote)) || !text(item.quote)) throw new Error('INVALID_ARGS:证据引文须连续存在于指定章节。')
  }
}
async function assertReadEvidence(store: AgentStore, item: Row, originalReads: Row[], purpose = '合并') {
  const chapterIndex = text(item.chapterIndex), quote = text(item.quote)
  const original = text((await store.get('chapterTexts', chapterIndex))?.text)
  const first = quote ? original.indexOf(quote) : -1
  if (first < 0) throw new Error(`INVALID_ARGS:第${chapterIndex}章找不到连续逐字引文：${JSON.stringify(quote.slice(0, 160))}。请从read_original返回的segments中复制原文，核对章节编号；省略、拼接或改写的文字请分别引用。`)
  const ranges = originalReads.flatMap(result => records(result.segments))
    .filter(segment => segment.chapterIndex === chapterIndex)
    .map(segment => ({ start: Number(segment.offset), end: Number(segment.offset) + text(segment.text).length }))
    .sort((a, b) => a.start - b.start)
  const covered: { start: number; end: number }[] = []
  for (const range of ranges) {
    const last = covered.at(-1)
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else covered.push({ ...range })
  }
  for (let at = first; at >= 0; at = original.indexOf(quote, at + 1)) {
    if (covered.some(range => range.start <= at && range.end >= at + quote.length)) return
  }
  const args = { chapter_indices: [chapterIndex], cursor: { chapterIndex, offset: first }, maxChars: Math.min(quote.length + 200, 8000) }
  throw new Error(`INVALID_ARGS:${purpose}前须读取证据所在原文片段。第${chapterIndex}章引文位于${first}–${first + quote.length}字，已读范围：${covered.map(range => `${range.start}–${range.end}`).join('、') || '无'}。请调用read_original：${JSON.stringify(args)}，必要时按nextCursor续读；补读后使用新的operationKey提交。`)
}
async function applyAssets(store: AgentStore, scope: Scope, payload: Row, readSet: ReadSet, commitId: string) {
  const originalReads = await Promise.all(readSet.queries.filter(read => read.tool === 'read_original').map(read => readTool(store, scope, read.tool, read.args)))
  const used = new Set<string>()
  for (const group of records(payload.groups)) {
    const kind = text(group.kind); const table = kind === 'character' ? 'characters' : 'locations'
    const ids = strings(group.memberIds)
    for (const id of ids) {
      if (used.has(`${kind}:${id}`)) throw new Error('INVALID_ARGS:同一条目在本命令中重复分组。')
      used.add(`${kind}:${id}`)
      if (!readSet.records.some(read => read.table === table && read.resolvedId === id)) throw new Error('INVALID_ARGS:合并成员须先读取详情。')
    }
    const members = await Promise.all(ids.map(id => store.get(table, id)))
    if (members.some(row => !row || row.bookId !== scope.bookId)) throw new Error('SCOPE:合并成员不存在或不属于当前书籍。')
    const named: Row[] = (members as Row[]).map(row => kind === 'character' ? normalizeCharacterNames({ ...row, name: text(row.name), aliases: strings(row.aliases), identity: text(row.identity) }) : row)
    const manualKeep = named.filter(row => row.manualKeep === true)
    const manualNames = [...new Set(named.filter(row => row.nameSource === 'manual').map(row => text(row.name)))]
    if (manualKeep.length > 1 || manualKeep.length === 1 && manualKeep[0].id !== group.keepId || manualNames.length > 1 || manualNames.length === 1 && manualNames[0] !== group.canonicalName) throw new Error('INVALID_ARGS:合并须保留人工指定的条目与主名。')
    if (!manualKeep.length && [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0] !== group.keepId) throw new Error('INVALID_ARGS:没有人工保留目标时，请保留编号排序最早的成员。')
    if (!named.flatMap(row => [text(row.name), ...strings(row.aliases)]).includes(text(group.canonicalName))) throw new Error('INVALID_ARGS:合并主名须来自成员的现有称呼。')
    const evidence = records(group.evidence)
    if (evidence.some(item => strings(item.memberIds).some(id => !ids.includes(id)))) throw new Error('INVALID_ARGS:证据引用了分组外成员。')
    const evidenceIds = new Set(evidence.flatMap(item => strings(item.memberIds)))
    if (ids.some(id => !evidenceIds.has(id))) throw new Error('INVALID_ARGS:原文证据须覆盖全部合并成员。')
    for (const item of evidence) {
      await assertReadEvidence(store, item, originalReads)
      for (const id of strings(item.memberIds)) { const member = named.find(row => row.id === id)!; if (![text(member.name), ...strings(member.aliases)].some(name => name && text(item.quote).includes(name))) throw new Error('INVALID_ARGS:证据须包含所引用成员的现有称呼。') }
    }
    await assertEvidence(store, evidence)
    const timestamp = new Date().toISOString()
    const kept = named.find(row => row.id === group.keepId)!
    const core = await mergeWorldAssets(store, {
      bookId: scope.bookId, kind: kind as 'character' | 'location', memberIds: ids, keepId: text(group.keepId), canonicalName: text(group.canonicalName), timestamp,
      nameSource: manualNames.length ? 'manual' : 'automatic', manualKeep: kept.manualKeep === true,
      expectedRevisions: Object.fromEntries(named.map(row => [text(row.id), Number(row.revision)])),
    })
    const merged = core.asset
    const { run } = await taskOf(store, scope)
    if (run.report) {
      const report = run.report as Row
      await store.put('pipelineRuns', { ...run, report: { ...report, groups: [...records(report.groups), { method: 'ai_identity', kind, memberIds: ids, memberNames: named.map(row => text(row.name)), keepId: merged.id, canonicalName: merged.name, aliases: merged.aliases ?? [], sourceChapters: merged.sourceChapters ?? [], conflicts: merged.mergeNotes ?? [], beforeTokens: named.reduce((sum, row) => sum + detailTokens(row as unknown as Character), 0), afterTokens: detailTokens(merged) }] } })
    }
  }
  const aliasChecks = records(payload.aliasChecks)
  if (!records(payload.groups).length && !aliasChecks.length) throw new Error('INVALID_ARGS:请提供合并组或明确的别名核实项。')
  if (aliasChecks.some(item => used.has(`${item.kind}:${item.id}`))) throw new Error('INVALID_ARGS:同一资产请先合并，再重新读取后校对别名。')
  await applyAliasChecks(store, scope, aliasChecks, readSet, commitId, async item => { await assertReadEvidence(store, item, originalReads, '别名核实'); await assertEvidence(store, [item]) })
}
async function applyStory(store: AgentStore, scope: Scope, payload: Row, readSet: ReadSet, queryResults: Map<QueryRead, Row>) {
  const timestamp = new Date().toISOString(); const remap = new Map<string, string>()
  const wasDetailed = (table: string, id: string) => {
    const tool = ({ nodes: 'get_node_detail', eventLines: 'get_event_line_detail', storyEditorNotes: 'get_editor_note_detail' } as Record<string, string>)[table]
    return readSet.queries.some(query => query.tool === tool && records(queryResults.get(query)?.data).some(row => row.id === id && !row.fields_omitted && (row.text === undefined || text(row.text).length > 0)))
  }
  const changedChapters = new Set<string>()
  for (const source of records(payload.new_nodes)) {
    const chapter = await store.get('chapters', text(source.chapterIndex)); const original = await store.get('chapterTexts', text(source.chapterIndex))
    if (!chapter || chapter.bookId !== scope.bookId || !original || !text(source.name).trim()) throw new Error('INVALID_ARGS:新增节点的章节与名称须有效。')
    const clientId = text(source.client_id)
    if (!clientId || remap.has(clientId) || await store.get('nodes', clientId) || await store.get('assetLifecycle', `node:${clientId}`)) throw new Error('INVALID_ARGS:新增节点的临时编号须唯一，且与已有编号区分。')
    const duplicate = (await store.rows('nodes')).find(row => row.chapterIndex === source.chapterIndex && row.name === source.name && text(row.quote) === text(source.quote))
    if (duplicate) { remap.set(clientId, text(duplicate.id)); continue }
    const id = `U-${crypto.randomUUID()}`; remap.set(clientId, id)
    const { client_id: _clientId, offset: _offset, ...fields } = source
    const quote = text(source.quote); const offset = quote ? text(original.text).indexOf(quote) : -1
    const nodes = await store.rows('nodes')
    const row = bindNodeCharacters({ ...fields, id, bookId: scope.bookId, chapterName: chapter.chapterName, revision: 1, createdBy: 'P3', confidence: 0.6, quote, order: Math.max(-1, ...nodes.filter(row => row.chapterIndex === chapter.chapterIndex).map(row => Number(row.order))) + 1, quoteStatus: quote ? offset < 0 ? 'unmatched' : 'matched' : 'empty', ...(offset < 0 ? {} : { offset }) } as unknown as EventNode, await store.rows('characters') as unknown as Character[])
    await store.put('nodes', row as unknown as Row)
    changedChapters.add(text(source.chapterIndex))
    await store.put('assetLifecycle', { key: `node:${id}`, bookId: scope.bookId, kind: 'node', originId: id, currentId: id, state: 'live', revision: 1, updatedAt: timestamp })
  }
  for (const chapterIndex of changedChapters) {
    const original = await store.get('chapterTexts', chapterIndex)
    const nodes = (await store.rows('nodes')).filter(row => row.chapterIndex === chapterIndex)
    if (nodes.every(row => text(row.quote) && text(original?.text).includes(text(row.quote)))) {
      nodes.sort((a, b) => text(original?.text).indexOf(text(a.quote)) - text(original?.text).indexOf(text(b.quote)) || Number(a.order) - Number(b.order) || text(a.id).localeCompare(text(b.id)))
      for (const [order, node] of nodes.entries()) {
        const offset = text(original?.text).indexOf(text(node.quote))
        if (node.order !== order || node.offset !== offset) await store.put('nodes', { ...node, order, offset, revision: Number(node.revision) + 1 })
      }
    }
  }
  const resolveId = (id: string) => remap.get(id) ?? id
  for (const op of records(payload.event_line_ops)) {
    const existingId = text(op.line_id) || text(op.keep_line_id)
    const old = existingId ? await store.get('eventLines', existingId) : undefined
    if (op.op !== 'create' && (!old || old.bookId !== scope.bookId)) throw new Error('SCOPE:事件线不存在或不属于当前书籍。')
    const affectedIds = [...(existingId ? [existingId] : []), ...strings(op.merge_line_ids)]
    for (const id of affectedIds) if (!wasDetailed('eventLines', id)) throw new Error('INVALID_ARGS:修改事件线前须调用get_event_line_detail读取详情。')
    const merging = await Promise.all(strings(op.merge_line_ids).map(id => store.get('eventLines', id)))
    if (merging.some(row => !row || row.bookId !== scope.bookId) || strings(op.merge_line_ids).includes(existingId)) throw new Error('INVALID_ARGS:事件线合并成员无效。')
    const nodeIds = [...new Set([...(op.op === 'append' || op.op === 'merge' ? strings(old?.nodeIds) : []), ...merging.flatMap(row => strings(row?.nodeIds)), ...strings(op.node_ids).map(resolveId)])]
    if (!strings(op.node_ids).length) throw new Error('INVALID_ARGS:事件线操作须有成员节点。')
    const evidenceIds = strings(op.evidenceNodeIds).map(resolveId)
    if (!nodeIds.length || evidenceIds.some(id => !nodeIds.includes(id))) throw new Error('INVALID_ARGS:事件线成员与依据节点不一致。')
    const nodes = await Promise.all(nodeIds.map(id => store.get('nodes', id)))
    if (nodes.some(row => !row || row.bookId !== scope.bookId)) throw new Error('SCOPE:事件节点不存在或不属于当前书籍。')
    const previousMembers = new Set([...(op.op === 'append' || op.op === 'merge' ? strings(old?.nodeIds) : []), ...merging.flatMap(row => strings(row?.nodeIds))])
    for (const id of [...nodeIds, ...evidenceIds]) {
      if (previousMembers.has(id) && !evidenceIds.includes(id)) continue
      if (![...remap.values()].includes(id) && !wasDetailed('nodes', id)) throw new Error('INVALID_ARGS:新串联或作为依据的节点须先调用get_node_detail读取详情。')
    }
    if (op.op === 'create' && (await store.rows('eventLines')).some(line => canonical([...strings(line.nodeIds)].sort()) === canonical([...nodeIds].sort()))) continue
    const id = existingId || `U-${crypto.randomUUID()}`
    const chapterOrder = new Map((await store.rows('chapters')).map(row => [text(row.chapterIndex), Number(row.order)]))
    nodes.sort((a, b) => (chapterOrder.get(text(a?.chapterIndex)) ?? 0) - (chapterOrder.get(text(b?.chapterIndex)) ?? 0) || Number(a?.order) - Number(b?.order) || text(a?.id).localeCompare(text(b?.id)))
    await store.put('eventLines', { ...old, id, bookId: scope.bookId, title: op.title ?? old?.title, nodeIds: nodes.map(row => text(row?.id)), chapters: [...new Set(nodes.map(row => text(row?.chapterIndex)))], cause: op.cause, process: op.process, result: op.result, lineStatus: op.line_status, revision: Number(old?.revision ?? 0) + 1, createdBy: old?.createdBy ?? 'P3', updatedAt: timestamp })
    const line = (await store.get('eventLines', id))!
    const times = nodes.map(row => text(row?.timeCoord)).filter(Boolean).sort()
    delete line.timeRange
    if (times.length) line.timeRange = [times[0], times[times.length - 1]]
    await store.put('eventLines', line)
    for (const mergedId of strings(op.merge_line_ids)) {
      await store.remove('eventLines', mergedId)
      const mapping = await store.get('assetLifecycle', `eventLine:${mergedId}`)
      await store.put('assetLifecycle', { ...mapping, key: `eventLine:${mergedId}`, bookId: scope.bookId, kind: 'eventLine', originId: mergedId, currentId: id, state: 'merged', revision: Number(mapping?.revision ?? 0) + 1, updatedAt: timestamp })
    }
    if (!old) await store.put('assetLifecycle', { key: `eventLine:${id}`, bookId: scope.bookId, kind: 'eventLine', originId: id, currentId: id, state: 'live', revision: 1, updatedAt: timestamp })
  }
  const lines = await store.rows('eventLines')
  for (const node of await store.rows('nodes')) {
    const eventLineIds = lines.filter(line => strings(line.nodeIds).includes(text(node.id))).map(line => text(line.id)).sort()
    if (canonical(eventLineIds) !== canonical(strings(node.eventLineIds).sort())) await store.put('nodes', { ...node, eventLineIds, revision: Number(node.revision) + 1 })
  }
  const memoryUpdate = payload.memory_update as Row
  const memoryId = scope.sessionId ?? 'memory'
  const previous = await store.get('storyEditorMemory', memoryId)
  if (!readSet.records.some(read => read.table === 'storyEditorMemory' && read.id === memoryId)) throw new Error('INVALID_ARGS:更新工作摘要前须读取当前工作记忆。')
  await store.put('storyEditorMemory', { id: memoryId, bookId: scope.bookId, ...(scope.sessionId ? { sessionId: scope.sessionId } : {}), workingSummary: memoryUpdate.workingSummary, revision: Number(previous?.revision ?? 0) + 1, dataFingerprint: await store.wait(hash(await store.rows('nodes'))), updatedAt: timestamp })
  for (const note of records(memoryUpdate.notes)) {
    await assertEvidence(store, records(note.evidence))
    if (!strings(note.nodeIds).length && !strings(note.lineIds).length && !records(note.evidence).length) throw new Error('INVALID_ARGS:工作事项须有节点、事件线或逐字引文依据。')
    for (const id of strings(note.nodeIds)) if (!await store.get('nodes', resolveId(id))) throw new Error('INVALID_ARGS:事项节点不存在。')
    for (const id of strings(note.lineIds)) if (!await store.get('eventLines', id)) throw new Error('INVALID_ARGS:事项事件线不存在。')
    const old = (await store.rows('storyEditorNotes')).find(row => row.sessionId === scope.sessionId && row.key === note.key)
    if (old && note.status === 'resolved' && !wasDetailed('storyEditorNotes', text(old.id))) throw new Error('INVALID_ARGS:解决已有线索前须调用get_editor_note_detail核对该事项。')
    const resolvedNote = { ...note, nodeIds: strings(note.nodeIds).map(resolveId) }
    await store.put('storyEditorNotes', { ...old, ...resolvedNote, id: old?.id ?? crypto.randomUUID(), bookId: scope.bookId, ...(scope.sessionId ? { sessionId: scope.sessionId } : {}), revision: Number(old?.revision ?? 0) + 1, stage: 'P3', basisFingerprint: await noteFingerprint(store, resolvedNote), createdAt: old?.createdAt ?? timestamp, updatedAt: timestamp })
  }
}

export async function commitCommand(repo: AgentRepository, scope: Scope, name: string, toolCallId: string, args: Row, readSet: ReadSet, signal?: AbortSignal): Promise<CommitAck> {
  assertScope(scope, repo.bookId)
  if (name !== (scope.profile === 'asset_editor' ? 'commit_asset_changes' : 'commit_story_changes')) throw new Error('SCOPE:当前职责不能执行此写工具。')
  validate(toolContracts[scope.profile].find(tool => tool.name === name)!.parameters, args)
  const operationKey = text(args.operationKey); const payload = args.payload as Row
  const payloadFingerprint = await hash({ tool: name, payload }); const timestamp = new Date().toISOString()
  const previous = await repo.transaction(true, async store => {
    const { run } = await taskOf(store, scope)
    const applied = records(run.appliedCommands).find(row => row.operationKey === operationKey)
    if (applied) {
      if (applied.taskId !== scope.taskId || applied.payloadFingerprint !== payloadFingerprint) throw new Error('IDEMPOTENCY_CONFLICT:命令键已经用于其他任务或内容。')
      return { ok: true as const, commitId: text(applied.commitId), operationKey, alreadyApplied: true, summary: text(applied.resultSummary) }
    }
    await checkLease(store, scope, signal)
    const intent = records(run.commandIntents).find(row => row.operationKey === operationKey)
    if (intent && (intent.taskId !== scope.taskId || intent.payloadFingerprint !== payloadFingerprint || intent.state === 'rejected')) throw new Error('IDEMPOTENCY_CONFLICT:命令内容或状态已变化，请使用新的命令键。')
    if (!intent) await store.put('pipelineRuns', { ...run, commandIntents: [...records(run.commandIntents), { operationKey, taskId: scope.taskId, toolCallId, toolName: name, state: 'prepared', payload, payloadFingerprint, expectedReadSet: readSet, createdAt: timestamp, updatedAt: timestamp }] })
    return undefined
  })
  if (previous) return previous
  let updatedReads: ReadSet | undefined
  try {
    const acknowledgement = await repo.transaction(true, async store => {
      await checkLease(store, scope, signal)
      const { run, task } = await taskOf(store, scope)
      const applied = records(run.appliedCommands).find(row => row.operationKey === operationKey)
      if (applied) {
        if (applied.taskId !== scope.taskId || applied.payloadFingerprint !== payloadFingerprint) throw new Error('IDEMPOTENCY_CONFLICT:命令内容不一致。')
        return { ok: true as const, commitId: text(applied.commitId), operationKey, alreadyApplied: true, summary: text(applied.resultSummary) }
      }
      const intent = records(run.commandIntents).find(row => row.operationKey === operationKey && row.taskId === scope.taskId && row.state === 'prepared')
      if (!intent) throw new Error('CONFLICT:命令意图未就绪。')
      const expected = intent.expectedReadSet as unknown as ReadSet
      const queryResults = await validateReadSet(store, scope, expected)
      const previousStory = new Map<string, Row>()
      if (name === 'commit_story_changes') for (const table of ['nodes', 'eventLines', 'storyEditorNotes']) for (const row of await store.rows(table)) previousStory.set(`${table}:${row.id}`, row)
      const workTables: Record<string, string> = { character: 'characters', location: 'locations', node: 'nodes', eventLine: 'eventLines', note: 'storyEditorNotes' }
      const workItems = records((task.input as Row | undefined)?.workItems)
      const before = await Promise.all(workItems.map(item => workTables[text(item.kind)] ? store.get(workTables[text(item.kind)], text(item.id)) : undefined))
      const commitId = crypto.randomUUID()
      if (name === 'commit_asset_changes') await applyAssets(store, scope, payload, expected, commitId)
      else await applyStory(store, scope, payload, expected, queryResults)
      signal?.throwIfAborted()
      const summary = name === 'commit_asset_changes' ? '世界资产修改已提交。' : '叙事资产与工作记忆已提交。'
      const latest = (await store.get('pipelineRuns', scope.runId))!
      const changed = [...records(task.reviewedItems)]
      const businessContent = (row: Row | undefined) => {
        if (!row) return row
        const { revision: _revision, updatedAt: _updatedAt, frequency: _frequency, ...content } = row
        if (scope.profile === 'story_editor') { delete content.order; delete content.offset }
        if (row.roleWeightSource !== 'manual') { delete content.roleWeight; delete content.roleWeightSource }
        return content
      }
      for (const [index, item] of workItems.entries()) if (workTables[text(item.kind)] && canonical(businessContent(before[index])) !== canonical(businessContent(await store.get(workTables[text(item.kind)], text(item.id))))) {
        const existing = changed.findIndex(row => row.workItemId === item.workItemId)
        const proof = { workItemId: item.workItemId, outcome: 'changed', reason: '本任务已提交该项资料的修改。' }
        if (existing < 0) changed.push(proof); else changed[existing] = proof
      }
      const updatedTask = { ...task, appliedCommitIds: [...strings(task.appliedCommitIds), commitId], reviewedItems: changed }
      await store.put('pipelineRuns', { ...latest, appliedCommands: [...records(latest.appliedCommands), { taskId: scope.taskId, operationKey, payloadFingerprint, commitId, committedAt: timestamp, resultSummary: summary }], commandIntents: records(latest.commandIntents).map(row => row.operationKey === operationKey ? { ...row, state: 'applied', commitId, updatedAt: timestamp } : row), tasks: records(latest.tasks).map(row => row.taskId === scope.taskId ? updatedTask : row) })
      await appendEntry(store, scope, { type: 'commit', summary: `${commitId}：${summary}` })
      updatedReads = structuredClone(readSet)
      await rebaseReadSet(store, scope, updatedReads)
      await saveTask(store, scope, { readSet: updatedReads })
      if (name === 'commit_story_changes') {
        await rebaseStoryCoverage(store, scope.runId, previousStory)
        const latestTask = (await taskOf(store, scope)).task
        await saveStoryCoverage(store, scope.runId, latestTask, records(latestTask.reviewedItems).filter(item => item.outcome === 'changed'))
      }
      if (name === 'commit_asset_changes') for (const group of records(payload.groups)) await acceptIdentityMerge(store, scope.runId, scope.taskId, text(group.kind), strings(group.memberIds), text(group.keepId), updatedReads)
      return { ok: true, commitId, operationKey, alreadyApplied: false, summary }
    })
    if (updatedReads) { readSet.records = updatedReads.records; readSet.queries = updatedReads.queries }
    return acknowledgement as CommitAck
  } catch (error) {
    await repo.transaction(true, async store => {
      const lease = await store.get('pipelineRuns', `lease:${domainOf(scope)}`)
      if (lease?.owner !== scope.owner) return
      const { run } = await taskOf(store, scope)
      await store.put('pipelineRuns', { ...run, commandIntents: records(run.commandIntents).map(row => row.operationKey === operationKey && row.state === 'prepared' ? { ...row, state: 'rejected', updatedAt: new Date().toISOString(), error: { code: 'COMMIT_FAILED', message: error instanceof Error ? error.message : '提交失败' } } : row) })
    }).catch(() => undefined)
    throw error
  }
}
