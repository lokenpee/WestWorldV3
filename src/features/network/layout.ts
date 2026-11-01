import type { Chapter } from '../../lib/storage/workspace'
import type { EventLine, EventNode } from '../assets/types'

export const nodeWidth = 200, nodeHeight = 84
export const lineColors = ['#426b45', '#a05f22', '#76518c', '#287d91', '#ad4c67', '#80712d']
export interface NetworkNode { id: string; x: number; y: number; node: EventNode; lineIds: string[] }
export interface NetworkEdge { id: string; lineId: string; source: string; target: string; color: string }
export interface NetworkLayout { nodes: NetworkNode[]; edges: NetworkEdge[]; chapters: { id: string; title: string; x: number; width: number }[]; width: number; height: number }

export function layoutNetwork(input: EventNode[], lines: EventLine[], chapters: Chapter[]): NetworkLayout {
  const chapterOrder = new Map(chapters.map(row => [row.chapterIndex, row.order]))
  const chapterNames = new Map(chapters.map(row => [row.chapterIndex, row.chapterName]))
  const sorted = [...input].sort((a, b) => (chapterOrder.get(a.chapterIndex) ?? Infinity) - (chapterOrder.get(b.chapterIndex) ?? Infinity) || a.order - b.order || a.id.localeCompare(b.id))
  const unique = [...new Map(sorted.map(row => [row.id, row])).values()]
  const memberships = new Map(unique.map(row => [row.id, [] as string[]]))
  for (const line of lines) for (const id of new Set(line.nodeIds)) memberships.get(id)?.push(line.id)
  const lane = new Map(lines.map((line, index) => [line.id, index]))
  const positions: NetworkNode[] = [], columns: NetworkLayout['chapters'] = []
  const groups = new Map<string, EventNode[]>()
  for (const row of unique) { if (!groups.has(row.chapterIndex)) groups.set(row.chapterIndex, []); groups.get(row.chapterIndex)!.push(row) }
  let x = 40, height = 280
  for (const [chapterId, rows] of groups) {
    const occupied: number[] = []
    for (const row of rows) {
      const lineIds = memberships.get(row.id)!
      const intended = lineIds.length ? 160 + Math.min(...lineIds.map(id => lane.get(id)!)) * 130 : 40
      let y = intended
      while (occupied.some(value => Math.abs(value - y) < nodeHeight + 20)) y += nodeHeight + 24
      occupied.push(y); height = Math.max(height, y + nodeHeight + 60)
      positions.push({ id: row.id, node: row, lineIds, x, y })
    }
    columns.push({ id: chapterId, title: chapterNames.get(chapterId) ?? `第${chapterId}章`, x, width: 280 })
    x += 280
  }
  const order = new Map(positions.map((row, index) => [row.id, index]))
  const edges: NetworkEdge[] = []
  for (const [index, line] of lines.entries()) {
    const ids = [...new Set(line.nodeIds)].filter(id => order.has(id)).sort((a, b) => order.get(a)! - order.get(b)!)
    for (let i = 1; i < ids.length; i++) edges.push({ id: `${line.id}:${ids[i - 1]}:${ids[i]}`, lineId: line.id, source: ids[i - 1], target: ids[i], color: lineColors[index % lineColors.length] })
  }
  return { nodes: positions, edges, chapters: columns, width: Math.max(400, x), height }
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
