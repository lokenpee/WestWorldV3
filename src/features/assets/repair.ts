import { remapCharacterLinks } from './characterLinks'
import { legacyRelationLabels, type LegacyRelationInput } from './migrate'
import { normalizeDirection, resolveSourceId, syncRelations } from './relations'
import { invalidateAssetProgress, type AssetChange } from './invalidate'
import type { MergeStore, Row } from './mergeCore'
import type { Character, CharacterRelation, EventNode, Lifecycle } from './types'

export const relationRepairKind = 'relation_binding_repair'

/** 地点合并缺陷留下的特征；来源必须能通过原始编号确定，不能用姓名猜测。 */
export function hasClearedEndpoints(row: CharacterRelation, characters: Character[], lifecycle: Lifecycle[]) {
  return row.sourceId === null && !row.targetIds.length && row.revision >= 2 && resolveSourceId(row.originCharacterId, characters, lifecycle) !== null
}

/** 在调用方事务中检查并修复。人物对编辑结果始终保持原样。 */
export async function repairRelationBindings(store: MergeStore, bookId: string, timestamp = new Date().toISOString()) {
  const runs = await store.rows('pipelineRuns')
  if (runs.some(row => row.recordType === 'lease' && (row.expiresAt === undefined || Number(row.expiresAt) > Date.now()))) return false
  const characters = await store.rows('characters') as unknown as Character[]
  const lifecycle = await store.rows('assetLifecycle') as unknown as Lifecycle[]
  const relations = await store.rows('characterRelations') as unknown as CharacterRelation[]
  const nodes = await store.rows('nodes') as unknown as EventNode[]
  // 只处理本书的数据；非法归属交给备份/资料校验报告。
  if ([...characters, ...lifecycle, ...relations, ...nodes].some(row => row.bookId !== bookId)) return false
  const beforeRelations: CharacterRelation[] = [], afterRelations: CharacterRelation[] = []
  const beforeNodes: EventNode[] = [], afterNodes: EventNode[] = []
  const changes: AssetChange[] = []
  const known = new Set(characters.map(row => row.id))
  const synced = new Map(syncRelations(relations, characters, lifecycle, timestamp).relations.map(row => [row.id, row]))
  for (const row of relations) {
    const sourceId = resolveSourceId(row.originCharacterId, characters, lifecycle)
    // 已知损坏只包括全部端点被清空；其他非法引用不通过自动修复掩盖。
    if (row.sourceId !== sourceId && !hasClearedEndpoints(row, characters, lifecycle)) continue
    if (row.targetIds.some(id => !known.has(id))) continue
    let next = synced.get(row.id)!
    const legacy = row.legacyPayload as LegacyRelationInput | undefined
    if (legacy && !legacy.reverse_label && row.reverseLabel === row.forwardLabel && row.direction === normalizeDirection(legacy.direction)) {
      const labels = legacyRelationLabels(legacy)
      if (labels.forwardLabel === row.forwardLabel && labels.relationType === row.relationType) next = { ...next, ...labels }
    }
    const comparable = { ...next, revision: row.revision, updatedAt: row.updatedAt }
    if (JSON.stringify(comparable) === JSON.stringify(row)) continue
    next = { ...next, revision: row.revision + 1, updatedAt: timestamp }
    beforeRelations.push(row); afterRelations.push(next)
    for (const id of [row.sourceId, ...row.targetIds, next.sourceId, ...next.targetIds]) if (id) changes.push({ kind: 'character', id })
  }
  const redirects = new Map(lifecycle.filter(row => row.kind === 'character').flatMap(row => {
    const id = resolveSourceId(row.originId, characters, lifecycle)
    return id ? [[row.originId, id] as const] : []
  }))
  const remappedNodes = remapCharacterLinks(nodes, characters, characters, redirects)
  for (const [index, node] of nodes.entries()) {
    const ids = [...(node.actorIds ?? []), ...(node.targetCharacterIds ?? [])]
    if (ids.some(id => !known.has(id) && !redirects.has(id))) continue
    const next = remappedNodes[index]
    if (next === node) continue
    beforeNodes.push(node); afterNodes.push({ ...next, revision: node.revision + 1 })
    changes.push({ kind: 'node', id: node.id })
  }
  if (!afterRelations.length && !afterNodes.length) return false
  for (const row of afterRelations) await store.put('characterRelations', row as unknown as Row)
  for (const row of afterNodes) await store.put('nodes', row as unknown as Row)
  await invalidateAssetProgress(store, changes, timestamp, runs)
  await store.put('pipelineRuns', {
    id: `relation-repair:${crypto.randomUUID()}`, bookId, recordType: 'asset_edit', stage: 'asset_edit', status: 'completed', startedAt: timestamp, finishedAt: timestamp, planVersion: '2.2',
    result: { kind: relationRepairKind, version: 1, before: { characterRelations: beforeRelations, nodes: beforeNodes }, after: { characterRelations: afterRelations, nodes: afterNodes } },
  })
  return true
}
