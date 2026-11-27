import { AssetError, type Character, type CharacterBinding, type EventNode, type Lifecycle } from './types'
import { characterNameHits, characterNameIndex, resolveLifecycleId } from './relations'

const unique = (values: string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))]

/** 本书全部同名命中；主名完整相等始终参加，别名沿用稳定称呼清理规则。 */
export const characterCandidates = (name: string, characters: Character[]) => characterNameHits(name, characters)

export interface NodeBindingOptions {
  /** 人工明确指定的编号，独立于自动称呼组保存。 */
  actorIds?: string[]
  /** 移除整组自动来源的原始称呼。 */
  removedMentions?: string[]
  /** 明确移除的称呼：不再保留原称呼文字。 */
  droppedMentions?: string[]
  /** 旧显示名：改名重映射时不再当作新的称呼来源。 */
  ignoreMentions?: string[]
  lifecycle?: Lifecycle[]
}

interface SideInput { mentions: string[]; existing: CharacterBinding[]; manual: string[] }

export function createNodeBindingContext(characters: Character[], lifecycle: Lifecycle[] = []) {
  return { index: characterNameIndex(characters), people: new Map(characters.map(person => [person.id, person])), mappings: new Map(lifecycle.filter(row => row.kind === 'character').map(row => [row.originId, row])) }
}

function bindSide(input: SideInput, characters: Character[], index: Map<string, string[]>, lifecycle: Lifecycle[], options: NodeBindingOptions, context: ReturnType<typeof createNodeBindingContext>) {
  const known = context.people
  const removed = new Set((options.removedMentions ?? []).map(value => value.trim()))
  const dropped = new Set((options.droppedMentions ?? []).map(value => value.trim()))
  const ignore = new Set((options.ignoreMentions ?? []).map(value => value.trim()))
  const remap = (ids: string[]) => unique(ids.map(id => resolveLifecycleId(id, lifecycle, 'character', context.mappings) ?? id).filter(id => known.has(id)))
  const manual = remap(input.manual)
  const groupNames = new Set(unique(input.existing.flatMap(group => group.ids)).map(id => context.people.get(id)?.name).filter((name): name is string => !!name))
  const requested = unique(input.mentions).filter(mention => !ignore.has(mention))
  const covered = new Set([...input.existing.map(group => group.mention), ...groupNames])
  const mentions = unique([...input.existing.map(group => group.mention), ...requested.filter(mention => !covered.has(mention))])
  const groups: CharacterBinding[] = []
  for (const mention of mentions) {
    if (removed.has(mention) || dropped.has(mention)) continue
    const prior = input.existing.find(group => group.mention === mention)
    const ids = unique([...(prior?.ids ?? []), ...characterNameHits(mention, characters, index)]).filter(id => known.has(id))
    if (!ids.length && prior?.ids.length) { dropped.add(mention); continue }
    groups.push({ mention, ids })
  }
  const ids = unique([...groups.flatMap(group => group.ids), ...manual])
  const names = unique([...ids.map(id => context.people.get(id)!.name), ...groups.filter(group => !group.ids.length).map(group => group.mention)])
  return { groups, manual, ids, names }
}

/** 保存节点：称呼组各自保存全部命中，人工明确指定的编号单独保存。 */
export function bindNodeCharacters(node: EventNode, characters: Character[], options: NodeBindingOptions = {}, context = createNodeBindingContext(characters, options.lifecycle)): EventNode {
  const index = context.index
  const lifecycle = options.lifecycle ?? []
  const actors = bindSide({ mentions: node.actors, existing: node.actorBindings ?? [], manual: options.actorIds ?? node.manualActorIds ?? [] }, characters, index, lifecycle, options, context)
  const updated = { ...node, actors: actors.names, actorIds: actors.ids, actorBindings: actors.groups }
  if (actors.manual.length) updated.manualActorIds = actors.manual
  else delete updated.manualActorIds
  return updated
}

/** 单个称呼绑定：返回全部命中编号与显示名称，供直接调用方使用。 */
export function bindCharacterNames(names: string[], characters: Character[], selectedIds?: string[]) {
  const index = characterNameIndex(characters)
  const hits = names.flatMap(name => characterNameHits(name, characters, index))
  const ids = unique(selectedIds?.length ? selectedIds : hits)
  const people = ids.map(id => characters.find(person => person.id === id)).filter((person): person is Character => !!person)
  const display = unique([...people.map(person => person.name), ...names.filter(name => !characterNameHits(name, characters, index).length)])
  return { ids, names: display }
}

/** 涉及人物的已绑定编号及尚未绑定的原文称呼。 */
export function nodeParticipants(node: EventNode, characters: Character[]) {
  const ids = unique(node.actorIds ?? [])
  const resolved = new Set(characters.filter(person => ids.includes(person.id)).map(person => person.name))
  for (const group of node.actorBindings ?? []) if (group.ids.length) resolved.add(group.mention)
  return { ids, names: unique(node.actors).filter(name => !resolved.has(name)) }
}

export function setNodeParticipants(node: EventNode, characters: Character[], selectedIds: string[], mentions: string[], removedMentions: string[] = []) {
  if (selectedIds.some(id => !characters.some(person => person.id === id))) throw new AssetError('VALIDATION', '所选人物已删除，请重新选择。', 'participantIds')
  const dropped = (node.actorBindings ?? []).filter(group =>
    !mentions.includes(group.mention) && (!group.ids.length || !group.ids.every(id => selectedIds.includes(id)))
  ).map(group => group.mention)
  return bindNodeCharacters({ ...node, actors: mentions }, characters, { actorIds: selectedIds, removedMentions, droppedMentions: dropped })
}

/** 人物新增、改名、删除或合并后维护节点：历史绑定按编号保留，新命中自动补齐。 */
export function remapCharacterLinks(nodes: EventNode[], before: Character[], after: Character[], redirects: ReadonlyMap<string, string> = new Map()) {
  const context = createNodeBindingContext(after)
  const known = new Set(after.map(person => person.id))
  const beforeNames = new Map(before.map(person => [person.id, person.name]))
  const mapId = (id: string) => redirects.get(id) ?? id
  return nodes.map(node => {
    const remap = (bindings: CharacterBinding[] | undefined) => (bindings ?? []).map(group => ({ mention: group.mention, ids: unique(group.ids.map(mapId)).filter(id => known.has(id)) }))
    const boundIds = unique([...(node.actorIds ?? []), ...(node.manualActorIds ?? []), ...(node.actorBindings ?? []).flatMap(group => group.ids)])
    const ignoreMentions = unique(boundIds.map(id => beforeNames.get(id) ?? ''))
    const droppedMentions = (node.actorBindings ?? []).filter(group => group.ids.length && group.ids.every(id => !known.has(mapId(id)))).map(group => group.mention)
    const next = bindNodeCharacters({
      ...node, actorBindings: remap(node.actorBindings),
      manualActorIds: unique((node.manualActorIds ?? []).map(mapId)).filter(id => known.has(id)),
    }, after, { ignoreMentions, droppedMentions }, context)
    return JSON.stringify([next.actorIds, next.actors, next.actorBindings, next.manualActorIds]) ===
      JSON.stringify([node.actorIds, node.actors, node.actorBindings, node.manualActorIds]) ? node : next
  })
}
