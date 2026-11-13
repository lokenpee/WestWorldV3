import { expect, it } from 'vitest'
import { createMemoryAgentRepository } from '../src/features/agents/repository'
import { createOrganizationStepState } from '../src/features/world/organization'
import { identityPage, navigateIdentityPages } from '../src/features/world/identityCandidates'
import { reviewContext } from '../src/features/agents/organizationReview'

const people = ['A', 'B', 'C'].map(id => ({ id, bookId: 'b', name: id, aliases: [], identity: '同一机构成员', revision: 1 }))
it('人物资料仅复用已完成且未变的同阶段结果，失败疑点和全量选择仍待处理', async () => {
  const repo = createMemoryAgentRepository('b', { characters: people })
  await repo.transaction(true, async store => {
    const state = await createOrganizationStepState(store, 'profiles')
    state.profileItems.forEach(item => { item.status = 'checked'; item.outcome = 'no_change' })
    state.profileItems[1].uncertainFields = ['identity']
    state.profileItems[2].lastError = { code: 'FAIL', message: '未完成', action: 'retry' }
    await store.put('pipelineRuns', { id: 'r', bookId: 'b', startedAt: '1', organization: state })
    expect((await createOrganizationStepState(store, 'profiles', 'reuse')).profileItems.map(item => item.status)).toEqual(['checked', 'pending', 'pending'])
    expect((await createOrganizationStepState(store, 'profiles', 'all')).profileItems.every(item => item.status === 'pending')).toBe(true)
    expect((await createOrganizationStepState(store, 'relations', 'reuse')).relationItems.every(item => item.status === 'pending')).toBe(true)
    await store.put('characters', { ...people[0], identity: '身份已修改' })
    expect((await createOrganizationStepState(store, 'profiles', 'reuse')).profileItems.every(item => item.status === 'pending')).toBe(true)
  })
})

it('查重翻页才留下逐人完成指纹，新人待处理且旧人仍在可查询目录', async () => {
  const repo = createMemoryAgentRepository('b', { characters: people })
  await repo.transaction(true, async store => {
    const state = await createOrganizationStepState(store, 'scan')
    const row = state as unknown as Record<string, unknown>
    await identityPage(store, row)
    expect(state.identityChecks).toBeUndefined()
    await navigateIdentityPages(store, row, { currentPageId: 'scan:0', direction: 'next' })
    expect(state.identityChecks).toHaveLength(3)
    await store.put('pipelineRuns', { id: 'r', bookId: 'b', startedAt: '1', organization: state })
    await store.put('characters', { ...people[0], id: 'D', name: 'A的别名' })
    const reused = await createOrganizationStepState(store, 'scan', 'reuse')
    expect(reused.scanPages.flatMap(page => page.ids)).toEqual(['D'])
    expect(reused.scanIds).toEqual(['A', 'B', 'C', 'D'])
    expect((await store.rows('characters')).map(person => person.id)).toContain('A')
  })
})

it('查重候选待人工核对时成员不复用，较新未完成页不会复活旧完成记录', async () => {
  const repo = createMemoryAgentRepository('b', { characters: people })
  await repo.transaction(true, async store => {
    const context = await reviewContext(store)
    const state = await createOrganizationStepState(store, 'scan')
    state.identityChecks = await Promise.all(people.map(async person => ({ id: person.id, fingerprint: await context.scan(person.id) })))
    state.candidateGroups = [{ id: 'g', memberIds: ['A', 'B'], status: 'pending', reason: '疑似', revision: 1, createdAt: '', updatedAt: '' }]
    await store.put('pipelineRuns', { id: 'r', bookId: 'b', startedAt: '1', organization: state })
    expect((await createOrganizationStepState(store, 'scan', 'reuse')).scanPages.flatMap(page => page.ids)).toEqual(['A', 'B'])
    await store.put('pipelineRuns', { id: 'new', bookId: 'b', startedAt: '2', organization: { scanPages: [{ ids: ['C'], status: 'issued' }] } })
    expect((await createOrganizationStepState(store, 'scan', 'reuse')).scanPages.flatMap(page => page.ids)).toContain('C')
  })
})
