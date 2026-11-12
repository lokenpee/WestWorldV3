import { expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { createMemoryAgentRepository, type Row } from '../src/features/agents/repository'
import { buildProfileReview, profileContent, reviewContext } from '../src/features/agents/organizationReview'
import { hash } from '../src/features/agents/contracts'
import { createWorkspace } from '../src/lib/storage/workspace'
import { readExecutionChain, readOrganizationStepIndex } from '../src/features/agents/trace'

it('资料准备仅读取人物且保持原指纹，关系索引保留原有结果', async () => {
  const repo = createMemoryAgentRepository('b', { characters: [{ id: 'A', bookId: 'b', name: '甲', revision: 1 }, { id: 'B', bookId: 'b', name: '乙', revision: 1 }] })
  await repo.transaction(false, async store => {
    const tables: string[] = []
    const organization: Row = {}
    await buildProfileReview({ ...store, rows: async name => { tables.push(name); return store.rows(name) } }, organization)
    expect(tables).toEqual(['characters'])
    const items = organization.profileItems as Row[]
    expect(items[0].contentFingerprint).toBe(await hash(profileContent((await store.get('characters', 'A'))!)))
    const context = await reviewContext(store)
    expect(await context.scan('A')).toBe(await hash({ profile: await context.profile('A'), pairs: [], unresolved: [] }))
  })
})

it('三个步骤共享一次索引读取，完成后重新查询；详情只读取本会话，旧运行仍能计数', async () => {
  const id = crypto.randomUUID()
  const workspace = createWorkspace({ settingsName: `perf-${id}`, bookPrefix: `perf-${id}-` })
  const db = workspace.openBook('b')
  const runs = db.table('pipelineRuns'), entries = db.table('storySessionEntries')
  try {
    await runs.put({ id: 'r', bookId: 'b', sessionId: 's', workflow: 'character_organization_v1', organization: { profileItems: [{ id: 'A', name: '甲' }] } })
    await entries.bulkPut([
      { id: 't', bookId: 'b', sessionId: 's', runId: 'r', unitId: 'profile:A', type: 'request_trace', input: { systemPromptSnapshotId: 'p' } },
      { id: 'p', bookId: 'b', sessionId: 's', type: 'prompt_snapshot', content: '规则' },
      { id: 'old', bookId: 'b', sessionId: 'other', type: 'request_trace', content: '无关历史'.repeat(10000) },
    ])
    const runReads = vi.spyOn(runs, 'toArray')
    const fullReads = vi.spyOn(entries, 'toArray')
    const indexes = await Promise.all((['scan', 'profiles', 'relations'] as const).map(step => readOrganizationStepIndex(workspace, 'b', step)))
    expect(runReads).toHaveBeenCalledTimes(1)
    expect(indexes[1][0].requestCount).toBe(1)
    expect(fullReads).not.toHaveBeenCalled()
    const chain = await readExecutionChain(workspace, 'b', 'r')
    expect(chain.requests.map(row => row.id)).toEqual(['t'])
    expect(chain.snapshots.get('p')?.content).toBe('规则')
    expect(fullReads).not.toHaveBeenCalled()
    await entries.put({ id: 't2', bookId: 'b', sessionId: 's', runId: 'r', unitId: 'profile:A', type: 'request_trace' })
    expect((await readOrganizationStepIndex(workspace, 'b', 'profiles'))[0].requestCount).toBe(2)
    expect(runReads).toHaveBeenCalledTimes(2)
    await runs.update('r', { sessionId: undefined })
    expect((await readOrganizationStepIndex(workspace, 'b', 'profiles'))[0].requestCount).toBe(2)
  } finally {
    vi.restoreAllMocks()
    await db.delete()
    await workspace.settings.delete()
    workspace.close()
  }
})
