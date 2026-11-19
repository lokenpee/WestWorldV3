import { writeFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { records } from '../src/features/agents/contracts'
import { reviewContext } from '../src/features/agents/organizationReview'
import { createMemoryAgentRepository, type AgentRepository, type Row } from '../src/features/agents/repository'
import { createAgentTools } from '../src/features/agents/tools'
import { saveCharacterPair } from '../src/features/assets/relationEdits'
import { createOrganizationStepState } from '../src/features/world/organization'

const bookId = 'opt07-book', runId = 'opt07-run', pairKey = '["A","B"]'

async function reuseMetrics(repo: AgentRepository) {
  return repo.transaction(false, async store => {
    const state = await createOrganizationStepState(store, 'relations', 'reuse')
    return {
      reusedCharacters: Number(state.reusedCount ?? 0),
      reusedPairs: state.pairChecks.filter(pair => pair.outcome === 'changed').length,
      aStatus: state.relationItems.find(item => item.id === 'A')?.status,
      bStatus: state.relationItems.find(item => item.id === 'B')?.status,
    }
  })
}

test('opt07：真实关系提交完成后立即复用、重新加载复用及内容变化失效', async () => {
  const repo = createMemoryAgentRepository(bookId, {
    characters: ['A', 'B'].map((id, index) => ({
      id, bookId, name: ['沈青', '李明'][index], aliases: [], confidence: 1,
      revision: 1, createdBy: 'P1', chapterIndex: '1', chapterName: '第1章',
    })),
    pipelineRuns: [{
      id: runId, bookId, recordType: 'run', stage: 'P2', phase: 'character_organization',
      workflow: 'character_organization_v1', status: 'running', startedAt: '2026-11-19T00:00:00.000Z',
      report: {}, commandIntents: [], appliedCommands: [],
      tasks: [{ taskId: 'task', workItemIds: ['organization:relations:A'], phase: 'character_organization',
        input: { workItems: [] }, appliedCommitIds: [], reviewedItems: [], readSet: { records: [], queries: [] } }],
    }, {
      id: 'lease:world', bookId, recordType: 'lease', lockKey: 'world', owner: 'owner', runId,
      expiresAt: Date.now() + 60_000,
    }],
  })
  const beforeFingerprint = await repo.transaction(true, async store => {
    await saveCharacterPair(store, {
      bookId, fromId: 'A', toId: 'B', forwardLabels: ['朋友'], reverseLabels: ['朋友'],
      reason: '固定样本初始关系', actor: 'manual', commitId: 'seed-pair', tool: 'test',
    })
    const organization = await createOrganizationStepState(store, 'relations', 'all')
    organization.activeWork = {
      id: 'relations:A', kind: 'relations', characterId: 'A', contextId: 'relations',
      status: 'running', requestCount: 0, draft: null, commitIds: [], dataVersion: 2,
    }
    await store.put('pipelineRuns', { ...(await store.get('pipelineRuns', runId))!, organization })
    return organization.relationItems.find(item => item.id === 'A')!.contentFingerprint
  })
  const scope = {
    bookId, profile: 'asset_editor' as const, phase: 'character_organization',
    workflow: 'character_organization_v1' as const, runId, taskId: 'task', owner: 'owner',
    workItemIds: ['organization:relations:A'], contextId: 'relations', unitId: 'relations:A',
    organizationWorkKind: 'relations' as const,
  }
  const tool = createAgentTools(repo, scope).tools.find(tool => tool.name === 'submit_relation_review')!
  const response = await tool.execute('submit', {
    changes: [{ targetId: 'B', action: 'set', forwardLabels: ['师父'], reverseLabels: ['徒弟'], reason: '整理为师徒关系' }],
    done: true, reason: '本人物关系整理完成',
  }) as { content: { text: string }[] }
  const ack = JSON.parse(response.content[0]!.text) as Row
  expect(ack).toMatchObject({ ok: true, changed: true, done: true, complete: true, outcome: 'changed', applied: ['B'], failed: [] })
  expect(ack.commitId).toEqual(expect.any(String))

  const fingerprints = await repo.transaction(false, async store => {
    const saved = (await store.get('pipelineRuns', runId))!.organization as Row
    const item = records(saved.relationItems).find(item => item.id === 'A')!
    const pair = records(saved.pairChecks).find(pair => pair.pairKey === pairKey)!
    expect(item).toMatchObject({ status: 'checked', outcome: 'changed' })
    expect(pair).toMatchObject({ outcome: 'changed' })
    expect(saved.activeWork).toBeNull()
    const current = await reviewContext(store)
    expect(current.pairs.find(pair => pair.pairKey === pairKey)).toMatchObject({ forwardLabels: ['师父'], reverseLabels: ['徒弟'] })
    const characterFingerprint = await current.scan('A'), pairFingerprint = await current.pair(pairKey)
    expect(characterFingerprint).not.toBe(beforeFingerprint)
    return {
      characterContentMatches: item.contentFingerprint === characterFingerprint,
      pairContentMatches: pair.fingerprint === pairFingerprint,
    }
  })
  const unchanged = await reuseMetrics(repo)
  expect(unchanged.bStatus).toBe('pending')

  const snapshot = await repo.transaction(false, async store => Object.fromEntries(await Promise.all(
    ['characters', 'characterRelations', 'characterRelationEdits', 'assetLifecycle', 'pipelineRuns']
      .map(async table => [table, await store.rows(table)] as const),
  )))
  const reloadedRepo = createMemoryAgentRepository(bookId, snapshot)
  const reloaded = await reuseMetrics(reloadedRepo)
  expect(reloaded).toEqual(unchanged)

  await reloadedRepo.transaction(true, async store => {
    await saveCharacterPair(store, {
      bookId, fromId: 'A', toId: 'B', forwardLabels: ['同僚'], reverseLabels: ['同僚'],
      reason: '完成后用户修改关系', actor: 'manual', commitId: 'later-pair', tool: 'test',
    })
  })
  const relationChanged = await reuseMetrics(reloadedRepo)
  expect(relationChanged).toMatchObject({ reusedCharacters: 0, reusedPairs: 0, aStatus: 'pending', bStatus: 'pending' })

  const profileChangedRepo = createMemoryAgentRepository(bookId, snapshot)
  await profileChangedRepo.transaction(true, async store => {
    const person = (await store.get('characters', 'A'))!
    await store.put('characters', { ...person, identity: '新任掌门', revision: Number(person.revision) + 1 })
  })
  const profileChanged = await reuseMetrics(profileChangedRepo)
  expect(profileChanged).toMatchObject({ reusedCharacters: 0, reusedPairs: 0, aStatus: 'pending', bStatus: 'pending' })

  // 量化前后使用相同样本；显式设置 0 验证基线，设置 1 验证修复后的目标。
  const expected = process.env.WW_OPT07_EXPECT_REUSED ?? '1'
  if (expected !== undefined) {
    expect(['0', '1']).toContain(expected)
    for (const measured of [unchanged, reloaded]) {
      expect(measured.reusedCharacters).toBe(Number(expected))
      expect(measured.reusedPairs).toBe(Number(expected))
      expect(measured.aStatus).toBe(expected === '1' ? 'checked' : 'pending')
    }
    expect(fingerprints.characterContentMatches).toBe(expected === '1')
    expect(fingerprints.pairContentMatches).toBe(expected === '1')
  }
  const result = {
    optimization: 7, sample: { characters: 2, completedCharacters: 1, changedPairs: 1 },
    submission: { ok: ack.ok, changed: ack.changed, complete: ack.complete, outcome: ack.outcome },
    expectedUnchanged: { reusedCharacters: 1, reusedPairs: 1 },
    fingerprints, unchanged, reloaded, relationChanged, profileChanged,
  }
  if (process.env.WW_OPT07_RESULT) writeFileSync(process.env.WW_OPT07_RESULT, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result))
})
