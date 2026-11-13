import { expect, it } from 'vitest'
import { createMemoryAgentRepository, type Row } from '../src/features/agents/repository'
import { createAgentTools } from '../src/features/agents/tools'
import type { Scope } from '../src/features/agents/queries'
import { buildProfileReview, buildRelationReview, refreshReview } from '../src/features/agents/organizationReview'
import { createOrganizationState } from '../src/features/world/organization'
import { emptyReport } from '../src/features/world/types'
import fixture from './fixtures/organization-profile.json'

const id = 'C6-P005', child = 'C49-P001'
const normalized = '在位皇帝，年号崇平，现为崇平十四年，御极天下十四载、亲政六年；以庶出之身夺嫡登位；膝下五子三女，为陈芷、陈泽之父；称谓有陛下、圣上、朕、父皇、天子；国号资料有“大明”“陈汉”“大汉”三种记载，仍待核实。'
const basis = [{ summary: '已完整核对当前人物和合并事实底稿，归纳重复并保留独有经历和分歧', source: { kind: 'asset', assetKind: 'character', id } }]
async function setup(relations = false, extra: Row = {}) {
  const person = { ...fixture, ...extra, id, bookId: 'a', revision: 1, confidence: 1, createdBy: 'P1', chapterIndex: '6' }
  const son = { id: child, name: '陈泽', identity: '皇子', aliases: [], bookId: 'a', revision: 1, confidence: 1, createdBy: 'P1', chapterIndex: '49' }
  const repo = createMemoryAgentRepository('a', {
    characters: [person, son, ...(relations ? [{ ...son, id: 'C50-P001', name: '友人', identity: '陈泽的友人' }] : [])],
    characterRelations: relations ? [
      { id: 'relation-1', bookId: 'a', originCharacterId: id, sourceName: '崇平帝', targetName: '陈泽', sourceId: id, targetIds: [child], relationType: 'family', forwardLabel: '父亲', reverseLabel: '儿子', direction: 'bidirectional', evidence: [], revision: 1, createdAt: '2026-11-05', updatedAt: '2026-11-05' },
      { id: 'relation-unknown', bookId: 'a', originCharacterId: id, sourceName: '崇平帝', targetName: '陈泽', sourceId: id, targetIds: [child], relationType: 'unknown', forwardLabel: '未知', reverseLabel: '儿子', direction: 'bidirectional', evidence: [], revision: 1, createdAt: '2026-11-05', updatedAt: '2026-11-05' },
      { id: 'relation-friend', bookId: 'a', originCharacterId: child, sourceName: '陈泽', targetName: '友人', sourceId: child, targetIds: ['C50-P001'], relationType: 'friend', forwardLabel: '朋友', reverseLabel: '朋友', direction: 'bidirectional', evidence: [], revision: 1, createdAt: '2026-11-05', updatedAt: '2026-11-05' },
    ] : [],
  })
  const scope: Scope = { bookId: 'a', profile: 'asset_editor', phase: 'character_organization', workflow: 'character_organization_v1', runId: 'run', taskId: 'task', owner: 'owner', workItemIds: ['organization:profiles'] }
  await repo.transaction(true, async store => {
    const organization = createOrganizationState([id, child]) as unknown as Row
    await buildProfileReview(store, organization)
    await store.put('pipelineRuns', { id: 'run', bookId: 'a', stage: 'P2', workflow: 'character_organization_v1', organization, report: emptyReport({ characters: 2, locations: 0 }), tasks: [{ taskId: 'task', phase: 'character_organization', appliedCommitIds: [], reviewedItems: [], readSet: { records: [], queries: [] }, input: { workItems: [] } }], appliedCommands: [], commandIntents: [] })
    await store.put('pipelineRuns', { id: 'lease:world', bookId: 'a', lockKey: 'world', owner: 'owner', runId: 'run', expiresAt: Date.now() + 300000 })
  })
  const adapter = createAgentTools(repo, scope)
  const call = async (name: string, args: Row) => (await adapter.tools.find(tool => tool.name === name)!.execute(crypto.randomUUID(), args)).details as Row
  const check = (args: Row = {}) => call('record_organization_progress', { operationKey: crypto.randomUUID(), action: 'check_item', kind: 'profile', id, outcome: 'no_change', reason: '已核对全部当前资料', ...args })
  const run = () => repo.transaction(false, store => store.get('pipelineRuns', 'run'))
  return { repo, scope, call, check, run, adapter }
}

it('未读、目录与不含事实底稿的读取不能登记资料完成', async () => {
  const { call, check } = await setup()
  await expect(check()).rejects.toThrow('完整读取')
  await call('query_character_catalog', {})
  await expect(check()).rejects.toThrow('完整读取')
  await call('get_character_detail', { ids: [id] })
  await expect(check()).rejects.toThrow('事实底稿')
  const detail = await call('get_character_detail', { ids: [id], include_facts: true })
  expect((detail.data as Row[])[0].mergeFacts).toEqual(fixture.mergeFacts)
  await expect(check()).resolves.toMatchObject({ ok: true })
})

it('合并、空确认和其他人物确认不能冒充资料修改', async () => {
  const { call, check, repo, run } = await setup()
  await call('get_character_detail', { ids: [id], include_facts: true })
  await expect(check({ outcome: 'changed', commitIds: [] })).rejects.toThrow('实际资料/关系修改确认')
  await expect(check({ outcome: 'changed', commitIds: ['merge-commit'] })).rejects.toThrow('实际资料/关系修改确认')
  await repo.transaction(true, async store => {
    const current = (await store.get('pipelineRuns', 'run'))!
    await store.put('pipelineRuns', { ...current, report: { ...(current.report as Row), assetEdits: [{ id: child, kind: 'character', tool: 'edit_character', commitId: 'other-person', fieldChanges: [{ field: 'identity', before: '', after: '皇子' }], timestamp: new Date().toISOString() }] } })
  })
  await expect(check({ outcome: 'changed', commitIds: ['other-person'] })).rejects.toThrow('实际资料/关系修改确认')
  expect((((await run())!.organization as Row).profileItems as Row[]).find(item => item.id === id)).toMatchObject({ id, status: 'pending' })
})

it('崇平帝真实重复样本实际归纳，国号保留疑点，独有事实和原底稿仍在', async () => {
  const { call, check, repo, run } = await setup()
  await call('get_character_detail', { ids: [id], include_facts: true })
  const edited = await call('edit_character', { operationKey: 'normalize-emperor', id, expectedRevision: 1, patch: { identity: normalized }, reason: '归纳重复身份和称谓，保留子女、登位和在位经历，国号存疑单列', basis })
  await expect(check({ outcome: 'no_change' })).rejects.toThrow('已有实际修改')
  await expect(check({ outcome: 'uncertain', commitIds: [edited.commitId] })).rejects.toThrow('uncertainFields')
  await check({ outcome: 'uncertain', uncertainFields: ['identity'], commitIds: [edited.commitId], reason: '重复身份已实际归纳，子女和登位经历保留；国号三种记载仍需查证' })
  const person = await repo.transaction(false, store => store.get('characters', id))
  expect(person?.identity).toBe(normalized)
  expect(String(person?.identity).match(/皇帝/g)).toHaveLength(1)
  for (const text of ['五子三女', '陈芷、陈泽', '庶出', '亲政六年', '大明', '陈汉', '大汉']) expect(person?.identity).toContain(text)
  expect(((person!.mergeFacts ?? []) as Row[]).map(fact => fact.id)).toEqual(expect.arrayContaining(fixture.mergeFacts.map(fact => fact.id)))
  const current = (await run())!
  expect(((current.organization as Row).profileItems as Row[])[0]).toMatchObject({ status: 'checked', outcome: 'uncertain', uncertainFields: ['identity'], commitIds: [edited.commitId] })
  expect(((current.report as Row).assetEdits as Row[])[0]).toMatchObject({ id, tool: 'edit_character', fieldChanges: [{ field: 'identity', before: fixture.identity, after: normalized }] })
})

it('长资料必须连续读完，可跨工具实例恢复完整读取证明', async () => {
  const { repo, scope, call, check } = await setup(false, { background: '原始独有经历。'.repeat(12000) })
  let detail = await call('get_character_detail', { ids: [id], include_facts: true, maxChars: 6000 })
  await expect(check()).rejects.toThrow('续读完')
  let part = (detail.data as Row[])[0]
  // 跳读末段仍不能冒充完整阅读。
  await call('get_character_detail', { ids: [id], include_facts: true, char_offset: Number(part.totalChars) - 10, maxChars: 6000 })
  await expect(check()).rejects.toThrow('续读完')
  while (part.nextCharOffset !== null) {
    detail = await call('get_character_detail', { ids: [id], include_facts: true, char_offset: part.nextCharOffset, maxChars: 6000 })
    part = (detail.data as Row[])[0]
  }
  const rebuilt = createAgentTools(repo, scope)
  await expect(rebuilt.tools.find(tool => tool.name === 'record_organization_progress')!.execute('resume', { operationKey: 'resume-check', action: 'check_item', kind: 'profile', id, outcome: 'no_change', reason: '已连续读取完整背景及底稿' })).resolves.toBeDefined()
})

it('真实资料改变使读取失效，频次和revision变化保持有效', async () => {
  const { call, check, repo } = await setup()
  await call('get_character_detail', { ids: [id], include_facts: true })
  await repo.transaction(true, async store => {
    const person = (await store.get('characters', id))!
    await store.put('characters', { ...person, revision: 2, frequency: { chapters: 2, mentions: 20, scopeChapters: 57, percentile: .9 } })
  })
  await check()
  await repo.transaction(true, async store => {
    const person = (await store.get('characters', id))!
    await store.put('characters', { ...person, identity: '人工已修正的身份', revision: 3 })
  })
  await expect(check()).rejects.toThrow('完整读取')
})

it('人物对须实际查询核对，双端共享结论，修改只使相关结果失效', async () => {
  const { call, repo, run } = await setup(true)
  await repo.transaction(true, async store => {
    const current = (await store.get('pipelineRuns', 'run'))!, state = current.organization as Row
    for (const item of state.profileItems as Row[]) Object.assign(item, { status: 'checked', outcome: 'no_change' })
    await buildRelationReview(store, state)
    await store.put('pipelineRuns', { ...current, organization: state })
  })
  const pair = JSON.stringify([child, id].sort())
  await call('get_character_detail', { ids: [id, child, 'C50-P001'] })
  const checkPair = (args: Row = {}) => call('record_organization_progress', { operationKey: crypto.randomUUID(), action: 'check_item', kind: 'pair', id: pair, outcome: 'no_change', reason: '身份关系与双方资料相符', basis: [{ summary: '已读取父子关系', source: { kind: 'relation', fromId: id, toId: child } }], ...args })
  await expect(checkPair()).rejects.toThrow('先读取')
  await expect(call('record_organization_progress', { operationKey: 'too-early', action: 'check_item', kind: 'relation_scan', id, outcome: 'no_change', reason: '只读人物资料，尚未读取关系' })).rejects.toThrow('须完整读取该人物当前关系')
  await call('get_character_relation', { fromId: id, toId: child })
  await checkPair()
  const reused = await checkPair()
  expect(reused.summary).toContain('复用')
  expect(((await run())!.organization as Row).pairChecks).toHaveLength(2)
  const otherKey = JSON.stringify([child, 'C50-P001'].sort())
  await call('get_character_relation', { fromId: child, toId: 'C50-P001' })
  await call('record_organization_progress', { operationKey: 'friend-checked', action: 'check_item', kind: 'pair', id: otherKey, outcome: 'no_change', reason: '完整资料说明二人为朋友', basis: [{ summary: '已读取朋友关系', source: { kind: 'relation', fromId: child, toId: 'C50-P001' } }] })
  const currentPair = (await call('get_character_relation', { fromId: id, toId: child })).data as Row
  const saved = await call('set_character_relation', { operationKey: 'clean-pair', fromId: id, toId: child, expectedFingerprint: currentPair.fingerprint, forwardLabels: ['父亲'], reverseLabels: ['儿子'], directionUnclear: false, reason: '去掉与已明确父子身份重复的未知标签', basis })
  expect(saved.changed).toBe(true)
  await checkPair({ outcome: 'changed', commitIds: [saved.commitId] })
  await repo.transaction(true, async store => {
    const current = (await store.get('pipelineRuns', 'run'))!, state = current.organization as Row
    const person = (await store.get('characters', id))!
    await store.put('characters', { ...person, revision: 2, frequency: { mentions: 999 } })
    await refreshReview(store, state)
    expect((state.pairChecks as Row[]).find(item => item.pairKey === pair)?.outcome).toBe('changed')
    expect((state.pairChecks as Row[]).find(item => item.pairKey === otherKey)?.outcome).toBe('no_change')
    await store.put('characters', { ...person, identity: '相关身份发生变化', revision: 3 })
    await refreshReview(store, state)
    expect((state.pairChecks as Row[]).find(item => item.pairKey === pair)?.outcome).toBeNull()
    expect((state.pairChecks as Row[]).find(item => item.pairKey === otherKey)?.outcome).toBe('no_change')
  })
})
