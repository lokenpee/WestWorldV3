import { expect, it } from 'vitest'
import { createMemoryAgentRepository } from '../src/features/agents/repository'
import { hash } from '../src/features/agents/contracts'
import { reviewQueue } from '../src/features/story/review'
import { recoverStoryCoverage, storyFingerprint, windowFingerprint } from '../src/features/story/coverage'
import { createAgentTools } from '../src/features/agents/tools'

it('目录查询与正常关联变化保留已完成项，实际内容变化要求复核', async () => {
  const a = { id: 'A', bookId: 'b', summary: '事件A', revision: 1, eventLineIds: [] }
  const b = { id: 'B', bookId: 'b', summary: '事件B', revision: 1, eventLineIds: [] }
  const coverage = { workItemId: 'global_review:orphans:A', phase: 'global_review', kind: 'node', id: 'A', status: 'checked', coveredFingerprint: await storyFingerprint('nodes', a), dependencies: { records: [{ table: 'nodes', id: 'B', resolvedId: 'B', factFingerprint: await storyFingerprint('nodes', b) }], queries: [{ tool: 'query_nodes', args: {} }] } }
  const repo = createMemoryAgentRepository('b', { nodes: [a, b], pipelineRuns: [{ id: 'run', bookId: 'b', coverageItems: [coverage] }] })
  await repo.transaction(true, async store => { await store.put('nodes', { ...b, summary: '目录中其他事件已变化', revision: 2 }); await store.put('eventLines', { id: 'line', bookId: 'b', nodeIds: ['B'] }) })
  expect((await repo.transaction(false, store => reviewQueue(store, 'run', 'session'))).pending.some(item => item.row.id === 'A')).toBe(false)
  await repo.transaction(true, store => store.put('pipelineRuns', { id: 'run', bookId: 'b', coverageItems: [{ ...coverage, dependencies: { ...coverage.dependencies, queries: [{ tool: 'get_node_detail', args: { ids: ['B'] } }] } }] }))
  expect((await repo.transaction(false, store => reviewQueue(store, 'run', 'session'))).pending.some(item => item.row.id === 'A')).toBe(true)
})

it('窗口指纹区分事件正文变化与新增事件线关联', async () => {
  const window = { start: 0, end: 100 }, node = { id: 'a', summary: '原事件', eventLineIds: ['line1'], revision: 1, order: 0 }
  expect(await windowFingerprint(window, [node])).toBe(await windowFingerprint(window, [{ ...node, eventLineIds: ['line1', 'line2'], revision: 2, order: 1 }]))
  expect(await windowFingerprint(window, [node])).not.toBe(await windowFingerprint(window, [{ ...node, summary: '实际事件已改' }]))
})

it('旧任务已提交的修改可恢复覆盖，已变化的节点不冒充完成', async () => {
  const node = { id: 'A', bookId: 'b', summary: '已串联', eventLineIds: ['line'], revision: 2 }
  const task = { taskId: 'old', phase: 'window_link', status: 'partial', appliedCommitIds: ['commit'], input: { workItems: [{ workItemId: 'window_link:0-1:node:A', kind: 'node', id: 'A', revision: 1, factFingerprint: 'before' }] }, reviewedItems: [{ workItemId: 'window_link:0-1:node:A', outcome: 'changed', reason: '提交已确认' }], readSet: { records: [{ table: 'nodes', id: 'A', resolvedId: 'A', factFingerprint: await hash(node) }], queries: [{ tool: 'get_node_detail', args: { ids: ['A'] } }] } }
  const repo = createMemoryAgentRepository('b', { nodes: [node], pipelineRuns: [{ id: 'run', bookId: 'b', tasks: [task], coverageItems: [] }] })
  await repo.transaction(true, store => recoverStoryCoverage(store, 'run'))
  expect(await repo.transaction(false, store => store.get('pipelineRuns', 'run'))).toMatchObject({ coverageItems: [{ status: 'checked', id: 'A' }] })
  await repo.transaction(true, async store => { await store.put('pipelineRuns', { id: 'run', bookId: 'b', tasks: [task], coverageItems: [] }); await store.put('nodes', { ...node, summary: '后来人工修改' }); await recoverStoryCoverage(store, 'run') })
  expect(await repo.transaction(false, store => store.get('pipelineRuns', 'run'))).toMatchObject({ coverageItems: [] })
})

it('最终总结前依据发生变化时拒绝把旧结论记为完成', async () => {
  const node = { id: 'A', bookId: 'b', name: '事件A', summary: '原内容', actors: [], quote: '', revision: 1, confidence: 1, createdBy: 'P1', chapterIndex: '1', chapterName: '第一章', order: 0 }
  const workItemId = 'window_link:0-1:node:A'
  const repo = createMemoryAgentRepository('b', { nodes: [node], pipelineRuns: [{ id: 'run', bookId: 'b', tasks: [{ taskId: 'task', appliedCommitIds: [], input: { workItems: [{ workItemId, kind: 'node', id: 'A' }] } }] }] })
  const adapter = createAgentTools(repo, { bookId: 'b', profile: 'story_editor', phase: 'window_link', runId: 'run', taskId: 'task', owner: 'owner', workItemIds: [workItemId] })
  await repo.transaction(true, store => store.put('pipelineRuns', { id: 'lease:narrative', bookId: 'b', owner: 'owner', runId: 'run', expiresAt: Date.now() + 30000 }))
  await adapter.tools.find(tool => tool.name === 'get_node_detail')!.execute('read', { ids: ['A'] })
  await repo.transaction(true, store => store.put('nodes', { ...node, summary: '实际内容已变化', revision: 2 }))
  await expect(adapter.tools.find(tool => tool.name === 'submit_result')!.execute('final', { status: 'completed', commitIds: [], summary: '保持不变', remainingWorkIds: [], reviewedItems: [{ workItemId, outcome: 'no_change', reason: '旧结论' }] })).rejects.toThrow('CONFLICT')
  expect(adapter.summary).toBeUndefined()
})
