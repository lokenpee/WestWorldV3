import { expect, it } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { createMemoryAgentRepository, type Row } from '../src/features/agents/repository'
import { createAgentTools } from '../src/features/agents/tools'
import { projectWorkSession } from '../src/features/agents/context'
import { createOrganizationState } from '../src/features/world/organization'
import type { Scope } from '../src/features/agents/queries'
import { createAgentFixture } from './support/agent-streams'

function fixture() {
  const data = createAgentFixture('book-a')
  const scope: Scope = { bookId: 'book-a', profile: 'asset_editor', phase: 'character_organization', runId: 'run', taskId: 'task', owner: 'owner', workItemIds: [], workKind: 'profile', unitId: 'profile:C1-P001' }
  const organization = createOrganizationState(['C1-P001', 'C2-P001'])
  data.pipelineRuns = [
    { id: 'run', bookId: 'book-a', organization, tasks: [{ taskId: 'task', input: { unitId: scope.unitId }, appliedCommitIds: [] }] },
    { id: 'lease:world', bookId: 'book-a', owner: 'owner', runId: 'run', expiresAt: Date.now() + 60000 },
  ]
  const repo = createMemoryAgentRepository('book-a', data)
  const adapter = (overrides: Partial<Scope> = {}) => createAgentTools(repo, { ...scope, ...overrides })
  const run = () => repo.transaction(false, store => store.get('pipelineRuns', 'run'))
  return { repo, adapter, run }
}
const call = async (adapter: ReturnType<typeof createAgentTools>, name: string, args: Row) => {
  const result = await adapter.tools.find(tool => tool.name === name)!.execute(crypto.randomUUID(), args)
  expect(result.isError).not.toBe(true)
  return result.details as Row
}

it('同一人物换参数、重建适配器和恢复任务均不能再读原文，原读集保留', async () => {
  const { repo, adapter, run } = fixture(), first = adapter()
  expect(await call(first, 'read_original', { chapter_indices: ['1'] })).toHaveProperty('text', '第二章的沈青就是第一章的沈青。')
  const reads = structuredClone(first.reads)
  expect(await call(first, 'read_original', { chapter_indices: ['1'] })).toMatchObject({ readLimitReached: true, text: '' })
  expect(first.reads).toEqual(reads)
  expect(await call(adapter(), 'read_original', { chapter_indices: ['2'] })).toHaveProperty('readLimitReached', true)
  await repo.transaction(true, async store => {
    const run = (await store.get('pipelineRuns', 'run'))!
    await store.put('pipelineRuns', { ...run, tasks: [...run.tasks as Row[], { taskId: 'resumed', input: { unitId: 'profile:C1-P001' }, appliedCommitIds: [] }] })
  })
  expect(await call(adapter({ taskId: 'resumed' }), 'read_original', { chapter_range: ['1', '2'] })).toHaveProperty('readLimitReached', true)
  expect(await call(adapter({ unitId: 'profile:C2-P001' }), 'read_original', { chapter_indices: ['1'] })).not.toHaveProperty('readLimitReached')
  expect(await call(adapter({ workKind: 'relations', unitId: 'relations:C1-P001' }), 'read_original', { chapter_indices: ['1'] })).not.toHaveProperty('readLimitReached')
  expect((await run())!.organization).toMatchObject({ originalReadUnits: ['profile:C1-P001', 'profile:C2-P001', 'relations:C1-P001'] })
})

it('失败不消耗额度，并行原文调用只有一次拿到正文，新轮可重新查阅', async () => {
  const { adapter, run } = fixture(), tool = adapter().tools.find(tool => tool.name === 'read_original')!
  await expect(tool.execute('invalid', {})).rejects.toThrow()
  expect((await run())!.organization).not.toHaveProperty('originalReadUnits')
  const results = await Promise.all([call(adapter(), 'read_original', { chapter_indices: ['1'] }), call(adapter(), 'read_original', { chapter_indices: ['2'] })])
  expect(results.filter(result => result.readLimitReached)).toHaveLength(1)
  expect(results.filter(result => (result.segments as unknown[]).length)).toHaveLength(1)
  expect(await call(fixture().adapter(), 'read_original', { chapter_indices: ['1'] })).not.toHaveProperty('readLimitReached')
})

it('旧存档缺少限额字段时按同人物任务的真实原文读集兼容', async () => {
  const { repo, adapter } = fixture()
  await repo.transaction(true, async store => {
    const run = (await store.get('pipelineRuns', 'run'))!, tasks = run.tasks as Row[]
    tasks[0].readSet = { queries: [{ tool: 'read_original', args: { chapter_indices: ['1'] }, resultFingerprint: 'old' }], records: [] }
    await store.put('pipelineRuns', { ...run, tasks })
  })
  expect(await call(adapter(), 'read_original', { chapter_indices: ['2'] })).toHaveProperty('readLimitReached', true)
})

it('人物详情无关系；独立关系概览支持分页和人物对，第三步人物对仍保留依据', async () => {
  const { repo, adapter } = fixture()
  await repo.transaction(true, async store => {
    const person = (await store.get('characters', 'C1-P001'))!
    await store.put('characters', { ...person, relations: [{ target: '沈青', relation_type: '朋友', evidence: [{ chapterIndex: '1', quote: '证据正文' }] }] })
    await store.put('characters', { ...person, id: 'C3-P001', name: '张三' })
    for (const [index, target] of ['C2-P001', 'C3-P001'].entries()) await store.put('characterRelations', {
      id: `r${index}`, bookId: 'book-a', originCharacterId: 'C1-P001', relationType: 'friend', sourceId: 'C1-P001', sourceName: '沈青', targetIds: [target], targetName: target === 'C2-P001' ? '沈青' : '张三',
      forwardLabel: '朋友', reverseLabel: '朋友', direction: 'bidirectional', revision: 1, evidence: [{ chapterIndex: '1', quote: '证据正文' }],
    })
  })
  const identity = adapter({ workKind: 'directory', unitId: 'directory:identity' })
  const details = await call(identity, 'get_character_detail', { ids: ['C1-P001'] })
  expect(details.data).toEqual([{ id: 'C1-P001', name: '沈青', aliases: [] }])
  const page = await call(identity, 'get_character_relation', { fromId: 'C1-P001', limit: 1 })
  expect(page).toMatchObject({ totalCount: 2, truncated: true, nextAfterId: 'C2-P001', data: [{ fromName: '沈青', toName: '沈青', forwardLabels: ['朋友'] }] })
  expect(JSON.stringify(page)).not.toContain('证据正文')
  expect(await call(identity, 'get_character_relation', { fromId: 'C1-P001', afterId: page.nextAfterId })).toMatchObject({ truncated: false, nextAfterId: null, data: [{ toId: 'C3-P001' }] })
  const pair = await call(identity, 'get_character_relation', { fromId: 'C1-P001', toId: 'C2-P001' })
  expect(pair.data).not.toHaveProperty('evidence')
  const full = await call(adapter({ workKind: 'relations', unitId: 'relations:C1-P001' }), 'get_character_relation', { fromId: 'C1-P001', toId: 'C2-P001' })
  expect(full.data).toHaveProperty('evidence', [{ chapterIndex: '1', quote: '证据正文' }])
  expect((await call(adapter(), 'get_character_detail', { ids: ['C1-P001'] })).data).not.toEqual(expect.arrayContaining([expect.objectContaining({ relations: expect.anything() })]))
})

it('恢复与压缩使用精简工具历史，原始链路保持完整且思考仍保留', () => {
  const data = { data: [{ id: 'P1', name: '沈青', identity: '船夫', relations: [{ evidence: '长证据'.repeat(500) }], relationEdges: ['重复关系'], mergeFacts: ['底稿'] }] }
  const messages = [
    { role: 'assistant', content: [{ type: 'thinking', thinking: '需要比较前页身份' }, { type: 'toolCall', id: 'call1', name: 'get_character_detail', arguments: { ids: ['P1'] } }] },
    { role: 'toolResult', toolCallId: 'call1', toolName: 'get_character_detail', content: [{ type: 'text', text: JSON.stringify(data) }], details: data, isError: false },
  ] as AgentMessage[]
  const entries = messages.map((message, ordinal) => ({ id: String(ordinal), unitId: 'directory:identity', ordinal, type: 'message', message }))
  const original = JSON.stringify(entries), projected = projectWorkSession(entries, 'directory:identity')
  expect(JSON.stringify(projected)).not.toContain('长证据')
  expect(JSON.stringify(projected)).toContain('需要比较前页身份')
  expect(JSON.stringify(projected)).toContain('船夫')
  expect(JSON.stringify(entries)).toBe(original)
  expect(JSON.stringify(projected).length).toBeLessThan(original.length / 2)
})
