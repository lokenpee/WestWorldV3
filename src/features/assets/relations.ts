import type { Character, CharacterRelation, Lifecycle, RelationDirection, RelationEdge, RelationEvidence, UnresolvedRelation } from './types'
import { characterMatchNames } from './characterNames'

export const relationDirections: RelationDirection[] = ['directed', 'bidirectional', 'unspecified']

/** 关系类型统一去首尾空白并转小写；方向取值不在枚举内时按“方向未明确”处理。 */
export function normalizeRelationType(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function normalizeDirection(value: unknown): RelationDirection {
  return value === 'directed' || value === 'bidirectional' ? value : 'unspecified'
}

/** 稳定关系编号：书籍、原始来源编号、规范内容与章节共同决定，重复提交复用同一行。 */
export function relationId(parts: { bookId: string; originCharacterId: string; targetName: string; relationType: string; forwardLabel: string; reverseLabel: string; direction: string; chapterIndex: string }) {
  let hash = 2166136261
  for (const character of [parts.bookId, parts.originCharacterId, parts.targetName.trim(), parts.relationType, parts.forwardLabel, parts.reverseLabel, parts.direction, parts.chapterIndex].join('\u0000')) {
    hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619)
  }
  return `R${(hash >>> 0).toString(16)}`
}

export interface ExtractedRelationInput {
  target: string; relationType: string; forwardLabel: string; reverseLabel: string
  direction: string; chapterIndex: string; quote: string
}

/** 新提取关系：归属实际落库的人物编号，目标按当前人物表全部命中。 */
export function extractedRelation(person: Character, input: ExtractedRelationInput, characters: Character[], lifecycle: Lifecycle[], timestamp = new Date().toISOString()): CharacterRelation {
  const targetName = input.target.trim()
  const relationType = normalizeRelationType(input.relationType) || 'unknown'
  const forwardLabel = input.forwardLabel.trim() || relationType
  const reverseLabel = input.reverseLabel.trim() || forwardLabel
  const direction = normalizeDirection(input.direction)
  const id = relationId({ bookId: person.bookId, originCharacterId: person.id, targetName, relationType, forwardLabel, reverseLabel, direction, chapterIndex: input.chapterIndex })
  return {
    id, bookId: person.bookId, originCharacterId: person.id, sourceName: person.name, targetName,
    relationType, forwardLabel, reverseLabel, direction, evidence: [{ chapterIndex: input.chapterIndex, quote: input.quote }],
    sourceId: resolveSourceId(person.id, characters, lifecycle), targetIds: bindTargetIds({ targetName, targetIds: [] }, characters, lifecycle),
    revision: 1, createdAt: timestamp, updatedAt: timestamp,
  }
}

/** 书名完整命中索引：主名始终参加匹配，别名沿用稳定称呼清理规则。 */
export function characterNameIndex(characters: Character[]): Map<string, string[]> {
  const index = new Map<string, string[]>()
  const add = (name: string, id: string) => {
    const value = name.trim()
    if (!value) return
    if (!index.has(value)) index.set(value, [])
    if (!index.get(value)!.includes(id)) index.get(value)!.push(id)
  }
  for (const person of characters) {
    add(person.name, person.id)
    for (const alias of characterMatchNames(person)) add(alias, person.id)
  }
  for (const ids of index.values()) ids.sort()
  return index
}

/** 一个称呼在本书命中的全部人物编号；不使用包含或相似度。 */
export function characterNameHits(name: string, characters: Character[], index = characterNameIndex(characters)): string[] {
  return index.get(name.trim()) ?? []
}

/** 沿生命周期映射解析到当前人物编号；已删除、缺失或跨书返回空。 */
export function resolveLifecycleId(id: string | null | undefined, lifecycle: Lifecycle[], kind: Lifecycle['kind'] = 'character'): string | null {
  if (!id) return null
  const mappings = new Map(lifecycle.filter(row => row.kind === kind).map(row => [row.originId, row]))
  const seen = new Set<string>()
  let current = id
  for (;;) {
    if (seen.has(current)) return null
    seen.add(current)
    const mapping = mappings.get(current)
    if (!mapping) return current
    if (mapping.state === 'deleted') return null
    const next = mapping.currentId || mapping.originId
    if (mapping.state !== 'merged' || next === current) return next
    current = next
  }
}

export function resolveSourceId(originCharacterId: string, characters: Character[], lifecycle: Lifecycle[]): string | null {
  const resolved = resolveLifecycleId(originCharacterId, lifecycle)
  return resolved && characters.some(person => person.id === resolved) ? resolved : null
}

/** 目标编号：已有编号沿映射收敛，加入称呼的当前全部命中，并把命中的同名条目一并收进。 */
export function bindTargetIds(relation: Pick<CharacterRelation, 'targetName' | 'targetIds'>, characters: Character[], lifecycle: Lifecycle[], index = characterNameIndex(characters)): string[] {
  const known = new Set(characters.map(person => person.id))
  const ids = new Set<string>()
  for (const id of relation.targetIds ?? []) {
    const resolved = resolveLifecycleId(id, lifecycle)
    if (resolved && known.has(resolved)) ids.add(resolved)
  }
  for (const id of characterNameHits(relation.targetName, characters, index)) ids.add(id)
  for (const id of [...ids]) {
    const person = characters.find(row => row.id === id)
    if (person) for (const hit of characterNameHits(person.name, characters, index)) ids.add(hit)
  }
  return [...ids].filter(id => known.has(id)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

export interface RelationBindingResult { relations: CharacterRelation[]; changed: CharacterRelation[] }

/** 统一绑定处理：来源只按原始编号解析，目标按称呼全命中；真实变化才递增修订号。 */
export function syncRelations(relations: CharacterRelation[], characters: Character[], lifecycle: Lifecycle[], timestamp = new Date().toISOString()): RelationBindingResult {
  const index = characterNameIndex(characters)
  const changed: CharacterRelation[] = []
  const next = relations.map(relation => {
    const sourceId = resolveSourceId(relation.originCharacterId, characters, lifecycle)
    const targetIds = bindTargetIds(relation, characters, lifecycle, index)
    if (sourceId === relation.sourceId && JSON.stringify(targetIds) === JSON.stringify(relation.targetIds ?? [])) return relation
    const updated = { ...relation, sourceId, targetIds, revision: relation.revision + 1, updatedAt: timestamp }
    changed.push(updated)
    return updated
  })
  return { relations: next, changed }
}

const evidenceKey = (item: RelationEvidence) => `${item.chapterIndex}\u0000${item.quote}`
const uniqueStrings = (values: string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))]

export interface RelationView { edges: RelationEdge[]; unresolved: UnresolvedRelation[] }

/** 有向关系结果：每条关系在两端各生成一个方向；同一有序端点对汇总去重标签与依据。 */
export function relationView(relations: CharacterRelation[], characters: Character[]): RelationView {
  const known = new Set(characters.map(person => person.id))
  const edges = new Map<string, RelationEdge>()
  const unresolved: UnresolvedRelation[] = []
  const add = (fromId: string, toId: string, relation: CharacterRelation, labels: string[]) => {
    const key = `${fromId}\u0000${toId}`
    const existing = edges.get(key)
    const unclear = relation.direction === 'unspecified'
    if (!existing) {
      edges.set(key, { fromId, toId, labels: uniqueStrings(labels), types: [relation.relationType], relationIds: [relation.id], evidence: [...relation.evidence], directionUnclear: unclear })
      return
    }
    existing.labels = uniqueStrings([...existing.labels, ...labels])
    existing.types = uniqueStrings([...existing.types, relation.relationType])
    if (!existing.relationIds.includes(relation.id)) existing.relationIds.push(relation.id)
    for (const item of relation.evidence) if (!existing.evidence.some(row => evidenceKey(row) === evidenceKey(item))) existing.evidence.push(item)
    existing.directionUnclear = existing.directionUnclear || unclear
  }
  for (const relation of relations) {
    const summary = { relationId: relation.id, sourceName: relation.sourceName, targetName: relation.targetName, forwardLabel: relation.forwardLabel, reverseLabel: relation.reverseLabel, direction: relation.direction }
    if (!relation.sourceId || !known.has(relation.sourceId)) { unresolved.push({ ...summary, reason: 'source_missing' }); continue }
    const targets = (relation.targetIds ?? []).filter(id => known.has(id))
    if (!targets.length) { unresolved.push({ ...summary, reason: 'target_missing' }); continue }
    let self = false
    for (const targetId of targets) {
      if (targetId === relation.sourceId) { self = true; continue }
      add(relation.sourceId, targetId, relation, [relation.forwardLabel])
      add(targetId, relation.sourceId, relation, [relation.reverseLabel])
    }
    if (self) unresolved.push({ ...summary, reason: 'self' })
  }
  return {
    edges: [...edges.values()].sort((a, b) => a.fromId.localeCompare(b.fromId, undefined, { numeric: true }) || a.toId.localeCompare(b.toId, undefined, { numeric: true })),
    unresolved,
  }
}

/** 按人物分组的有关关系：出边与入边都在内，顺序稳定。 */
export function edgesFor(edges: RelationEdge[], characterId: string): RelationEdge[] {
  return edges.filter(edge => edge.fromId === characterId || edge.toId === characterId)
}

/** 人物详情兼容字段：把关系表投影回旧的 relations 形状，不写回持久人物行。 */
export function projectRelations(edges: RelationEdge[], relations: CharacterRelation[], unresolved: UnresolvedRelation[], characterId: string, characters: Character[]) {
  const person = characters.find(row => row.id === characterId)
  const names = new Set([characterId, ...(person ? [person.name, ...characterMatchNames(person)] : [])])
  const name = (id: string) => characters.find(row => row.id === id)?.name ?? id
  const projected = edges.filter(edge => edge.fromId === characterId).map(edge => ({
    target: name(edge.toId), targetId: edge.toId, relation_type: edge.types[0] ?? '', relation_label: edge.labels.join('、'),
    direction: edge.directionUnclear ? 'unspecified' : 'directed', evidence: edge.evidence,
  }))
  const related = new Set(relations.filter(relation => relation.sourceId === characterId || names.has(relation.sourceName)).map(relation => relation.id))
  return { relations: projected, unresolvedRelations: unresolved.filter(item => related.has(item.relationId)) }
}

export interface RelationPage { items: RelationEdge[]; total: number; offset: number; nextOffset: number | null }

export function paginateEdges(edges: RelationEdge[], offset = 0, limit = 100): RelationPage {
  const start = Math.max(0, Math.trunc(offset) || 0)
  const size = Math.max(1, Math.trunc(limit) || 100)
  const items = edges.slice(start, start + size)
  const next = start + items.length < edges.length ? start + items.length : null
  return { items, total: edges.length, offset: start, nextOffset: next }
}
