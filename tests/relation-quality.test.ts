import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createBookAgentRepository } from '../src/features/agents/repository'
import { applyOrganizationTool } from '../src/features/agents/organizationCommands'
import { commitCommand } from '../src/features/agents/commands'
import { refreshReview, pendingPairChecks } from '../src/features/agents/organizationReview'
import { visiblePairChecks } from '../src/features/world/organizationReport'
import type { OrganizationState } from '../src/features/world/types'
import { saveCharacterPair } from '../src/features/assets/relationEdits'
import { pairKeyOf } from '../src/features/assets/relations'
import type { Character } from '../src/features/assets/types'
import type { Scope } from '../src/features/agents/queries'
import type { ReadSet } from '../src/features/agents/commands'

const opened: ReturnType<typeof createWorkspace>[] = []
const sourceId = 'C1-P021'
const baseScope: Scope = { bookId: 'a', profile: 'asset_editor', phase: 'character_organization', runId: 'run-quality', taskId: 'task-quality', owner: 'owner-quality', workItemIds: [] }
let scope: Scope = baseScope
const quote = {
  caiquan: '贾珩为蔡权好友',
  laijia: '明日，我亲自讯问赖大',
  yuanyang: '贾母身后的大丫鬟鸳鸯',
  xiezaiyi: '贾珩与谢再义以朋友相称',
}
const person = (id: string, name: string): Character => ({ id, bookId: 'a', name, aliases: [], identity: `${name}的身份`, confidence: 1, revision: 1, createdBy: 'P1', chapterIndex: '1', chapterName: '第1章' })
const ev = (text: string) => [{ chapterIndex: '1', quote: text }]
const readChapter: ReadSet = { records: [], queries: [{ tool: 'read_original', args: { chapter_indices: ['1'] }, resultFingerprint: 'fixture' }] }

afterEach(async () => {
  for (const workspace of opened.splice(0)) {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name)
  }
})

async function setup() {
  scope = { ...baseScope, runId: `run-quality-${crypto.randomUUID()}` }
  const id = crypto.randomUUID()
  const workspace = createWorkspace({ settingsName: `relation-quality-${id}`, bookPrefix: `relation-quality-book-${id}-` })
  opened.push(workspace)
  await workspace.settings.books.put({ id: 'a', title: '关系质量样本', sourceFileName: 'quality.txt', createdAt: new Date().toISOString() })
  const db = workspace.openBook('a')
  const names: Record<string, string> = { [sourceId]: '贾珩', 'C1-P037': '蔡权', 'C8-P014': '赖家', 'C3-P029': '鸳鸯', 'C3-P023': '林黛玉', 'C3-P024': '探春', 'C3-P026': '迎春', 'C2-P029': '宋源', 'C3-P021': '贾母', 'C46-P010': '谢再义', 'C4-P005': '晴雯', 'C4-P011': '碧儿', 'C5-P010': '戴权', 'C2-P027': '焦大', 'C1-P024': '贾赦' }
  await db.table('characters').bulkPut(Object.entries(names).map(([id, name]) => person(id, name)))
  const chapterText = [quote.caiquan, quote.laijia, quote.yuanyang, quote.xiezaiyi, '贾珩与蔡权兄弟相称，同为锦衣卫同僚。', '贾珩与谢再义以朋友相称，并授其射艺。'].join('\n')
  await db.chapters.put({ bookId: 'a', chapterIndex: '1', chapterName: '第1章', order: 0, charCount: chapterText.length })
  await db.table('chapterTexts').put({ bookId: 'a', chapterIndex: '1', text: chapterText })
  const now = new Date().toISOString()
  const pair = (target: string, forward: string[], reverse: string[], unclear = false) => {
    const key = pairKeyOf(sourceId, target)
    const [aId, bId] = JSON.parse(key) as [string, string]
    return { pairKey: key, bookId: 'a', aId, bId, state: 'active', aToBLabels: forward, bToALabels: reverse, directionUnclear: unclear, evidence: [], sourceRelationIds: [`R-${target}`], revision: 1, updatedAt: now, updatedBy: 'manual', commitId: 'seed' }
  }
  await db.table('characterRelationEdits').bulkPut([
    pair('C1-P037', ['上官', '上司', '朋友', '兄弟相称'], ['下属', '朋友', '兄弟相称']),
    pair('C8-P014', ['未知'], ['未知'], true),
    pair('C3-P029', ['未知'], ['未知'], true),
    pair('C3-P023', ['未知', '珩大哥（同辈兄长般）'], ['未知', '林妹妹（同辈妹妹）'], true),
    pair('C3-P024', ['未知'], ['未知'], true),
    pair('C3-P026', ['未知'], ['未知'], true),
    pair('C2-P029', ['未知'], ['未知'], true),
    pair('C3-P021', ['族中晚辈', '晚辈'], ['族中长辈', '长辈'], true),
    pair('C46-P010', ['朋友', '学射弟子'], ['朋友', '授艺之师'], true),
    pair('C4-P005', ['公子（主家）', '主人', '未知', '主子'], ['丫鬟', '大丫鬟', '未知', '服侍的丫鬟'], true),
    pair('C4-P011', ['主子', '主人', '未知'], ['丫鬟', '未知'], true),
    pair('C5-P010', ['请托者', '受旨之臣', '未知', '受旨者'], ['受请托的权阉内监', '传旨太监', '未知', '传旨内相'], true),
    pair('C2-P027', ['未知', '主家（族长）', '主子'], ['未知', '家仆', '仆役'], true),
    pair('C1-P024', ['族中晚辈', '族中同族'], ['族中长辈', '族中同族'], false),
  ])
  await db.table('pipelineRuns').put({
    id: scope.runId, bookId: 'a', workflow: 'character_organization_v1', status: 'running', report: { assetEdits: [] },
    tasks: [{ taskId: scope.taskId, phase: 'character_organization', status: 'running', workItemIds: [], input: { workItems: [] }, readSet: { records: [], queries: [] }, appliedCommitIds: [] }],
    commandIntents: [], appliedCommands: [],
    organization: {
      step: 'relations', revision: 1, pairChecks: [],
      relationItems: [{ id: sourceId, name: '贾珩', status: 'pending', outcome: null, reason: '', commitIds: [] }],
      activeWork: { kind: 'relations', id: `relations:${sourceId}`, characterId: sourceId, targetIds: [sourceId], commitIds: [] },
    },
  })
  await db.table('pipelineRuns').put({ id: 'lease:world', recordType: 'lease', bookId: 'a', lockKey: 'world', owner: scope.owner, runId: scope.runId, expiresAt: Date.now() + 60000 })
  return { db, repo: createBookAgentRepository(workspace, 'a') }
}

async function submit(repo: Awaited<ReturnType<typeof setup>>['repo'], changes: Record<string, unknown>[], extra: Record<string, unknown> = {}, readSet = readChapter) {
  return repo.transaction(true, store => applyOrganizationTool(store, scope, 'submit_relation_review', { changes, done: true, reason: '测试提交', operationKey: crypto.randomUUID(), ...extra }, readSet as never, crypto.randomUUID(), new Date().toISOString()))
}

describe('关系质量边界（宽松版）', () => {
  it('碧儿无证据去重保存为修改，但标记 unverified 并保持原存疑状态', async () => {
    const { db, repo } = await setup()
    const result = await submit(repo, [{ targetId: 'C4-P011', action: 'set', forwardLabels: ['主子'], reverseLabels: ['丫鬟'], reason: '主子/主人同义去重' }])
    expect(result).toMatchObject({ changed: true, outcome: 'uncertain', unverified: ['C4-P011'] })
    const edit = await db.table('characterRelationEdits').get(pairKeyOf(sourceId, 'C4-P011')) as Record<string, unknown>
    expect(edit).toMatchObject({ aToBLabels: ['主子'], bToALabels: ['丫鬟'], directionUnclear: true, evidenceStatus: 'unverified' })
  })

  it('戴权、晴雯、焦大的同义/包含去重无证据通过', async () => {
    const { db, repo } = await setup()
    await submit(repo, [
      { targetId: 'C5-P010', action: 'set', forwardLabels: ['请托者', '受旨之臣'], reverseLabels: ['受请托的权阉内监', '传旨太监'], reason: '戴权同义去重' },
      { targetId: 'C4-P005', action: 'set', forwardLabels: ['主子'], reverseLabels: ['大丫鬟'], reason: '晴雯同义去重' },
      { targetId: 'C2-P027', action: 'set', forwardLabels: ['主家（族长）'], reverseLabels: ['家仆'], reason: '焦大同义去重' },
    ])
    expect((await db.table('characterRelationEdits').get(pairKeyOf(sourceId, 'C5-P010')) as { aToBLabels: string[] }).aToBLabels).toEqual(['请托者', '受旨之臣'])
    expect((await db.table('characterRelationEdits').get(pairKeyOf(sourceId, 'C4-P005')) as { aToBLabels: string[] }).aToBLabels).toEqual(['主子'])
    expect((await db.table('characterRelationEdits').get(pairKeyOf(sourceId, 'C2-P027')) as { aToBLabels: string[] }).aToBLabels).toEqual(['主家（族长）'])
  })

  it('删除独立维度不再硬拒绝，保存为修改并标记待核对', async () => {
    const { db, repo } = await setup()
    const result = await submit(repo, [{ targetId: 'C1-P037', action: 'set', forwardLabels: ['朋友'], reverseLabels: ['朋友'], reason: '只保留朋友' }])
    expect(result).toMatchObject({ changed: true, outcome: 'uncertain' })
    expect((result as unknown as { unverified: string[] }).unverified).toEqual(['C1-P037'])
    expect((await db.table('characterRelationEdits').get(pairKeyOf(sourceId, 'C1-P037')) as { aToBLabels: string[] }).aToBLabels).toEqual(['朋友'])
  })

  it('C1-P024 删除族中同族不再硬拒绝，保存为修改并标记待核对', async () => {
    const { db, repo } = await setup()
    const result = await submit(repo, [{ targetId: 'C1-P024', action: 'set', forwardLabels: ['族中晚辈'], reverseLabels: ['族中长辈'], reason: '去掉重复的族中同族' }])
    expect(result).toMatchObject({ changed: true, outcome: 'uncertain', unverified: ['C1-P024'] })
    expect((await db.table('characterRelationEdits').get(pairKeyOf(sourceId, 'C1-P024')) as { aToBLabels: string[] }).aToBLabels).toEqual(['族中晚辈'])
  })

  it('C3-P023 改成未知不再硬拒绝，保存为修改并标记待核对', async () => {
    const { db, repo } = await setup()
    const result = await submit(repo, [{ targetId: 'C3-P023', action: 'set', forwardLabels: ['未知'], reverseLabels: ['未知'], reason: '删除称谓，保留未知' }])
    expect(result).toMatchObject({ changed: true, outcome: 'uncertain', unverified: ['C3-P023'] })
    expect((await db.table('characterRelationEdits').get(pairKeyOf(sourceId, 'C3-P023')) as { aToBLabels: string[] }).aToBLabels).toEqual(['未知'])
  })

  it('宋源新增具体关系不再阻塞，保存为修改并标记待核对', async () => {
    const { repo } = await setup()
    const result = await submit(repo, [{ targetId: 'C2-P029', action: 'set', forwardLabels: ['主子'], reverseLabels: ['学生'], reason: '推断师生' }])
    expect(result).toMatchObject({ changed: true, outcome: 'uncertain' })
    expect((result as unknown as { unverified: string[] }).unverified).toEqual(['C2-P029'])
  })

  it('带有效引文的修改保存为 verified，无效引文保存为 unverified 而不是拒绝', async () => {
    const { db, repo } = await setup()
    await submit(repo, [{ targetId: 'C1-P037', action: 'set', forwardLabels: ['上官', '朋友'], reverseLabels: ['下属', '朋友'], reason: '有效原文', evidence: ev(quote.caiquan) }])
    expect(await db.table('characterRelationEdits').get(pairKeyOf(sourceId, 'C1-P037'))).toMatchObject({ evidenceStatus: 'verified' })
    const { repo: repo2 } = await setup()
    // 换一个全新 workspace，验证无效引文不被拒绝
    const invalid = await submit(repo2, [{ targetId: 'C1-P037', action: 'set', forwardLabels: ['朋友'], reverseLabels: ['朋友'], reason: '无效原文', evidence: ev('不存在的引文') }])
    expect(invalid).toMatchObject({ changed: true, outcome: 'uncertain' })
  })

  it('删除关系仍要求可追溯依据，带有效引文可以删除', async () => {
    const { db, repo } = await setup()
    const failed = await submit(repo, [{ targetId: 'C1-P037', action: 'delete', reason: '删除错误关系' }])
    expect(failed).toMatchObject({ changed: false, done: false })
    expect((failed as unknown as { failed?: { targetId: string; code: string }[] }).failed?.map(item => ({ targetId: item.targetId, code: item.code }))).toEqual([{ targetId: 'C1-P037', code: 'INVALID_ARGS' }])
    await submit(repo, [{ targetId: 'C1-P037', action: 'delete', reason: '原文不支持', evidence: ev(quote.caiquan) }])
    expect(await db.table('characterRelationEdits').get(pairKeyOf(sourceId, 'C1-P037'))).toMatchObject({ state: 'deleted', evidenceStatus: 'verified' })
  })

  it('uncertainPairs 标记已有人物对为待核对', async () => {
    const { db, repo } = await setup()
    const result = await submit(repo, [], { uncertainPairs: [{ targetId: 'C2-P029', reason: '证据不足' }] })
    expect(result).toMatchObject({ outcome: 'uncertain' })
    const run = await db.table('pipelineRuns').get(scope.runId) as Record<string, unknown>
    expect(((run.organization as Record<string, unknown>).pairChecks as Record<string, unknown>[]).find(row => row.pairKey === pairKeyOf(sourceId, 'C2-P029'))).toMatchObject({ outcome: 'uncertain', reason: '证据不足', commitIds: [] })
  })

  it('pairChecks 按人物对记录各自的理由、确认号与证据状态', async () => {
    const { db, repo } = await setup()
    const result = await submit(repo, [
      { targetId: 'C1-P037', action: 'set', forwardLabels: ['上官', '朋友'], reverseLabels: ['下属', '朋友'], reason: '原文支持', evidence: ev(quote.caiquan) },
      { targetId: 'C4-P011', action: 'set', forwardLabels: ['主子'], reverseLabels: ['丫鬟'], reason: '同义去重' },
    ], { reason: '整批测试提交', uncertainPairs: [{ targetId: 'C2-P029', reason: '证据不足，待核对' }] })
    const run = await db.table('pipelineRuns').get(scope.runId) as Record<string, unknown>
    const pairs = (run.organization as Record<string, unknown>).pairChecks as Record<string, unknown>[]
    const pairOf = (targetId: string) => pairs.find(row => row.pairKey === pairKeyOf(sourceId, targetId))!
    expect(pairOf('C1-P037')).toMatchObject({ outcome: 'changed', reason: '原文支持', commitIds: [(result as { commitId: string }).commitId], evidenceStatus: 'verified' })
    expect(pairOf('C4-P011')).toMatchObject({ outcome: 'uncertain', reason: '实质关系修改未提供可核实证据，需复核：同义去重', commitIds: [(result as { commitId: string }).commitId] })
    expect(pairOf('C4-P011').evidenceStatus).toBe('unverified')
    expect(pairOf('C2-P029')).toMatchObject({ outcome: 'uncertain', reason: '证据不足，待核对', commitIds: [] })
    expect(pairOf('C3-P021')).toMatchObject({ outcome: 'no_change', reason: '本次未提交修改，未逐对确认。', commitIds: [], basis: [] })
    expect(pairs.filter(row => row.reason === '整批测试提交')).toHaveLength(0)
  })

  it('多批修改时每个 pairCheck 只引用该人物对的实际确认', async () => {
    const { db, repo } = await setup()
    const first = await submit(repo, [{ targetId: 'C1-P037', action: 'set', forwardLabels: ['上官'], reverseLabels: ['下属'], reason: '第一批修改', evidence: ev(quote.caiquan) }], { done: false })
    const second = await submit(repo, [{ targetId: 'C4-P011', action: 'set', forwardLabels: ['主子'], reverseLabels: ['丫鬟'], reason: '第二批去重' }], { done: true })
    const firstId = (first as { commitId: string }).commitId, secondId = (second as { commitId: string }).commitId
    expect(firstId).not.toBe(secondId)
    const run = await db.table('pipelineRuns').get(scope.runId) as Record<string, unknown>
    const pairs = (run.organization as Record<string, unknown>).pairChecks as Record<string, unknown>[]
    const pairOf = (targetId: string) => pairs.find(row => row.pairKey === pairKeyOf(sourceId, targetId))!
    expect(pairOf('C1-P037')).toMatchObject({ outcome: 'changed', reason: '第一批修改', commitIds: [firstId] })
    expect(pairOf('C4-P011')).toMatchObject({ outcome: 'uncertain', reason: '实质关系修改未提供可核实证据，需复核：第二批去重', commitIds: [secondId] })
  })

  it('先前批次标记的待核对人物对在完成时保留原因', async () => {
    const { db, repo } = await setup()
    await submit(repo, [], { done: false, uncertainPairs: [{ targetId: 'C2-P029', reason: '前一批证据不足' }] })
    const result = await submit(repo, [], { done: true, reason: '其余关系本次不改' })
    expect(result).toMatchObject({ outcome: 'uncertain', applied: [] })
    const run = await db.table('pipelineRuns').get(scope.runId) as Record<string, unknown>
    const pair = ((run.organization as Record<string, unknown>).pairChecks as Record<string, unknown>[]).find(row => row.pairKey === pairKeyOf(sourceId, 'C2-P029'))!
    expect(pair).toMatchObject({ outcome: 'uncertain', reason: '前一批证据不足', commitIds: [] })
  })

  it('逐对登记过的明确无变化保留原因和依据，不被默认 no_change 覆盖', async () => {
    const { db, repo } = await setup()
    const key = pairKeyOf(sourceId, 'C3-P021')
    const basis = [{ summary: '双方资料与当前关系相符', source: { kind: 'relation', fromId: sourceId, toId: 'C3-P021' } }]
    const current = await db.table('pipelineRuns').get(scope.runId) as Record<string, unknown>
    const organization = current.organization as Record<string, unknown>
    organization.pairChecks = [{ pairKey: key, fingerprint: 'known', outcome: 'no_change', reason: '双方资料与当前关系相符', basis, commitIds: [] }]
    await db.table('pipelineRuns').put({ ...current, organization })
    await submit(repo, [], { done: true, reason: '本次不改' })
    const run = await db.table('pipelineRuns').get(scope.runId) as Record<string, unknown>
    const pair = ((run.organization as Record<string, unknown>).pairChecks as Record<string, unknown>[]).find(row => row.pairKey === key)!
    expect(pair).toMatchObject({ outcome: 'no_change', reason: '双方资料与当前关系相符', basis })
  })

  it('单人物运行保留其他人物的历史 pairChecks，报告只展示当前人物', async () => {
    const { db, repo } = await setup()
    const unrelated = pairKeyOf('C1-P037', 'C8-P014')
    const current = await db.table('pipelineRuns').get(scope.runId) as Record<string, unknown>
    const organization = current.organization as Record<string, unknown>
    organization.mode = 'relations'; organization.targetCharacterId = sourceId; organization.reviewVersion = 2
    organization.pairChecks = [{ pairKey: unrelated, fingerprint: 'other', outcome: null, reason: '其他人物的未完成历史', basis: [], commitIds: [] }]
    await db.table('pipelineRuns').put({ ...current, organization })
    await repo.transaction(true, async store => {
      const run = (await store.get('pipelineRuns', scope.runId))!
      const state = run.organization as Record<string, unknown>
      await refreshReview(store, state)
      await store.put('pipelineRuns', { ...run, organization: state })
    })
    const run = await db.table('pipelineRuns').get(scope.runId) as Record<string, unknown>
    const pairs = (run.organization as Record<string, unknown>).pairChecks as Record<string, unknown>[]
    expect(pairs.find(row => row.pairKey === unrelated)).toMatchObject({ outcome: null, reason: '其他人物的未完成历史' })
    expect(pairs.filter(row => (JSON.parse(String(row.pairKey)) as string[]).includes(sourceId))).toHaveLength(14)
    expect(visiblePairChecks(run.organization as unknown as OrganizationState)).toHaveLength(14)
    expect(pendingPairChecks(run.organization as Record<string, unknown>)).toHaveLength(14)
  })

  it('批量结构性错误隔离失败项，合法项仍写入', async () => {
    const { db, repo } = await setup()
    const result = await submit(repo, [
      { targetId: 'C3-P021', action: 'set', forwardLabels: ['族中晚辈'], reverseLabels: ['族中长辈'], reason: '合法去重' },
      { targetId: 'C1-P037', action: 'delete', reason: '无依据删除' },
      { targetId: 'C1-P999', action: 'set', forwardLabels: ['朋友'], reverseLabels: ['朋友'], reason: '不存在' },
    ])
    expect(result).toMatchObject({ changed: true, done: false })
    expect((result as unknown as { failed?: { targetId: string; code: string }[] }).failed?.map(item => ({ targetId: item.targetId, code: item.code }))).toEqual(expect.arrayContaining([
      { targetId: 'C1-P037', code: 'INVALID_ARGS' },
      { targetId: 'C1-P999', code: 'NOT_FOUND' },
    ]))
    expect((await db.table('characterRelationEdits').get(pairKeyOf(sourceId, 'C3-P021')) as { aToBLabels: string[] }).aToBLabels).toEqual(['族中晚辈'])
  })

  it('实质修改的无效证据保存为 unverified，不拒绝保存', async () => {
    const { db, repo } = await setup()
    const result = await submit(repo, [{ targetId: 'C2-P029', action: 'set', forwardLabels: ['主子'], reverseLabels: ['学生'], reason: '无效证据', evidence: ev('不存在的引文') }])
    expect(result).toMatchObject({ changed: true, outcome: 'uncertain' })
    expect(await db.table('characterRelationEdits').get(pairKeyOf(sourceId, 'C2-P029'))).toMatchObject({ evidenceStatus: 'unverified' })
  })

  it('多证据逐条记录 verified/unverified，整体为 partial', async () => {
    const { db, repo } = await setup()
    const result = await submit(repo, [{
      targetId: 'C1-P037', action: 'set', forwardLabels: ['上官', '朋友'], reverseLabels: ['下属', '朋友'], reason: '两条证据一真一假',
      evidence: [...ev(quote.caiquan), ...ev('不存在的引文')],
    }])
    expect(result).toMatchObject({ changed: true, outcome: 'uncertain' })
    const edit = await db.table('characterRelationEdits').get(pairKeyOf(sourceId, 'C1-P037')) as { evidenceStatus?: string; evidence?: { verified?: boolean; reason?: string }[] }
    expect(edit.evidenceStatus).toBe('partial')
    expect(edit.evidence?.map(item => item.verified)).toEqual([true, false])
    expect(edit.evidence?.[1]?.reason).toContain('逐字')
  })

  it('真实版本冲突仍被拒绝', async () => {
    const { repo } = await setup()
    await expect(repo.transaction(true, store => saveCharacterPair(store, {
      bookId: 'a', fromId: sourceId, toId: 'C1-P037', forwardLabels: ['朋友'], reverseLabels: ['朋友'], reason: '旧版本',
      expectedFingerprint: 'stale', actor: 'agent', commitId: 'conflict-test', tool: 'test',
    }))).rejects.toThrow('CONFLICT')
  })

  it('单人物 pairChecks 只包含当前人物相关关系对（本样本 14 对）', async () => {
    const { db, repo } = await setup()
    await submit(repo, [{ targetId: 'C4-P011', action: 'set', forwardLabels: ['主子'], reverseLabels: ['丫鬟'], reason: '同义去重' }])
    const run = await db.table('pipelineRuns').get(scope.runId) as Record<string, unknown>
    const pairs = (run.organization as Record<string, unknown>).pairChecks as { pairKey: string }[]
    expect(pairs).toHaveLength(14)
    expect(pairs.every(pair => (JSON.parse(pair.pairKey) as string[]).includes(sourceId))).toBe(true)
  })

  it('空 changes done=true 不把累计修改误报为本次 applied', async () => {
    const { db, repo } = await setup()
    const first = await submit(repo, [{ targetId: 'C4-P011', action: 'set', forwardLabels: ['主子'], reverseLabels: ['丫鬟'], reason: '同义去重' }], { done: false })
    expect(first).toMatchObject({ changed: true, applied: ['C4-P011'] })
    const before = await db.table('characterRelationEdits').get(pairKeyOf(sourceId, 'C4-P011')) as { revision: number }
    const second = await submit(repo, [], { done: true })
    const after = await db.table('characterRelationEdits').get(pairKeyOf(sourceId, 'C4-P011')) as { revision: number }
    expect(second).toMatchObject({ changed: false, applied: [], done: true, cumulativeApplied: ['C4-P011'] })
    expect(after.revision).toBe(before.revision)
  })

  it('相同 operationKey 重试返回 alreadyApplied，不重复写库', async () => {
    const { db, repo } = await setup()
    const args = { operationKey: 'idem-key', done: true, reason: '幂等测试', changes: [{ targetId: 'C4-P011', action: 'set', forwardLabels: ['主子'], reverseLabels: ['丫鬟'], reason: '同义去重' }] }
    const set = { records: [], queries: [] }
    const first = await commitCommand(repo, scope, 'submit_relation_review', 'call-1', args, set)
    const before = await db.table('characterRelationEdits').get(pairKeyOf(sourceId, 'C4-P011')) as { revision: number }
    const second = await commitCommand(repo, scope, 'submit_relation_review', 'call-2', args, set)
    const after = await db.table('characterRelationEdits').get(pairKeyOf(sourceId, 'C4-P011')) as { revision: number }
    expect(first).toMatchObject({ ok: true, alreadyApplied: false })
    expect(second).toMatchObject({ ok: true, alreadyApplied: true, operationKey: 'idem-key' })
    expect(after.revision).toBe(before.revision)
  })

  it('不同 payload 重复同一错误会标记 repeated 并跳过', async () => {
    const { repo } = await setup()
    const first = await submit(repo, [{ targetId: 'C1-P037', action: 'delete', reason: '无依据删除' }])
    expect((first as unknown as { failed: { targetId: string; code: string; repeated: boolean }[] }).failed[0]).toMatchObject({ targetId: 'C1-P037', code: 'INVALID_ARGS', repeated: false })
    const second = await submit(repo, [{ targetId: 'C1-P037', action: 'delete', reason: '换个理由仍然无依据' }])
    expect(second).toMatchObject({ changed: false, done: false })
    expect((second as unknown as { failed: { targetId: string; code: string; repeated: boolean }[] }).failed[0]).toMatchObject({ targetId: 'C1-P037', code: 'INVALID_ARGS', repeated: true })
  })

  it('NOT_FOUND 目标补齐并重新读取后可成功提交', async () => {
    const { db, repo } = await setup()
    const missing = await submit(repo, [{ targetId: 'C1-P999', action: 'set', forwardLabels: ['朋友'], reverseLabels: ['朋友'], reason: '目标尚未建立' }])
    expect((missing as unknown as { failed: { targetId: string; code: string; repeated: boolean }[] }).failed[0]).toMatchObject({ targetId: 'C1-P999', code: 'NOT_FOUND', repeated: false })
    await db.table('characters').put(person('C1-P999', '新目标'))
    const reread = { ...readChapter, queries: [...readChapter.queries, { tool: 'get_character_detail', args: { ids: ['C1-P999'] }, resultFingerprint: 'fixture' }] }
    const recovered = await submit(repo, [{ targetId: 'C1-P999', action: 'set', forwardLabels: ['朋友'], reverseLabels: ['朋友'], reason: '目标已补齐' }], {}, reread)
    expect(recovered).toMatchObject({ changed: true, done: true, complete: true })
  })
})
