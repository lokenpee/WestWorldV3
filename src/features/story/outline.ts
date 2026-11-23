import type { AgentStore, Row } from '../agents/repository'
import type { EventLine, EventNode, StoryEvent, StoryMembership } from '../assets/types'

export const usesOutline = (line: EventLine | Row) => Array.isArray(line.eventIds) && !line.outlinePending
export const hasOutlineDescription = (row: Row | undefined) => [row?.summary, row?.coreClue].every(value => typeof value === 'string' && value.trim().length > 0)

export function storyMemberships(nodes: EventNode[], lines: EventLine[], events: StoryEvent[]) {
  const memberships = new Map(nodes.map(node => [node.id, [] as StoryMembership[]]))
  const byEvent = new Map(events.map(event => [event.id, event]))
  const referenced = new Set<string>()
  const add = (ids: string[], membership: StoryMembership) => {
    for (const id of new Set(ids)) memberships.get(id)?.push(membership)
  }
  for (const line of lines) {
    if (!usesOutline(line)) { add(line.nodeIds, { lineId: line.id, eventId: null }); continue }
    for (const id of new Set(line.eventIds)) {
      const event = byEvent.get(id)
      if (event) { referenced.add(id); add(event.nodeIds, { lineId: line.id, eventId: id }) }
    }
  }
  for (const event of events) if (!referenced.has(event.id)) add(event.nodeIds, { lineId: null, eventId: event.id })
  return Object.fromEntries(memberships)
}

export function orderedStoryNodes(ids: string[], nodes: ReadonlyMap<string, EventNode>, chapters: ReadonlyMap<string, number>) {
  return [...new Set(ids)].flatMap(id => nodes.has(id) ? [nodes.get(id)!] : [])
    .sort((a, b) => (chapters.get(a.chapterIndex) ?? Infinity) - (chapters.get(b.chapterIndex) ?? Infinity) || a.order - b.order || a.id.localeCompare(b.id))
}

export function outlineLineMembers(line: EventLine, events: ReadonlyMap<string, StoryEvent>) {
  return usesOutline(line) ? (line.eventIds ?? []).flatMap(id => events.get(id)?.nodeIds ?? []) : line.nodeIds
}

export function outlineStatistics(nodes: EventNode[]) {
  return {
    chapters: [...new Set(nodes.map(node => node.chapterIndex))],
    characterIds: [...new Set(nodes.flatMap(node => [...(node.actorIds ?? []), ...(node.targetCharacterIds ?? [])]))],
    characterNames: [...new Set(nodes.flatMap(node => {
      return [
        ...(node.actors ?? []).filter(name => !node.actorBindings?.some(group => group.mention === name && group.ids.length)),
        ...(node.targets ?? []).filter(name => !node.targetBindings?.some(group => group.mention === name && group.ids.length)),
      ]
    }))],
    locationNames: [...new Set(nodes.flatMap(node => node.locationNames ?? []))],
  }
}

export async function synchronizeOutline(store: Pick<AgentStore, 'rows' | 'put'>, timestamp: string, normalizeEvents = true) {
  const [lines, events] = await Promise.all([
    store.rows('eventLines') as unknown as Promise<EventLine[]>,
    store.rows('storyEvents') as unknown as Promise<StoryEvent[]>,
  ])
  if (!events.length && !lines.some(usesOutline)) return
  const [nodes, chapters] = await Promise.all([store.rows('nodes') as unknown as Promise<EventNode[]>, store.rows('chapters')])
  const chapterOrder = new Map(chapters.map(row => [String(row.chapterIndex), Number(row.order)]))
  const nodeById = new Map(nodes.map(node => [node.id, node]))
  for (const event of normalizeEvents ? events : []) {
    const ids = orderedStoryNodes(event.nodeIds, nodeById, chapterOrder).map(node => node.id)
    if (JSON.stringify(ids) !== JSON.stringify(event.nodeIds)) {
      event.nodeIds = ids
      event.revision++
      await store.put('storyEvents', { ...event })
    }
  }
  const byEvent = new Map(events.map(event => [event.id, event]))
  for (const line of lines.filter(usesOutline)) {
    const members = orderedStoryNodes(outlineLineMembers(line, byEvent), nodeById, chapterOrder)
    const nodeIds = members.map(node => node.id)
    const chapters = [...new Set(members.map(node => node.chapterIndex))]
    const times = members.flatMap(node => node.timeCoord ? [node.timeCoord] : []).sort()
    const timeRange = times.length ? [times[0], times[times.length - 1]] : undefined
    if (JSON.stringify([nodeIds, chapters, timeRange]) !== JSON.stringify([line.nodeIds, line.chapters, line.timeRange])) {
      Object.assign(line, { nodeIds, chapters, revision: line.revision + 1, updatedAt: timestamp })
      if (timeRange) line.timeRange = timeRange
      else delete line.timeRange
      await store.put('eventLines', { ...line })
    }
  }
  const memberships = storyMemberships(nodes, lines, events)
  for (const node of nodes) {
    const ids = [...new Set(memberships[node.id].flatMap(item => item.lineId ? [item.lineId] : []))].sort()
    if (JSON.stringify(ids) !== JSON.stringify(node.eventLineIds ?? [])) {
      await store.put('nodes', { ...node, eventLineIds: ids, revision: node.revision + 1, updatedAt: timestamp } as unknown as Row)
    }
  }
}
