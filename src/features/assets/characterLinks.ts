import { AssetError, type Character, type EventNode } from './types'

const unique = (values: string[]) => [...new Set(values)]
const namesFor = (person: Character) => [person.name, ...(person.aliases ?? [])]
export const characterCandidates = (name: string, characters: Character[]) => characters.filter(person => namesFor(person).includes(name.trim()))

export function bindCharacterNames(names: string[], characters: Character[], selectedIds?: string[]) {
  if (selectedIds?.some(id => !characters.some(person => person.id === id))) throw new AssetError('VALIDATION', '所选人物已删除，请重新选择。', 'actors')
  const ids = unique(selectedIds?.length ? selectedIds : names.flatMap(name => {
    const candidates = characterCandidates(name, characters)
    return candidates.length === 1 ? [candidates[0].id] : []
  }))
  const people = ids.map(id => characters.find(person => person.id === id)!)
  const unresolved = names.filter(name => !people.some(person => namesFor(person).includes(name)))
  return { ids, names: unique([...people.map(person => person.name), ...unresolved]) }
}

export function bindNodeCharacters(node: EventNode, characters: Character[], actorIds?: string[], targetIds?: string[]) {
  const actors = bindCharacterNames(node.actors, characters, actorIds)
  const targets = bindCharacterNames(node.targets ?? [], characters, targetIds)
  return { ...node, actors: actors.names, actorIds: actors.ids, targets: targets.names, targetCharacterIds: targets.ids }
}

// 人物统一选择及原有归类规则见 docs/decisions/node-references.md。
export function nodeParticipants(node: EventNode, characters: Character[]) {
  const actorIds = node.actorIds ?? bindCharacterNames(node.actors, characters).ids
  const targetIds = node.targetCharacterIds ?? bindCharacterNames(node.targets ?? [], characters).ids
  const ids = unique([...actorIds, ...targetIds])
  const people = characters.filter(person => ids.includes(person.id))
  const unresolved = (names: string[]) => names.filter(name => !people.some(person => namesFor(person).includes(name)))
  const targetNames = unresolved(node.targets ?? [])
  return {
    ids,
    names: unique([...unresolved(node.actors), ...targetNames.filter(name => characterCandidates(name, characters).length > 0)]),
    objects: targetNames.filter(name => characterCandidates(name, characters).length === 0),
    actorIds,
    targetIds,
  }
}

export function nodeProcess(node: EventNode, characters: Character[]) {
  const objects = nodeParticipants(node, characters).objects
  const process = node.process ?? ''
  const description = `涉及对象：${objects.join('、')}`
  return objects.length && !process.includes(description) ? [process, description].filter(Boolean).join('\n') : process
}

export function setNodeParticipants(node: EventNode, characters: Character[], selectedIds: string[], names: string[]) {
  if (selectedIds.some(id => !characters.some(person => person.id === id))) throw new AssetError('VALIDATION', '所选人物已删除，请重新选择。', 'participantIds')
  const previous = nodeParticipants(node, characters)
  const pending = unique(names.map(name => name.trim()).filter(Boolean))
  const ids = unique([...selectedIds, ...pending.flatMap(name => {
    const candidates = characterCandidates(name, characters)
    return candidates.length === 1 ? [candidates[0].id] : []
  })])
  const people = characters.filter(person => ids.includes(person.id))
  const unlinked = pending.filter(name => !people.some(person => namesFor(person).includes(name)))
  const actorIds = unique([...previous.actorIds.filter(id => ids.includes(id)), ...ids.filter(id => !previous.actorIds.includes(id) && !previous.targetIds.includes(id))])
  const targetCharacterIds = previous.targetIds.filter(id => ids.includes(id))
  const targetNames = unlinked.filter(name => (node.targets ?? []).includes(name) && !node.actors.includes(name))
  const currentNames = (selected: string[]) => selected.map(id => characters.find(person => person.id === id)!.name)
  return {
    ...node,
    actors: unique([...currentNames(actorIds), ...unlinked.filter(name => !targetNames.includes(name))]),
    actorIds,
    targets: unique([...currentNames(targetCharacterIds), ...targetNames, ...previous.objects]),
    targetCharacterIds,
    process: nodeProcess(node, characters),
  }
}

export function remapCharacterLinks(nodes: EventNode[], before: Character[], after: Character[], redirects: ReadonlyMap<string, string> = new Map()): EventNode[] {
  const remap = (names: string[], storedIds: string[] | undefined) => {
    const oldIds = storedIds ?? bindCharacterNames(names, before).ids
    const oldPeople = oldIds.map(id => before.find(person => person.id === id)).filter((person): person is Character => !!person)
    const unresolved: string[] = []
    const newlyBound: string[] = []
    for (const name of names.filter(value => !oldPeople.some(person => namesFor(person).includes(value)))) {
      const previous = characterCandidates(name, before)
      const current = characterCandidates(name, after)
      const mergedIds = unique(previous.map(person => redirects.get(person.id) ?? person.id))
      if (previous.length === 0 && current.length === 1) newlyBound.push(current[0].id)
      else if (redirects.size && previous.length && mergedIds.length === 1 && after.some(person => person.id === mergedIds[0])) newlyBound.push(mergedIds[0])
      else unresolved.push(name)
    }
    const ids = unique([...oldIds.map(id => redirects.get(id) ?? id), ...newlyBound].filter(id => after.some(person => person.id === id)))
    return { ids, names: unique([...ids.map(id => after.find(person => person.id === id)!.name), ...unresolved]) }
  }
  return nodes.map(node => {
    const actors = remap(node.actors, node.actorIds)
    const targets = remap(node.targets ?? [], node.targetCharacterIds)
    return { ...node, actors: actors.names, actorIds: actors.ids, targets: targets.names, targetCharacterIds: targets.ids }
  })
}
