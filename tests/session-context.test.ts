import { expect, it, vi } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { createMemoryAgentRepository } from '../src/features/agents/repository'
import { appendEntry } from '../src/features/agents/commands'
import { compactSession, sessionProjection } from '../src/features/agents/compaction'
import { estimateTextTokens, projectSession, repairToolPairs, settingsForWindow } from '../src/features/agents/context'
import type { Scope } from '../src/features/agents/queries'
import type { ModelService } from '../src/features/models/service'

const scope: Scope = { bookId: 'a', profile: 'story_editor', phase: 'global_review', runId: 'run', taskId: 'task', sessionId: 'session', owner: 'owner', workItemIds: [] }
async function fixture() {
  const repo = createMemoryAgentRepository('a', { storySessions: [{ id: 'session', bookId: 'a', nextOrdinal: 0, leaseOwner: 'owner', leaseUntil: Date.now() + 60000 }], pipelineRuns: [{ id: 'run', bookId: 'a', tasks: [] }, { id: 'lease:narrative', bookId: 'a', owner: 'owner', runId: 'run', expiresAt: Date.now() + 60000 }] })
  await repo.transaction(true, async store => {
    await appendEntry(store, scope, { type: 'message', message: { role: 'system', content: '本书工具与职责', timestamp: 1 } })
    await appendEntry(store, scope, { type: 'message', message: { role: 'user', content: '旧资料'.repeat(6000), timestamp: 2 } })
    await appendEntry(store, scope, { type: 'message', message: { role: 'user', content: '当前任务精确编号N-123', timestamp: 3 } })
  })
  return repo
}
const result = (summary: string) => ({ ok: true, mode: 'direct', attempts: [], elapsedMs: 1, text: '', value: { summary }, usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, costStatus: 'unknown' } })
const generator = (summary = '本书旧资料已核对，参照原始条目回查，当前任务以精确编号为准。') => vi.fn(async () => result(summary)) as unknown as ModelService['generate']

it('压缩按窗口缩放预算，中文字符按权重估算', () => {
  expect(estimateTextTokens('汉字ABCD')).toBe(4)
  expect(settingsForWindow(8192)).toEqual({ reserve: 2048, keep: 2048 })
  expect(settingsForWindow(1000000)).toEqual({ reserve: 32768, keep: 150000 })
})

it('压缩追加摘要、保留原历史，重建投影保留任务编号并统计摘要费用', async () => {
  const repo = await fixture(), generate = generator()
  const before = (await sessionProjection(repo, 'session')).allEntries
  const messages = await compactSession(repo, scope, { generate, contextWindow: 8192, prompt: '当前任务精确编号N-123' })
  const restored = await sessionProjection(repo, 'session')
  expect(restored.allEntries.slice(0, before.length)).toEqual(before)
  expect(restored.allEntries.filter(row => row.type === 'compaction')).toHaveLength(1)
  expect(JSON.stringify(messages)).toContain('当前任务精确编号N-123')
  expect(JSON.stringify(restored.messages)).not.toContain('旧资料'.repeat(200))
  expect(JSON.stringify(messages)).toContain('历史会话压缩摘要')
  const run = await repo.transaction(false, store => store.get('pipelineRuns', 'run'))
  expect(Number((run!.usage as { totalTokens: number }).totalTokens)).toBeGreaterThan(0)
})

it.each([{ label: '空摘要', summary: '' }, { label: '空白摘要', summary: ' '.repeat(5) }, { label: '仍超窗', summary: '巨大摘要'.repeat(10000) }])('无效或仍超窗摘要保留原历史且不追加压缩记录：$label', async ({ summary }) => {
  const repo = await fixture(), before = (await sessionProjection(repo, 'session')).allEntries
  await expect(compactSession(repo, scope, { generate: generator(summary), contextWindow: 8192, prompt: '当前任务精确编号N-123' })).rejects.toThrow()
  expect((await sessionProjection(repo, 'session')).allEntries).toEqual(before)
})

it('压缩取消和会话末端变化时不提交摘要，可再次压缩恢复', async () => {
  const repo = await fixture(), controller = new AbortController()
  const cancelled = vi.fn(async () => { controller.abort(); return result('有效摘要') }) as unknown as ModelService['generate']
  await expect(compactSession(repo, scope, { generate: cancelled, contextWindow: 8192, prompt: '当前任务精确编号N-123', signal: controller.signal })).rejects.toBeDefined()
  expect((await sessionProjection(repo, 'session')).allEntries.filter(row => row.type === 'compaction')).toHaveLength(0)
  let changed = false
  const concurrent = vi.fn(async () => { if (!changed) { changed = true; await repo.transaction(true, store => appendEntry(store, scope, { type: 'message', message: { role: 'user', content: '其他已保存记录', timestamp: 4 } })) } return result('有效摘要') }) as unknown as ModelService['generate']
  await expect(compactSession(repo, scope, { generate: concurrent, contextWindow: 8192, prompt: '当前任务精确编号N-123' })).rejects.toThrow('会话已变化')
  expect((await sessionProjection(repo, 'session')).allEntries.filter(row => row.type === 'compaction')).toHaveLength(0)
  await compactSession(repo, scope, { generate: generator(), contextWindow: 8192, prompt: '当前任务精确编号N-123' })
  expect((await sessionProjection(repo, 'session')).allEntries.filter(row => row.type === 'compaction')).toHaveLength(1)
})

it('工具调用与结果保持配对，提交确认推迟至结果之后，缺失结果只补在投影中', () => {
  const call = { role: 'assistant', content: [{ type: 'toolCall', id: 't', name: 'write', arguments: {} }], timestamp: 1 } as AgentMessage
  const commit: AgentMessage = { role: 'user', content: '[代码提交确认] commit-1', timestamp: 2 }
  const tool: AgentMessage = { role: 'toolResult', toolCallId: 't', toolName: 'write', content: [{ type: 'text', text: '已提交' }], isError: false, timestamp: 3 }
  expect(repairToolPairs([call, commit, tool]).map(row => row.role)).toEqual(['assistant', 'toolResult', 'user'])
  expect(repairToolPairs([tool])).toEqual([])
  const repaired = repairToolPairs([call, commit])
  expect(repaired[1]).toMatchObject({ role: 'toolResult', isError: true })
  const rows = [{ id: 'one', parentId: null, type: 'message', message: call }]
  projectSession(rows, 'one')
  expect(rows).toHaveLength(1)
  expect(() => projectSession([{ id: 'one', parentId: 'missing' }], 'one')).toThrow('缺少父条目')
  expect(() => projectSession([{ id: 'one', parentId: 'one' }], 'one')).toThrow('循环')
})
