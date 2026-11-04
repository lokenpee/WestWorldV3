import type { Character, CharacterRelation, CharacterRelationEdit, EventNode, Lifecycle, LocationAsset } from './types'
import { assetTables } from './types'
import { fuseWorldAssets, validateMergeOptions, type WorldKind } from './merge'
import { remapCharacterLinks } from './characterLinks'
import { effectivePairs, pairKeyOf, syncRelations } from './relations'
import { updateFrequencies } from './derive'

export type Row = Record<string, unknown>
/** 共同合并核心的最小存储接口：资产服务用 Dexie 适配，智能体命令用仓储适配。 */
export interface MergeStore {
  get(table: string, id: string): Promise<Row | undefined>
  rows(table: string): Promise<Row[]>
  put(table: string, row: Row): Promise<void>
  remove(table: string, id: string): Promise<void>
}
export type MergeSource = 'manual' | 'mechanical' | 'exact_name' | 'ai'
export interface MergeCoreOptions {
  bookId: string; kind: WorldKind; memberIds: string[]; keepId: string; canonicalName: string
  timestamp?: string
  /** 合并后的主名来源与人工保留标记，由各入口按自己的规则给出。 */
  nameSource: 'manual' | 'automatic'; manualKeep: boolean
  /** 成员读取时的修订号；与当前库不符时拒绝。 */
  expectedRevisions?: Record<string, number>
  /** 人工入口的频次重算范围；队列与智能体入口不重算。 */
  frequencyTexts?: { chapterIndex: string; text: string }[]
  /** 本次合并的持久确认号与修改者；用于关系编辑结果。 */
  commitId?: string
  actor?: 'manual' | 'agent'
}
export interface MergeCoreResult {
  asset: Character | LocationAsset
  members: (Character | LocationAsset)[]
  conflicts: string[]
  changedCharacterIds: string[]
  changedNodeIds: string[]
  changedRelationIds: string[]
}

interface DexieLikeTable {
  get(id: string): Promise<Row | undefined>
  toArray(): Promise<Row[]>
  put(row: Row): Promise<unknown>
  delete(id: string): Promise<void>
}
/** Dexie 适配：调用方在自己的事务中传入。 */
export function dexieMergeStore(db: { table(name: string): unknown }): MergeStore {
  const table = (name: string) => db.table(name) as DexieLikeTable
  return {
    get: (name, id) => table(name).get(id),
    rows: name => table(name).toArray(),
    put: async (name, row) => { await table(name).put(row) },
    remove: async (name, id) => { await table(name).delete(id) },
  }
}

/** 合并结果里不再保存内联关系；旧字段只在读取旧资料时投影。 */
function stripRelations<T extends object>(row: T): T {
  const copy = structuredClone(row) as Row
  delete copy.relations
  return copy as T
}

/** 合并前读取受影响人物对的有效结果，合并后按保留编号重写编辑结果。 */
async function remapPairEdits(store: MergeStore, bookId: string, fromCharacters: Character[], redirects: ReadonlyMap<string, string>, memberIds: string[], options: MergeCoreOptions, timestamp: string) {
  const relations = await store.rows('characterRelations') as unknown as CharacterRelation[]
  const edits = await store.rows('characterRelationEdits') as unknown as CharacterRelationEdit[]
  if (!edits.length) return
  const before = effectivePairs(relations, edits, fromCharacters)
  const editsByKey = new Map(edits.map(edit => [edit.pairKey, edit]))
  const mapId = (id: string) => redirects.get(id) ?? id
  const affected = before.filter(pair => memberIds.includes(pair.fromId) || memberIds.includes(pair.toId))
  if (!affected.length) return
  const groups = new Map<string, { aId: string; bId: string; aLabels: string[]; bLabels: string[]; evidence: CharacterRelation['evidence']; sourceIds: string[]; legacyIds: string[]; active: boolean; anyEdit: boolean; unclear: boolean; revision: number; updatedBy: 'manual' | 'agent' }>()
  for (const pair of affected) {
    const fromId = mapId(pair.fromId), toId = mapId(pair.toId)
    if (fromId === toId) continue
    const [aId, bId] = [fromId, toId].sort()
    const pairKey = pairKeyOf(aId, bId)
    const group = groups.get(pairKey) ?? { aId, bId, aLabels: [], bLabels: [], evidence: [], sourceIds: [], legacyIds: [], active: false, anyEdit: false, unclear: false, revision: 0, updatedBy: 'manual' }
    const forward = fromId === aId
    group.aLabels = [...new Set([...group.aLabels, ...(forward ? pair.forwardLabels : pair.reverseLabels)])]
    group.bLabels = [...new Set([...group.bLabels, ...(forward ? pair.reverseLabels : pair.forwardLabels)])]
    for (const item of pair.evidence) if (!group.evidence.some(row => row.chapterIndex === item.chapterIndex && row.quote === item.quote)) group.evidence.push(item)
    group.sourceIds = [...new Set([...group.sourceIds, ...pair.sourceRelationIds])]
    group.legacyIds = [...new Set([...group.legacyIds, ...pair.legacyRecordIds])]
    if (pair.state === 'active') { group.active = true; group.unclear = group.unclear || pair.directionUnclear }
    const edit = editsByKey.get(pair.pairKey)
    if (edit) { group.anyEdit = true; group.legacyIds = [...new Set([...group.legacyIds, ...(edit.legacyRecordIds ?? [])])]; group.revision = Math.max(group.revision, edit.revision); if (edit.updatedBy === 'agent' && !editsByKey.get(pairKey)?.updatedBy) group.updatedBy = 'agent' }
    groups.set(pairKey, group)
  }
  for (const [pairKey, group] of groups) {
    if (!group.anyEdit) continue
    const state = group.active && (group.aLabels.length || group.bLabels.length) ? 'active' : 'deleted'
    const previous = editsByKey.get(pairKey)
    await store.put('characterRelationEdits', {
      pairKey, bookId, aId: group.aId, bId: group.bId, state,
      aToBLabels: state === 'active' ? group.aLabels : [], bToALabels: state === 'active' ? group.bLabels : [],
      directionUnclear: state === 'active' ? group.unclear : false, evidence: group.evidence,
      sourceRelationIds: [...new Set([...group.sourceIds, ...(previous?.sourceRelationIds ?? [])])],
      legacyRecordIds: group.legacyIds.sort(),
      revision: Math.max(group.revision, previous?.revision ?? 0) + 1, updatedAt: timestamp,
      updatedBy: options.actor ?? group.updatedBy, commitId: options.commitId ?? crypto.randomUUID(),
    } as unknown as Row)
  }
  for (const pair of affected) {
    const fromId = mapId(pair.fromId), toId = mapId(pair.toId)
    const mapped = fromId === toId ? null : pairKeyOf(fromId, toId)
    if (mapped !== pair.pairKey) await store.remove('characterRelationEdits', pair.pairKey)
  }
}

/**
 * 人物/地点融合的共同核心：融合资产、写编号映射、收敛关系端点、更新节点引用。
 * 不自行开启事务，也不做权限、版本或证据检查；那些由各入口保留。
 */
export async function mergeWorldAssets(store: MergeStore, options: MergeCoreOptions): Promise<MergeCoreResult> {
  const { bookId, kind, memberIds, keepId, canonicalName } = options
  validateMergeOptions(kind, { memberIds, keepId, canonicalName })
  const table = assetTables[kind]
  const timestamp = options.timestamp ?? new Date().toISOString()
  const members = (await Promise.all(memberIds.map(id => store.get(table, id)))) as unknown as (Character | LocationAsset)[]
  if (members.some(row => !row || row.bookId !== bookId)) throw new Error('CONFLICT:合并成员不存在或不属于当前书籍。')
  if (options.expectedRevisions && members.some(row => Number(row.revision) !== options.expectedRevisions![row.id])) throw new Error('CONFLICT:所选资料已变化或删除，请刷新合并预览。')
  const beforeCharacters = kind === 'character' ? (await store.rows('characters')) as unknown as Character[] : []
  const beforeRows = (await store.rows(table)) as unknown as (Character | LocationAsset)[]
  const fusion = fuseWorldAssets(kind, members as never, keepId, canonicalName, timestamp)
  const asset = stripRelations({ ...fusion.result, nameSource: options.nameSource, manualKeep: options.manualKeep }) as unknown as Character | LocationAsset
  const memberSet = new Set(memberIds)
  const afterRows = beforeRows.filter(row => !memberSet.has(row.id)).concat([asset])
  const finalRows = options.frequencyTexts ? updateFrequencies(afterRows, options.frequencyTexts, kind === 'character') : afterRows
  const beforeById = new Map(beforeRows.map(row => [row.id, row]))
  for (const row of finalRows) {
    const old = beforeById.get(row.id)
    if (old && JSON.stringify(old) === JSON.stringify(row)) continue
    const next = { ...row, revision: row.id === keepId ? asset.revision : (old?.revision ?? 0) + 1 }
    await store.put(table, next as unknown as Row)
  }
  for (const member of members) if (member.id !== keepId) await store.remove(table, member.id)

  const redirects = new Map(memberIds.map(id => [id, keepId]))
  const mappings = await store.rows('assetLifecycle') as unknown as Lifecycle[]
  const current = new Map(mappings.filter(row => row.kind === kind).map(row => [row.originId, row]))
  const targetsMergeGroup = (mapping: Lifecycle) => {
    let currentId = mapping.currentId || mapping.originId
    const visited = new Set<string>([mapping.originId])
    while (!redirects.has(currentId)) {
      const next = current.get(currentId)
      if (!next || next.state === 'deleted' || (next.currentId || next.originId) === currentId) return false
      if (visited.has(currentId)) throw new Error('CONFLICT:来源映射存在循环，请检查资料后再合并。')
      visited.add(currentId); currentId = next.currentId || next.originId
    }
    return true
  }
  const ensured: Lifecycle[] = [...mappings]
  for (const id of memberIds) if (!ensured.some(row => row.kind === kind && row.originId === id)) {
    ensured.push({ key: `${kind}:${id}`, bookId, kind, originId: id, currentId: id, state: 'live', revision: 0, updatedAt: timestamp })
  }
  const afterLifecycle = ensured.map(mapping => mapping.kind === kind && mapping.state !== 'deleted' && targetsMergeGroup(mapping)
    ? { ...mapping, currentId: keepId, state: mapping.originId === keepId ? 'live' as const : 'merged' as const, revision: mapping.revision + 1, updatedAt: timestamp }
    : mapping)
  for (const mapping of afterLifecycle) {
    const before = ensured.find(row => row.key === mapping.key)
    if (JSON.stringify(before) !== JSON.stringify(mapping)) await store.put('assetLifecycle', mapping as unknown as Row)
  }

  if (kind === 'character') await remapPairEdits(store, bookId, beforeCharacters, redirects, memberIds, options, timestamp)

  const afterCharacters = kind === 'character' ? finalRows as Character[] : beforeCharacters

  const relations = await store.rows('characterRelations') as unknown as CharacterRelation[]
  const synced = kind === 'character' ? syncRelations(relations, afterCharacters, afterLifecycle, timestamp) : { changed: [] as CharacterRelation[] }
  for (const relation of synced.changed) await store.put('characterRelations', relation as unknown as Row)

  const changedNodeIds: string[] = []
  if (kind === 'character') {
    const nodes = await store.rows('nodes') as unknown as EventNode[]
    const remapped = remapCharacterLinks(nodes, beforeCharacters, afterCharacters, redirects)
    for (const [index, node] of remapped.entries()) {
      if (JSON.stringify(node) === JSON.stringify(nodes[index])) continue
      changedNodeIds.push(node.id)
      await store.put('nodes', { ...node, revision: (nodes[index]?.revision ?? 1) + 1 } as unknown as Row)
    }
  }

  const changedCharacterIds = [...new Set(synced.changed.flatMap(relation => [relation.sourceId, ...relation.targetIds]).filter((id): id is string => !!id))].sort()
  return { asset, members, conflicts: fusion.conflicts, changedCharacterIds, changedNodeIds, changedRelationIds: synced.changed.map(row => row.id) }
}
