import type { Character, CharacterRelation, EventNode, LegacyRelation, Lifecycle } from './types'
import { bindNodeCharacters } from './characterLinks'
import { bindTargetIds, characterNameIndex, normalizeDirection, normalizeRelationType, relationId, resolveSourceId } from './relations'

interface LegacyRelationInput extends LegacyRelation {
  reverse_label?: unknown
  quote?: unknown
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
      const relationType = normalizeRelationType(legacy.relation_type) || 'unknown'
      const forwardLabel = (typeof legacy.relation_label === 'string' ? legacy.relation_label.trim() : '') || relationType
      const reverseLabel = (typeof legacy.reverse_label === 'string' ? legacy.reverse_label.trim() : '') || forwardLabel
      const direction = normalizeDirection(legacy.direction)
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
