import { expect, it } from 'vitest'
import { layoutGraph } from '../src/features/character-network/layout'
import { minimumDistance, vacantPosition, type Point } from '../src/features/character-network/geometry'
import { largeBookData } from './support/acceptance-book'

function distance(points: Record<string, Point>) {
  const values = Object.values(points)
  let minimum = Infinity
  for (let a = 0; a < values.length; a++) for (let b = a + 1; b < values.length; b++) minimum = Math.min(minimum, Math.hypot(values[a].x - values[b].x, values[a].y - values[b].y))
  return minimum
}

it('小图、窄屏及大图的初始和完成布局均保留76单位中心距', () => {
  const large = largeBookData()
  const samples = [
    { nodes: Array.from({ length: 10 }, (_, i) => ({ id: `P${i}`, role: '主要人物' })), edges: [], width: 320, height: 320 },
    { nodes: large.tables.characters.map(row => ({ id: String(row.id), role: String(row.roleWeight) })), edges: large.tables.characterRelationEdits.map(row => ({ a: String(row.aId), b: String(row.bId) })), width: 800, height: 600 },
  ]
  for (const sample of samples) {
    const result = layoutGraph({ ...sample, type: 'layout', seed: 7 }, initial => expect(distance(initial)).toBeGreaterThanOrEqual(minimumDistance))
    expect(Object.keys(result)).toHaveLength(sample.nodes.length)
    expect(distance(result)).toBeGreaterThanOrEqual(minimumDistance)
    const primary = sample.nodes.filter(row => row.role === '主要人物').map(row => Math.hypot(result[row.id].x - sample.width / 2, result[row.id].y - sample.height / 2))
    const peripheral = sample.nodes.filter(row => row.role === '路人').map(row => Math.hypot(result[row.id].x - sample.width / 2, result[row.id].y - sample.height / 2))
    if (peripheral.length) expect(primary.reduce((a, b) => a + b, 0) / primary.length).toBeLessThan(peripheral.reduce((a, b) => a + b, 0) / peripheral.length)
  }
}, 20000)

it('拖到已有节点或局部新增时只安放新坐标，旧节点不动', () => {
  const points = { A: { x: 100, y: 100 }, B: { x: 300, y: 100 } }
  const before = structuredClone(points)
  const inserted = vacantPosition(points, points.A)
  expect(distance({ ...points, C: inserted })).toBeGreaterThanOrEqual(minimumDistance)
  const dragged = vacantPosition(points, points.A, 'B')
  expect(Math.hypot(dragged.x - points.A.x, dragged.y - points.A.y)).toBeGreaterThanOrEqual(minimumDistance)
  expect(points).toEqual(before)
})
