export interface Point { x: number; y: number }
export const minimumDistance = 76
const spacing = minimumDistance + 1

/** 布局收尾、局部新增及拖动共用的相邻格空位查询。 */
export class PositionIndex {
  private cells = new Map<string, Point[]>()
  add(point: Point) {
    const key = `${Math.floor(point.x / minimumDistance)},${Math.floor(point.y / minimumDistance)}`
    const cell = this.cells.get(key) ?? []
    cell.push(point); this.cells.set(key, cell)
  }
  free(point: Point) {
    const cx = Math.floor(point.x / minimumDistance), cy = Math.floor(point.y / minimumDistance)
    for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) {
      if ((this.cells.get(`${x},${y}`) ?? []).some(other => Math.hypot(point.x - other.x, point.y - other.y) < minimumDistance)) return false
    }
    return true
  }
  place(desired: Point): Point {
    if (this.free(desired)) { const point = { ...desired }; this.add(point); return point }
    // 按方环从近到远检查，世界坐标不受屏幕尺寸限制。
    for (let ring = 1; ; ring++) {
      const candidates: Point[] = []
      for (let x = -ring; x <= ring; x++) for (const y of [-ring, ring]) candidates.push({ x: desired.x + x * spacing, y: desired.y + y * spacing })
      for (let y = -ring + 1; y < ring; y++) for (const x of [-ring, ring]) candidates.push({ x: desired.x + x * spacing, y: desired.y + y * spacing })
      candidates.sort((a, b) => Math.hypot(a.x - desired.x, a.y - desired.y) - Math.hypot(b.x - desired.x, b.y - desired.y))
      for (const point of candidates) if (this.free(point)) { this.add(point); return point }
    }
  }
}

export function vacantPosition(positions: Record<string, Point>, desired: Point, excludeId?: string) {
  const index = new PositionIndex()
  for (const [id, point] of Object.entries(positions)) if (id !== excludeId) index.add(point)
  return index.place(desired)
}

export function segmentDistance(point: Point, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy)
}
