import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createModelService } from '../src/features/models/service'
import { createExtractionService } from '../src/features/extraction/service'
import { defaultConfig } from '../src/features/models/types'
import { emptyTables, tableNames, validateBookData } from '../src/features/backup/data'
import { createAssetService } from '../src/features/assets/service'

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

it('P1把通用称谓归入身份说明，保留稳定别名与只有称谓的人物', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(stream({ characters: [
    { name: '林如海', confidence: 1, aliases_mentioned: ['爸爸', '姑父', '林姑父'], identity: '官员' },
    { name: '太后', confidence: 1, aliases_mentioned: ['娘娘', '哀家'] },
  ], locations: [] })).mockResolvedValueOnce(stream({ nodes: [{ name: '问候', summary: '问候', actors: ['爸爸', '太后'], quote: '', confidence: 1 }] }))
  const { service, db, book } = await setup(fetcher)
  await service.start('a')
  expect(await db.table('characters').get('C1-P001')).toMatchObject({ aliases: ['林姑父'], identity: '官员；原文称谓：爸爸、姑父' })
  expect(await db.table('characters').get('C1-P002')).toMatchObject({ name: '太后', aliases: [], identity: '原文称谓：娘娘、哀家' })
  expect(await db.table('nodes').get('C1-N001')).toMatchObject({ actors: ['爸爸', '太后'], actorIds: [] })
  const tables = emptyTables(); for (const name of tableNames) tables[name] = await db.table(name).toArray()
  expect(await validateBookData({ book, tables })).toEqual([])
})

it('两章顺序执行独立请求，资产和凭证实时出现，完整资料可备份', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
    const body = JSON.parse(init?.body as string)
    expect(body.messages.filter((row: { role: string }) => row.role === 'user')).toHaveLength(1)
    return stream(body.tools[0].function.parameters.properties.characters ? { ...world, characters: [...world.characters, world.characters[0]] } : narrative)
  })
  const { workspace, db, service, book } = await setup(fetcher, 2)
  let sawFirstCommit = false
  const stop = service.subscribe(() => { if (service.state('a')?.results.some(row => row.ok && row.step === 'worldAssets')) sawFirstCommit = true })
  await service.start('a'); stop()
  expect(sawFirstCommit).toBe(true)
  expect(fetcher).toHaveBeenCalledTimes(4)
  expect(await db.table('characters').count()).toBe(4)
  expect(await db.table('extractionReceipts').count()).toBe(4)
  expect(await service.progress('a')).toMatchObject({ status: 'completed', completedChapters: ['1', '2'] })
  expect(await db.table('nodes').get('C1-N001')).toMatchObject({ quoteStatus: 'matched', offset: 0, actorIds: [] })
  expect(await db.table('nodes').get('C1-N002')).toMatchObject({ quoteStatus: 'unmatched' })
  expect(await db.table('characters').get('C1-P001')).toMatchObject({ profile: {}, speechStyleSample: '你好', createdBy: 'P1' })
  const tables = emptyTables(); for (const name of tableNames) tables[name] = await db.table(name).toArray()
  expect(await validateBookData({ book, tables })).toEqual([])
  await service.start('a'); expect(fetcher).toHaveBeenCalledTimes(4)
  expect(await workspace.openBook('b').table('characters').count()).toBe(0)
})

it('世界步骤鉴权失败只请求一次，叙事步骤仍提交，章节保持失败与部分成功', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{"error":{"message":"invalid key"}}', { status: 401 })).mockResolvedValueOnce(stream(narrative))
  const { db, service } = await setup(fetcher)
  await service.start('a')
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(await db.table('extractionReceipts').count()).toBe(1)
  expect(await service.progress('a')).toMatchObject({ status: 'failed', failedChapters: ['1'], partialChapters: { '1': ['worldAssets'] } })
  expect(service.state('a')?.results.map(row => row.ok)).toEqual([false, true])
})

it('已有节点和删除凭证占用编号，新结果追加且保留人工内容', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(stream(world)).mockResolvedValueOnce(stream(narrative))
  const { db, service } = await setup(fetcher)
  await db.table('nodes').add({ id: 'C1-N001', bookId: 'a', createdBy: 'manual', revision: 1, chapterIndex: '1', chapterName: '第1章', name: '已有节点', summary: '人工内容', actors: [], quote: '', confidence: 1, order: 0 })
  await db.table('assetLifecycle').add({ key: 'node:C1-N002', bookId: 'a', kind: 'node', originId: 'C1-N002', state: 'deleted', revision: 1, updatedAt: new Date().toISOString() })
  await service.start('a')
  expect(await db.table('nodes').get('C1-N001')).toMatchObject({ summary: '人工内容', revision: 1, order: 0 })
  expect(await db.table('nodes').get('C1-N002')).toBeUndefined()
  expect(await db.table('nodes').get('C1-N003')).toMatchObject({ name: '送信', order: 1 })
  expect(await db.table('nodes').get('C1-N004')).toMatchObject({ name: '回查', order: 2 })
})

it('网络重发与结构修正共用三次预算，正文与原回复保留', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('temporary', { status: 503 })).mockResolvedValueOnce(stream({ characters: [{ name: '', confidence: 1 }], locations: [] })).mockResolvedValueOnce(stream(world)).mockResolvedValueOnce(stream(narrative))
  const { service } = await setup(fetcher)
  await service.start('a')
  expect(fetcher).toHaveBeenCalledTimes(4)
  expect(service.state('a')?.results[0]).toMatchObject({ ok: true, attempts: 3 })
})

it('资产写入失败时资产、生命周期与凭证共同回滚', async () => {
  const { db, service } = await setup(vi.fn<typeof fetch>().mockResolvedValue(stream(world)))
  db.table('extractionReceipts').hook('creating', () => { throw new Error('模拟磁盘写入失败') })
  await service.start('a')
  for (const table of ['characters', 'locations', 'assetLifecycle', 'extractionReceipts']) expect(await db.table(table).count()).toBe(0)
  expect(service.state('a')?.error).toContain('模拟磁盘写入失败')
  expect(await service.progress('a')).toMatchObject({ status: 'failed', completedChapters: [] })
})

it('取消在途请求不提交晚到结果，同书另一执行器无法启动', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }) }))
  const { workspace, db, models, service } = await setup(fetcher)
  const running = service.start('a')
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
  const other = createExtractionService(workspace, models)
  await other.start('a'); expect(other.state('a')?.error).toContain('已有处理任务')
  service.cancel('a'); await running
  expect(await db.table('characters').count()).toBe(0)
  expect(await db.table('extractionReceipts').count()).toBe(0)
  expect(await service.progress('a')).toMatchObject({ status: 'cancelled' })
  expect(await db.table('pipelineRuns').get('lease:extraction')).toBeUndefined()
})


it('取消后重建服务只补缺，保留人工修改、合并与删除，沿用运行编号且可备份', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(stream(world)).mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }) })).mockResolvedValueOnce(stream(narrative))
  const { workspace, db, models, service, book } = await setup(fetcher)
  const running = service.start('a')
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  const originalRun = (await service.progress('a'))!.runId
  service.cancel('a'); await running
  const assets = createAssetService(workspace)
  const people = (await assets.read('a')).characters
  await assets.update('a', 'character', people[0].id, people[0].revision, { background: '人工保留背景' })
  const preview = await assets.previewMerge('a', 'character', { memberIds: people.map(row => row.id), keepId: people[0].id, canonicalName: '沈青' })
  await assets.confirmMerge('a', 'character', preview.request)
  const location = (await assets.read('a')).locations[0]
  await assets.remove('a', 'location', location.id, location.revision)
  const resumed = createExtractionService(workspace, models)
  await resumed.start('a')
  expect(fetcher).toHaveBeenCalledTimes(3)
  expect(await resumed.progress('a')).toMatchObject({ status: 'completed', runId: originalRun, canOrganize: true, completedSteps: 2 })
  const current = await assets.read('a')
  expect(current.characters).toHaveLength(1)
  expect(current.characters[0]).toMatchObject({ background: '人工保留背景' })
  expect(current.locations).toHaveLength(0)
  expect(current.nodes[0].actorIds).toEqual([people[0].id])
  expect(await db.table('assetLifecycle').get(`character:${people[1].id}`)).toMatchObject({ state: 'merged', currentId: people[0].id })
  const tables = emptyTables(); for (const name of tableNames) tables[name] = await db.table(name).toArray()
  expect(await validateBookData({ book, tables })).toEqual([])
})

it('失败原因刷新后可读取，继续只请求失败步骤', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{"error":{"message":"invalid key"}}', { status: 401 })).mockResolvedValueOnce(stream(narrative)).mockResolvedValueOnce(stream(world))
  const { workspace, models, service, db } = await setup(fetcher)
  await service.start('a')
  const resumed = createExtractionService(workspace, models)
  expect((await resumed.progress('a'))!.failures).toMatchObject([{ chapterIndex: '1', step: 'worldAssets', message: expect.stringContaining('鉴权') }])
  const nodes = await db.table('nodes').toArray()
  await resumed.start('a')
  expect(fetcher).toHaveBeenCalledTimes(3)
  expect(await db.table('nodes').toArray()).toEqual(nodes)
  expect((await resumed.progress('a'))!.failures).toEqual([])
})

it('失效任务转为可继续，活跃租约保持原状态，恢复过程不调用模型', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(stream(world)).mockResolvedValueOnce(stream(narrative))
  const { service, db } = await setup(fetcher)
  await db.table('pipelineRuns').put({ id: 'interrupted', recordType: 'run', bookId: 'a', stage: 'P1', status: 'running', startedAt: new Date().toISOString(), planVersion: '2.2', tasks: [] })
  await db.table('compileProgress').update('P1', { status: 'running', runId: 'interrupted' })
  await db.table('pipelineRuns').put({ id: 'lease:extraction', recordType: 'lease', bookId: 'a', owner: 'old', runId: 'interrupted', lockKey: 'extraction', expiresAt: Date.now() + 30000 })
  await service.recover('a'); expect((await service.progress('a'))!.status).toBe('running')
  await db.table('pipelineRuns').update('lease:extraction', { expiresAt: 0 })
  await service.recover('a')
  expect(fetcher).not.toHaveBeenCalled()
  expect(await service.progress('a')).toMatchObject({ status: 'paused', completedSteps: 0, canOrganize: false })
  expect(await db.table('pipelineRuns').get('lease:extraction')).toBeUndefined()
  await service.start('a')
  expect(await service.progress('a')).toMatchObject({ status: 'completed', runId: 'interrupted', canOrganize: true })
})

it('来源记录缺失时保留原资产并停止续跑，完成状态由成功凭证覆盖决定', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(stream(world)).mockResolvedValueOnce(stream(narrative))
  const { db, service } = await setup(fetcher)
  await service.start('a')
  await db.table('extractionReceipts').delete('1:narrativeAssets')
  expect(await service.progress('a')).toMatchObject({ status: 'paused', completedSteps: 1, canOrganize: false })
  await db.table('assetLifecycle').delete('character:C1-P001')
  await service.start('a')
  expect(service.state('a')!.error).toContain('来源记录不完整')
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(await db.table('characters').count()).toBe(2)
})


it('执行权变化后晚到的旧回复不写资产、不覆盖新进度、不删除新执行权', async () => {
  let release: (value: Response) => void = () => undefined
  const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(resolve => { release = resolve }))
  const { db, service } = await setup(fetcher)
  const oldRun = service.start('a')
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
  await db.table('pipelineRuns').update('lease:extraction', { owner: 'replacement-owner', runId: 'replacement-run', expiresAt: Date.now() + 30000 })
  await db.table('compileProgress').update('P1', { runId: 'replacement-run', status: 'paused' })
  release(stream(world)); await oldRun
  expect(await db.table('characters').count()).toBe(0)
  expect(await db.table('extractionReceipts').count()).toBe(0)
  expect(await db.table('compileProgress').get('P1')).toMatchObject({ runId: 'replacement-run', status: 'paused' })
  expect(await db.table('pipelineRuns').get('lease:extraction')).toMatchObject({ owner: 'replacement-owner' })
})
