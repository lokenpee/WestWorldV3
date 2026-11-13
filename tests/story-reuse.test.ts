import { expect, it } from 'vitest'
import { createMemoryAgentRepository } from '../src/features/agents/repository'
import { refreshReading, saveReading, navigateStoryReading } from '../src/features/story/reading'
import { inheritedReadingChecks, usableReadingChecks } from '../src/features/story/reuse'
import { storyMessages } from '../src/features/story/views'

it('P3逐项完成凭据跨页复用；新增、变更、待核对的节点留下，其余跳过', async () => {
  const nodes = Array.from({ length: 11 }, (_, i) => ({ id: `N${i}`, bookId: 'b', name: `节点${i}`, summary: '伏笔', chapterIndex: '1', order: i }))
  const repo = createMemoryAgentRepository('b', { nodes, pipelineRuns: [{ id: 'old', bookId: 'b', stage: 'P3', startedAt: '1' }] })
  await repo.transaction(true, async store => {
    await saveReading(store, 'old', 'window_link', await refreshReading(store, 'old', 's', 'window_link'))
    await navigateStoryReading(store, { bookId: 'b', runId: 'old', sessionId: 's', taskId: 't', phase: 'window_link' }, { direction: 'next' }, 'n')
    await store.put('nodes', { ...nodes[0], summary: '伏笔已修改' })
    await store.put('nodes', { ...nodes[0], id: 'new', order: 20 })
    await store.put('storyEditorNotes', { id: 'note', bookId: 'b', status: 'active', nodeIds: ['N1'] })
    const checks = await inheritedReadingChecks(store, 'window_link')
    expect(checks.map(check => check.id)).toEqual(nodes.slice(2, 10).map(node => node.id))
    await store.put('pipelineRuns', { id: 'new', bookId: 'b', stage: 'P3', startedAt: '2' })
    await saveReading(store, 'new', 'window_link', { pages: [], currentPageId: null, receipts: [], reusedChecks: checks })
    const next = await refreshReading(store, 'new', 's', 'window_link')
    expect(next.pages.flatMap(page => page.ids)).toEqual(['N0', 'N1', 'N10', 'new'])
    expect(await inheritedReadingChecks(store, 'global_review')).toEqual([])
    // 换书籍身份导入备份不改变业务内容指纹。
    const restored = createMemoryAgentRepository('restored', { nodes: nodes.slice(2, 10).map(node => ({ ...node, bookId: 'restored' })) })
    expect(await restored.transaction(false, target => usableReadingChecks(target, checks))).toHaveLength(8)
  })
})

it('续跑模型视图去掉旧原文和存储字段，原始日志保持不变', () => {
  const messages = [
    { role: 'system', content: '旧工具提示词', timestamp: 1 },
    { role: 'toolResult', toolCallId: 'a', toolName: 'read_original', timestamp: 2, isError: false, content: [{ type: 'text', text: JSON.stringify({ text: '原文秘密' }) }] },
    { role: 'toolResult', toolCallId: 'b', toolName: 'get_story_detail', timestamp: 3, isError: false, content: [{ type: 'text', text: JSON.stringify({ data: [{ id: 'N', kind: 'node', summary: '概述', process: '详细经过', quote: '证据秘密', bookId: 'b', revision: 20 }] }) }] },
  ] as Parameters<typeof storyMessages>[0]
  const before = JSON.stringify(messages), current = storyMessages(messages)
  expect(JSON.stringify(current)).not.toMatch(/旧工具提示词|原文秘密|证据秘密|bookId|revision/)
  expect(JSON.stringify(current)).toContain('详细经过')
  expect(JSON.stringify(messages)).toBe(before)
})
