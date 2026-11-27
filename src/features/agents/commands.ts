import type { AgentRepository, AgentStore, Row } from './repository'
import { canonical, hash, records, strings, text, toolContracts, validate, parametersFor } from './contracts'
import { applyOutline, OutlineError } from '../story/outlineCommands'
import { recordStoryReads, storyView } from '../story/views'
import { assertScope, noteFingerprint, readTool, resolveAsset, type Scope } from './queries'
import { detailTokens } from '../assets/merge'
import { mergeWorldAssets } from '../assets/mergeCore'
import { applyAssetPatch } from '../assets/assetPatch'
import { deleteCharacterPair, saveCharacterPair } from '../assets/relationEdits'
import { pairKeyOf } from '../assets/relations'
import { bindNodeCharacters } from '../assets/characterLinks'
import type { Basis, Character, EventNode, RelationEvidence } from '../assets/types'
import { acceptIdentityMerge } from '../world/queue'
import { rebaseStoryCoverage, saveStoryCoverage } from '../story/coverage'
import { applyAliasChecks } from './assetAliases'
import { applyOrganizationTool, assertBasis, hasCharacterDetailRead, organizationTool, reconcileOrganizationAfterWrite, replayOrganizationSubmit } from './organizationCommands'
import { noteOrganizationWrite } from './organizationReview'
import { isStoryWrite, storyAssetEdits, storyPayload, storyWriteTools } from './storyCommands'

export interface QueryRead { tool: string; args: Row; resultFingerprint: string }
export interface RecordRead { table: string; id: string; resolvedId: string | null; revision: number; factFingerprint: string }
export interface ReadSet { records: RecordRead[]; queries: QueryRead[] }
export interface CommitAck { ok: boolean; commitId?: string; status?: 'succeeded' | 'partial' | 'failed'; operationKey: string; alreadyApplied: boolean; summary: string; complete?: boolean; changed?: boolean; affected?: { kind: string; id: string; revision: number }[]; pair?: { pairKey: string; state: string; editRevision: number; fingerprint: string; legacyRecordIds?: string[] } }
interface ToolWriteResult { ok?: boolean; status?: CommitAck['status']; changed?: boolean; summary?: string; affected?: { kind: string; id: string; revision: number }[]; pair?: { pairKey: string; state: string; editRevision: number; fingerprint: string; legacyRecordIds?: string[] }; asset?: { id: string }; groupId?: string; revision?: number; reused?: boolean; clearedCount?: number; step?: string; action?: string; kind?: string; id?: string }

function replayAck(applied: Row, operationKey: string): CommitAck {
  const result = records([applied.result])[0] ?? {}
  // 兼容旧账本：逐项失败从来不代表整次请求成功。
  const failed = records(result.failed).length > 0
  const status = result.status ?? (failed ? result.changed === true ? 'partial' : 'failed' : Array.isArray(result.failed) ? 'succeeded' : undefined)
  const ack = { ...result, ok: result.ok !== false && !failed, ...(status ? { status } : {}), commitId: text(applied.commitId), operationKey, alreadyApplied: true, summary: text(applied.resultSummary) } as CommitAck
  if (status === 'failed') delete ack.commitId
  return ack
}

function bindReviewReads(reads: ReadSet, run: Row) {
  const active = (run.organization as Row | undefined)?.activeWork as Row | undefined
  const id = text(active?.characterId)
  if (!id) return
  for (const query of reads.queries) {
    const field = query.tool === 'query_character_profile' ? 'id' : query.tool === 'query_relation_work' ? 'characterId' : undefined
    if (field && !text(query.args[field])) query.args = { ...query.args, [field]: id }
  }
}

async function restoreCompletedWork(store: AgentStore, scope: Scope, run: Row, applied: Row, name: string, args: Row, reads: ReadSet, signal?: AbortSignal) {
  if (!['submit_profile_review', 'submit_relation_review'].includes(name) || (applied.result as Row | undefined)?.complete !== true) return
  const active = (run.organization as Row | undefined)?.activeWork as Row | undefined
  // 旧轮恢复可能重新挂起同一个工作项；只恢复它的完成状态，绝不能操作下一个人物。
  const unitId = text(applied.unitId) || scope.unitId
  if (!active || !unitId || text(active.id) !== unitId) return
  await checkLease(store, scope, signal)
  await replayOrganizationSubmit(store, scope, name, args, reads, text(applied.commitId))
}
export const domainOf = (scope: Scope) => scope.profile === 'asset_editor' ? 'world' : 'narrative'
export async function checkLease(store: AgentStore, scope: Scope, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const lease = await store.get('pipelineRuns', `lease:${domainOf(scope)}`)
  if (!lease || lease.bookId !== scope.bookId || lease.owner !== scope.owner || lease.runId !== scope.runId || Number(lease.expiresAt) <= Date.now()) throw scope.outline ? new OutlineError('LEASE_LOST', '本任务的执行权已失效。') : new Error('CONFLICT:本任务的执行权已失效。')
  if (scope.sessionId) {
    const session = await store.get('storySessions', scope.sessionId)
    if (!session || session.bookId !== scope.bookId || session.leaseOwner !== scope.owner || Number(session.leaseUntil) <= Date.now()) throw scope.outline ? new OutlineError('LEASE_LOST', '会话执行权与本任务不一致。') : new Error('SCOPE:会话执行权与本任务不一致。')
  }
}
export async function appendEntry(store: AgentStore, scope: Scope, value: Row, options: { advanceLeaf?: boolean } = {}) {
  if (!scope.sessionId) return
  const session = await store.get('storySessions', scope.sessionId)
  if (!session || session.bookId !== scope.bookId) throw new Error('SCOPE:消息会话不属于当前书籍。')
  const id = crypto.randomUUID(); const timestamp = new Date().toISOString()
  await store.put('storySessionEntries', { ...value, ...(scope.taskId ? { taskId: scope.taskId } : {}), ...(scope.contextId ? { contextId: scope.contextId } : {}), ...(scope.unitId ? { unitId: scope.unitId } : {}), ...(value.type === 'compaction' && !value.firstKeptEntryId ? { firstKeptEntryId: id } : {}), id, sessionId: scope.sessionId, bookId: scope.bookId, ordinal: session.nextOrdinal, parentId: session.leafId ?? null, createdAt: timestamp })
  await store.put('storySessions', { ...session, ...(options.advanceLeaf === false ? {} : { leafId: id }), nextOrdinal: Number(session.nextOrdinal) + 1, updatedAt: timestamp })
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
    const named: Row[] = members as Row[]
    const manualKeep = named.filter(row => row.manualKeep === true)
    const manualNames = [...new Set(named.filter(row => row.nameSource === 'manual').map(row => text(row.name)))]
    if (manualKeep.length > 1 || manualKeep.length === 1 && manualKeep[0].id !== group.keepId || manualNames.length > 1 || manualNames.length === 1 && manualNames[0] !== group.canonicalName) throw new Error('INVALID_ARGS:合并须保留人工指定的条目与主名。')
    if (!manualKeep.length && [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0] !== group.keepId) throw new Error('INVALID_ARGS:没有人工保留目标时，请保留编号排序最早的成员。')
    if (!named.flatMap(row => [text(row.name), ...strings(row.aliases)]).includes(text(group.canonicalName))) throw new Error('INVALID_ARGS:合并主名须来自成员的现有称呼。')
    const evidence = records(group.evidence)
    if (evidence.some(item => strings(item.memberIds).some(id => !ids.includes(id)))) throw new Error('INVALID_ARGS:证据引用了分组外成员。')
    for (const item of evidence) await assertReadEvidence(store, item, originalReads)
    await assertEvidence(store, evidence)
    const timestamp = new Date().toISOString()
    const kept = named.find(row => row.id === group.keepId)!
    const core = await mergeWorldAssets(store, {
      bookId: scope.bookId, kind: kind as 'character' | 'location', memberIds: ids, keepId: text(group.keepId), canonicalName: text(group.canonicalName), timestamp,
      nameSource: manualNames.length ? 'manual' : 'automatic', manualKeep: kept.manualKeep === true,
      expectedRevisions: Object.fromEntries(named.map(row => [text(row.id), Number(row.revision)])),
      commitId, actor: 'agent',
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
  const modern = ['story_lines_v2', 'story_pages_v3'].includes(scope.workflow ?? '')
  const paged = scope.workflow === 'story_pages_v3'
  let changed = false
  const savedNodes: Row[] = [], savedNotes: Row[] = [], lineIds: string[] = []
  const wasDetailed = (table: string, id: string) => {
    if (paged && readSet.records.some(read => read.table === table && (read.id === id || read.resolvedId === id))) return true
    const tool = ({ nodes: 'get_node_detail', eventLines: 'get_event_line_detail', storyEditorNotes: 'get_editor_note_detail' } as Record<string, string>)[table]
    const kind = ({ nodes: 'node', eventLines: 'eventLine', storyEditorNotes: 'note' } as Record<string, string>)[table]
    const details = readSet.queries.filter(query => query.tool === tool || query.tool === 'get_story_detail' && query.args.kind === kind).flatMap(query => records(queryResults.get(query)?.data)).filter(row => row.id === id && !row.fields_omitted)
    if (paged && details.length) return true
    if (details.some(row => row.text === undefined)) return true
    let end = 0
    for (const row of details.sort((a, b) => Number(a.charOffset) - Number(b.charOffset))) {
      if (Number(row.charOffset) > end) break
      end = Math.max(end, Number(row.charOffset) + text(row.text).length)
      if (end >= Number(row.totalChars)) return true
    }
    return false
  }
  const changedChapters = new Set<string>()
  for (const source of records(payload.new_nodes)) {
    const chapter = await store.get('chapters', text(source.chapterIndex)); const original = await store.get('chapterTexts', text(source.chapterIndex))
    if (!chapter || chapter.bookId !== scope.bookId || !original || !text(source.name).trim()) throw new Error('INVALID_ARGS:新增节点的章节与名称须有效。')
    if (modern && !readSet.records.some(read => read.table === 'chapterTexts' && read.id === source.chapterIndex)) throw new Error('INVALID_ARGS:补充节点前请读取对应章节原文。')
    const clientId = text(source.client_id)
    if (!clientId || remap.has(clientId) || await store.get('nodes', clientId) || await store.get('assetLifecycle', `node:${clientId}`)) throw new Error('INVALID_ARGS:新增节点的临时编号须唯一，且与已有编号区分。')
    const duplicate = (await store.rows('nodes')).find(row => row.chapterIndex === source.chapterIndex && row.name === source.name && text(row.quote) === text(source.quote))
    if (duplicate) { remap.set(clientId, text(duplicate.id)); savedNodes.push({ id: duplicate.id, name: duplicate.name, chapterIndex: duplicate.chapterIndex, reused: true }); continue }
    const id = `U-${crypto.randomUUID()}`; remap.set(clientId, id)
    changed = true; savedNodes.push({ id, name: source.name, chapterIndex: source.chapterIndex, reused: false })
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
    for (const id of affectedIds) if (!wasDetailed('eventLines', id)) throw new Error(modern ? 'INVALID_ARGS:修改事件线前须调用get_story_detail读取详情。' : 'INVALID_ARGS:修改事件线前须调用get_event_line_detail读取详情。')
    const merging = await Promise.all(strings(op.merge_line_ids).map(id => store.get('eventLines', id)))
    if (merging.some(row => !row || row.bookId !== scope.bookId) || strings(op.merge_line_ids).includes(existingId)) throw new Error('INVALID_ARGS:事件线合并成员无效。')
    const nodeIds = [...new Set([...(op.op === 'append' || op.op === 'merge' ? strings(old?.nodeIds) : []), ...merging.flatMap(row => strings(row?.nodeIds)), ...strings(op.node_ids).map(resolveId)])]
    if (!strings(op.node_ids).length) throw new Error('INVALID_ARGS:事件线操作须有成员节点。')
    const evidenceIds = strings(op.evidenceNodeIds).map(resolveId)
    if (!nodeIds.length || evidenceIds.some(id => !nodeIds.includes(id))) throw new Error('INVALID_ARGS:事件线成员与依据节点不一致。')
    const nodes = await Promise.all(nodeIds.map(id => store.get('nodes', id)))
    if (nodes.some(row => !row || row.bookId !== scope.bookId)) throw new Error('SCOPE:事件节点不存在或不属于当前书籍。')
    const previousMembers = new Set([...(op.op === 'append' || op.op === 'merge' || modern && op.op === 'update' ? strings(old?.nodeIds) : []), ...merging.flatMap(row => strings(row?.nodeIds))])
    for (const id of [...nodeIds, ...evidenceIds]) {
      if (previousMembers.has(id) && !evidenceIds.includes(id)) continue
      if (![...remap.values()].includes(id) && !wasDetailed('nodes', id)) throw new Error(modern ? 'INVALID_ARGS:新串联或作为依据的节点须先调用get_story_detail读取详情。' : 'INVALID_ARGS:新串联或作为依据的节点须先调用get_node_detail读取详情。')
    }
    const duplicate = op.op === 'create' ? (await store.rows('eventLines')).find(line => canonical([...strings(line.nodeIds)].sort()) === canonical([...nodeIds].sort()) && (!modern || line.title === op.title)) : undefined
    if (duplicate) { lineIds.push(text(duplicate.id)); continue }
    const id = existingId || `U-${crypto.randomUUID()}`
    lineIds.push(id)
    const chapterOrder = new Map((await store.rows('chapters')).map(row => [text(row.chapterIndex), Number(row.order)]))
    nodes.sort((a, b) => (chapterOrder.get(text(a?.chapterIndex)) ?? 0) - (chapterOrder.get(text(b?.chapterIndex)) ?? 0) || Number(a?.order) - Number(b?.order) || text(a?.id).localeCompare(text(b?.id)))
    const content = { title: op.title ?? old?.title, nodeIds: nodes.map(row => text(row?.id)), chapters: [...new Set(nodes.map(row => text(row?.chapterIndex)))], lineStatus: op.line_status, ...(op.summary === undefined ? {} : { summary: op.summary }) }
    if (old && !strings(op.merge_line_ids).length && canonical(content) === canonical(Object.fromEntries(Object.keys(content).map(key => [key, old[key]])))) continue
    changed = true
    await store.put('eventLines', { ...old, ...content, id, bookId: scope.bookId, revision: Number(old?.revision ?? 0) + 1, createdBy: old?.createdBy ?? 'P3', updatedAt: timestamp })
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
  const memoryUpdate = payload.memory_update as Row | undefined
  if (!memoryUpdate) return { changed, nodes: savedNodes, lineIds }
  const memoryId = scope.sessionId ?? 'memory'
  const previous = await store.get('storyEditorMemory', memoryId)
  if (memoryUpdate.workingSummary !== undefined && (!modern || memoryUpdate.workingSummary !== previous?.workingSummary)) {
    if (!readSet.records.some(read => read.table === 'storyEditorMemory' && read.id === memoryId)) throw new Error('INVALID_ARGS:更新工作摘要前须读取当前工作记忆。')
    changed = true
    await store.put('storyEditorMemory', { id: memoryId, bookId: scope.bookId, ...(scope.sessionId ? { sessionId: scope.sessionId } : {}), workingSummary: memoryUpdate.workingSummary, revision: Number(previous?.revision ?? 0) + 1, dataFingerprint: await store.wait(hash(await store.rows('nodes'))), updatedAt: timestamp })
  }
  for (const note of records(memoryUpdate.notes)) {
    if (paged) {
      for (const evidence of records(note.evidence)) {
        const chapter = await store.get('chapters', text(evidence.chapterIndex))
        if (!chapter || chapter.bookId !== scope.bookId) throw new Error('SCOPE:线索引用的章节不属于当前书籍。')
      }
    } else await assertEvidence(store, records(note.evidence))
    if (!paged && !strings(note.nodeIds).length && !strings(note.lineIds).length && !records(note.evidence).length) throw new Error('INVALID_ARGS:工作事项须有节点、事件线或引文依据。')
    for (const id of strings(note.nodeIds)) if (!await store.get('nodes', resolveId(id))) throw new Error('INVALID_ARGS:事项节点不存在。')
    for (const id of strings(note.eventIds)) if (!await store.get('storyEvents', id)) throw new Error('INVALID_ARGS:事项事件不存在。')
    for (const id of strings(note.lineIds)) if (!await store.get('eventLines', id)) throw new Error('INVALID_ARGS:事项事件线不存在。')
    const old = (await store.rows('storyEditorNotes')).find(row => row.sessionId === scope.sessionId && row.key === note.key)
    if (old && note.status === 'resolved' && !wasDetailed('storyEditorNotes', text(old.id))) {
      if (paged && scope.outline) {
        const lookup = JSON.stringify({ kind: 'note', ids: [old.id] })
        const hint = scope.quickStoryCheck ? '请在正常串联或全书复核中' : '请先'
        throw new Error(`READ_REQUIRED:关闭已有事项前需核对该事项。${hint}调用 get_story_detail ${lookup}。`)
      }
      throw new Error(modern ? 'INVALID_ARGS:解决已有线索前须调用get_story_detail核对该事项。' : 'INVALID_ARGS:解决已有线索前须调用get_editor_note_detail核对该事项。')
    }
    const resolvedNote = { ...note, ...(paged && scope.outline ? { basisVersion: 2 } : {}), nodeIds: strings(note.nodeIds).map(resolveId) }
    let saved = old
    const basisFingerprint = await noteFingerprint(store, resolvedNote)
    if (!old || old.basisFingerprint !== basisFingerprint || canonical(resolvedNote) !== canonical(Object.fromEntries(Object.keys(resolvedNote).map(key => [key, old[key]])))) {
      changed = true
      saved = { ...old, ...resolvedNote, id: old?.id ?? crypto.randomUUID(), bookId: scope.bookId, ...(scope.sessionId ? { sessionId: scope.sessionId } : {}), revision: Number(old?.revision ?? 0) + 1, stage: 'P3', basisFingerprint, createdAt: old?.createdAt ?? timestamp, updatedAt: timestamp }
      await store.put('storyEditorNotes', saved)
    }
    if (paged && scope.outline && saved) savedNotes.push(storyView(saved, 'note', true))
  }
  return { changed, nodes: savedNodes, lineIds, ...(savedNotes.length ? { notes: savedNotes } : {}) }
}

export const assetReviewTools = ['edit_character', 'edit_location', 'edit_event_node', 'edit_event_line', 'set_character_relation', 'delete_character_relation'] as const
export const relationTools = ['set_character_relation', 'delete_character_relation'] as const
export const organizationWriteTools = [...assetReviewTools, 'save_identity_groups', 'navigate_identity_pages', 'merge_assets', 'save_candidate_group', 'resolve_candidate_group', 'clear_candidate_groups', 'record_organization_progress', 'submit_profile_review', 'submit_relation_review'] as const
const editTables: Record<string, { table: string; kind: 'character' | 'location' | 'node' | 'eventLine'; detail: string }> = {
  edit_character: { table: 'characters', kind: 'character', detail: 'get_character_detail' },
  edit_location: { table: 'locations', kind: 'location', detail: 'get_location_detail' },
  edit_event_node: { table: 'nodes', kind: 'node', detail: 'get_node_detail' },
  edit_event_line: { table: 'eventLines', kind: 'eventLine', detail: 'get_event_line_detail' },
}
async function assertToolEvidence(store: AgentStore, scope: Scope, evidence: Row[], readSet: ReadSet) {
  const originalReads = await Promise.all(readSet.queries.filter(read => read.tool === 'read_original').map(read => readTool(store, scope, read.tool, read.args)))
  for (const item of evidence) await assertReadEvidence(store, item, originalReads, '修改资产')
  await assertEvidence(store, evidence)
}
function requireRecordRead(readSet: ReadSet, table: string, id: string, detail: string) {
  const read = readSet.records.some(row => row.table === table && (row.id === id || row.resolvedId === id)) ||
    readSet.queries.some(query => query.tool === detail && strings((query.args as Row)?.ids).includes(id))
  if (!read) throw new Error('INVALID_ARGS:提交前须读取该对象的完整详情。')
}
async function assertNarrativeWritable(store: AgentStore, scope: Scope, kind: string) {
  if (kind !== 'node' && kind !== 'eventLine') return
  const lease = await store.get('pipelineRuns', 'lease:narrative')
  if (lease && lease.bookId === scope.bookId && (lease.expiresAt === undefined || Number(lease.expiresAt) > Date.now()) && lease.owner !== scope.owner) throw new Error('ASSET_DOMAIN_LOCKED:叙事任务正在运行，本项待稍后继续。')
}
async function assertRelationReviewItem(store: AgentStore, scope: Scope, args: Row, fromId: string, toId: string, readSet: ReadSet) {
  const reviewItemId = text(args.reviewItemId)
  if (!reviewItemId) throw new Error('INVALID_ARGS:人物关系专项提交须提供本任务工作项reviewItemId。')
  const { task } = await taskOf(store, scope)
  const work = records((task.input as Row | undefined)?.workItems).find(item => text(item.workItemId) === reviewItemId)
  if (!work) throw new Error('INVALID_ARGS:reviewItemId不属于本任务。')
  const kind = text(work.kind), id = text(work.id), pairKey = pairKeyOf(fromId, toId)
  if (kind === 'relation' && id !== pairKey) throw new Error('INVALID_ARGS:关系项提交的人物对与工作项不一致。')
  if (kind === 'character_relation_scan' && ![fromId, toId].includes(id)) throw new Error('INVALID_ARGS:人物扫描新增关系须包含被扫描人物。')
  if (kind === 'legacy_relation') {
    const legacy = await store.get('legacyRelationRecords', id)
    if (!legacy) throw new Error('NOT_FOUND:旧关系工作项对应的归档不存在。')
    if (!readSet.queries.some(query => query.tool === 'get_legacy_relation_records' && strings((query.args as Row).ids).includes(id))) throw new Error('INVALID_ARGS:处理旧关系项前须读取该旧记录原值。')
    const known = new Set((await store.rows('characters')).map(row => text(row.id)))
    const live = strings(legacy.pairKeys).filter(key => {
      try { const [a, b] = JSON.parse(key) as string[]; return known.has(a) && known.has(b) } catch { return false }
    })
    if (live.length && !live.includes(pairKey)) throw new Error('INVALID_ARGS:旧关系项的明确端点已存在，不能用其他同名编号代替。')
  }
  if (!['relation', 'character_relation_scan', 'legacy_relation'].includes(kind)) throw new Error('INVALID_ARGS:该工作项不是人物关系专项范围。')
}

async function applyAgentAssetTool(store: AgentStore, scope: Scope, name: string, args: Row, readSet: ReadSet, commitId: string, timestamp: string) {
  const evidence = records(args.evidence)
  const basis = records(args.basis)
  if (name === 'delete_character_relation') {
    if (scope.phase === 'character_organization') {
      if (basis.length) await assertBasis(store, scope, basis, readSet)
      else await assertToolEvidence(store, scope, evidence, readSet)
    } else await assertToolEvidence(store, scope, evidence, readSet)
  }
  if ((relationTools as readonly string[]).includes(name)) {
    const fromId = text(args.fromId), toId = text(args.toId)
    requireRecordRead(readSet, 'characters', fromId, 'get_character_detail')
    requireRecordRead(readSet, 'characters', toId, 'get_character_detail')
    if (!readSet.queries.some(query => query.tool === 'get_character_relation' && text((query.args as Row).fromId) === fromId && text((query.args as Row).toId) === toId)) throw new Error('INVALID_ARGS:修改人物对前须调用get_character_relation读取当前结果和指纹。')
    if (scope.reviewScope === 'relations') await assertRelationReviewItem(store, scope, args, fromId, toId, readSet)
    if (scope.phase === 'character_organization' && name === 'delete_character_relation' && !basis.some(value => ['relation', 'asset', 'chapter'].includes(String((value.source as Row)?.kind))) && !evidence.length) throw new Error('INVALID_ARGS:删除关系须有逐字原文或可追溯依据。')
    const write = {
      bookId: scope.bookId, fromId, toId, forwardLabels: strings(args.forwardLabels), reverseLabels: strings(args.reverseLabels),
      directionUnclear: args.directionUnclear === true, evidence: evidence as unknown as RelationEvidence[], basis: basis as unknown as Basis[], reason: text(args.reason), expectedFingerprint: text(args.expectedFingerprint),
      actor: 'agent' as const, commitId, tool: name, operationKey: text(args.operationKey), runId: scope.runId,
    }
    const result = await (name === 'set_character_relation' ? saveCharacterPair : deleteCharacterPair)(store, write)
    return {
      changed: result.changed, affected: result.affected,
      pair: { pairKey: result.pair.pairKey, state: result.pair.state, editRevision: result.pair.editRevision, fingerprint: result.pair.fingerprint, legacyRecordIds: result.pair.legacyRecordIds },
      summary: name === 'set_character_relation' ? '人物对关系已保存。' : '人物对关系已删除。',
    }
  }
  const target = editTables[name]
  if (!target) throw new Error('INVALID_ARGS:未知的资产编辑工具。')
  const id = text(args.id)
  if (scope.phase === 'character_organization' && target.kind === 'character') {
    if (!await hasCharacterDetailRead(store, scope, id, readSet)) throw new Error('INVALID_ARGS:修改人物前须实际读完该人物详情，关系端点引用不能代替完整资料。')
  } else requireRecordRead(readSet, target.table, id, target.detail)
  await assertNarrativeWritable(store, scope, target.kind)
  const originalFacts = scope.phase === 'character_organization' && target.kind === 'character' ? records((await store.get('characters', id))?.mergeFacts) : []
  const result = await applyAssetPatch(store, {
    bookId: scope.bookId, kind: target.kind, id, expectedRevision: Number(args.expectedRevision),
    patch: (args.patch ?? {}) as Row, reason: text(args.reason), evidence: evidence as unknown as RelationEvidence[],
    basis: basis as unknown as Basis[], commitId, tool: name, actor: 'agent', timestamp,
  })
  if (originalFacts.length) {
    const current = (await store.get('characters', id))!
    const facts = new Map([...originalFacts, ...records(current.mergeFacts)].map(fact => [text(fact.id), fact]))
    await store.put('characters', { ...current, mergeFacts: [...facts.values()] })
  }
  const run = await store.get('pipelineRuns', scope.runId)
  if (run) {
    const report = (run.report ?? {}) as Row
    await store.put('pipelineRuns', { ...run, report: { ...report, assetEdits: [...records(report.assetEdits), result.record] } })
  }
  return { changed: result.changes.length > 0, affected: result.affected, summary: '资产字段修改已提交。' }
}
export async function commitCommand(repo: AgentRepository, scope: Scope, name: string, toolCallId: string, args: Row, readSet: ReadSet, signal?: AbortSignal): Promise<CommitAck> {
  assertScope(scope, repo.bookId)
  const relationOnly = scope.profile === 'asset_editor' && scope.phase === 'asset_review' && scope.reviewScope === 'relations'
  const organization = scope.phase === 'character_organization'
  const allowed = scope.profile === 'asset_editor'
    ? (organization ? [...organizationWriteTools] : scope.phase === 'asset_review' ? [...(relationOnly ? relationTools : assetReviewTools)] : ['commit_asset_changes'])
    : scope.workflow === 'story_pages_v3' ? [scope.outline ? 'save_story_outline' : 'save_story_lines', 'save_story_notes'] : ['commit_story_changes', ...storyWriteTools.filter(tool => tool !== 'save_story_outline')]
  if (!allowed.includes(name)) throw new Error(relationOnly ? 'WRITE_SCOPE_DENIED:人物关系专项只允许保存或删除人物对关系。' : 'SCOPE:当前职责或阶段不能执行此写工具。')
  validate(parametersFor(toolContracts[scope.profile].find(tool => tool.name === name)!, scope.workflow, scope.outline), args)
  const operationKey = text(args.operationKey); const payload = name === 'commit_asset_changes' || name === 'commit_story_changes' ? args.payload as Row : args
  const outlineWrite = name === 'save_story_outline'
  const payloadFingerprint = await hash({ tool: name, payload }); const timestamp = new Date().toISOString()
  const previous = await repo.transaction(true, async store => {
    const { run } = await taskOf(store, scope)
    if (organization && run.status === 'cancelled') throw new Error('CANCELLED:运行已取消，不能继续写入。')
    const applied = records(run.appliedCommands).find(row => row.operationKey === operationKey)
    if (applied) {
      if (applied.payloadFingerprint !== payloadFingerprint || !organization && !outlineWrite && applied.taskId !== scope.taskId) throw new Error('IDEMPOTENCY_CONFLICT:命令键已经用于其他任务或内容。')
      if (organization) await restoreCompletedWork(store, scope, run, applied, name, args, readSet, signal)
      return replayAck(applied, operationKey)
    }
    await checkLease(store, scope, signal)
    const intent = records(run.commandIntents).find(row => row.operationKey === operationKey)
    if (intent && (intent.payloadFingerprint !== payloadFingerprint || !organization && !outlineWrite && intent.taskId !== scope.taskId || intent.state === 'rejected' && !organization && !outlineWrite)) throw new Error('IDEMPOTENCY_CONFLICT:命令内容或状态已变化，请使用新的命令键。')
    if (!intent) await store.put('pipelineRuns', { ...run, commandIntents: [...records(run.commandIntents), { operationKey, taskId: scope.taskId, toolCallId, toolName: name, state: 'prepared', payload, payloadFingerprint, expectedReadSet: readSet, createdAt: timestamp, updatedAt: timestamp }] })
    else if ((organization || outlineWrite) && (intent.state === 'rejected' || intent.taskId !== scope.taskId)) await store.put('pipelineRuns', { ...run, commandIntents: records(run.commandIntents).map(row => row.operationKey === operationKey ? { ...row, taskId: scope.taskId, toolCallId, state: 'prepared', expectedReadSet: readSet, error: undefined, updatedAt: timestamp } : row) })
    return undefined
  })
  if (previous) return previous
  let updatedReads: ReadSet | undefined
  try {
    const acknowledgement = await repo.transaction(true, async store => {
      await checkLease(store, scope, signal)
      const { run, task } = await taskOf(store, scope)
      if (organization && run.status === 'cancelled') throw new Error('CANCELLED:运行已取消，不能继续写入。')
      const applied = records(run.appliedCommands).find(row => row.operationKey === operationKey)
      if (applied) {
        if (applied.payloadFingerprint !== payloadFingerprint || !organization && !outlineWrite && applied.taskId !== scope.taskId) throw new Error('IDEMPOTENCY_CONFLICT:命令内容不一致。')
        if (organization) await restoreCompletedWork(store, scope, run, applied, name, args, readSet, signal)
        return replayAck(applied, operationKey)
      }
      const intent = records(run.commandIntents).find(row => row.operationKey === operationKey && row.taskId === scope.taskId && row.state === 'prepared')
      if (!intent) throw new Error('CONFLICT:命令意图未就绪。')
      const expected = intent.expectedReadSet as unknown as ReadSet
      const dedicated = organization && ['submit_profile_review', 'submit_relation_review', 'save_identity_groups', 'navigate_identity_pages'].includes(name)
      updatedReads = structuredClone(readSet)
      if (organization) { bindReviewReads(expected, run); bindReviewReads(updatedReads, run) }
      const queryResults = organization && name === 'record_organization_progress' ? new Map<QueryRead, Row>() : dedicated ? new Map<QueryRead, Row>() : await validateReadSet(store, scope, expected)
      const previousStory = new Map<string, Row>()
      if (name === 'commit_story_changes' || isStoryWrite(name)) for (const table of ['nodes', 'eventLines', 'storyEditorNotes', ...(name === 'save_story_outline' ? ['storyEvents'] : [])]) for (const row of await store.rows(table)) previousStory.set(`${table}:${row.id}`, row)
      const workTables: Record<string, string> = { character: 'characters', location: 'locations', node: 'nodes', eventLine: 'eventLines', note: 'storyEditorNotes' }
      const workItems = records((task.input as Row | undefined)?.workItems)
      const before = await Promise.all(workItems.map(item => workTables[text(item.kind)] ? store.get(workTables[text(item.kind)], text(item.id)) : undefined))
      const commitId = crypto.randomUUID()
      let storyResult: Row | undefined
      if (name === 'commit_asset_changes') await applyAssets(store, scope, payload, expected, commitId)
      else if (name === 'commit_story_changes') await applyStory(store, scope, payload, expected, queryResults)
      else if (name === 'save_story_outline') storyResult = await applyOutline(store, scope, args, expected, timestamp)
      else if (isStoryWrite(name)) storyResult = await applyStory(store, scope, await storyPayload(store, scope, name, args), expected, queryResults)
      if (name === 'save_story_lines' && scope.workflow === 'story_pages_v3' && storyResult) {
        storyResult.lines = await Promise.all(strings(storyResult.lineIds).map(async lineId => {
          const before = strings(previousStory.get(`eventLines:${lineId}`)?.nodeIds)
          const after = strings((await store.get('eventLines', lineId))?.nodeIds)
          return { lineId, added: after.filter(id => !before.includes(id)).length, removed: before.filter(id => !after.includes(id)).length }
        }))
      }
      signal?.throwIfAborted()
      const toolResult = organizationTool(name)
        ? await applyOrganizationTool(store, scope, name, args, expected, commitId, timestamp) as ToolWriteResult
        : (assetReviewTools as readonly string[]).includes(name) ? await applyAgentAssetTool(store, scope, name, args, expected, commitId, timestamp) as ToolWriteResult : storyResult ? { ...storyResult, summary: storyResult.changed ? '故事资料已保存。' : '资料一致，本次未修改。' } as ToolWriteResult : undefined
      if (toolResult?.status === 'failed') {
        const latest = (await store.get('pipelineRuns', scope.runId))!
        await store.put('pipelineRuns', { ...latest, commandIntents: records(latest.commandIntents).map(row => row.operationKey === operationKey ? { ...row, state: 'rejected', updatedAt: timestamp, error: { code: 'SUBMIT_FAILED', message: toolResult.summary } } : row) })
        return { ...toolResult, ok: false, operationKey, alreadyApplied: false, summary: toolResult.summary ?? '本次提交失败。' } as CommitAck
      }
      await noteOrganizationWrite(store, scope, name, args, toolResult?.changed === true)
      const summary = toolResult?.summary ?? (name === 'commit_asset_changes' ? '世界资产修改已提交。' : '叙事资产与工作记忆已提交。')
      const latest = (await store.get('pipelineRuns', scope.runId))!
      if (storyResult) latest.assetEdits = [...records(latest.assetEdits), ...await storyAssetEdits(store, previousStory, name, args, storyResult, commitId, timestamp)]
      const changed = [...records(task.reviewedItems)]
      const businessContent = (row: Row | undefined) => {
        if (!row) return row
        const { revision: _revision, updatedAt: _updatedAt, frequency: _frequency, ...content } = row
        if (scope.profile === 'story_editor') { delete content.order; delete content.offset }
        if (!['manual', 'agent'].includes(String(row.roleWeightSource ?? ''))) { delete content.roleWeight; delete content.roleWeightSource }
        return content
      }
      for (const [index, item] of workItems.entries()) if (workTables[text(item.kind)] && canonical(businessContent(before[index])) !== canonical(businessContent(await store.get(workTables[text(item.kind)], text(item.id))))) {
        const existing = changed.findIndex(row => row.workItemId === item.workItemId)
        const proof = { workItemId: item.workItemId, outcome: 'changed', reason: '本任务已提交该项资料的修改。' }
        if (existing < 0) changed.push(proof); else changed[existing] = proof
      }
      if (toolResult?.pair && toolResult.changed) {
        const reviewWorkId = text(args.reviewItemId)
        const reviewWork = reviewWorkId ? workItems.find(item => text(item.workItemId) === reviewWorkId) : undefined
        const work = reviewWork ?? workItems.find(item => text(item.kind) === 'relation' && text(item.id) === toolResult.pair!.pairKey)
        if (work) {
          const existing = changed.findIndex(row => row.workItemId === work.workItemId)
          const proof = { workItemId: work.workItemId, outcome: 'changed', reason: '本任务已提交该人物对的修改。' }
          if (existing < 0) changed.push(proof); else changed[existing] = proof
        }
      }
      if (organization && toolResult?.changed && ((assetReviewTools as readonly string[]).includes(name) || name === 'merge_assets')) {
        const work = workItems.find(item => text(item.kind) === 'organization')
        if (work) {
          const existing = changed.findIndex(row => row.workItemId === work.workItemId)
          const proof = { workItemId: work.workItemId, outcome: 'changed', reason: '本任务已提交资产或关系修改。' }
          if (existing < 0) changed.push(proof); else changed[existing] = proof
        }
      }
      const updatedTask = { ...task, appliedCommitIds: [...strings(task.appliedCommitIds), commitId], reviewedItems: changed }
      let assetReview = (latest as Row).assetReview as Row | undefined
      if (toolResult?.pair) {
        const reviewWorkId = text(args.reviewItemId)
        const reviewItems = records(assetReview?.items)
        const pairKey = toolResult.pair.pairKey, fingerprint = toolResult.pair.fingerprint
        const reviewWork = reviewWorkId ? workItems.find(item => text(item.workItemId) === reviewWorkId) : undefined
        const upsertPair = (row: Row) => {
          const resolved = records(row.resolvedPairs).filter(item => text(item.pairKey) !== pairKey)
          return { ...row, commitIds: [...new Set([...strings(row.commitIds), commitId])], resolvedPairs: [...resolved, { pairKey, fingerprint }] }
        }
        const at = reviewItems.findIndex(row => text(row.workItemId) === reviewWorkId)
        if (at >= 0) reviewItems[at] = upsertPair(reviewItems[at])
        if (reviewWork && text(reviewWork.kind) === 'character_relation_scan' && toolResult.changed) {
          const relationWorkId = `asset_review:relations:relation:${encodeURIComponent(pairKey)}`
          if (!reviewItems.some(row => text(row.workItemId) === relationWorkId)) {
            const [aId, bId] = JSON.parse(pairKey) as [string, string]
            reviewItems.push({
              workItemId: relationWorkId, kind: 'relation', id: pairKey, fromId: aId, toId: bId, revision: 0, factFingerprint: fingerprint,
              status: 'checked', outcome: 'changed', reason: '人物扫描发现并提交的新关系。', taskId: scope.taskId, updatedAt: timestamp,
              commitIds: [commitId], resolvedPairs: [{ pairKey, fingerprint }],
            })
          }
        }
        assetReview = { ...(assetReview ?? { version: 1 }), items: reviewItems, updatedAt: timestamp }
      }
      if (organization) await reconcileOrganizationAfterWrite(store, scope, latest, name, args, toolResult as Row | undefined)
      await store.put('pipelineRuns', { ...latest, ...(assetReview ? { assetReview } : {}), appliedCommands: [...records(latest.appliedCommands), { taskId: scope.taskId, ...(scope.unitId ? { unitId: scope.unitId } : {}), operationKey, payloadFingerprint, commitId, committedAt: timestamp, resultSummary: summary, ...(toolResult ? { result: { ...toolResult } } : {}) }], commandIntents: records(latest.commandIntents).map(row => row.operationKey === operationKey ? { ...row, state: 'applied', commitId, updatedAt: timestamp } : row), tasks: records(latest.tasks).map(row => row.taskId === scope.taskId ? updatedTask : row) })
      await appendEntry(store, scope, { type: 'commit', summary: `${commitId}：${summary}` })
      if (outlineWrite) await recordStoryReads(store, updatedReads, records(storyResult?.changes).filter(item => item.action === 'created'))
      if (name === 'save_story_notes' && storyResult?.notes) await recordStoryReads(store, updatedReads, records(storyResult.notes))
      await rebaseReadSet(store, scope, updatedReads)
      await saveTask(store, scope, { readSet: updatedReads })
      if (name === 'commit_story_changes' || isStoryWrite(name)) {
        await rebaseStoryCoverage(store, scope.runId, previousStory)
        const latestTask = (await taskOf(store, scope)).task
        await saveStoryCoverage(store, scope.runId, latestTask, records(latestTask.reviewedItems).filter(item => item.outcome === 'changed'))
      }
      if (name === 'commit_asset_changes') for (const group of records(payload.groups)) await acceptIdentityMerge(store, scope.runId, scope.taskId, text(group.kind), strings(group.memberIds), text(group.keepId), updatedReads)
      return { ok: true, commitId, operationKey, alreadyApplied: false, ...(toolResult ?? {}), summary } as CommitAck
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
