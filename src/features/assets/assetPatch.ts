import { AssetError, assetTables, roleWeights, type AssetEditRecord, type AssetFieldChange, type AssetKind, type Character, type EventLine, type EventNode, type LocationAsset, type RelationEvidence, type RoleWeight } from './types'
import { bindNodeCharacters, nodeParticipants, remapCharacterLinks, setNodeParticipants } from './characterLinks'
import { normalizeCharacterNames } from './characterNames'
import { rebuildFacts } from './derive'
import { syncRelations } from './relations'

type Row = Record<string, unknown>
export interface PatchStore {
  get(table: string, id: string): Promise<Row | undefined>
  rows(table: string): Promise<Row[]>
  put(table: string, row: Row): Promise<void>
}
export interface AssetPatchInput {
  bookId: string; kind: AssetKind; id: string
  expectedRevision: number; patch: Row
  reason: string; evidence: RelationEvidence[]
  commitId: string; tool: string; actor: 'manual' | 'agent'
  timestamp?: string
}
export interface AssetPatchResult {
  asset: Row
  changes: AssetFieldChange[]
  affected: { kind: AssetKind; id: string; revision: number }[]
  record: AssetEditRecord
}

const characterFields = ['name', 'aliases', 'identity', 'ageText', 'age', 'gender', 'appearance', 'personality', 'background', 'speechStyleSample', 'roleWeight', 'chapterIndex', 'manualSourceNote'] as const
const locationFields = ['name', 'aliases', 'description', 'chapterIndex', 'manualSourceNote'] as const
const nodeFields = ['name', 'summary', 'process', 'chapterIndex', 'quote', 'participantIds', 'unlinkedParticipants', 'actors', 'targets', 'actorIds', 'targetCharacterIds', 'time_text', 'time_hint', 'world_delta', 'new_facts', 'started_actions', 'timeCoord', 'timePrecision'] as const
const lineFields = ['title', 'nodeIds', 'cause', 'process', 'result', 'lineStatus'] as const
const allowedFields: Record<AssetKind, readonly string[]> = { character: characterFields, location: locationFields, node: nodeFields, eventLine: lineFields }
const textFields = new Set(['name', 'identity', 'ageText', 'gender', 'appearance', 'personality', 'background', 'speechStyleSample', 'description', 'manualSourceNote', 'summary', 'process', 'quote', 'time_text', 'time_hint', 'timeCoord', 'timePrecision', 'title', 'cause', 'result'])
const listFields = new Set(['aliases', 'participantIds', 'unlinkedParticipants', 'actors', 'targets', 'actorIds', 'targetCharacterIds', 'world_delta', 'new_facts', 'started_actions', 'nodeIds'])

const fail = (message: string): never => { throw new AssetError('VALIDATION', message) }
const unique = (values: string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))]
const changedValue = (before: unknown, after: unknown) => JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)

export function validateAssetPatch(kind: AssetKind, patch: Row) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) fail('请提供至少一个要修改的字段。')
  for (const key of Object.keys(patch)) if (!allowedFields[kind].includes(key)) fail(`不支持修改字段：${key}`)
  if (patch.name !== undefined && (typeof patch.name !== 'string' || !patch.name.trim())) fail('名称不能为空。')
  if (patch.title !== undefined && (typeof patch.title !== 'string' || !patch.title.trim())) fail('标题不能为空。')
  if (patch.summary !== undefined && (typeof patch.summary !== 'string' || !patch.summary.trim())) fail('概述不能为空。')
  for (const key of textFields) if (patch[key] !== undefined && typeof patch[key] !== 'string') fail(`${key} 须为文本。`)
  for (const key of listFields) if (patch[key] !== undefined && (!Array.isArray(patch[key]) || !(patch[key] as unknown[]).every(value => typeof value === 'string'))) fail(`${key} 须为文本列表。`)
  if (patch.age !== undefined && patch.age !== null && (typeof patch.age !== 'number' || !Number.isFinite(patch.age) || patch.age < 0)) fail('年龄须为非负数字或 null。')
  if (patch.chapterIndex !== undefined && patch.chapterIndex !== null && typeof patch.chapterIndex !== 'string') fail('章节须为文本或 null。')
  if (kind === 'node' && patch.chapterIndex === null) fail('事件节点必须有所属章节。')
  if (patch.roleWeight !== undefined && !roleWeights.includes(patch.roleWeight as RoleWeight)) fail('人物层级无效。')
  if (patch.lineStatus !== undefined && !['open', 'closed'].includes(String(patch.lineStatus))) fail('事件线状态无效。')
  if ((patch.participantIds !== undefined || patch.unlinkedParticipants !== undefined) && ['actors', 'targets', 'actorIds', 'targetCharacterIds'].some(key => patch[key] !== undefined)) fail('统一涉及人物与底层行动/对象字段不能同次提交。')
}

async function chapterOf(store: PatchStore, bookId: string, chapterIndex: unknown) {
  if (chapterIndex === null) return undefined
  const chapter = await store.get('chapters', String(chapterIndex))
  if (!chapter || chapter.bookId !== bookId) fail('请选择本书的有效章节。')
  return chapter
}

function text(value: unknown) { return typeof value === 'string' ? value : '' }

async function patchCharacter(store: PatchStore, input: AssetPatchInput, before: Character): Promise<{ row: Character; changes: AssetFieldChange[] }> {
  const { patch } = input
  const changes: AssetFieldChange[] = []
  const row: Character = { ...before }
  const record = (field: string, value: unknown) => { const prior = (before as unknown as Row)[field]; if (changedValue(prior, value)) changes.push({ field, before: prior, after: value }) }
  if (patch.name !== undefined) {
    const name = String(patch.name).trim()
    record('name', name)
    row.name = name
    row.nameSource = 'automatic'
  }
  if (patch.aliases !== undefined) {
    const aliases = unique((patch.aliases as string[]).filter(alias => alias.trim() !== row.name))
    record('aliases', aliases)
    row.aliases = aliases
    row.verifiedAliases = [...aliases]
  }
  for (const field of ['identity', 'appearance', 'personality', 'background', 'speechStyleSample'] as const) if (patch[field] !== undefined) {
    const value = String(patch[field]); record(field, value); row[field] = value
  }
  if (patch.manualSourceNote !== undefined) { const value = String(patch.manualSourceNote).trim(); record('manualSourceNote', value); row.manualSourceNote = value }
  if (patch.chapterIndex !== undefined) {
    if (patch.chapterIndex === null) { delete row.chapterIndex; delete row.chapterName; changes.push({ field: 'chapterIndex', before: before.chapterIndex, after: null }) }
    else {
      const chapter = await chapterOf(store, input.bookId, patch.chapterIndex)
      record('chapterIndex', String(patch.chapterIndex)); row.chapterIndex = String(patch.chapterIndex); row.chapterName = text(chapter?.chapterName)
    }
  }
  if (!row.chapterIndex && !(row.sourceChapters ?? []).length && !row.manualSourceNote) fail('没有来源章节时，请填写来源说明。')
  const profile = { ...(row.profile ?? {}) }
  if (patch.age !== undefined) { changes.push({ field: 'profile.age', before: before.profile?.age, after: patch.age ?? null }); if (patch.age === null) delete profile.age; else profile.age = Number(patch.age) }
  if (patch.ageText !== undefined) { changes.push({ field: 'profile.ageText', before: before.profile?.ageText, after: String(patch.ageText) }); if (String(patch.ageText)) profile.ageText = String(patch.ageText); else delete profile.ageText }
  if (patch.gender !== undefined) { changes.push({ field: 'profile.gender', before: before.profile?.gender, after: String(patch.gender) }); if (String(patch.gender)) profile.gender = String(patch.gender); else delete profile.gender }
  row.profile = profile
  if (patch.roleWeight !== undefined) { record('roleWeight', patch.roleWeight); row.roleWeight = patch.roleWeight as RoleWeight; row.roleWeightSource = 'agent' }
  Object.assign(row, normalizeCharacterNames(row))
  const facts: Record<string, string> = {}
  for (const field of ['identity', 'appearance', 'personality', 'background'] as const) if (patch[field] !== undefined) facts[field] = String(patch[field])
  if (Object.keys(facts).length) {
    row.mergeFacts = rebuildFacts(row.mergeFacts ?? [], facts, row.sourceChapters ?? (row.chapterIndex ? [row.chapterIndex] : []))
    row.optimizedFactIds = (row.optimizedFactIds ?? []).filter(id => row.mergeFacts!.some(fact => fact.id === id))
    delete row.optimizationFingerprint
  }
  return { row, changes }
}

async function patchLocation(store: PatchStore, input: AssetPatchInput, before: LocationAsset): Promise<{ row: LocationAsset; changes: AssetFieldChange[] }> {
  const { patch } = input
  const changes: AssetFieldChange[] = []
  const row: LocationAsset = { ...before }
  const record = (field: string, value: unknown) => { const prior = (before as unknown as Row)[field]; if (changedValue(prior, value)) changes.push({ field, before: prior, after: value }) }
  if (patch.name !== undefined) { const name = String(patch.name).trim(); record('name', name); row.name = name; row.nameSource = 'automatic' }
  if (patch.aliases !== undefined) { const aliases = unique((patch.aliases as string[]).filter(alias => alias.trim() !== row.name)); record('aliases', aliases); row.aliases = aliases; row.verifiedAliases = [...aliases] }
  if (patch.description !== undefined) { record('description', String(patch.description)); row.description = String(patch.description) }
  if (patch.manualSourceNote !== undefined) { record('manualSourceNote', String(patch.manualSourceNote).trim()); row.manualSourceNote = String(patch.manualSourceNote).trim() }
  if (patch.chapterIndex !== undefined) {
    if (patch.chapterIndex === null) { delete row.chapterIndex; delete row.chapterName; changes.push({ field: 'chapterIndex', before: before.chapterIndex, after: null }) }
    else { const chapter = await chapterOf(store, input.bookId, patch.chapterIndex); record('chapterIndex', String(patch.chapterIndex)); row.chapterIndex = String(patch.chapterIndex); row.chapterName = text(chapter?.chapterName) }
  }
  if (!row.chapterIndex && !(row.sourceChapters ?? []).length && !row.manualSourceNote) fail('没有来源章节时，请填写来源说明。')
  return { row, changes }
}

async function reorderChapter(store: PatchStore, chapterIndex: string, timestamp: string) {
  const nodes = await store.rows('nodes') as unknown as EventNode[]
  const group = nodes.filter(node => node.chapterIndex === chapterIndex).sort((a, b) => (a.offset ?? Infinity) - (b.offset ?? Infinity) || a.order - b.order || a.id.localeCompare(b.id))
  for (const [order, node] of group.entries()) if (node.order !== order) await store.put('nodes', { ...node, order, revision: node.revision + 1, updatedAt: timestamp } as unknown as Row)
}

async function synchronizeLines(store: PatchStore, timestamp: string) {
  const nodes = await store.rows('nodes') as unknown as EventNode[]
  const lines = await store.rows('eventLines') as unknown as EventLine[]
  const chapters = await store.rows('chapters')
  const chapterOrder = new Map(chapters.map(chapter => [text(chapter.chapterIndex), Number(chapter.order)]))
  const nodeById = new Map(nodes.map(node => [node.id, node]))
  const surviving: EventLine[] = []
  for (const line of lines) {
    const members = unique(line.nodeIds ?? []).map(id => nodeById.get(id)).filter((node): node is EventNode => !!node)
      .sort((a, b) => (chapterOrder.get(a.chapterIndex) ?? 0) - (chapterOrder.get(b.chapterIndex) ?? 0) || a.order - b.order || a.id.localeCompare(b.id))
    if (!members.length) {
      const mapping = await store.get('assetLifecycle', `eventLine:${line.id}`)
      await store.put('assetLifecycle', { ...mapping, key: `eventLine:${line.id}`, bookId: line.bookId, kind: 'eventLine', originId: line.id, state: 'deleted', revision: Number(mapping?.revision ?? 0) + 1, updatedAt: timestamp } as unknown as Row)
      continue
    }
    const updated: EventLine = { ...line, nodeIds: members.map(node => node.id), chapters: [...new Set(members.map(node => node.chapterIndex))] }
    const times = members.map(node => node.timeCoord).filter((time): time is string => !!time).sort()
    if (times.length) updated.timeRange = [times[0], times[times.length - 1]]
    else delete updated.timeRange
    if (JSON.stringify(updated) !== JSON.stringify(line)) updated.updatedAt = timestamp
    surviving.push(updated)
    if (JSON.stringify(updated) !== JSON.stringify(line)) await store.put('eventLines', updated as unknown as Row)
  }
  const lineIdsFor = (nodeId: string) => surviving.filter(line => line.nodeIds.includes(nodeId)).map(line => line.id).sort()
  for (const node of nodes) {
    const eventLineIds = lineIdsFor(node.id)
    if (JSON.stringify(eventLineIds) !== JSON.stringify(node.eventLineIds ?? [])) await store.put('nodes', { ...node, eventLineIds, revision: node.revision + 1, updatedAt: timestamp } as unknown as Row)
  }
  return surviving
}

async function patchNode(store: PatchStore, input: AssetPatchInput, before: EventNode): Promise<{ row: Row; changes: AssetFieldChange[]; affected: AssetPatchResult['affected'] }> {
  const { patch } = input
  const changes: AssetFieldChange[] = []
  const affected: AssetPatchResult['affected'] = []
  const record = (field: string, value: unknown) => { const prior = (before as unknown as Row)[field]; if (changedValue(prior, value)) changes.push({ field, before: prior, after: value }) }
  let row: EventNode = { ...before }
  const timestamp = input.timestamp ?? new Date().toISOString()
  if (patch.chapterIndex !== undefined) {
    const chapter = await chapterOf(store, input.bookId, patch.chapterIndex)
    record('chapterIndex', patch.chapterIndex); row.chapterIndex = String(patch.chapterIndex); row.chapterName = text(chapter?.chapterName); row.order = await store.rows('nodes').then(rows => Math.max(-1, ...rows.filter(item => item.chapterIndex === row.chapterIndex && item.id !== row.id).map(item => Number(item.order ?? 0))) + 1)
  }
  if (patch.name !== undefined) { const name = String(patch.name).trim(); record('name', name); row.name = name }
  if (patch.summary !== undefined) { const summary = String(patch.summary).trim(); record('summary', summary); row.summary = summary }
  for (const field of ['process', 'time_text', 'time_hint', 'timeCoord', 'timePrecision'] as const) if (patch[field] !== undefined) { record(field, String(patch[field])); row[field] = String(patch[field]) }
  for (const field of ['world_delta', 'new_facts', 'started_actions'] as const) if (patch[field] !== undefined) { const value = unique(patch[field] as string[]); record(field, value); row[field] = value }
  if (patch.quote !== undefined) {
    const quote = String(patch.quote)
    const source = await store.get('chapterTexts', row.chapterIndex)
    const matched = !!quote.trim() && !!source && String(source.text ?? '').includes(quote)
    record('quote', quote); row.quote = quote; row.quoteStatus = !quote.trim() ? 'empty' : matched ? 'matched' : 'unmatched'
    if (matched) row.offset = String(source!.text).indexOf(quote); else delete row.offset
  }
  const characters = await store.rows('characters') as unknown as Character[]
  if (patch.participantIds !== undefined || patch.unlinkedParticipants !== undefined) {
    const prior = nodeParticipants(row, characters)
    row = setNodeParticipants(row, characters, (patch.participantIds as string[] | undefined) ?? prior.ids, (patch.unlinkedParticipants as string[] | undefined) ?? prior.names)
  } else {
    for (const field of ['actors', 'targets'] as const) if (patch[field] !== undefined) { const value = unique(patch[field] as string[]); record(field, value); row[field] = value }
    row = bindNodeCharacters(row, characters, { actorIds: patch.actorIds as string[] | undefined, targetCharacterIds: patch.targetCharacterIds as string[] | undefined })
  }
  row.revision = before.revision + 1
  ;(row as unknown as Row).updatedAt = timestamp
  await store.put('nodes', row as unknown as Row)
  affected.push({ kind: 'node', id: row.id, revision: row.revision })
  if (before.chapterIndex !== row.chapterIndex) await reorderChapter(store, before.chapterIndex, timestamp)
  await reorderChapter(store, row.chapterIndex, timestamp)
  await synchronizeLines(store, timestamp)
  return { row: row as unknown as Row, changes, affected }
}

async function patchLine(store: PatchStore, input: AssetPatchInput, before: EventLine): Promise<{ row: Row; changes: AssetFieldChange[]; affected: AssetPatchResult['affected'] }> {
  const { patch } = input
  const changes: AssetFieldChange[] = []
  const record = (field: string, value: unknown) => { const prior = (before as unknown as Row)[field]; if (changedValue(prior, value)) changes.push({ field, before: prior, after: value }) }
  const row: EventLine = { ...before, revision: before.revision + 1, updatedAt: input.timestamp ?? new Date().toISOString() }
  if (patch.title !== undefined) { const title = String(patch.title).trim(); record('title', title); row.title = title }
  for (const field of ['cause', 'process', 'result'] as const) if (patch[field] !== undefined) { record(field, String(patch[field])); row[field] = String(patch[field]) }
  if (patch.lineStatus !== undefined) { record('lineStatus', patch.lineStatus); row.lineStatus = patch.lineStatus as EventLine['lineStatus'] }
  if (patch.nodeIds !== undefined) {
    const nodeIds = unique(patch.nodeIds as string[])
    if (!nodeIds.length) fail('请至少选择一个事件节点。')
    const nodes = await Promise.all(nodeIds.map(id => store.get('nodes', id)))
    if (nodes.some(node => !node || node.bookId !== input.bookId)) fail('所选节点已删除或不属于本书。')
    record('nodeIds', nodeIds); row.nodeIds = nodeIds
  }
  const nodes = await Promise.all(row.nodeIds.map(id => store.get('nodes', id) as Promise<EventNode | undefined>))
  const chapters = await store.rows('chapters')
  const order = new Map(chapters.map(chapter => [text(chapter.chapterIndex), Number(chapter.order)]))
  const members = nodes.filter((node): node is EventNode => !!node).sort((a, b) => (order.get(a.chapterIndex) ?? 0) - (order.get(b.chapterIndex) ?? 0) || a.order - b.order || a.id.localeCompare(b.id))
  row.nodeIds = members.map(node => node.id)
  row.chapters = [...new Set(members.map(node => node.chapterIndex))]
  const times = members.map(node => node.timeCoord).filter((time): time is string => !!time).sort()
  if (times.length) row.timeRange = [times[0], times[times.length - 1]]; else delete row.timeRange
  if (!row.chapters.length) fail('事件线须至少包含一个有效节点。')
  await store.put('eventLines', row as unknown as Row)
  await synchronizeLines(store, row.updatedAt)
  return { row: row as unknown as Row, changes, affected: [{ kind: 'eventLine', id: row.id, revision: row.revision }] }
}

/** 四类资产共用的字段补丁：未传字段保留，显式清空按类型处理，派生字段由代码重算。 */
export async function applyAssetPatch(store: PatchStore, input: AssetPatchInput): Promise<AssetPatchResult> {
  validateAssetPatch(input.kind, input.patch)
  const table = assetTables[input.kind]
  const before = await store.get(table, input.id)
  if (!before || before.bookId !== input.bookId) throw new AssetError('NOT_FOUND', '资产不存在或不属于当前书籍。')
  if (Number(before.revision) !== input.expectedRevision) throw new AssetError('CONFLICT', '资料已更新，请重新读取后提交。')
  const timestamp = input.timestamp ?? new Date().toISOString()
  let result: { row: Row; changes: AssetFieldChange[]; affected: AssetPatchResult['affected'] }
  if (input.kind === 'character') {
    const patched = await patchCharacter(store, { ...input, timestamp }, before as unknown as Character)
    await store.put('characters', { ...patched.row, revision: Number(before.revision) + 1, updatedAt: timestamp } as unknown as Row)
    const nodes = await store.rows('nodes') as unknown as EventNode[]
    const afterCharacters = await store.rows('characters') as unknown as Character[]
    const remapped = remapCharacterLinks(nodes, [before as unknown as Character], afterCharacters)
    const affected: AssetPatchResult['affected'] = [{ kind: 'character', id: input.id, revision: Number(before.revision) + 1 }]
    for (const [index, node] of remapped.entries()) if (JSON.stringify(node) !== JSON.stringify(nodes[index])) {
      const revision = Number(nodes[index].revision) + 1
      await store.put('nodes', { ...node, revision, updatedAt: timestamp } as unknown as Row)
      affected.push({ kind: 'node', id: node.id, revision })
    }
    const relations = await store.rows('characterRelations')
    const synced = syncRelations(relations as never, afterCharacters, await store.rows('assetLifecycle') as never, timestamp)
    for (const relation of synced.changed) await store.put('characterRelations', relation as unknown as Row)
    result = { row: { ...patched.row, revision: Number(before.revision) + 1 }, changes: patched.changes, affected }
  } else if (input.kind === 'location') {
    const patched = await patchLocation(store, { ...input, timestamp }, before as unknown as LocationAsset)
    const next = { ...patched.row, revision: Number(before.revision) + 1, updatedAt: timestamp }
    await store.put('locations', next as unknown as Row)
    result = { row: next, changes: patched.changes, affected: [{ kind: 'location', id: input.id, revision: next.revision }] }
  } else if (input.kind === 'node') {
    result = await patchNode(store, { ...input, timestamp }, before as unknown as EventNode)
  } else {
    result = await patchLine(store, { ...input, timestamp }, before as unknown as EventLine)
  }
  const record: AssetEditRecord = {
    commitId: input.commitId, tool: input.tool, kind: input.kind, id: input.id,
    fieldChanges: result.changes, reason: input.reason, evidence: input.evidence, timestamp, actor: input.actor,
  }
  return { asset: result.row, changes: result.changes, affected: result.affected, record }
}
