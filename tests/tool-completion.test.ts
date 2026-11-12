import { describe, expect, it } from 'vitest'
import { createMemoryAgentRepository, type Row } from '../src/features/agents/repository'
import { createAgentTools } from '../src/features/agents/tools'
import { commitCommand, type ReadSet } from '../src/features/agents/commands'
import { readTool, type Scope } from '../src/features/agents/queries'
import { hash, records, toolContracts } from '../src/features/agents/contracts'
import { saveCharacterPair } from '../src/features/assets/relationEdits'

async function fixture(kind: 'relations' | 'profile' = 'relations') {
  const scope: Scope = { bookId: 'test', runId: crypto.randomUUID(), taskId: 'task', owner: 'owner', profile: 'asset_editor', phase: 'character_organization', workKind: kind, unitId: `${kind}:A`, workItemIds: [] }
  const ids = Array.from({ length: 20 }, (_, i) => `B${i}`)
  const repo = createMemoryAgentRepository('test', {
    characters: ['A', ...ids].map(id => ({ id, bookId: 'test', name: id, aliases: [], identity: '人物', personality: '旧资料', revision: 1, confidence: 1, createdBy: 'P1', chapterIndex: '1', chapterName: '第一章' })),
    chapters: [{ chapterIndex: '1', bookId: 'test', chapterName: '第一章', order: 0 }],
    chapterTexts: [{ chapterIndex: '1', bookId: 'test', text: 'A与B0是朋友。A与B1是同僚。' }],
    pipelineRuns: [
      { id: 'lease:world', bookId: 'test', owner: scope.owner, runId: scope.runId, expiresAt: Date.now() + 60000 },
      { id: scope.runId, bookId: 'test', status: 'running', report: { assetEdits: [] }, tasks: [{ taskId: 'task', input: { workItems: [] }, appliedCommitIds: [], reviewedItems: [] }], commandIntents: [], appliedCommands: [], organization: {
        step: kind === 'profile' ? 'profiles' : 'relations', revision: 1, pairChecks: [],
        profileItems: [{ id: 'A', status: 'pending', commitIds: [] }], relationItems: [{ id: 'A', status: 'pending', commitIds: [] }],
        activeWork: { id: `${kind}:A`, kind, characterId: 'A', dataVersion: 1, commitIds: [] },
      } },
    ],
  })
  if (kind === 'relations') await repo.transaction(true, async store => {
    for (const id of ids) await saveCharacterPair(store, { bookId: 'test', fromId: 'A', toId: id, forwardLabels: ['旧关系'], reverseLabels: ['旧关系'], reason: '样本', actor: 'manual', commitId: `seed-${id}`, tool: 'fixture' })
  })
  const adapter = createAgentTools(repo, scope)
  const call = async (name: string, args: Row) => {
    const result = await adapter.tools.find(tool => tool.name === name)!.execute(crypto.randomUUID(), structuredClone(args))
    const value = JSON.parse(result.content.filter(part => part.type === 'text').map(part => part.text).join('')) as Row
    if (value.ok === false) expect(result.isError).toBe(true)
    return value
  }
  const run = () => repo.transaction(false, store => store.get('pipelineRuns', scope.runId)).then(row => row!)
  return { repo, scope, adapter, call, run, ids }
}

describe('工具查询、提交、完成与重放的真实调用链', () => {
  it('模型声明只保留业务字段，工具详情使用同一精简声明，内部旧参数仍可结束', async () => {
    for (const kind of ['relations', 'profile'] as const) {
      const { adapter, call } = await fixture(kind)
      const name = kind === 'relations' ? 'submit_relation_review' : 'submit_profile_review'
      const schema = adapter.tools.find(tool => tool.name === name)!.parameters as { properties: Row }
      expect(schema.properties).not.toHaveProperty('operationKey')
      if (kind === 'relations') {
        expect(schema.properties).not.toHaveProperty('basis')
        expect((schema.properties.changes as { items: { properties: Row } }).items.properties).toHaveProperty('basis')
        const before = JSON.stringify(toolContracts.asset_editor.find(tool => tool.name === name)!.parameters).length
        expect(JSON.stringify(schema).length).toBeLessThan(before * 0.75)
      }
      expect(await call('get_tools_detail', { name })).toMatchObject({ parameters: schema })
      expect(await call(name, { ...(kind === 'relations' ? { changes: [] } : { patch: {} }), done: true, operationKey: 'legacy', basis: [{ summary: '当前资料', source: { kind: 'asset', assetKind: 'character', id: 'A' } }] })).toMatchObject({ ok: true, complete: true })
    }
  })
  it('两批查证、3对修改、17对待核对跨批保留，空changes完成并可处理下一人物', async () => {
    const { call, run, ids, adapter, repo, scope } = await fixture()
    await call('query_relation_work', { targetIds: ids.slice(0, 10), fields: ['targetId', 'evidence'] })
    await call('query_relation_work', { targetIds: ids.slice(10), fields: ['targetId', 'evidence'] })
    const first = await call('submit_relation_review', { changes: ids.slice(0, 3).map(targetId => ({ targetId, action: 'set', forwardLabels: ['朋友'], reverseLabels: ['朋友'] })), uncertainPairs: ids.slice(3, 12).map(targetId => ({ targetId, reason: '依据不足' })), done: false })
    expect(first).toMatchObject({ ok: true, complete: false, applied: ids.slice(0, 3) })
    await call('submit_relation_review', { changes: [], uncertainPairs: ids.slice(12).map(targetId => ({ targetId, reason: '尚待核对' })), done: false })
    const result = await call('submit_relation_review', { changes: [], done: true })
    expect(result).toMatchObject({ ok: true, status: 'succeeded', complete: true, done: true })
    const organization = (await run()).organization as Row
    expect(organization.activeWork).toBeNull()
    expect(records(organization.pairChecks).filter(row => row.outcome === 'changed')).toHaveLength(3)
    expect(records(organization.pairChecks).filter(row => row.outcome === 'uncertain')).toHaveLength(17)
    expect(adapter.reads.queries.every(query => query.args.characterId === 'A')).toBe(true)
    await repo.transaction(true, async store => {
      const next = (await store.get('pipelineRuns', scope.runId))!
      const org = next.organization as Row
      org.activeWork = { id: 'relations:B0', kind: 'relations', characterId: 'B0', commitIds: [] }
      org.relationItems = [...records(org.relationItems), { id: 'B0', status: 'pending', commitIds: [] }]
      await store.put('pipelineRuns', next)
    })
    const next = createAgentTools(repo, { ...scope, unitId: 'relations:B0' })
    const ack = await next.tools.find(tool => tool.name === 'submit_relation_review')!.execute('finish-next', { changes: [], done: true })
    expect(ack.details).toMatchObject({ ok: true, complete: true })
    expect(records(((await run()).organization as Row).relationItems).find(row => row.id === 'B0')).toMatchObject({ status: 'checked' })
  })

  it('资料查询省略id后仍可分批修改、空patch结束', async () => {
    const { call, run, adapter } = await fixture('profile')
    await call('query_character_profile', {})
    await call('submit_profile_review', { patch: { personality: '新资料' }, done: false })
    expect(await call('submit_profile_review', { patch: {}, done: true })).toMatchObject({ ok: true, complete: true })
    expect(((await run()).organization as Row).activeWork).toBeNull()
    expect(adapter.reads.queries[0]!.args.id).toBe('A')
  })

  it.each(['relations', 'profile'] as const)('旧%s读集恢复后补齐查询人物身份', async kind => {
    const { repo, scope } = await fixture(kind)
    const tool = kind === 'relations' ? 'query_relation_work' : 'query_character_profile'
    const value = await repo.transaction(true, store => readTool(store, scope, tool, {}))
    const reads: ReadSet = { records: [], queries: [{ tool, args: {}, resultFingerprint: await hash(value) }] }
    const ack = await commitCommand(repo, scope, kind === 'relations' ? 'submit_relation_review' : 'submit_profile_review', 'finish', { operationKey: 'finish', ...(kind === 'relations' ? { changes: [] } : { patch: {} }), done: true }, reads)
    expect(ack).toMatchObject({ ok: true, complete: true })
    expect(reads.queries[0]!.args[kind === 'relations' ? 'characterId' : 'id']).toBe('A')
  })

  it('自指全失败没有成功确认，人物保留，空提交随后能结束', async () => {
    const { call, run } = await fixture()
    const result = await call('submit_relation_review', { changes: [{ targetId: 'A', action: 'set' }], done: true })
    expect(result).toMatchObject({ ok: false, status: 'failed', complete: false, done: false, applied: [] })
    expect(result).not.toHaveProperty('commitId')
    expect((await run()).appliedCommands).toEqual([])
    expect(records((await run()).tasks)[0]!.appliedCommitIds).toEqual([])
    expect(((await run()).organization as Row).activeWork).toMatchObject({ characterId: 'A' })
    expect(await call('submit_relation_review', { changes: [], done: true })).toMatchObject({ ok: true, complete: true })
  })

  it('部分成功及重复回执保持失败语义，成功项不重复写库', async () => {
    const { call, run, repo } = await fixture()
    const args = { changes: [{ targetId: 'B0', action: 'set', forwardLabels: ['朋友'] }, { targetId: 'A', action: 'set' }], done: true }
    const result = await call('submit_relation_review', args)
    expect(result).toMatchObject({ ok: false, status: 'partial', complete: false, applied: ['B0'] })
    expect(result.commitId).toEqual(expect.any(String))
    const before = await repo.transaction(false, store => store.get('characters', 'A'))
    expect(await call('submit_relation_review', args)).toMatchObject({ ok: false, status: 'partial', complete: false, commitId: result.commitId, alreadyApplied: true })
    expect(await repo.transaction(false, store => store.get('characters', 'A'))).toEqual(before)
    expect((await run()).appliedCommands).toHaveLength(1)
  })

  it('新一批全失败仍如实返回之前已提交的累计成果', async () => {
    const { call, run } = await fixture()
    const saved = await call('submit_relation_review', { changes: [{ targetId: 'B0', action: 'set', forwardLabels: ['朋友'] }], done: false })
    const failed = await call('submit_relation_review', { changes: [{ targetId: 'A', action: 'set' }], done: true })
    expect(failed).toMatchObject({ ok: false, status: 'failed', applied: [], cumulativeApplied: ['B0'] })
    expect(failed).not.toHaveProperty('commitId')
    expect(records((await run()).appliedCommands).map(row => row.commitId)).toEqual([saved.commitId])
  })

  it('合法无变化项与失败项混合时保留部分确认而不夸大修改', async () => {
    const { call } = await fixture()
    const args = { changes: [{ targetId: 'B0', action: 'set', forwardLabels: ['旧关系'], reverseLabels: ['旧关系'] }, { targetId: 'A', action: 'set' }], done: true }
    expect(await call('submit_relation_review', args)).toMatchObject({ ok: false, status: 'partial', changed: false, applied: [], complete: false, commitId: expect.any(String) })
    expect(await call('submit_relation_review', args)).toMatchObject({ ok: false, status: 'partial', alreadyApplied: true })
  })

  it.each(['relations', 'profile'] as const)('重放已完成的%s回执不会误结束下一人物', async kind => {
    const { call, run, repo, scope } = await fixture(kind)
    const tool = kind === 'relations' ? 'submit_relation_review' : 'submit_profile_review'
    const args = { ...(kind === 'relations' ? { changes: [] } : { patch: {} }), done: true }
    const first = await call(tool, args)
    await repo.transaction(true, async store => {
      const saved = (await store.get('pipelineRuns', scope.runId))!
      const organization = saved.organization as Row
      organization.activeWork = { kind, id: `${kind}:B0`, characterId: 'B0', dataVersion: 1, commitIds: [] }
      const field = kind === 'relations' ? 'relationItems' : 'profileItems'
      organization[field] = [...records(organization[field]), { id: 'B0', status: 'pending', commitIds: [] }]
      await store.put('pipelineRuns', saved)
    })
    expect(await call(tool, args)).toMatchObject({ commitId: first.commitId, alreadyApplied: true })
    expect(((await run()).organization as Row).activeWork).toMatchObject({ characterId: 'B0' })
  })

  it.each([
    [[{ chapterIndex: '1', quote: 'A与B0是朋友。' }], 'verified'],
    [[{ chapterIndex: '1', quote: 'A和B0是好友。' }], 'unverified'],
    [[{ chapterIndex: '2', quote: 'A与B0是朋友。' }], 'unverified'],
    [[{ chapterIndex: '1', quote: 'A与B0是朋友。' }, { chapterIndex: '1', quote: '改写' }], 'partial'],
  ])('证据%j按逐字来源校验为%s', async (evidence, evidenceStatus) => {
    const { call, run } = await fixture()
    expect(await call('submit_relation_review', { changes: [{ targetId: 'B0', action: 'set', forwardLabels: ['朋友'], evidence }], done: true })).toMatchObject({ ok: true, complete: true })
    expect(records(((await run()).report as Row).assetEdits).at(-1)).toMatchObject({ evidenceStatus })
  })

  it('普通关系工具重复保存相同内容时，最终总结仍可如实报告未修改', async () => {
    const { repo, scope, run } = await fixture()
    const workItemId = 'relation:A:B0'
    const reviewScope: Scope = { ...scope, phase: 'asset_review', workKind: undefined, workItemIds: [workItemId] }
    await repo.transaction(true, async store => {
      const saved = (await store.get('pipelineRuns', scope.runId))!
      records(saved.tasks)[0]!.input = { workItems: [{ workItemId, kind: 'relation', id: '["A","B0"]', fromId: 'A', toId: 'B0' }] }
      await store.put('pipelineRuns', saved)
    })
    const adapter = createAgentTools(repo, reviewScope)
    const call = async (name: string, args: Row) => {
      const result = await adapter.tools.find(tool => tool.name === name)!.execute(crypto.randomUUID(), args)
      return JSON.parse(result.content.filter(part => part.type === 'text').map(part => part.text).join('')) as Row
    }
    await call('get_character_detail', { ids: ['A', 'B0'] })
    const pair = (await call('get_character_relation', { fromId: 'A', toId: 'B0' })).data as Row
    const ack = await call('set_character_relation', { operationKey: 'same', fromId: 'A', toId: 'B0', expectedFingerprint: pair.fingerprint, forwardLabels: ['旧关系'], reverseLabels: ['旧关系'], directionUnclear: false, reason: '保持原值' })
    expect(ack.changed).toBe(false)
    expect(records((await run()).tasks)[0]!.reviewedItems).toEqual([])
    expect(await call('submit_result', { status: 'completed', commitIds: [ack.commitId], summary: '无变化', reviewedItems: [{ workItemId, outcome: 'no_change', reason: '保持原值' }], remainingWorkIds: [] })).toMatchObject({ accepted: true })
  })

  it('三人候选组只合并两人后可登记partial，伪造提交号不能通过', async () => {
    const { call, run } = await fixture('profile')
    await call('get_character_detail', { ids: ['A', 'B0', 'B1'] })
    const group = await call('save_candidate_group', { operationKey: 'group', memberIds: ['A', 'B0', 'B1'], reason: '疑似同人' })
    const basis = ['A', 'B0'].map(id => ({ summary: '样本确认同人', source: { kind: 'asset', assetKind: 'character', id } }))
    const merge = await call('merge_assets', { operationKey: 'merge', kind: 'character', keepId: 'A', memberIds: ['A', 'B0'], expectedRevisions: { A: 1, B0: 1 }, reason: '两人为同人', basis })
    const args = { groupId: group.groupId, expectedRevision: group.revision, outcome: 'partial', reason: '合并两人，另一人待核对', basis: [basis[0]], commitIds: [merge.commitId] }
    await expect(call('resolve_candidate_group', { ...args, operationKey: 'fake', commitIds: ['fabricated'] })).rejects.toThrow(/提交确认/)
    expect(await call('resolve_candidate_group', { ...args, operationKey: 'resolve' })).toMatchObject({ ok: true })
    expect(records(((await run()).organization as Row).candidateDecisions)[0]).toMatchObject({ outcome: 'partial', commitIds: [merge.commitId] })
  })

  it.each(['profile', 'relations'] as const)('已绑定%s查询的人物被合并后，读集跟随有效人物而非丢失身份', async kind => {
    const { call, run } = await fixture(kind)
    await call(kind === 'profile' ? 'query_character_profile' : 'query_relation_work', {})
    const details = records((await call('get_character_detail', { ids: ['A', 'B0'] })).data)
    await call('merge_assets', { operationKey: 'merge-current', kind: 'character', keepId: 'B0', memberIds: ['A', 'B0'], expectedRevisions: Object.fromEntries(details.map(row => [row.id, row.revision])), reason: '合并当前人物', basis: ['A', 'B0'].map(id => ({ summary: '样本核对', source: { kind: 'asset', assetKind: 'character', id } })) })
    expect(((await run()).organization as Row).activeWork).toMatchObject({ characterId: 'B0' })
    expect(await call(kind === 'profile' ? 'submit_profile_review' : 'submit_relation_review', { ...(kind === 'profile' ? { patch: {} } : { changes: [] }), done: true })).toMatchObject({ ok: true, complete: true })
  })
})
