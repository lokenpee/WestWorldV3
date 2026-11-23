import type { Chapter } from '../../lib/storage/workspace'
import type { EventLine, EventNode, StoryEvent, StoryMembership } from '../assets/types'
import { storyMemberships, usesOutline } from '../story/outline'

export const nodeWidth = 200, nodeHeight = 84
export const lineColors = ['#426b45', '#a05f22', '#76518c', '#287d91', '#ad4c67', '#80712d']
export interface NetworkNode { id: string; x: number; y: number; node: EventNode; lineIds: string[]; memberships: StoryMembership[] }
export interface NetworkEdge { id: string; lineId: string | null; source: string; target: string; color: string; eventIds?: string[] }
export interface NetworkLayout { nodes: NetworkNode[]; edges: NetworkEdge[]; chapters: { id: string; title: string; x: number; width: number }[]; width: number; height: number }

export function layoutNetwork(input: EventNode[], lines: EventLine[], chapters: Chapter[], events: StoryEvent[] = []): NetworkLayout {
  const chapterOrder = new Map(chapters.map(row => [row.chapterIndex, row.order]))
  const chapterNames = new Map(chapters.map(row => [row.chapterIndex, row.chapterName]))
  const sorted = [...input].sort((a, b) => (chapterOrder.get(a.chapterIndex) ?? Infinity) - (chapterOrder.get(b.chapterIndex) ?? Infinity) || a.order - b.order || a.id.localeCompare(b.id))
  const unique = [...new Map(sorted.map(row => [row.id, row])).values()]
  const memberships = storyMemberships(unique, lines, events)
  const lane = new Map(lines.map((line, index) => [line.id, index]))
  const positions: NetworkNode[] = [], columns: NetworkLayout['chapters'] = []
  const groups = new Map<string, EventNode[]>()
  for (const row of unique) { if (!groups.has(row.chapterIndex)) groups.set(row.chapterIndex, []); groups.get(row.chapterIndex)!.push(row) }
  let x = 40, height = 280
  for (const [chapterId, rows] of groups) {
    const occupied: number[] = []
    for (const row of rows) {
      const lineIds = [...new Set(memberships[row.id].flatMap(item => item.lineId ? [item.lineId] : []))]
      const intended = lineIds.length ? 160 + Math.min(...lineIds.map(id => lane.get(id)!)) * 130 : 40
      let y = intended
      while (occupied.some(value => Math.abs(value - y) < nodeHeight + 20)) y += nodeHeight + 24
      occupied.push(y); height = Math.max(height, y + nodeHeight + 60)
      positions.push({ id: row.id, node: row, lineIds, memberships: memberships[row.id], x, y })
    }
    columns.push({ id: chapterId, title: chapterNames.get(chapterId) ?? `第${chapterId}章`, x, width: 280 })
    x += 280
  }
  const order = new Map(positions.map((row, index) => [row.id, index]))
  const edges = new Map<string, NetworkEdge>()
  const eventsById = new Map(events.map(event => [event.id, event]))
  const grouped = new Set(lines.flatMap(line => line.eventIds ?? []))
  const paths = [
    ...lines.map(line => ({
      key: line.id, lineId: line.id as string | null,
      segments: usesOutline(line) ? (line.eventIds ?? []).flatMap(id => eventsById.has(id) ? [{ eventId: id, nodeIds: eventsById.get(id)!.nodeIds }] : []) : [{ eventId: null, nodeIds: line.nodeIds }],
    })),
    ...events.filter(event => !grouped.has(event.id)).map(event => ({
      key: 'event:' + event.id, lineId: null,
      segments: [{ eventId: event.id, nodeIds: event.nodeIds }],
    })),
  ]
  for (const [index, {key, lineId, segments}] of paths.entries()) {
    for (const segment of segments) {
      const ids = [...new Set(segment.nodeIds)].filter(id => order.has(id)).sort((a, b) => order.get(a)! - order.get(b)!)
      for (let i = 1; i < ids.length; i++) {
        const source = ids[i - 1], target = ids[i], id = `${key}:${source}:${target}`
        const edge = edges.get(id)
        if (edge && segment.eventId) { if (!edge.eventIds!.includes(segment.eventId)) edge.eventIds!.push(segment.eventId) }
        else if (!edge) edges.set(id, { id, lineId, source, target, color: lineColors[index % lineColors.length], ...(segment.eventId ? { eventIds: [segment.eventId] } : {}) })
      }
    }
  }
  return { nodes: positions, edges: [...edges.values()], chapters: columns, width: Math.max(400, x), height }
}

export interface NetworkView { x: number; y: number; zoom: number }
export function fitNetwork(nodes: NetworkNode[], width: number, height: number): NetworkView {
  if (!nodes.length) return { x: 0, y: 0, zoom: 1 }
  const minX = Math.min(...nodes.map(row => row.x)) - 30, minY = Math.min(...nodes.map(row => row.y)) - 50
  const rangeX = Math.max(...nodes.map(row => row.x)) + nodeWidth + 30 - minX
  const rangeY = Math.max(...nodes.map(row => row.y)) + nodeHeight + 30 - minY
  const zoom = Math.max(0.001, Math.min(1, width / rangeX, height / rangeY))
  return { x: minX - (width / zoom - rangeX) / 2, y: minY - (height / zoom - rangeY) / 2, zoom }
}
