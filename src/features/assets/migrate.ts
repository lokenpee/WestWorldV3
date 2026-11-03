import type { Character, CharacterRelation, EventNode, LegacyRelation, Lifecycle } from './types'
import { bindNodeCharacters } from './characterLinks'
import { bindTargetIds, characterNameIndex, normalizeDirection, normalizeRelationType, relationId, resolveSourceId } from './relations'

export interface LegacyRelationInput extends LegacyRelation {
  reverse_label?: unknown
  quote?: unknown
}

const legacyInverseLabels = new Map([
  ['父亲', '子女'], ['母亲', '子女'], ['儿子', '父母'], ['女儿', '父母'], ['子女', '父母'], ['暗恋', '被暗恋'],
])

/** 只推导可确定的反向称呼；不能确定时保留原词并标记方向未明确。 */
export function legacyRelationLabels(legacy: LegacyRelationInput) {
  const relationType = normalizeRelationType(legacy.relation_type) || 'unknown'
  const forwardLabel = (typeof legacy.relation_label === 'string' ? legacy.relation_label.trim() : '') || relationType
  const explicitReverse = typeof legacy.reverse_label === 'string' ? legacy.reverse_label.trim() : ''
  const direction = normalizeDirection(legacy.direction)
  if (explicitReverse || direction === 'bidirectional') return { relationType, forwardLabel, reverseLabel: explicitReverse || forwardLabel, direction }
  const reverseLabel = direction === 'directed' ? legacyInverseLabels.get(forwardLabel) : undefined
  return { relationType, forwardLabel, reverseLabel: reverseLabel || forwardLabel, direction: reverseLabel ? direction : 'unspecified' as const }
}

/**
 * 版本5到6：人物行内联关系转成独立关系记录。
 * originCharacterId 固定为原承载行编号；sourceId 只沿该编号解析，目标按本书全部完整命中。
 */
export function migrateCharacterRelations(characters: Character[], lifecycle: Lifecycle[], timestamp = new Date().toISOString()): CharacterRelation[] {
  const index = characterNameIndex(characters)
  const seen = new Set<string>()
  const relations: CharacterRelation[] = []
  for (const person of characters) {
    for (const legacy of (person.relations ?? []) as LegacyRelationInput[]) {
      const targetName = typeof legacy.target === 'string' ? legacy.target.trim() : ''
      if (!targetName) continue
      const { relationType, forwardLabel, reverseLabel, direction } = legacyRelationLabels(legacy)
      const chapterIndex = person.chapterIndex ?? person.sourceChapters?.[0] ?? ''
      const id = relationId({ bookId: person.bookId, originCharacterId: person.id, targetName, relationType, forwardLabel, reverseLabel, direction, chapterIndex })
      if (seen.has(id)) continue
      seen.add(id)
      relations.push({
        id, bookId: person.bookId, originCharacterId: person.id, sourceName: person.name, targetName,
        relationType, forwardLabel, reverseLabel, direction,
        evidence: chapterIndex ? [{ chapterIndex, quote: typeof legacy.quote === 'string' ? legacy.quote : '' }] : [],
        sourceId: resolveSourceId(person.id, characters, lifecycle),
        targetIds: bindTargetIds({ targetName, targetIds: [] }, characters, lifecycle, index),
        revision: 1, createdAt: timestamp, updatedAt: timestamp, legacyPayload: { ...legacy },
      })
    }
  }
  return relations
}

/** 旧节点把显示称呼变成初始绑定项，已有编号进入旧资料编号字段。 */
export function migrateNodeBindings(nodes: EventNode[], characters: Character[]): EventNode[] {
  return nodes.map(node => node.actorBindings !== undefined ? node : bindNodeCharacters({
    ...node,
    legacyActorIds: node.legacyActorIds ?? node.actorIds ?? [],
    legacyTargetCharacterIds: node.legacyTargetCharacterIds ?? node.targetCharacterIds ?? [],
  }, characters))
}
