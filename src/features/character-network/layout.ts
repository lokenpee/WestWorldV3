import { minimumDistance, PositionIndex, type Point } from './geometry'

export interface LayoutNode { id: string; role: string }
export interface LayoutRequest { type: 'layout'; nodes: LayoutNode[]; edges: { a: string; b: string }[]; width: number; height: number; seed: number }
const weight = (role: string) => role === '主要人物' ? 0.012 : role === '重要配角' ? 0.007 : role === 'NPC' ? 0.003 : 0.0015
const rank = (role: string) => role === '主要人物' ? 0 : role === '重要配角' ? 1 : role === 'NPC' ? 2 : 3
function seeded(id: string, seed: number) {
  let value = 2166136261 ^ seed
  for (const character of id) value = Math.imul(value ^ character.codePointAt(0)!, 16777619)
  return (value >>> 0) / 4294967295
}

/** 无屏幕边界的力导向；收尾以空间索引保证碰撞约束优先。 */
export function layoutGraph(request: LayoutRequest, onInitial?: (positions: Record<string, Point>) => void) {
  const { width, height, seed } = request
  const nodes = [...request.nodes].sort((a, b) => rank(a.role) - rank(b.role) || seeded(a.id, seed) - seeded(b.id, seed) || a.id.localeCompare(b.id))
  const positions: Record<string, Point> = {}
  const ids = new Set(nodes.map(node => node.id))
  const edges = request.edges.filter(edge => ids.has(edge.a) && ids.has(edge.b))
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length)))
  const cells = Array.from({ length: columns * columns }, (_, i) => ({ x: (i % columns - (columns - 1) / 2) * 90, y: (Math.floor(i / columns) - (columns - 1) / 2) * 90 }))
    .sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y) || a.x - b.x || a.y - b.y)
  for (const [i, node] of nodes.entries()) positions[node.id] = { x: width / 2 + cells[i].x, y: height / 2 + cells[i].y }
  onInitial?.(structuredClone(positions))
  const cellSize = minimumDistance * 2
  for (let iteration = 0; iteration < 120; iteration++) {
    const grid = new Map<string, string[]>()
    for (const node of nodes) {
      const point = positions[node.id], key = `${Math.floor(point.x / cellSize)},${Math.floor(point.y / cellSize)}`
      const cell = grid.get(key) ?? []; cell.push(node.id); grid.set(key, cell)
    }
    for (const node of nodes) {
      const point = positions[node.id], cx = Math.floor(point.x / cellSize), cy = Math.floor(point.y / cellSize)
      let pushX = 0, pushY = 0
      for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) for (const otherId of grid.get(`${x},${y}`) ?? []) {
        if (otherId === node.id) continue
        const other = positions[otherId]
        const dx = point.x - other.x || 0.01, dy = point.y - other.y || 0.01, distance = Math.hypot(dx, dy)
        if (distance < 110) { const force = (110 - distance) / distance * 0.2; pushX += dx * force; pushY += dy * force }
      }
      point.x += Math.max(-25, Math.min(25, pushX)); point.y += Math.max(-25, Math.min(25, pushY))
    }
    for (const edge of edges) {
      const a = positions[edge.a], b = positions[edge.b], dx = b.x - a.x, dy = b.y - a.y
      const distance = Math.hypot(dx, dy) || 1, force = (distance - 150) / distance * 0.008
      a.x += dx * force; a.y += dy * force; b.x -= dx * force; b.y -= dy * force
    }
    for (const node of nodes) {
      const point = positions[node.id], pull = weight(node.role)
      point.x += (width / 2 - point.x) * pull; point.y += (height / 2 - point.y) * pull
    }
  }
  const index = new PositionIndex()
  for (const node of nodes) positions[node.id] = index.place(positions[node.id])
  return positions
}
