import { expect, it } from 'vitest'
import { fitNetwork, layoutNetwork, nodeHeight } from '../src/features/network/layout'
import type { EventLine, EventNode } from '../src/features/assets/types'
import type { Chapter } from '../src/lib/storage/workspace'

const nodes = ['A', 'B', 'C', 'D'].map((id, i) => ({ id, name: id, summary: id, chapterIndex: i < 2 ? '1' : '2', order: i, revision: 1 })) as EventNode[]
const lines = [{ id: 'L1', title: '主线', nodeIds: ['B', 'A', 'A'] }, { id: 'L2', title: '支线', nodeIds: ['B', 'C', 'missing'] }] as EventLine[]
const chapters = [{ chapterIndex: '1', chapterName: '第一章', order: 0 }, { chapterIndex: '2', chapterName: '第二章', order: 1 }] as Chapter[]
it('共享节点只布局一次，孤点保留，边按章节顺序连接真实成员', () => {
  const layout = layoutNetwork(nodes, lines, chapters)
  expect(layout.nodes).toHaveLength(4)
  expect(layout.nodes.find(row => row.id === 'B')?.lineIds).toEqual(['L1', 'L2'])
  expect(layout.nodes.find(row => row.id === 'D')?.lineIds).toEqual([])
  expect(layout.edges.map(row => [row.source, row.target])).toEqual([['A', 'B'], ['B', 'C']])
  const first = layout.nodes.filter(row => row.node.chapterIndex === '1')
  expect(Math.abs(first[0].y - first[1].y)).toBeGreaterThan(nodeHeight)
  expect(lines[0].nodeIds).toEqual(['B', 'A', 'A'])
})
it('筛选结果能适配视口，空图有有效初始视图', () => {
  const layout = layoutNetwork(nodes, lines, chapters)
  const view = fitNetwork(layout.nodes, 320, 300)
  for (const row of layout.nodes) {
    expect(row.x).toBeGreaterThanOrEqual(view.x)
    expect(row.y + nodeHeight).toBeLessThanOrEqual(view.y + 300 / view.zoom)
  }
  expect(fitNetwork([], 320, 300)).toEqual({ x: 0, y: 0, zoom: 1 })
})
