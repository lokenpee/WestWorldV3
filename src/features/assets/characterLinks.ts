import { AssetError, type Character, type CharacterBinding, type EventNode, type Lifecycle } from './types'
import { characterNameHits, characterNameIndex, resolveLifecycleId } from './relations'

const unique = (values: string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))]

/** 本书全部同名命中；主名完整相等始终参加，别名沿用稳定称呼清理规则。 */
export const characterCandidates = (name: string, characters: Character[]) => characterNameHits(name, characters)

export interface NodeBindingOptions {
  /** 人工明确指定的编号，独立于自动称呼组保存。 */
  actorIds?: string[]; targetCharacterIds?: string[]
  /** 移除整组自动来源的原始称呼。 */
  removedMentions?: string[]
  /** 明确移除的称呼：不再保留原称呼文字。 */
  droppedMentions?: string[]
  /** 旧显示名：改名重映射时不再当作新的称呼来源。 */
  ignoreMentions?: string[]
  lifecycle?: Lifecycle[]
}

interface SideInput { mentions: string[]; existing: CharacterBinding[]; manual: string[]; legacy: string[] }

function bindSide(input: SideInput, characters: Character[], index: Map<string, string[]>, lifecycle: Lifecycle[], options: NodeBindingOptions) {
  const known = new Set(characters.map(person => person.id))
  const removed = new Set((options.removedMentions ?? []).map(value => value.trim()))
  const dropped = new Set((options.droppedMentions ?? []).map(value => value.trim()))
  const ignore = new Set((options.ignoreMentions ?? []).map(value => value.trim()))
  const remap = (ids: string[]) => unique(ids.map(id => resolveLifecycleId(id, lifecycle) ?? id).filter(id => known.has(id)))
  const manual = remap(input.manual), legacy = remap(input.legacy)
  const groupNames = new Set(unique(input.existing.flatMap(group => group.ids)).map(id => characters.find(person => person.id === id)?.name).filter((name): name is string => !!name))
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
  const ids = unique([...groups.flatMap(group => group.ids), ...manual, ...legacy])
  const names = unique([...ids.map(id => characters.find(person => person.id === id)!.name), ...groups.filter(group => !group.ids.length).map(group => group.mention)])
  return { groups, manual, legacy, ids, names }
}

/** 保存节点：称呼组各自保存全部命中，人工明确编号与旧资料编号单独保留。 */
export function bindNodeCharacters(node: EventNode, characters: Character[], options: NodeBindingOptions = {}): EventNode {
  const index = characterNameIndex(characters)
  const lifecycle = options.lifecycle ?? []
  const actors = bindSide({ mentions: node.actors, existing: node.actorBindings ?? [], manual: options.actorIds ?? node.manualActorIds ?? [], legacy: node.legacyActorIds ?? [] }, characters, index, lifecycle, options)
  const targets = bindSide({ mentions: node.targets ?? [], existing: node.targetBindings ?? [], manual: options.targetCharacterIds ?? node.manualTargetCharacterIds ?? [], legacy: node.legacyTargetCharacterIds ?? [] }, characters, index, lifecycle, options)
  return {
    ...node,
    actors: actors.names, actorIds: actors.ids, actorBindings: actors.groups, manualActorIds: actors.manual, legacyActorIds: actors.legacy,
    targets: targets.names, targetCharacterIds: targets.ids, targetBindings: targets.groups, manualTargetCharacterIds: targets.manual, legacyTargetCharacterIds: targets.legacy,
  }
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

/** 人工“涉及人物”面板读取：全部命中编号、仍待关联的称呼和非人物对象。 */
export function nodeParticipants(node: EventNode, characters: Character[]) {
  const ids = unique([...(node.actorIds ?? []), ...(node.targetCharacterIds ?? [])])
  const bound = [
    ...(node.actorBindings ?? []),
    ...(node.targetBindings ?? []),
  ].filter(group => group.ids.length)
  const display = new Set(ids.map(id => characters.find(person => person.id === id)?.name).filter((name): name is string => !!name))
  const resolved = (mention: string) => display.has(mention) || bound.some(group => group.mention === mention)
  const unresolved = (mentions: string[]) => unique(mentions).filter(mention => !resolved(mention))
  const names = unique([...unresolved(node.actors), ...unresolved(node.targets ?? []).filter(name => characterCandidates(name, characters).length > 0)])
  const objects = unique(node.targets ?? []).filter(name => !resolved(name) && !characterCandidates(name, characters).length)
  return { ids, names, objects, actorIds: unique(node.actorIds ?? []), targetIds: unique(node.targetCharacterIds ?? []), actorMentions: unique((node.actorBindings ?? []).map(group => group.mention)), targetMentions: unique((node.targetBindings ?? []).map(group => group.mention)) }
}

export function nodeProcess(node: EventNode, characters: Character[]) {
  const objects = nodeParticipants(node, characters).objects
  const process = node.process ?? ''
  const description = `涉及对象：${objects.join('、')}`
  return objects.length && !process.includes(description) ? [process, description].filter(Boolean).join('\n') : process
}

/** 人工保存涉及人物：保留已有归类，新称呼与新选择记入行动人物。 */
export function setNodeParticipants(node: EventNode, characters: Character[], selectedIds: string[], mentions: string[], removedMentions: string[] = []) {
  if (selectedIds.some(id => !characters.some(person => person.id === id))) throw new AssetError('VALIDATION', '所选人物已删除，请重新选择。', 'participantIds')
  const previous = nodeParticipants(node, characters)
  const kept = unique(mentions)
  const targetMentions = (node.targetBindings ?? []).map(group => group.mention).filter(mention => !(node.actorBindings ?? []).some(group => group.mention === mention))
  const nextTarget = kept.filter(mention => targetMentions.includes(mention))
  const nextActor = kept.filter(mention => !nextTarget.includes(mention))
  const manual = unique(selectedIds)
  const nextActorIds = manual.filter(id => previous.actorIds.includes(id) || !previous.targetIds.includes(id))
  const nextTargetIds = manual.filter(id => previous.targetIds.includes(id))
  const boundMentions = [...(node.actorBindings ?? []), ...(node.targetBindings ?? [])].filter(group => group.ids.length).map(group => group.mention)
  const pendingMentions = [...(node.actorBindings ?? []).filter(group => !group.ids.length), ...(node.targetBindings ?? []).filter(group => !group.ids.length && characterCandidates(group.mention, characters).length > 0)].map(group => group.mention)
  const dropped = unique([...boundMentions, ...pendingMentions]).filter(mention => !kept.includes(mention))
  return bindNodeCharacters({ ...node, actors: nextActor, targets: [...nextTarget, ...previous.objects.filter(object => !kept.includes(object))] }, characters, {
    actorIds: nextActorIds, targetCharacterIds: nextTargetIds, removedMentions, droppedMentions: dropped,
  })
}

/** 人物新增、改名、删除或合并后维护节点：历史绑定按编号保留，新命中自动补齐。 */
export function remapCharacterLinks(nodes: EventNode[], before: Character[], after: Character[], redirects: ReadonlyMap<string, string> = new Map()) {
  const known = new Set(after.map(person => person.id))
  const beforeNames = new Map(before.map(person => [person.id, person.name]))
  const mapId = (id: string) => redirects.get(id) ?? id
  return nodes.map(node => {
    const remap = (bindings: CharacterBinding[] | undefined) => (bindings ?? []).map(group => ({ mention: group.mention, ids: unique(group.ids.map(mapId)).filter(id => known.has(id)) }))
    const boundIds = unique([...(node.actorBindings ?? []).flatMap(group => group.ids), ...(node.targetBindings ?? []).flatMap(group => group.ids), ...(node.actorIds ?? []), ...(node.targetCharacterIds ?? []), ...(node.manualActorIds ?? []), ...(node.manualTargetCharacterIds ?? []), ...(node.legacyActorIds ?? []), ...(node.legacyTargetCharacterIds ?? [])])
    const ignoreMentions = unique(boundIds.map(id => beforeNames.get(id) ?? '')).filter(Boolean)
    const droppedMentions = unique([...(node.actorBindings ?? []), ...(node.targetBindings ?? [])].filter(group => group.ids.length && group.ids.every(id => !known.has(mapId(id)))).map(group => group.mention))
    // 旧节点只有编号没有绑定来源时，把已有编号按旧资料编号保留。
    const legacyActors = (node.actorBindings ?? []).length || (node.manualActorIds ?? []).length || (node.legacyActorIds ?? []).length ? node.legacyActorIds ?? [] : node.actorIds ?? []
    const legacyTargets = (node.targetBindings ?? []).length || (node.manualTargetCharacterIds ?? []).length || (node.legacyTargetCharacterIds ?? []).length ? node.legacyTargetCharacterIds ?? [] : node.targetCharacterIds ?? []
    const next = bindNodeCharacters({
      ...node,
      actorBindings: remap(node.actorBindings), targetBindings: remap(node.targetBindings),
      manualActorIds: unique((node.manualActorIds ?? []).map(mapId)).filter(id => known.has(id)),
      manualTargetCharacterIds: unique((node.manualTargetCharacterIds ?? []).map(mapId)).filter(id => known.has(id)),
      legacyActorIds: unique(legacyActors.map(mapId)).filter(id => known.has(id)),
      legacyTargetCharacterIds: unique(legacyTargets.map(mapId)).filter(id => known.has(id)),
      actorIds: unique((node.actorIds ?? []).map(mapId)).filter(id => known.has(id)),
      targetCharacterIds: unique((node.targetCharacterIds ?? []).map(mapId)).filter(id => known.has(id)),
    }, after, { ignoreMentions, droppedMentions })
    // 有效编号与显示名称都没变时不写回，避免无关人物变化给旧节点补元数据并触发失效。
    const same = (a: string[] | undefined, b: string[] | undefined) => JSON.stringify(a ?? []) === JSON.stringify(b ?? [])
    return same(next.actorIds, node.actorIds) && same(next.targetCharacterIds, node.targetCharacterIds) && same(next.actors, node.actors) && same(next.targets, node.targets) ? node : next
  })
}
