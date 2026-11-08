import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { encodeBackup, inspectBackup } from '../src/features/backup/codec'
import { createModelService } from '../src/features/models/service'
import { createExtractionService } from '../src/features/extraction/service'
import { defaultConfig } from '../src/features/models/types'
import { emptyTables, tableNames, validateBookData, pauseBookData } from '../src/features/backup/data'

const workspaces: ReturnType<typeof createWorkspace>[] = []
const world = { characters: [{ name: '沈青', confidence: 1, profile: { ageText: null }, speech_style_sample: '你好' }, { name: '沈青', confidence: 0.5, identity: '送信人' }], locations: [{ name: '青石镇', confidence: 1 }] }
const narrative = { nodes: [{ name: '送信', summary: '沈青送信', actors: ['沈青'], quote: '沈青送信。', confidence: 1 }, { name: '回查', summary: '原文未定位', actors: [], quote: '未匹配片段', confidence: 0.5 }] }
function stream(value: unknown) {
  const frame = (delta: object, finish_reason: string | null) => ({ id: 'extraction', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason }] })
  const frames = [frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'submit', type: 'function', function: { name: 'submit_result', arguments: JSON.stringify(value) } }] }, null), frame({}, 'tool_calls')]
  return new Response(frames.map(row => `data: ${JSON.stringify(row)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
}
async function setup(fetcher: typeof fetch, count = 1) {
  const id = crypto.randomUUID(); const workspace = createWorkspace({ settingsName: `extract-${id}`, bookPrefix: `extract-${id}-book-` }); workspaces.push(workspace)
  const book = { id: 'a', title: '提取样本', sourceFileName: '样本.txt', createdAt: new Date().toISOString() }
  await workspace.settings.books.add(book)
  const db = workspace.openBook('a'); const text = '沈青送信。沈青说：“你好”。青石镇。'
  await db.chapters.bulkPut(Array.from({ length: count }, (_, order) => ({ bookId: 'a', chapterIndex: String(order + 1), chapterName: `第${order + 1}章`, order, charCount: text.length })))
  await db.table('chapterTexts').bulkPut(Array.from({ length: count }, (_, order) => ({ bookId: 'a', chapterIndex: String(order + 1), text })))
  await db.table('compileProgress').add({ bookId: 'a', stage: 'P1', status: 'idle', totalChapters: count, completedChapters: [], failedChapters: [], updatedAt: book.createdAt })
  const models = createModelService(workspace, { fetch: fetcher, wait: async (_ms, signal) => signal.throwIfAborted() })
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://extraction.invalid/v1', extractionModel: 'test' }, 'extraction-fake-key')
  return { book, workspace, db, models, service: createExtractionService(workspace, models) }
}
afterEach(async () => { for (const workspace of workspaces.splice(0)) { workspace.close(); for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name) } })

const dataFor = (init?: RequestInit) => JSON.parse(init?.body as string).tools[0].function.parameters.properties.characters ? world : narrative
function abortable(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) reject(signal.reason)
    else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

it('一起提取同时请求两类资产，各类章节顺序保存', async () => {
  let active = 0, peak = 0
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    peak = Math.max(peak, ++active)
    await new Promise(resolve => setTimeout(resolve, 20))
    active--
    return stream(dataFor(init))
  })
  const { service, db } = await setup(fetcher, 3)
  await service.startTogether('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect(peak).toBe(2)
  expect(fetcher).toHaveBeenCalledTimes(6)
  expect(await db.table('extractionReceipts').count()).toBe(6)
  expect((await service.progress('a'))?.status).toBe('completed')
  expect(await db.table('pipelineRuns').where('recordType').equals('lease').count()).toBe(0)
})

it('单章待提取入口只请求该章节该类型，成功可单独重提', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => stream(dataFor(init)))
  const { service, db } = await setup(fetcher, 3)
  await service.extractChapter('a', '2', 'worldAssets')
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect((await db.table('extractionReceipts').toArray()).map(row => row.key)).toEqual(['2:worldAssets'])
  const oldIds = (await db.table('characters').toArray()).map(row => row.id)
  await service.extractChapter('a', '2', 'worldAssets')
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect((await db.table('characters').toArray()).every(row => !oldIds.includes(row.id))).toBe(true)
  expect((await service.progress('a'))?.steps['1'].worldAssets.status).toBe('pending')
})

it('失败章节小按钮可重试，其他成功章节不重提', async () => {
  let fail = true
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => fail ? new Response('bad', { status: 401 }) : stream(dataFor(init)))
  const { service } = await setup(fetcher, 2)
  await service.extractChapter('a', '1', 'worldAssets')
  expect((await service.progress('a'))?.steps['1'].worldAssets.status).toBe('failed')
  fail = false
  await service.extractChapter('a', '1', 'worldAssets')
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect((await service.progress('a'))?.steps['1'].worldAssets.status).toBe('completed')
})

it('世界和叙事独立运行，暂停世界不影响叙事，继续不重复清空', async () => {
  let holdWorld = false
  let worldCalls = 0
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const data = dataFor(init)
    if (data === world && holdWorld && ++worldCalls === 2) return abortable(init?.signal)
    return stream(data)
  })
  const { service, db } = await setup(fetcher, 2)
  await service.startTogether('a')
  await service.cancelAll('a')
  holdWorld = true
  const worldRun = service.startLane('a', 'worldAssets', { replace: true })
  await vi.waitFor(() => expect(worldCalls).toBe(2))
  const savedIds = (await db.table('characters').toArray()).map(row => row.id)
  service.pauseLane('a', 'worldAssets')
  await worldRun
  expect((await service.progress('a'))?.extractionJobs.worldAssets?.status).toBe('paused')
  await service.startLane('a', 'narrativeAssets', { replace: true })
  expect((await service.progress('a'))?.extractionJobs.narrativeAssets?.status).toBe('completed')
  holdWorld = false
  await service.startLane('a', 'worldAssets', { resume: true })
  const ids = (await db.table('characters').toArray()).map(row => row.id)
  expect(savedIds.every(id => ids.includes(id))).toBe(true)
  expect((await service.progress('a'))?.status).toBe('completed')
})

it('取消保留成果并移除重提模式，一起提取仅补未完成步骤', async () => {
  let calls = 0, holding = true
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    if (++calls > 1 && holding) return abortable(init?.signal)
    return stream(dataFor(init))
  })
  const { service, db } = await setup(fetcher, 2)
  const run = service.startTogether('a')
  await vi.waitFor(async () => expect(await db.table('extractionReceipts').count()).toBe(1))
  await service.cancelAll('a'); await run
  expect((await service.progress('a'))?.extractionJobs).toEqual({})
  expect(await db.table('extractionReceipts').count()).toBe(1)
  const beforeCalls = calls
  holding = false
  await service.startTogether('a')
  expect(calls - beforeCalls).toBe(3)
  expect(await db.table('extractionReceipts').count()).toBe(4)
})

it('刷新恢复已中断任务时保留双类范围，不自动发请求', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => stream(dataFor(init)))
  const { service, db, workspace, models, book } = await setup(fetcher)
  const progress = await db.table('compileProgress').get('P1')
  await db.table('compileProgress').put({ ...progress, status: 'running', extractionJobs: { worldAssets: { step: 'worldAssets', scope: 'all', startedAt: book.createdAt, mode: 'replace', group: 'single', status: 'running', runId: 'lost' } } })
  await db.table('pipelineRuns').put({ id: 'lease:extraction:worldAssets', bookId: 'a', recordType: 'lease', extractionStep: 'worldAssets', lockKey: 'extraction', owner: 'lost', runId: 'lost', expiresAt: 0 })
  await createExtractionService(workspace, models).recover('a')
  expect(fetcher).not.toHaveBeenCalled()
  expect((await service.progress('a'))?.extractionJobs.worldAssets).toMatchObject({ status: 'paused', mode: 'replace', scope: 'all' })
})

it('双类状态及租约可通过备份校验，恢复后任务暂停', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => stream(dataFor(init)))
  const { service, db, book } = await setup(fetcher)
  await service.startTogether('a')
  const tables = emptyTables()
  for (const name of tableNames) tables[name] = await db.table(name).toArray()
  expect(await validateBookData({ book, tables })).toEqual([])
  const p1 = tables.compileProgress.find(row => row.stage === 'P1')!
  ;(p1.extractionJobs as Record<string, { status: string }>).worldAssets.status = 'running'
  p1.status = 'running'
  const paused = pauseBookData({ book, tables })
  expect((paused.tables.compileProgress.find(row => row.stage === 'P1')!.extractionJobs as Record<string, { status: string }>).worldAssets.status).toBe('paused')
  expect(await validateBookData(paused)).toEqual([])
})

it('重提前目标原文缺失仍保留旧资产', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => stream(dataFor(init)))
  const { service, db } = await setup(fetcher)
  await service.startTogether('a')
  const before = await db.table('characters').toArray()
  await db.table('chapterTexts').delete('1')
  expect((await service.previewLane('a', 'worldAssets')).blockers).toContain('第1章原文缺失或为空，无法重新提取。')
  await service.startLane('a', 'worldAssets', { replace: true })
  expect(await db.table('characters').toArray()).toEqual(before)
  expect(service.state('a')?.error).toContain('原文缺失')
})

it('轻量进度已有步骤摘要时不读取含原文的历史运行', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => stream(dataFor(init)))
  const { service, db } = await setup(fetcher)
  await service.startTogether('a')
  const table = db.table('pipelineRuns')
  const read = vi.spyOn(table, 'get')
  await service.progress('a')
  expect(read).not.toHaveBeenCalled()
})

it('世界任务失去执行权不写入晚到结果，叙事任务仍可完成', async () => {
  let requested = false, release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const data = dataFor(init)
    if (data === world) { requested = true; await gate }
    return stream(data)
  })
  const { service, db } = await setup(fetcher)
  const run = service.startTogether('a')
  await vi.waitFor(() => expect(requested).toBe(true))
  await db.table('pipelineRuns').update('lease:world', { owner: 'other' })
  release(); await run
  expect(await db.table('characters').count()).toBe(0)
  expect(await db.table('extractionReceipts').get('1:worldAssets')).toBeUndefined()
  expect(await db.table('extractionReceipts').get('1:narrativeAssets')).toBeDefined()
})

it('运行中备份排除执行权并保留可恢复的双类状态', async () => {
  let requested = 0
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => { requested++; return abortable(init?.signal) })
  const { service, db, book } = await setup(fetcher)
  const run = service.startTogether('a')
  await vi.waitFor(() => expect(requested).toBe(2))
  try {
    const tables = emptyTables()
    for (const name of tableNames) tables[name] = await db.table(name).toArray()
    const leases = tables.pipelineRuns.filter(row => row.recordType === 'lease')
    expect(leases).toHaveLength(4)
    expect(new Set(leases.map(row => row.lockKey)).size).toBe(4)
    const exported = await encodeBackup({ book, tables })
    expect(exported.processing).toBe(true)
    const restored = await inspectBackup(exported.bytes)
    expect(restored.errors).toEqual([])
    expect(restored.data?.tables.pipelineRuns.every(row => row.recordType !== 'lease')).toBe(true)
    const progress = restored.data?.tables.compileProgress.find(row => row.stage === 'P1')
    const jobs = progress?.extractionJobs as Record<string, { status: string }>
    expect(Object.values(jobs).every(job => job.status === 'paused')).toBe(true)
  } finally { await service.cancelAll('a'); await run }
})

it('不存在的单章编号不会启动整书或修改现有成果', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => stream(dataFor(init)))
  const { service, db } = await setup(fetcher)
  await service.extractChapter('a', '999', 'worldAssets')
  expect(service.state('a')?.error).toContain('章节或步骤不存在')
  expect(fetcher).not.toHaveBeenCalled()
  expect(await db.table('extractionReceipts').count()).toBe(0)
})

it('启动前读取仍未完成时取消，晚到读取不会重新启动任务', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => stream(dataFor(init)))
  const { service, db } = await setup(fetcher)
  const table = db.table('compileProgress')
  const progress = await table.get('P1')
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(table, 'get').mockReturnValueOnce(Dexie.Promise.resolve(gate).then(() => progress))
  const start = service.startTogether('a')
  await service.cancelAll('a')
  release(); await start
  expect(fetcher).not.toHaveBeenCalled()
  expect(await db.table('pipelineRuns').where('recordType').equals('lease').count()).toBe(0)
})

it('启动时进度读取失败会释放本地控制，修复后可重新启动', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => stream(dataFor(init)))
  const { service, db } = await setup(fetcher)
  vi.spyOn(db.table('compileProgress'), 'get').mockRejectedValueOnce(new Error('进度读取失败'))
  await service.start('a')
  expect(service.state('a')).toMatchObject({ running: false, error: '进度读取失败' })
  await service.startTogether('a')
  expect((await service.progress('a'))?.status).toBe('completed')
})

it('请求已全部保存但统计阶段暂停后，继续收尾不重复模型请求', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => stream(dataFor(init)))
  const { service } = await setup(fetcher)
  await service.extractChapter('a', '1', 'narrativeAssets')
  let paused = false
  const unsubscribe = service.subscribe(() => {
    if (!paused && service.laneState('a', 'worldAssets')?.chapter === '正在更新出场统计') {
      paused = true
      service.pauseTogether('a')
    }
  })
  await service.startTogether('a'); unsubscribe()
  expect(paused).toBe(true)
  expect((await service.progress('a'))?.extractionJobs.worldAssets?.status).toBe('paused')
  const requests = fetcher.mock.calls.length
  await service.startTogether('a')
  expect((await service.progress('a'))?.extractionJobs.worldAssets?.status).toBe('completed')
  expect(fetcher).toHaveBeenCalledTimes(requests)
})

it('世界保存及单章重提只读取下游运行，不扫描P1原文历史', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => stream(dataFor(init)))
  const { service, db } = await setup(fetcher)
  const table = db.table('pipelineRuns')
  await table.put({ id: 'history', bookId: 'a', recordType: 'run', stage: 'P1', status: 'completed', tasks: [{ input: { text: '原'.repeat(1000000) } }] })
  const readAll = vi.spyOn(table, 'toArray')
  await service.extractChapter('a', '1', 'worldAssets')
  await service.extractChapter('a', '1', 'worldAssets')
  expect(readAll).not.toHaveBeenCalled()
  expect(service.state('a')?.error).toBeUndefined()
  expect((await service.progress('a'))?.steps['1'].worldAssets.status).toBe('completed')
})

it('旧书没有P1进度行时仍可从章节凭证显示待提取并正常启动', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => stream(dataFor(init)))
  const { service, db } = await setup(fetcher)
  await db.table('compileProgress').delete('P1')
  expect(await service.progress('a')).toMatchObject({ status: 'idle', totalChapters: 1, completedSteps: 0 })
  await service.startTogether('a')
  expect(await service.progress('a')).toMatchObject({ status: 'completed', completedSteps: 2 })
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('整类重提暂停后手动补一章，原整书继续范围仍保留', async () => {
  let holding = true
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => holding ? abortable(init?.signal) : stream(dataFor(init)))
  const { service, db } = await setup(fetcher, 2)
  const run = service.startLane('a', 'worldAssets', { replace: true })
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
  service.pauseLane('a', 'worldAssets'); await run
  holding = false
  await service.extractChapter('a', '1', 'worldAssets')
  expect((await service.progress('a'))?.extractionJobs.worldAssets).toMatchObject({ scope: 'all', mode: 'replace', group: 'single', status: 'paused' })
  const ids = (await db.table('characters').toArray()).map(row => row.id)
  await service.startLane('a', 'worldAssets', { resume: true })
  expect((await service.progress('a'))?.extractionJobs.worldAssets?.status).toBe('completed')
  expect(ids.length).toBeGreaterThan(0)
  expect(await db.table('characters').bulkGet(ids)).not.toContain(undefined)
})

it.each(['lease:extraction', 'lease:extraction:worldAssets', 'lease:extraction:narrativeAssets'])('取消清理没有本页控制器的执行锁 %s，并保留成果', async leaseId => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => stream(dataFor(init)))
  const { service, db } = await setup(fetcher, 2)
  await service.extractChapter('a', '1', 'worldAssets')
  const before = await db.table('characters').toArray()
  const step = leaseId.endsWith('narrativeAssets') ? 'narrativeAssets' : 'worldAssets'
  const domain = step === 'worldAssets' ? 'world' : 'narrative'
  await db.table('compileProgress').update('P1', { extractionJobs: undefined, status: 'paused' })
  await db.table('pipelineRuns').put({ id: leaseId, recordType: 'lease', bookId: 'a', lockKey: leaseId.slice(6), owner: 'old', runId: 'old', expiresAt: Date.now() + 30000, ...(leaseId === 'lease:extraction' ? {} : { extractionStep: step }) })
  await db.table('pipelineRuns').put({ id: `lease:${domain}`, recordType: 'lease', bookId: 'a', lockKey: domain, owner: 'old', runId: 'old', expiresAt: Date.now() + 30000 })
  await service.cancelAll('a')
  expect((await service.progress('a'))?.busy).toBe(false)
  expect(await db.table('pipelineRuns').where('recordType').equals('lease').count()).toBe(0)
  expect(await db.table('characters').toArray()).toEqual(before)
  await service.extractChapter('a', '2', 'narrativeAssets')
  expect((await service.progress('a'))?.steps['2'].narrativeAssets.status).toBe('completed')
})

it('刷新清理没有任务的分步骤残留锁，保留另一个任务的领域锁', async () => {
  const { service, db } = await setup(vi.fn<typeof fetch>())
  await db.table('compileProgress').update('P1', { status: 'paused' })
  await db.table('pipelineRuns').bulkPut([
    { id: 'lease:extraction:worldAssets', recordType: 'lease', bookId: 'a', lockKey: 'extraction:worldAssets', extractionStep: 'worldAssets', owner: 'old', runId: 'old', expiresAt: 0 },
    { id: 'lease:world', recordType: 'lease', bookId: 'a', lockKey: 'world', owner: 'p2', runId: 'p2', expiresAt: Date.now() + 30000 },
  ])
  await service.recover('a')
  expect((await service.progress('a'))?.busy).toBe(false)
  expect((await db.table('pipelineRuns').get('lease:world'))?.owner).toBe('p2')
})

it('另一执行者点击取消，本页立即停止等待中的请求', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => abortable(init?.signal))
  const { service, workspace, models } = await setup(fetcher)
  const run = service.startTogether('a')
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  await createExtractionService(workspace, models).cancelAll('a')
  await vi.waitFor(() => expect(service.state('a')?.running).toBe(false))
  await run
  expect((await service.progress('a'))?.busy).toBe(false)
})

it('刷新恢复已暂停的旧整书任务时，同时释放旧领域锁', async () => {
  const { service, db } = await setup(vi.fn<typeof fetch>())
  await db.table('compileProgress').update('P1', { status: 'paused' })
  await db.table('pipelineRuns').bulkPut(['extraction', 'world'].map(domain => ({ id: `lease:${domain}`, recordType: 'lease', bookId: 'a', lockKey: domain, owner: 'old', runId: 'old', expiresAt: Date.now() + 30000 })))
  await service.recover('a')
  expect(await db.table('pipelineRuns').where('recordType').equals('lease').count()).toBe(0)
  expect((await service.progress('a'))?.busy).toBe(false)
})
