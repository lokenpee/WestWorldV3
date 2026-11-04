import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createAssetService } from '../src/features/assets/service'
import { createWorldService } from '../src/features/world/service'
import type { ModelService } from '../src/features/models/service'
import type { WorldKind } from '../src/features/assets/merge'
import { emptyTables, tableNames, validateBookData } from '../src/features/backup/data'
import { createImportService } from '../src/lib/storage/importService'
import { createBackupService } from '../src/features/backup/service'
import { liveQuery } from 'dexie'
import { aliasScore, findCandidates, findExactNameGroups } from '../src/features/world/candidates'
import { characterMatchNames } from '../src/features/assets/characterNames'
import { repairAutomaticProtection } from '../src/features/world/protection'
import { emptyReport } from '../src/features/world/types'
import { createBookAgentRepository } from '../src/features/agents/repository'
import { createAgentTools } from '../src/features/agents/tools'
import { commitCommand } from '../src/features/agents/commands'

const opened: ReturnType<typeof createWorkspace>[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const workspace of opened.splice(0)) { workspace.close(); for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name) } })
async function setup() {
  const key = crypto.randomUUID(), workspace = createWorkspace({ settingsName: `mechanical-${key}`, bookPrefix: `mechanical-${key}-book-` }); opened.push(workspace)
  const book = { id: 'a', title: '机械合并样本', sourceFileName: 'a.txt', createdAt: new Date().toISOString() }
  await workspace.settings.books.put(book)
  const db = workspace.openBook('a')
  for (const [index, text] of ['沈青在客栈遇到顾衡。陆川是药师。', '沈青接过顾衡的信。陆川是镖师。'].entries()) {
    const chapterIndex = String(index + 1)
    await db.chapters.put({ bookId: 'a', chapterIndex, chapterName: `第${chapterIndex}章`, order: index, charCount: text.length })
    await db.table('chapterTexts').put({ bookId: 'a', chapterIndex, text })
    await db.table('extractionReceipts').bulkPut(['worldAssets', 'narrativeAssets'].map(substep => ({ key: `${chapterIndex}:${substep}`, bookId: 'a', chapterIndex, substep, inputFingerprint: 'fixture', originIds: [], committedAt: book.createdAt, runId: 'p1-fixture' })))
  }
  await db.table('characters').bulkPut(['沈青', '顾衡', '陆川'].flatMap((name, index) => [1, 2].map(number => ({ id: `${['A', 'B', 'C'][index]}${number}`, bookId: 'a', name, identity: index === 2 ? number === 1 ? '药师' : '镖师' : '原文人物', chapterIndex: String(number), chapterName: `第${number}章`, sourceChapters: [String(number)], revision: 1, confidence: 1, createdBy: 'P1' }))))
  await db.table('locations').bulkPut([1, 2].map(number => ({ id: `L${number}`, bookId: 'a', name: '客栈', description: '镇上的客栈', chapterIndex: String(number), chapterName: `第${number}章`, sourceChapters: [String(number)], revision: 1, confidence: 1, createdBy: 'P1' })))
  await db.table('nodes').put({ id: 'N1', bookId: 'a', name: '交信', summary: '沈青接信', chapterIndex: '1', chapterName: '第1章', actors: ['沈青', '顾衡'], actorIds: ['A2', 'B2'], quote: '', order: 0, revision: 1, confidence: 1, createdBy: 'P1' })
  const assets = createAssetService(workspace), generate = vi.fn(), agent = vi.fn()
  const models = { generate, agent, settings: {} } as unknown as Pick<ModelService, 'generate' | 'agent' | 'settings'>
  const service = createWorldService(workspace, models, assets)
  async function add(memberIds: string[], kind: WorldKind = 'character', keepId = memberIds[0]) {
    const rows = await db.table(kind === 'character' ? 'characters' : 'locations').bulkGet(memberIds)
    const request = (await assets.previewMerge('a', kind, { memberIds, keepId, canonicalName: rows[0]!.name })).request
    return service.mechanical.add('a', kind, request)
  }
  async function validate() {
    const tables = emptyTables(); for (const name of tableNames) tables[name] = await db.table(name).toArray()
    expect(await validateBookData({ book, tables })).toEqual([])
  }
  return { workspace, book, db, assets, models, service, add, validate, generate, agent }
}

it('自动同名融合保持自动来源，两份融合结果仍可按原文进行AI异名合并', async () => {
  const { workspace, db, service } = await setup()
  await service.organize('a')
  for (const row of await db.table('characters').toArray()) expect(row).toMatchObject({ nameSource: 'automatic', manualKeep: false })
  const original = '沈青又名顾衡，是同一人。'
  await db.table('chapterTexts').update('1', { text: original })
  const scope = { bookId: 'a', profile: 'asset_editor' as const, phase: 'ai_identity', runId: 'ai-run', taskId: 'ai-task', owner: 'ai-owner', workItemIds: [] }
  await db.table('pipelineRuns').bulkPut([{ id: scope.runId, bookId: 'a', tasks: [{ taskId: scope.taskId, appliedCommitIds: [], readSet: { records: [], queries: [] } }], commandIntents: [], appliedCommands: [], report: emptyReport({ characters: 3, locations: 1 }) }, { id: 'lease:world', bookId: 'a', owner: scope.owner, runId: scope.runId, expiresAt: Date.now() + 30000 }])
  const repo = createBookAgentRepository(workspace, 'a'), adapter = createAgentTools(repo, scope)
  await adapter.tools.find(tool => tool.name === 'get_character_detail')!.execute('details', { ids: ['A1', 'B1'] })
  await adapter.tools.find(tool => tool.name === 'read_original')!.execute('original', { chapter_indices: ['1'] })
  await expect(commitCommand(repo, scope, 'commit_asset_changes', 'merge', { operationKey: 'merge-auto', payload: { groups: [{ kind: 'character', keepId: 'A1', memberIds: ['A1', 'B1'], canonicalName: '沈青', confidence: 1, reason: '原文明示异名同人', evidence: [{ chapterIndex: '1', quote: original, memberIds: ['A1', 'B1'] }] }] } }, adapter.reads)).resolves.toMatchObject({ ok: true })
  expect(await db.table('characters').get('A1')).toMatchObject({ nameSource: 'automatic', manualKeep: false, verifiedAliases: ['顾衡'] })
})

it('旧人工保护标记只按完整自动提交记录纠正，人工操作及后续修改继续保留', async () => {
  const { workspace, db, service, validate } = await setup()
  await service.organize('a')
  for (const id of ['A1', 'B1', 'C1']) await db.table('characters').update(id, { nameSource: 'manual', manualKeep: true })
  for (const run of await db.table('pipelineRuns').where('stage').equals('P2').toArray()) if (run.mechanicalQueue) await db.table('pipelineRuns').put({ ...run, mechanicalQueue: { ...run.mechanicalQueue, items: run.mechanicalQueue.items.map(({ protectionVersion: _version, ...item }: import('../src/features/world/types').MechanicalQueueItem) => item) } })
  const runs = await db.table('pipelineRuns').where('stage').equals('manual_merge').toArray()
  const manual = runs.find(run => run.report.groups[0].keepId === 'B1')!
  await db.table('pipelineRuns').put({ ...manual, id: 'real-manual-decision' })
  await db.table('characters').update('C1', { updatedAt: '2099-01-01T00:00:00.000Z', identity: '后续人工修改' })
  const runId = 'repair-run', owner = 'repair-owner', now = new Date().toISOString()
  await db.table('pipelineRuns').bulkPut([{ id: runId, bookId: 'a', recordType: 'run', stage: 'P2', phase: 'ai_identity', status: 'running', startedAt: now, planVersion: '2.2', report: emptyReport({ characters: 3, locations: 1 }) }, { id: 'lease:world', recordType: 'lease', bookId: 'a', lockKey: 'world', runId, owner, expiresAt: Date.now() + 30000 }])
  const repaired = await repairAutomaticProtection(workspace, 'a', runId, owner)
  expect(repaired.map(row => row.id)).toEqual(['A1'])
  expect(await db.table('characters').get('A1')).toMatchObject({ nameSource: 'automatic', manualKeep: false })
  expect(await db.table('characters').get('B1')).toMatchObject({ nameSource: 'manual', manualKeep: true })
  expect(await db.table('characters').get('C1')).toMatchObject({ nameSource: 'manual', manualKeep: true, identity: '后续人工修改' })
  await db.table('pipelineRuns').delete('lease:world')
  await validate()
})

it('只合并人工确认的组，逐组原子保存来源与人物关联，全书统计只读取一轮原文', async () => {
  const { service, assets, db, add, validate, generate, agent } = await setup()
  await service.scan('a')
  expect((await service.mechanical.read('a')).items).toEqual([])
  await add(['A1', 'A2']); await add(['B1', 'B2']); await add(['L1', 'L2'], 'location')
  await validate()
  const reads = vi.spyOn(db.table('chapterTexts'), 'get'), fullReads = vi.spyOn(db.table('chapterTexts'), 'toArray'), runScans = vi.spyOn(db.table('pipelineRuns'), 'toArray')
  await service.mechanical.start('a')
  const queue = await service.mechanical.read('a')
  expect(queue).toMatchObject({ pending: 0, completed: 3, failed: 0, statisticsPending: false, run: { status: 'completed', report: { groups: expect.any(Array), usage: { totalTokens: 0 } } } })
  expect(queue.run?.report.groups).toHaveLength(3)
  expect(await db.table('characters').count()).toBe(4)
  expect(await db.table('locations').count()).toBe(1)
  expect(await db.table('characters').get('C1')).toMatchObject({ identity: '药师' })
  expect(await db.table('characters').get('C2')).toMatchObject({ identity: '镖师' })
  expect(await db.table('nodes').get('N1')).toMatchObject({ actorIds: ['A1', 'B1'] })
  expect(await db.table('assetLifecycle').get('character:A2')).toMatchObject({ state: 'merged', currentId: 'A1' })
  expect((await assets.read('a')).manualMerges).toHaveLength(3)
  expect(reads).toHaveBeenCalledTimes(2); expect(fullReads).not.toHaveBeenCalled()
  expect(runScans).not.toHaveBeenCalled()
  expect(generate).not.toHaveBeenCalled(); expect(agent).not.toHaveBeenCalled()
  expect(await db.table('pipelineRuns').get('lease:world')).toBeUndefined()
  await validate()
})

it('当前组保存后停止，刷新服务后继续，统计引起的修订变化保留已确认待办', async () => {
  const { workspace, service, models, assets, db, add, validate } = await setup()
  await add(['A1', 'A2']); await add(['B1', 'B2'])
  const original = assets.confirmMerge.bind(assets)
  let enter: () => void = () => undefined, release: () => void = () => undefined
  const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const spy = vi.spyOn(assets, 'confirmMerge').mockImplementationOnce(async (...args) => { enter(); await gate; return original(...args) })
  const running = service.mechanical.start('a'); await entered
  await expect(assets.update('a', 'character', 'C1', 1, { identity: '不应写入' })).rejects.toMatchObject({ code: 'ASSET_DOMAIN_LOCKED' })
  await expect(createWorldService(workspace, models, assets).mechanical.start('a')).rejects.toMatchObject({ code: 'ASSET_DOMAIN_LOCKED' })
  await service.mechanical.stop('a'); release(); await running
  expect(await service.mechanical.read('a')).toMatchObject({ completed: 1, pending: 1, run: { status: 'paused' } })
  expect((await db.table('characters').get('B1')).revision).toBeGreaterThan(1)
  await createWorldService(workspace, models, assets).mechanical.start('a')
  expect(await service.mechanical.read('a')).toMatchObject({ completed: 2, pending: 0, failed: 0 })
  expect(spy).toHaveBeenCalledTimes(2)
  await validate()
})

it('同组重复加入更新确认，重叠组拒绝，内容变化的一组失败后继续其他组', async () => {
  const { service, assets, db, add, validate } = await setup()
  const first = await add(['A1', 'A2'])
  expect((await add(['A1', 'A2'])).id).toBe(first.id)
  await expect(add(['A1', 'A2', 'B1'])).rejects.toThrow('部分成员已在待合并队列')
  await add(['B1', 'B2'])
  await assets.update('a', 'character', 'A1', 1, { identity: '人工新增身份' })
  await service.mechanical.start('a')
  expect(await service.mechanical.read('a')).toMatchObject({ completed: 1, failed: 1, pending: 0, run: { status: 'degraded' } })
  expect(await db.table('characters').get('A2')).toBeDefined()
  expect(await db.table('characters').get('B2')).toBeUndefined()
  await add(['A1', 'A2'])
  await service.mechanical.start('a')
  expect(await service.mechanical.read('a')).toMatchObject({ completed: 2, failed: 0, pending: 0, run: { status: 'completed', report: { failed: [] } } })
  expect(await db.table('characters').get('A1')).toMatchObject({ identity: expect.stringContaining('人工新增身份') })
  await validate()
})

it('资产与队列确认同事务，日志失败整体回滚，提交成功后反馈丢失不重复合并', async () => {
  const { service, assets, db, add, validate } = await setup()
  await add(['A1', 'A2']); await add(['B1', 'B2'])
  let fail = true
  const hook = (_key: unknown, row: { stage?: string }) => { if (fail && row.stage === 'manual_merge') { fail = false; throw new Error('模拟日志写入失败') } }
  db.table('pipelineRuns').hook('creating', hook)
  await service.mechanical.start('a')
  expect(await db.table('characters').count()).toBe(6)
  expect((await service.mechanical.read('a')).completed).toBe(0)
  db.table('pipelineRuns').hook('creating').unsubscribe(hook)
  const original = assets.confirmMerge.bind(assets)
  vi.spyOn(assets, 'confirmMerge').mockImplementationOnce(async (...args) => { const result = await original(...args); expect(result.asset.id).toBe('A1'); throw new Error('模拟提交反馈丢失') })
  await service.mechanical.start('a')
  expect(await service.mechanical.read('a')).toMatchObject({ completed: 1, pending: 1 })
  await service.mechanical.start('a')
  expect(await service.mechanical.read('a')).toMatchObject({ completed: 2, failed: 0, pending: 0 })
  expect((await assets.read('a')).manualMerges).toHaveLength(2)
  await validate()
})

it('执行权变化时旧队列不写资产，也不释放新执行者的锁', async () => {
  const { service, assets, db, add } = await setup()
  await add(['A1', 'A2'])
  const original = assets.confirmMerge.bind(assets)
  vi.spyOn(assets, 'confirmMerge').mockImplementationOnce(async (...args) => {
    await db.table('pipelineRuns').update('lease:world', { owner: 'new-owner', runId: 'new-run' })
    return original(...args)
  })
  await service.mechanical.start('a')
  expect(await db.table('characters').count()).toBe(6)
  expect(await db.table('pipelineRuns').get('lease:world')).toMatchObject({ owner: 'new-owner', runId: 'new-run' })
  expect((await service.mechanical.read('a')).completed).toBe(0)
})

it('部分完成队列备份恢复保留成功项与确认依据，副本继续且不改变原书', async () => {
  const { workspace, service, assets, models, db, add, validate } = await setup()
  await add(['A1', 'A2']); await add(['B1', 'B2'])
  const original = assets.confirmMerge.bind(assets)
  vi.spyOn(assets, 'confirmMerge').mockImplementationOnce(async (...args) => { const result = await original(...args); await service.mechanical.stop('a'); return result })
  await service.mechanical.start('a'); await validate()
  const importer = createImportService(workspace), backups = createBackupService(workspace, importer)
  try {
    const exported = await backups.exportBook('a')
    expect((await backups.inspectBackup(exported.bytes)).ok).toBe(true)
    const copy = await backups.importBackup(exported.bytes), restored = createWorldService(workspace, models, assets)
    expect(await restored.mechanical.read(copy.id)).toMatchObject({ completed: 1, pending: 1 })
    await restored.mechanical.start(copy.id)
    expect(await restored.mechanical.read(copy.id)).toMatchObject({ completed: 2, pending: 0, failed: 0 })
    expect(await workspace.openBook(copy.id).table('characters').count()).toBe(4)
    expect(await db.table('characters').count()).toBe(5)
    expect((await backups.inspectBackup((await backups.exportBook(copy.id)).bytes)).ok).toBe(true)
  } finally { importer.close() }
})

it('可移除未执行项，完成后新增确认创建新队列，已合并项保持可追溯', async () => {
  const { service, db, add, validate } = await setup()
  const a = await add(['A1', 'A2']); const b = await add(['B1', 'B2'])
  await service.mechanical.remove('a', b.id)
  await service.mechanical.start('a')
  await expect(service.mechanical.remove('a', a.id)).rejects.toThrow('已经合并')
  await add(['B1', 'B2']); await service.mechanical.start('a')
  const rounds = (await db.table('pipelineRuns').toArray()).filter(run => run.phase === 'mechanical_queue')
  expect(rounds).toHaveLength(2)
  expect(rounds.filter(run => run.mechanicalQueue.current)).toHaveLength(1)
  expect(rounds.reduce((sum, run) => sum + run.report.groups.length, 0)).toBe(2)
  await validate()
})

it('统计失败保留收尾待办，再次运行只补统计而不重复合并', async () => {
  const { service, assets, db, add, validate } = await setup()
  await add(['A1', 'A2'])
  const merge = vi.spyOn(assets, 'confirmMerge')
  let once = true
  db.table('characters').hook('updating', modifications => { if (once && Object.keys(modifications).some(key => key.startsWith('frequency'))) { once = false; throw new Error('模拟统计保存失败') } })
  await service.mechanical.start('a')
  expect(await service.mechanical.read('a')).toMatchObject({ completed: 1, pending: 0, statisticsPending: true, run: { status: 'paused' } })
  await validate()
  await service.mechanical.start('a')
  expect(await service.mechanical.read('a')).toMatchObject({ completed: 1, pending: 0, statisticsPending: false, run: { status: 'completed' } })
  expect(merge).toHaveBeenCalledOnce()
  await validate()
})

it('运行中导出的副本续接未完成组，源队列保持独立', async () => {
  const { workspace, service, assets, models, db, add } = await setup()
  await add(['A1', 'A2']); await add(['B1', 'B2'])
  const original = assets.confirmMerge.bind(assets)
  let calls = 0, enter: () => void = () => undefined, release: () => void = () => undefined
  const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(assets, 'confirmMerge').mockImplementation(async (...args) => { if (args[0] === 'a' && ++calls === 2) { enter(); await gate }; return original(...args) })
  const running = service.mechanical.start('a'); await entered
  const importer = createImportService(workspace), backups = createBackupService(workspace, importer)
  try {
    const copy = await backups.importBackup((await backups.exportBook('a')).bytes)
    const restored = createWorldService(workspace, models, assets)
    expect(await restored.mechanical.read(copy.id)).toMatchObject({ completed: 1, pending: 1, statisticsPending: true })
    await restored.mechanical.start(copy.id)
    expect(await restored.mechanical.read(copy.id)).toMatchObject({ completed: 2, pending: 0, failed: 0 })
    expect(await db.table('characters').count()).toBe(5)
    expect(await workspace.openBook(copy.id).table('characters').count()).toBe(4)
  } finally { release(); await running; importer.close() }
})

it('恢复副本保留已经失效的人工确认，不把旧确认套用到变化后的成员', async () => {
  const { workspace, assets, models, db, add } = await setup()
  await add(['A1', 'A2']); await add(['B1', 'B2'])
  await assets.update('a', 'character', 'A1', 1, { identity: '确认后发生变化' })
  const importer = createImportService(workspace), backups = createBackupService(workspace, importer)
  try {
    const copy = await backups.importBackup((await backups.exportBook('a')).bytes)
    const restored = createWorldService(workspace, models, assets)
    await restored.mechanical.start(copy.id)
    expect(await restored.mechanical.read(copy.id)).toMatchObject({ completed: 1, failed: 1, pending: 0 })
    expect(await workspace.openBook(copy.id).table('characters').get('A2')).toBeDefined()
    expect(await db.table('characters').count()).toBe(6)
  } finally { importer.close() }
})

it('代码整理每次保存候选摘要报告并更新报告编号', async () => {
  const { service, db } = await setup()
  await db.table('characters').bulkPut([{ id: 'D1', bookId: 'a', name: '张三', identity: '', revision: 1, confidence: 1, createdBy: 'P1' }, { id: 'D2', bookId: 'a', name: '张三丰', identity: '', revision: 1, confidence: 1, createdBy: 'P1' }])
  await service.organize('a')
  const scans = (await service.reports('a')).filter(run => run.phase === 'mechanical')
  expect(scans).toHaveLength(1)
  expect(scans[0].report.skipped.join('\n')).toContain('人物候选：张三（D1）、张三丰（D2）')
  expect(scans[0].report.skipped.join('\n')).toContain('主名包含')
  expect(service.state('a')?.reportId).toBe(scans[0].id)
  await service.organize('a')
  expect((await service.reports('a')).filter(run => run.phase === 'mechanical')).toHaveLength(2)
})

it('代码整理自动处理所有完整同名组，名称不同仍留候选，自动规则有记录且不调用模型', async () => {
  const { service, db, validate, agent, generate } = await setup()
  await db.table('characters').bulkPut([{ id: 'D1', bookId: 'a', name: '张三', identity: '', revision: 1, confidence: 1, createdBy: 'P1' }, { id: 'D2', bookId: 'a', name: '张三丰', identity: '', revision: 1, confidence: 1, createdBy: 'P1' }])
  const result = await service.organize('a')
  expect(result).toMatchObject({ merged: 4, failed: 0 })
  expect(await db.table('characters').count()).toBe(5)
  expect(await db.table('locations').count()).toBe(1)
  expect(await db.table('characters').get('C2')).toBeUndefined()
  expect(await db.table('characters').get('C1')).toMatchObject({ identity: expect.stringContaining('药师') })
  expect(result.candidates.some(row => row.memberIds.includes('D1') && row.memberIds.includes('D2'))).toBe(true)
  expect((await service.mechanical.read('a')).items.every(item => item.confirmation === 'exact_name')).toBe(true)
  expect(await service.organize('a')).toMatchObject({ merged: 0, failed: 0 })
  expect(agent).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled()
  await validate()
})

it('自动同名合并保留已选主名编号，并把已确认异名组留待一键执行', async () => {
  const { service, db, add, validate } = await setup()
  await add(['A1', 'A2'], 'character', 'A2')
  await add(['B1', 'C1'])
  expect(await service.organize('a')).toMatchObject({ merged: 2, failed: 0 })
  expect(await db.table('characters').get('A1')).toBeUndefined()
  expect(await db.table('characters').get('A2')).toBeDefined()
  const pending = await service.mechanical.read('a')
  expect(pending.pending).toBe(1)
  expect(pending.items.find(item => item.status === 'pending')?.request.memberIds).toEqual(['B1', 'C1'])
  expect(await db.table('characters').get('C1')).toBeDefined()
  await validate()
})

it('实时查询在完成后解除忙碌状态，遗留的完成任务锁可恢复清理', async () => {
  const { service, assets, db, add } = await setup()
  await add(['A1', 'A2'])
  let running: boolean | undefined
  const subscription = liveQuery(() => service.mechanical.read('a')).subscribe(value => { running = value.running })
  try {
    await service.mechanical.start('a')
    await vi.waitFor(() => expect(running).toBe(false))
    const run = (await service.mechanical.read('a')).run!
    await db.table('pipelineRuns').put({ id: 'lease:world', bookId: 'a', recordType: 'lease', lockKey: 'world', owner: 'orphan', runId: run.id, expiresAt: Date.now() + 60000 })
    expect((await service.mechanical.read('a')).running).toBe(false)
    await service.mechanical.recover('a')
    expect(await db.table('pipelineRuns').get('lease:world')).toBeUndefined()
    const row = await db.table('characters').get('A1')
    await expect(assets.update('a', 'character', 'A1', row.revision, { identity: '合并后可编辑' })).resolves.toBeDefined()
  } finally { subscription.unsubscribe() }
})

it('中断的运行队列过期后恢复为待办，统计分位排序与原定义一致', async () => {
  const { service, db, add } = await setup()
  await add(['A1', 'A2'])
  const run = (await service.mechanical.read('a')).run!
  await db.table('pipelineRuns').put({ ...run, status: 'running', mechanicalQueue: { ...run.mechanicalQueue!, items: run.mechanicalQueue!.items.map(item => ({ ...item, status: 'running' })) } })
  await db.table('pipelineRuns').put({ id: 'lease:world', bookId: 'a', recordType: 'lease', lockKey: 'world', owner: 'orphan', runId: run.id, expiresAt: 0 })
  await service.mechanical.recover('a')
  expect(await service.mechanical.read('a')).toMatchObject({ running: false, pending: 1, run: { status: 'paused' } })
  await service.mechanical.start('a')
  const rows = await db.table('characters').toArray()
  for (const row of rows) {
    const higher = rows.filter(other => other.frequency.chapters > row.frequency.chapters || other.frequency.chapters === row.frequency.chapters && other.frequency.mentions > row.frequency.mentions).length
    const same = rows.filter(other => other.frequency.chapters === row.frequency.chapters && other.frequency.mentions === row.frequency.mentions).length
    expect(row.frequency.percentile).toBe((higher + (same - 1) / 2) / Math.max(1, rows.length - 1))
  }
})

it('最多三组并行准备，资产提交保持单组顺序', async () => {
  const { service, assets, db, add } = await setup()
  await add(['A1', 'A2']); await add(['B1', 'B2']); await add(['C1', 'C2'])
  const actualGet = db.table('characters').bulkGet.bind(db.table('characters'))
  let entered = 0, ready: () => void = () => undefined, release: () => void = () => undefined
  const allReady = new Promise<void>(resolve => { ready = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(db.table('characters'), 'bulkGet').mockImplementation(keys => { if (++entered <= 3) { if (entered === 3) ready(); return Dexie.Promise.resolve(gate).then(() => actualGet(keys)) }; return actualGet(keys) })
  const actualMerge = assets.confirmMerge.bind(assets)
  let writes = 0, maximum = 0
  vi.spyOn(assets, 'confirmMerge').mockImplementation(async (...args) => { writes++; maximum = Math.max(maximum, writes); try { return await actualMerge(...args) } finally { writes-- } })
  const task = service.mechanical.start('a')
  await allReady; release(); await task
  expect(maximum).toBe(1)
  expect((await service.mechanical.read('a')).completed).toBe(3)
})

it('完整主名自动组不采用包含、别名或去后缀规则，别名剪枝保留原严格阈值', () => {
  const person = (id: string, name: string, aliases: string[] = []) => ({ id, bookId: 'a', name, aliases, confidence: 1, revision: 1, createdBy: 'P1' as const })
  expect(findExactNameGroups('character', [person('a', '张三'), person('b', '张三'), person('c', '张三丰'), person('d', '张三（修订版）'), person('e', '老张', ['张三'])])[0].memberIds).toEqual(['a', 'b'])
  for (let index = 0; index < 40; index++) {
    const left = person('a', `person-${index}-aaaaaaaaaa`, Array.from({ length: index % 7 }, (_, i) => `alias-${index}-${i}`))
    const right = person('b', `person-${index}-${index % 2 ? 'zzzzzzzzzz' : 'aaaaaaaaba'}`, Array.from({ length: index % 5 }, (_, i) => `alias-${index}-${i}`))
    if (aliasScore(characterMatchNames(left), characterMatchNames(right)) > 0.9) expect(findCandidates('character', [left, right]).length > 0).toBe(true)
  }
  expect(findCandidates('character', [person('x', '完全无关甲', ['别名一']), person('y', '另外一个乙', ['别名二'])]).length).toBe(0)
})

it('候选扫描仅读取人物地点，不读取节点或整张任务历史', async () => {
  const { service, db } = await setup()
  const nodes = vi.spyOn(db.table('nodes'), 'toArray'), history = vi.spyOn(db.table('pipelineRuns'), 'toArray')
  expect((await service.scan('a')).length).toBeGreaterThan(0)
  expect(nodes).not.toHaveBeenCalled(); expect(history).not.toHaveBeenCalled()
})
