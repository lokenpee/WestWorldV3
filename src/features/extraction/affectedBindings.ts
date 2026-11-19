import { characterNameIndex, resolveLifecycleId } from '../assets/relations'
import type { Character, CharacterRelation, EventNode, Lifecycle } from '../assets/types'

/** P1只新增人物时，找出称呼或编号可能新增命中的旧关联。 */
export function addedCharacterBindingScope(before: Character[], after: Character[], lifecycle: Lifecycle[]) {
  const previousIds = new Set(before.map(person => person.id))
  const added = after.filter(person => !previousIds.has(person.id))
  const addedIds = new Set(added.map(person => person.id))
  const names = new Set(characterNameIndex(added).keys())
  const people = new Map(after.map(person => [person.id, person]))
  const mappings = new Map(lifecycle.filter(row => row.kind === 'character').map(row => [row.originId, row]))
  const matchesName = (name: string) => names.has(name.trim())
  const resolve = (id: string) => resolveLifecycleId(id, lifecycle, 'character', mappings)

  return {
    added,
    relation(relation: CharacterRelation) {
      if (!added.length) return false
      const source = resolve(relation.originCharacterId)
      if ((source && addedIds.has(source)) || matchesName(relation.targetName)) return true
      return (relation.targetIds ?? []).some(id => {
        const resolved = resolve(id)
        const target = resolved ? people.get(resolved) : undefined
        // 关系还会按已绑定目标的主名补齐同名人物，包括最初通过别名绑定的目标。
        return !!target && (addedIds.has(target.id) || matchesName(target.name))
      })
    },
    node(node: EventNode) {
      if (!added.length) return false
      const groups = [...(node.actorBindings ?? []), ...(node.targetBindings ?? [])]
      if ([...node.actors, ...(node.targets ?? []), ...groups.map(group => group.mention)].some(matchesName)) return true
      return [
        ...(node.actorIds ?? []), ...(node.targetCharacterIds ?? []),
        ...(node.manualActorIds ?? []), ...(node.manualTargetCharacterIds ?? []),
        ...(node.legacyActorIds ?? []), ...(node.legacyTargetCharacterIds ?? []),
        ...groups.flatMap(group => group.ids),
      ].some(id => addedIds.has(id))
    },
  }
}
