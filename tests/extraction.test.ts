import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createModelService } from '../src/features/models/service'
import { createExtractionService } from '../src/features/extraction/service'
import { validateExtraction, promptOf } from '../src/features/extraction/contracts'
import { defaultConfig } from '../src/features/models/types'
import { emptyTables, tableNames, validateBookData } from '../src/features/backup/data'
import { encodeBackup, inspectBackup, restoredTables } from '../src/features/backup/codec'
import { createAssetService } from '../src/features/assets/service'
import { readExtractionInput } from '../src/features/extraction/taskStore'
import type { StoredTask } from '../src/features/extraction/recovery'
import { RemoteDatabase } from '../src/features/local-storage/client'

function interceptDisk(db: RemoteDatabase, check: (body: Record<string, unknown>) => void) {
  const request = RemoteDatabase.prototype.request
  const spy = vi.spyOn(RemoteDatabase.prototype, 'request').mockImplementation(function<T>(this: RemoteDatabase, body: Record<string, unknown>): Promise<T> {
    if (this.name === db.name) check(body)
    return request.call(this, body) as Promise<T>
  })
  return () => spy.mockRestore()
}

const workspaces: ReturnType<typeof createWorkspace>[] = []
const world = { characters: [{ name: '沈青', confidence: 1, profile: { ageText: null }, speech_style_sample: '你好' }, { name: '沈青', confidence: 0.5, identity: '送信人' }], locations: [{ name: '青石镇', confidence: 1 }] }
const narrative = { nodes: [{ name: '送信', summary: '沈青送信', actors: ['沈青'], quote: '沈青送信。', confidence: 1 }, { name: '回查', summary: '原文未定位', actors: [], quote: '未匹配片段', confidence: 0.5 }] }
function stream(value: unknown) {
  const frame = (delta: object, finish_reason: string | null) => ({ id: 'extraction', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason }] })
  const frames = [frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'submit', type: 'function', function: { name: 'submit_result', arguments: JSON.stringify(value) } }] }, null), frame({}, 'tool_calls')]
  return new Response(frames.map(row => `data: ${JSON.stringify(row)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
}
async function setup(fetcher: typeof fetch, count = 1, texts?: string[]) {
  const id = crypto.randomUUID(); const workspace = createWorkspace({ settingsName: `extract-${id}`, bookPrefix: `extract-${id}-book-` }); workspaces.push(workspace)
  const book = { id: 'a', title: '提取样本', sourceFileName: '样本.txt', createdAt: new Date().toISOString() }
  await workspace.settings.books.add(book)
  const db = workspace.openBook('a')
  const fallback = '沈青送信。沈青说：“你好”。青石镇。'
  const textOf = (order: number) => texts?.[order] ?? fallback
  await db.chapters.bulkPut(Array.from({ length: count }, (_, order) => ({ bookId: 'a', chapterIndex: String(order + 1), chapterName: `第${order + 1}章`, order, charCount: textOf(order).length })))
  await db.table('chapterTexts').bulkPut(Array.from({ length: count }, (_, order) => ({ bookId: 'a', chapterIndex: String(order + 1), text: textOf(order) })))
  await db.table('compileProgress').add({ bookId: 'a', stage: 'P1', status: 'idle', totalChapters: count, completedChapters: [], failedChapters: [], updatedAt: book.createdAt })
  const models = createModelService(workspace, { fetch: fetcher, wait: async (_ms, signal) => signal.throwIfAborted() })
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://extraction.invalid/v1', extractionModel: 'test' }, 'extraction-fake-key')
  return { book, workspace, db, models, service: createExtractionService(workspace, models) }
}
afterEach(async () => { for (const workspace of workspaces.splice(0)) { workspace.close(); for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name) } })

const extractionMessage = (value: unknown) => ({ content: [{ type: 'toolCall', name: 'submit_result', arguments: value }] }) as unknown as Parameters<typeof validateExtraction>[1]
const relationWorld = (quote: string) => ({ characters: [{ name: '沈青', confidence: 1, relations: [{ target: '顾衡', relation_type: 'friend', relation_label: '朋友', reverse_label: '朋友', direction: 'bidirectional', quote }] }], locations: [] })

it('节点地点按出现顺序保存、可更正，并兼容省略与无效输入', async () => {
  const locations = [' 荣庆堂 ', '', '荣庆堂', '宁国府前院厢房']
  const input = { nodes: [{ ...narrative.nodes[0], locationNames: locations }, narrative.nodes[1]] }
  expect(() => validateExtraction('narrativeAssets', extractionMessage({ nodes: [{ ...input.nodes[0], locationNames: '荣庆堂' }] }))).toThrow('字段、类型或置信度不符合要求')
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const fields = JSON.parse(init?.body as string).tools[0].function.parameters.properties
    if (fields.characters) return stream(world)
    expect(fields.nodes.items.properties.locationNames.type).toBe('array')
    return stream(input)
  })
  const { service, db, workspace, book } = await setup(fetcher)
  await service.start(book.id)
  const [located, unlocated] = await db.table('nodes').toArray()
  expect(located.locationNames).toEqual(['荣庆堂', '宁国府前院厢房'])
  expect(unlocated.locationNames).toBeUndefined()
  await createAssetService(workspace).update(book.id, 'node', located.id, located.revision, { locationNames: [' 宁国府 '] })
  expect((await db.table('nodes').get(located.id))?.locationNames).toEqual(['宁国府'])
  const tables = emptyTables()
  for (const table of tableNames) tables[table] = await db.table(table).toArray()
  expect(await validateBookData({ book, tables })).toEqual([])
  const backup = await encodeBackup({ book, tables })
  const inspected = await inspectBackup(backup.bytes)
  expect(inspected.ok).toBe(true)
  expect((await restoredTables(inspected.data!, 'copy')).nodes.find(node => node.id === located.id)?.locationNames).toEqual(['宁国府'])
})

it('人物关系依据只要求有内容，不要求长度或逐字匹配本章原文', () => {
  expect(() => validateExtraction('worldAssets', extractionMessage(relationWorld('二人是多年朋友，这是模型概括的依据。')))).not.toThrow()
  expect(() => validateExtraction('worldAssets', extractionMessage(relationWorld('朋友')))).not.toThrow()
  expect(() => validateExtraction('worldAssets', extractionMessage(relationWorld('朋')))).not.toThrow()
  expect(() => validateExtraction('worldAssets', extractionMessage(relationWorld('依'.repeat(501))))).not.toThrow()
  expect(() => validateExtraction('worldAssets', extractionMessage(relationWorld('')))).toThrow('字段、类型或置信度不符合要求')
})

it('整书重提世界资产先清空再提取，保留叙事节点并清除P2', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => stream(JSON.parse(init?.body as string).tools[0].function.parameters.properties.characters ? world : narrative))
  const { service, db, workspace } = await setup(fetcher, 2)
  await service.start('a')
  const before = { characters: await db.table('characters').count(), locations: await db.table('locations').count(), nodes: await db.table('nodes').count() }
  await workspace.openBook('a').table('pipelineRuns').put({ id: 'p2-old', bookId: 'a', recordType: 'run', stage: 'P2', status: 'completed', startedAt: new Date().toISOString(), planVersion: '2.2', report: { status: 'completed' } })
  fetcher.mockClear()
  await service.reExtract('a', { scope: 'all', step: 'worldAssets' })
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(service.state('a')?.error).toBeUndefined()
  expect(await db.table('characters').count()).toBe(before.characters)
  expect(await db.table('locations').count()).toBe(before.locations)
  expect(await db.table('nodes').count()).toBe(before.nodes)
  expect(await db.table('extractionReceipts').where('substep').equals('narrativeAssets').count()).toBe(2)
  expect(await db.table('pipelineRuns').get('p2-old')).toBeUndefined()
  expect((await service.progress('a'))?.reExtract).toBeUndefined()
}, 30000)

it('整书重提叙事资产删除事件线和P3结果，保留人物地点', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => stream(JSON.parse(init?.body as string).tools[0].function.parameters.properties.characters ? world : narrative))
  const { service, db, workspace } = await setup(fetcher, 1)
  await service.start('a')
  const assets = createAssetService(workspace)
  const node = (await db.table('nodes').toArray())[0]
  await assets.create('a', 'eventLine', { title: '送信线', nodeIds: [node.id] })
  const before = { characters: await db.table('characters').count(), locations: await db.table('locations').count(), nodes: await db.table('nodes').count() }
  await workspace.openBook('a').table('pipelineRuns').put({ id: 'p3-old', bookId: 'a', recordType: 'run', stage: 'P3', status: 'completed', startedAt: new Date().toISOString(), planVersion: '2.2' })
  fetcher.mockClear()
  await service.reExtract('a', { scope: 'all', step: 'narrativeAssets' })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(service.state('a')?.error).toBeUndefined()
  expect(await db.table('eventLines').count()).toBe(0)
  expect(await db.table('nodes').count()).toBe(before.nodes)
  expect(await db.table('characters').count()).toBe(before.characters)
  expect(await db.table('locations').count()).toBe(before.locations)
  expect(await db.table('pipelineRuns').get('p3-old')).toBeUndefined()
}, 30000)

it('单章重提合并编号后其他章节凭证仍有效，首章失败可继续且立即备份可校验', async () => {
  let failing = false
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const schema = JSON.parse(init?.body as string).tools[0].function.parameters
    if (failing && schema.properties.characters) return stream({ characters: [{ name: '', confidence: 1 }], locations: [] })
    return stream(schema.properties.characters ? world : narrative)
  })
  const { service, db, workspace, book } = await setup(fetcher, 2)
  await service.start('a')
  const assets = createAssetService(workspace)
  const preview = await assets.previewMerge('a', 'character', { memberIds: ['C1-P001', 'C2-P001'], keepId: 'C2-P001', canonicalName: '沈青' })
  await assets.confirmMerge('a', 'character', preview.request)
  const now = new Date().toISOString()
  await db.table('characterRelations').put({ id: 'R-CROSS', bookId: 'a', originCharacterId: 'C1-P002', sourceName: '沈青', targetName: '沈青', relationType: 'friend', forwardLabel: '朋友', reverseLabel: '朋友', direction: 'bidirectional', evidence: [], sourceId: 'C1-P002', targetIds: ['C2-P002'], revision: 1, createdAt: now, updatedAt: now })
  const chapter2Location = (await db.table('locations').toArray()).find(row => row.chapterIndex === '2')!
  await db.table('pipelineRuns').put({ id: 'p2-coverage', bookId: 'a', recordType: 'run', stage: 'P2', status: 'paused', startedAt: now, planVersion: '2.2', coverageItems: [{ workItemId: `p2:${chapter2Location.id}`, phase: 'asset_review', kind: 'location', id: chapter2Location.id, status: 'checked', inputRevision: 1, inputFingerprint: 'fixture', coveredRevision: 1, coveredFingerprint: 'fixture', dependencies: { records: [], queries: [] }, taskId: null, outcome: 'no_change', reason: 'fixture', invalidations: 0, updatedAt: now }] })
  await db.table('compileProgress').put({ bookId: 'a', stage: 'P2', status: 'paused', totalChapters: 2, completedChapters: [], failedChapters: [], updatedAt: now, validity: 'current' })
  failing = true
  await service.reExtract('a', { scope: 'chapter', chapterIndex: '2', step: 'worldAssets' })
  expect(service.state('a')?.error).toBeUndefined()
  expect(await db.table('characters').get('C2-P001')).toBeUndefined()
  expect((await db.table('characterRelations').get('R-CROSS'))?.targetIds).not.toContain('C2-P002')
  expect((await db.table('pipelineRuns').get('p2-coverage'))?.coverageItems[0]).toMatchObject({ status: 'stale', invalidations: 1 })
  expect(await db.table('compileProgress').get('P2')).toMatchObject({ validity: 'stale' })
  const progress = await service.progress('a')
  expect(progress?.reExtract).toMatchObject({ step: 'worldAssets', scope: 'chapter', chapterIndex: '2' })
  const tables = emptyTables(); for (const name of tableNames) tables[name] = await db.table(name).toArray()
  expect(await validateBookData({ book, tables })).toEqual([])
  failing = false
  await service.continueReExtract('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect((await service.progress('a'))?.reExtract).toBeUndefined()
  expect(await db.table('extractionReceipts').get('2:worldAssets')).toBeTruthy()
  expect(await db.table('characters').count()).toBeGreaterThan(0)
}, 30000)

it.each(['all', 'chapter'] as const)('原文缺失时%s世界重提保留旧资产和凭证', async scope => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => stream(JSON.parse(init?.body as string).tools[0].function.parameters.properties.characters ? world : narrative))
  const { service, db } = await setup(fetcher, 2)
  await service.start('a')
  const beforePeople = await db.table('characters').toArray()
  const beforeReceipts = await db.table('extractionReceipts').toArray()
  await db.table('chapterTexts').delete('2')
  fetcher.mockClear()
  const request = scope === 'all' ? { scope, step: 'worldAssets' as const } : { scope, chapterIndex: '2', step: 'worldAssets' as const }
  expect((await service.reExtractPreview('a', request)).blockers).toContain('第2章原文缺失或为空，无法重新提取。')
  await expect(service.reExtract('a', request)).rejects.toThrow('第2章原文缺失')
  expect(await db.table('characters').toArray()).toEqual(beforePeople)
  expect(await db.table('extractionReceipts').toArray()).toEqual(beforeReceipts)
  expect(fetcher).not.toHaveBeenCalled()
})

it('预览后原文变为空白，清空事务仍拒绝且单章不检查其他章节', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => stream(JSON.parse(init?.body as string).tools[0].function.parameters.properties.characters ? world : narrative))
  const { service, db, models } = await setup(fetcher, 2)
  await service.start('a')
  await db.table('chapterTexts').delete('2')
  const request = { scope: 'chapter' as const, chapterIndex: '1', step: 'worldAssets' as const }
  expect((await service.reExtractPreview('a', request)).blockers).toEqual([])
  const beforePeople = await db.table('characters').toArray()
  const beforeReceipts = await db.table('extractionReceipts').toArray()
  const readSettings = models.settings.read.bind(models.settings)
  let reads = 0
  vi.spyOn(models.settings, 'read').mockImplementation(async () => {
    if (++reads === 2) await db.table('chapterTexts').update('1', { text: ' \n\t' })
    return readSettings()
  })
  fetcher.mockClear()
  await service.reExtract('a', request)
  expect(service.state('a')?.error).toContain('第1章原文缺失或为空')
  expect(await db.table('characters').toArray()).toEqual(beforePeople)
  expect(await db.table('extractionReceipts').toArray()).toEqual(beforeReceipts)
  expect((await service.progress('a'))?.reExtract).toBeUndefined()
  expect(fetcher).not.toHaveBeenCalled()
})

it.each(['all', 'chapter'] as const)('%s重提失败后章节重试成功按原范围解除标记', async scope => {
  let failing = false
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const isWorld = !!JSON.parse(init?.body as string).tools[0].function.parameters.properties.characters
    return stream(isWorld ? failing ? { characters: [{ name: '', confidence: 1 }], locations: [] } : world : narrative)
  })
  const { service, db } = await setup(fetcher, 2)
  await service.start('a')
  const narrativeReceipts = await db.table('extractionReceipts').where('substep').equals('narrativeAssets').toArray()
  failing = true
  await service.reExtract('a', scope === 'all' ? { scope, step: 'worldAssets' } : { scope, chapterIndex: '1', step: 'worldAssets' })
  expect((await service.progress('a'))?.reExtract?.scope).toBe(scope)
  failing = false
  fetcher.mockClear()
  await service.retry('a', '1', 'worldAssets')
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(await db.table('extractionReceipts').get('1:worldAssets')).toBeTruthy()
  if (scope === 'all') {
    expect((await service.progress('a'))?.reExtract?.scope).toBe('all')
    await service.retry('a', '2', 'worldAssets')
    expect(fetcher).toHaveBeenCalledTimes(2)
  }
  expect((await service.progress('a'))?.reExtract).toBeUndefined()
  expect((await service.reExtractPreview('a', { scope: 'chapter', chapterIndex: '1', step: 'worldAssets' })).blockers).toEqual([])
  expect(await db.table('extractionReceipts').where('substep').equals('narrativeAssets').toArray()).toEqual(narrativeReceipts)
}, 30000)

it('取消待继续重提不写入Schema外字段，备份仍可校验', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => stream(JSON.parse(init?.body as string).tools[0].function.parameters.properties.characters ? world : narrative))
  const { service, db, book } = await setup(fetcher)
  await service.start('a')
  await db.table('compileProgress').update('P1', { reExtract: { step: 'worldAssets', scope: 'all', startedAt: new Date().toISOString() } })
  await service.cancelReExtract('a')
  const progress = await db.table('compileProgress').get('P1')
  expect(progress).not.toHaveProperty('reExtract')
  expect(progress).not.toHaveProperty('completedSteps')
  expect(progress).toMatchObject({ status: 'completed' })
  const tables = emptyTables(); for (const name of tableNames) tables[name] = await db.table(name).toArray()
  expect(await validateBookData({ book, tables })).toEqual([])
})

it('取消全部提取后不写入Schema外字段，备份校验通过', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => stream(JSON.parse(init?.body as string).tools[0].function.parameters.properties.characters ? world : narrative))
  const { service, db, book } = await setup(fetcher)
  await service.start('a')
  await service.cancelAll('a')
  const progress = await db.table('compileProgress').get('P1')
  expect(progress).not.toHaveProperty('completedSteps')
  const tables = emptyTables(); for (const name of tableNames) tables[name] = await db.table(name).toArray()
  expect(await validateBookData({ book, tables })).toEqual([])
})

const sceneNode = { nodes: [{ name: '本章场景', summary: '本章人物在场景中活动', actors: ['沈青'], quote: '沈青', confidence: 1 }] }

it('P1-A 只写入有依据的关系，保留未知和临时关系，普通互动不建关系', async () => {
  const samples = [
    { text: '沈青与顾衡是多年好友，镇上人都知道。', world: { characters: [{ name: '沈青', confidence: 1, relations: [{ target: '顾衡', relation_type: 'friend', relation_label: '朋友', reverse_label: '朋友', direction: 'bidirectional', quote: '沈青与顾衡是多年好友' }] }, { name: '顾衡', confidence: 1 }], locations: [] } },
    { text: '沈青在渡口遇见顾衡，两人寒暄几句便各自离开。', world: { characters: [{ name: '沈青', confidence: 1 }, { name: '顾衡', confidence: 1 }], locations: [] } },
    { text: '沈青与顾衡临时结盟，约定共同查案。', world: { characters: [{ name: '沈青', confidence: 1, relations: [{ target: '顾衡', relation_type: 'ally', relation_label: '同盟', reverse_label: '同盟', direction: 'bidirectional', quote: '沈青与顾衡临时结盟' }] }, { name: '顾衡', confidence: 1 }], locations: [] } },
    { text: '沈青听说顾衡与自己有旧，但两人究竟是什么关系，无人说得清。', world: { characters: [{ name: '沈青', confidence: 1, relations: [{ target: '顾衡', relation_type: 'unknown', relation_label: '未知', reverse_label: '未知', direction: 'unspecified', quote: '沈青听说顾衡与自己有旧，但具体关系不明' }] }, { name: '顾衡', confidence: 1 }], locations: [] } },
  ]
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = init?.body as string
    const isWorld = !!JSON.parse(body).tools[0].function.parameters.properties.characters
    const sample = samples.find(item => body.includes(item.text))
    return stream(isWorld ? sample!.world : sceneNode)
  })
  const { service, db } = await setup(fetcher, samples.length, samples.map(item => item.text))
  await service.start('a')
  const relations = await db.table('characterRelations').toArray()
  expect(relations).toHaveLength(3)
  expect(relations.map(row => `${row.forwardLabel}/${row.reverseLabel}`)).toEqual(expect.arrayContaining(['朋友/朋友', '同盟/同盟', '未知/未知']))
  expect(relations.some(row => row.evidence[0]?.chapterIndex === '2')).toBe(false)
  expect(relations.find(row => row.forwardLabel === '未知')?.relationType).toBe('unknown')
})

it('P1-A 未具名关系目标保留原文称谓，不猜测姓名', async () => {
  const text = '王夫人的父亲当日也在荣国府。'
  const world = { characters: [
    { name: '王夫人', confidence: 1, relations: [{ target: '王夫人的父亲', relation_type: 'parent_child', relation_label: '女儿', reverse_label: '父亲', direction: 'directed', quote: '王夫人的父亲当日也在荣国府' }] },
    { name: '王夫人的父亲', confidence: 0.6, identity: '王夫人的父亲' },
  ], locations: [] }
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => stream(JSON.parse(init?.body as string).tools[0].function.parameters.properties.characters ? world : sceneNode))
  const { service, db } = await setup(fetcher, 1, [text])
  await service.start('a')
  const people = await db.table('characters').toArray()
  expect(people.some(row => row.name === '王夫人的父亲')).toBe(true)
  expect(people.some(row => row.name === '王老爷')).toBe(false)
  const relations = await db.table('characterRelations').toArray()
  const unnamed = people.find(row => row.name === '王夫人的父亲')!
  expect(relations[0]).toMatchObject({ targetName: '王夫人的父亲', targetIds: [unnamed.id] })
})

it('P1-B 传闻和猜测保留来源与不确定性，不写成已确认事实', async () => {
  const text = '镇上传说顾衡杀了人，但无人证实。'
  const world = { characters: [{ name: '顾衡', confidence: 1 }, { name: '沈青', confidence: 1 }], locations: [] }
  const narrativeNode = { nodes: [{ name: '顾衡杀人的传闻', summary: '镇上传说顾衡杀人，但无人证实', process: '镇上流传顾衡杀人的说法，来源和真假均未确认。', actors: ['镇上的人'], new_facts: ['据传顾衡杀过人，尚未证实'], quote: text, confidence: 0.6 }] }
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => stream(JSON.parse(init?.body as string).tools[0].function.parameters.properties.characters ? world : narrativeNode))
  const { service, db } = await setup(fetcher, 1, [text])
  await service.start('a')
  const node = (await db.table('nodes').toArray())[0]
  expect(node).toMatchObject({ name: '顾衡杀人的传闻', summary: '镇上传说顾衡杀人，但无人证实', new_facts: ['据传顾衡杀过人，尚未证实'] })
  expect(node.process).toContain('未确认')
  expect(node.world_delta ?? []).toEqual([])
})

it('P1提示词包含关系存在性、未具名指向和传闻不确定性规则', () => {
  const worldPrompt = promptOf('worldAssets')
  expect(worldPrompt).toContain('仅同场、交谈、想起、打量或打算办事不足以建立关系')
  expect(worldPrompt).toContain('临时同盟')
  expect(worldPrompt).toContain('未具名但能明确指向的人物')
  expect(worldPrompt).toContain('“有人”“众人”等泛称不作为具体人物')
  expect(worldPrompt).toContain('依据不足时省略该条关系')
  expect(worldPrompt).toContain('关系目标使用该条主名')
  expect(worldPrompt).toContain('正向填“父亲”、反向填“儿子”')
  expect(promptOf('narrativeAssets')).toContain('猜测、传闻、谎言、未经证实的指控')
})

it.each(['worldAssets', 'narrativeAssets'] as const)('P1 %s 初始消息纯净，修正独立追加且保存来源不变', async failingStep => {
  const text = '  沈青送信。\n沈青说：“你好”。青石镇。\n'
  const calls = { worldAssets: 0, narrativeAssets: 0 }
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const request = JSON.parse(init?.body as string)
    const step = request.tools[0].function.parameters.properties.characters ? 'worldAssets' : 'narrativeAssets'
    calls[step]++
    if (step === failingStep && calls[step] === 1) return stream(step === 'worldAssets'
      ? { characters: [{ name: '', confidence: 1 }], locations: [] }
      : { nodes: [{ name: '', summary: '送信', actors: ['沈青'], quote: '', confidence: 1 }] })
    return stream(step === 'worldAssets' ? world : narrative)
  })
  const { service, db } = await setup(fetcher, 1, [text])
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect(fetcher).toHaveBeenCalledTimes(3)
  for (const [, init] of fetcher.mock.calls) {
    const request = JSON.parse(init?.body as string)
    const messages = request.messages as { role: string; content: string }[]
    const users = messages.filter(row => row.role === 'user')
    expect(users[0].content).toBe(`第1章\n\n${text}`)
    expect(request.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['submit_result'])
    expect(JSON.stringify(request.tools)).not.toContain('证据不足填未知')
    const system = messages.filter(row => row.role === 'system').map(row => row.content).join('\n')
    expect([...system.matchAll(/^## (.+)$/gm)].map(match => match[1])).toEqual(['任务', '铁律', '字段', '工具'])
    expect(system).toContain('【文学资料处理说明】')
    expect(system).not.toMatch(/不要输出任何 id|工具参数的字段|AUTO-GENERATED|自检清单|章节标识|证据不足填未知/)
    if (users.length > 1) {
      expect(users).toHaveLength(2)
      expect(users[1].content).toContain('实际错误：')
      expect(users[1].content).not.toContain(text)
      expect(messages.some(row => row.role === 'assistant')).toBe(true)
      expect(messages.some(row => row.role === 'tool' && row.content.includes('结果校验未通过'))).toBe(true)
    }
  }
  expect(calls[failingStep]).toBe(2)
  expect(await db.table('extractionReceipts').count()).toBe(2)
  expect(await db.table('characters').count()).toBe(world.characters.length)
  expect(await db.table('nodes').count()).toBe(narrative.nodes.length)
  const character = (await db.table('characters').toArray())[0]
  const node = (await db.table('nodes').toArray())[0]
  expect(character).toMatchObject({ chapterIndex: '1', chapterName: '第1章' })
  expect(node).toMatchObject({ chapterIndex: '1', chapterName: '第1章' })
})

it('续期延迟超过有效期时，同一执行者保存回复并继续所有章节', async () => {
  const fetcher = vi.fn<typeof fetch>()
  const { service, db } = await setup(fetcher, 2)
  fetcher.mockImplementation(async (_url, init) => {
    await db.table('pipelineRuns').update('lease:extraction', { expiresAt: 0 })
    return stream(JSON.parse(init?.body as string).tools[0].function.parameters.properties.characters ? world : narrative)
  })
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect(fetcher).toHaveBeenCalledTimes(4)
  expect(await service.progress('a')).toMatchObject({ status: 'completed', completedSteps: 4 })
})

it('旧任务中断且没有失败章节时，显示已暂停而不是失败零章', async () => {
  const { service, db } = await setup(vi.fn<typeof fetch>())
  await db.table('compileProgress').update('P1', { status: 'failed', failedChapters: [] })
  expect(await service.progress('a')).toMatchObject({ status: 'paused', failedChapters: [], completedSteps: 0 })
})

it('结构连续失败最多三次请求，后续步骤继续，点击重试只补指定失败项', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(stream({ characters: [{ name: '', confidence: 1 }], locations: [] }))
    .mockResolvedValueOnce(stream({ characters: [{ name: '', confidence: 1 }], locations: [] }))
    .mockResolvedValueOnce(stream({ characters: [{ name: '', confidence: 1 }], locations: [] }))
    .mockResolvedValueOnce(stream(narrative)).mockResolvedValueOnce(stream(world)).mockResolvedValueOnce(stream(narrative))
  const { service, db, book } = await setup(fetcher, 2)
  await service.start('a')
  expect(fetcher).toHaveBeenCalledTimes(6)
  expect(await service.progress('a')).toMatchObject({ status: 'failed', completedSteps: 3, failedChapters: ['1'], steps: { '1': { worldAssets: { status: 'failed' }, narrativeAssets: { status: 'completed' } }, '2': { worldAssets: { status: 'completed' }, narrativeAssets: { status: 'completed' } } } })
  const before = await db.table('nodes').toArray()
  fetcher.mockResolvedValue(stream(world))
  await service.retry('a', '1', 'worldAssets')
  expect(fetcher).toHaveBeenCalledTimes(7)
  expect(await service.progress('a')).toMatchObject({ status: 'completed', completedSteps: 4, failedChapters: [] })
  const after = await db.table('nodes').toArray()
  const content = (rows: Record<string, unknown>[]) => rows.map(({ actorIds: _ids, actorBindings: _bindings, revision: _revision, ...row }) => row)
  expect(content(after)).toEqual(content(before))
  for (const node of after.filter(row => row.name === '送信')) {
    expect(node.actorIds).toEqual(expect.arrayContaining(['C1-P001', 'C1-P002', 'C2-P001', 'C2-P002']))
    expect(node.revision).toBe(before.find(row => row.id === node.id)!.revision + 1)
  }
  await service.retry('a', '1', 'worldAssets')
  expect(fetcher).toHaveBeenCalledTimes(7)
  const tables = emptyTables(); for (const name of tableNames) tables[name] = await db.table(name).toArray()
  expect(await validateBookData({ book, tables })).toEqual([])
})

it('两次结构修正可以成功，记录真实修正次数并保持三次总额度', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(stream({})).mockResolvedValueOnce(stream({})).mockResolvedValueOnce(stream(world)).mockResolvedValueOnce(stream(narrative))
  const { service, db, book } = await setup(fetcher)
  await service.start('a')
  expect(fetcher).toHaveBeenCalledTimes(4)
  const run = (await db.table('pipelineRuns').toArray()).find(row => row.stage === 'P1')!
  expect(run).toMatchObject({ taskStorage: 'separate', nextTaskOrdinal: 2 })
  expect(run).not.toHaveProperty('tasks')
  expect((await db.table('extractionTasks').where('runId').equals(run.id).sortBy('ordinal'))[0]).toMatchObject({ status: 'completed', repairCount: 2, stepsUsed: 3 })
  const tables = emptyTables(); for (const name of tableNames) tables[name] = await db.table(name).toArray()
  expect(await validateBookData({ book, tables })).toEqual([])
})

it('单项模型异常及结果约束失败保留错误并继续后续章节', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => stream(JSON.parse(init?.body as string).tools[0].function.parameters.properties.characters ? world : narrative))
  const { service, db } = await setup(fetcher, 2)
  let once = true
  db.table('characters').hook('creating', () => { if (once) { once = false; throw new DOMException('本项数据约束失败', 'DataError') } })
  await service.start('a')
  expect(await service.progress('a')).toMatchObject({ status: 'failed', completedSteps: 3, completedChapters: ['2'] })
  expect(service.state('a')?.error).toBeUndefined()
  expect(service.state('a')?.results[0]).toMatchObject({ ok: false, message: expect.stringContaining('本项数据约束失败') })
})

it('续期到期后其他阶段已取得资源时，旧提取停止写入', async () => {
  const fetcher = vi.fn<typeof fetch>()
  const { service, db } = await setup(fetcher)
  fetcher.mockImplementation(async () => {
    await db.table('pipelineRuns').update('lease:extraction', { expiresAt: 0 })
    await db.table('pipelineRuns').put({ id: 'lease:world', bookId: 'a', recordType: 'lease', owner: 'new', runId: 'other', expiresAt: Date.now() + 30000 })
    return stream(world)
  })
  await service.start('a')
  expect(await db.table('extractionReceipts').count()).toBe(0)
  expect(await db.table('characters').count()).toBe(0)
  expect(await service.progress('a')).toMatchObject({ status: 'paused', failedChapters: [] })
  expect(service.state('a')?.error).toContain('其他处理任务')
})

it('P1保留原始别名，不移动通用称谓', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(stream({ characters: [
    { name: '林如海', confidence: 1, aliases_mentioned: ['爸爸', '姑父', '林姑父'], identity: '官员' },
    { name: '太后', confidence: 1, aliases_mentioned: ['娘娘', '哀家'] },
  ], locations: [] })).mockResolvedValueOnce(stream({ nodes: [{ name: '问候', summary: '问候', actors: ['爸爸', '太后'], quote: '', confidence: 1 }] }))
  const { service, db, book } = await setup(fetcher)
  await service.start('a')
  expect(await db.table('characters').get('C1-P001')).toMatchObject({ aliases: ['爸爸', '姑父', '林姑父'], identity: '官员' })
  expect(await db.table('characters').get('C1-P002')).toMatchObject({ name: '太后', aliases: ['娘娘', '哀家'] })
  expect(await db.table('nodes').get('C1-N001')).toMatchObject({ actors: ['太后', '爸爸'], actorIds: ['C1-P002'] })
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
  expect(await db.table('nodes').get('C1-N001')).toMatchObject({ quoteStatus: 'matched', offset: 0, actorIds: ['C1-P001', 'C1-P002', 'C2-P001', 'C2-P002'] })
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
  expect(await service.progress('a')).toMatchObject({ status: 'paused', completedChapters: [], failedChapters: [] })
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
  const after = await db.table('nodes').toArray()
  expect(after.find(row => row.name === '送信')).toEqual({ ...nodes.find(row => row.name === '送信'), actorIds: ['C1-P001', 'C1-P002'], actorBindings: [{ mention: '沈青', ids: ['C1-P001', 'C1-P002'] }], revision: 2 })
  expect(after.find(row => row.name === '回查')).toEqual(nodes.find(row => row.name === '回查'))
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

it('P1关系按落库人物编号保存，目标全部命中，人物行不再内联关系', async () => {
  const withRelation = { characters: [
    { name: '沈青', confidence: 1, relations: [{ target: '顾衡', relation_type: 'friendship', relation_label: '朋友', reverse_label: '朋友', direction: 'bidirectional', quote: '沈青送信' }] },
    { name: '顾衡', confidence: 1 },
  ], locations: [] }
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(stream(withRelation)).mockResolvedValueOnce(stream({ nodes: [] }))
  const { service, db } = await setup(fetcher)
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  const relations = await db.table('characterRelations').toArray()
  expect(relations).toHaveLength(1)
  expect(relations[0]).toMatchObject({
    originCharacterId: 'C1-P001', sourceName: '沈青', targetName: '顾衡', targetIds: ['C1-P002'],
    relationType: 'friendship', forwardLabel: '朋友', reverseLabel: '朋友', direction: 'bidirectional',
    evidence: [{ chapterIndex: '1', quote: '沈青送信' }], revision: 1,
  })
  expect(await db.table('characters').get('C1-P001')).not.toHaveProperty('relations')
})

it('关系依据不要求逐字匹配本章原文，有简明依据即可保存', async () => {
  const valid = { characters: [{ name: '沈青', confidence: 1, relations: [{ target: '顾衡', relation_type: 'parent_child', relation_label: '父亲', reverse_label: '子女', direction: 'directed', quote: '模型概括的父子关系依据' }] }], locations: [] }
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string)
    return stream(body.tools[0].function.parameters.properties.characters ? valid : { nodes: [] })
  })
  const { service, db } = await setup(fetcher)
  await service.start('a')
  const relations = await db.table('characterRelations').toArray()
  expect(relations).toHaveLength(1)
  expect(relations[0]).toMatchObject({ originCharacterId: 'C1-P001', targetName: '顾衡', evidence: [{ chapterIndex: '1', quote: '模型概括的父子关系依据' }] })
  expect(await db.table('extractionReceipts').get('1:worldAssets')).toBeTruthy()
  expect(service.state('a')?.results.find(row => row.step === 'worldAssets')?.ok).toBe(true)
})

it('两步骤独立记录共享快照，正常进度不读取任务历史和快照', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => stream(JSON.parse(init?.body as string).tools[0].function.parameters.properties.characters ? world : narrative))
  const { service, db } = await setup(fetcher)
  await service.start('a')
  const runId = (await db.table('compileProgress').get('P1')).runId
  const run = await db.table('pipelineRuns').get(runId)
  expect(run).toMatchObject({ taskStorage: 'separate', nextTaskOrdinal: 2 })
  expect(run).not.toHaveProperty('tasks')
  const tasks = await db.table('extractionTasks').where('runId').equals(runId).sortBy('ordinal')
  expect(tasks.map(task => task.status)).toEqual(['completed', 'completed'])
  expect(tasks[0].input.snapshotId).toBe(tasks[1].input.snapshotId)
  expect(tasks[0].inputFingerprint).not.toBe(tasks[1].inputFingerprint)
  expect(await db.table('extractionInputs').count()).toBe(1)
  const rejectHistory = () => { throw new Error('普通进度不应读取任务正文历史') }
  const restore = db instanceof RemoteDatabase ? interceptDisk(db, body => {
    if (['extractionTasks', 'extractionInputs'].includes(String(body.table)) && ['get', 'bulkGet', 'query'].includes(String(body.action)) && !(body.query as { keysOnly?: boolean })?.keysOnly) rejectHistory()
  }) : (() => {
    db.table('extractionTasks').hook('reading', rejectHistory)
    db.table('extractionInputs').hook('reading', rejectHistory)
    return () => {
      db.table('extractionTasks').hook('reading').unsubscribe(rejectHistory)
      db.table('extractionInputs').hook('reading').unsubscribe(rejectHistory)
    }
  })()
  try { expect(await service.progress('a')).toMatchObject({ status: 'completed', completedSteps: 2 }) }
  finally { restore() }
})

it('继续旧运行迁移失败不改原任务；重试保留历史正文并完成新任务', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => stream(JSON.parse(init?.body as string).tools[0].function.parameters.properties.characters ? world : narrative))
  const { service, db } = await setup(fetcher), timestamp = new Date().toISOString()
  const original: StoredTask = { taskId: 'old-task', ordinal: 0, callId: 'old-call', phase: 'worldAssets', status: 'failed', workItemIds: ['P1:worldAssets:chapter:1'], input: { chapterIndex: '1', chapterName: '历史章名', text: '历史正文，不是现在的章节正文。' }, inputFingerprint: 'old-input-proof', promptHash: 'old-prompt', attempt: 1, repairCount: 0, stepsUsed: 1, appliedCommitIds: [], reviewedItems: [], readSet: { records: [], queries: [] }, createdAt: timestamp, updatedAt: timestamp, lastError: { code: 'network', message: '旧失败' } }
  const legacy = { id: 'legacy-run', bookId: 'a', recordType: 'run', stage: 'P1', status: 'paused', startedAt: timestamp, planVersion: '2.2', tasks: [original] }
  await db.table('pipelineRuns').put(legacy)
  await db.table('compileProgress').update('P1', { status: 'paused', runId: legacy.id })
  const rejectMigration = () => { throw new Error('模拟旧任务迁移失败') }
  const restore = db instanceof RemoteDatabase ? interceptDisk(db, body => {
    if (body.table === 'extractionTasks' && (body.action === 'add' || body.action === 'bulk' && body.add)) rejectMigration()
  }) : (() => { db.table('extractionTasks').hook('creating', rejectMigration); return () => db.table('extractionTasks').hook('creating').unsubscribe(rejectMigration) })()
  await service.start('a')
  expect(service.state('a')?.error).toContain('模拟旧任务迁移失败')
  expect(fetcher).not.toHaveBeenCalled()
  expect(await db.table('pipelineRuns').get(legacy.id)).toEqual(legacy)
  expect(await db.table('extractionInputs').count()).toBe(0)
  expect(await db.table('pipelineRuns').where('recordType').equals('lease').count()).toBe(0)
  restore()
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(await db.table('pipelineRuns').get(legacy.id)).toMatchObject({ status: 'completed', taskStorage: 'separate', nextTaskOrdinal: 3 })
  const tasks = await db.table('extractionTasks').where('runId').equals(legacy.id).sortBy('ordinal')
  expect(tasks).toHaveLength(3)
  expect(tasks[0]).toMatchObject({ inputFingerprint: original.inputFingerprint, lastError: original.lastError, status: 'failed' })
  expect(await readExtractionInput(db, tasks[0])).toEqual(original.input)
  expect(tasks.slice(1).map(task => task.status)).toEqual(['completed', 'completed'])
})

it('任务完成记录失败时资产与凭证一同回滚，失败任务仍可重试', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => stream(world))
  const { service, db } = await setup(fetcher)
  const failCompletion = (changes: unknown) => {
    if ((changes as { status?: string }).status === 'completed') throw Object.assign(new Error('模拟任务完成保存失败'), { name: 'ConstraintError' })
  }
  const restore = db instanceof RemoteDatabase ? interceptDisk(db, body => {
    if (body.table === 'extractionTasks' && body.action === 'put') failCompletion(body.value)
  }) : (() => { db.table('extractionTasks').hook('updating', failCompletion); return () => db.table('extractionTasks').hook('updating').unsubscribe(failCompletion) })()
  await service.retry('a', '1', 'worldAssets')
  expect(await db.table('characters').count()).toBe(0)
  expect(await db.table('locations').count()).toBe(0)
  expect(await db.table('assetLifecycle').count()).toBe(0)
  expect(await db.table('extractionReceipts').count()).toBe(0)
  expect((await db.table('extractionTasks').toArray()).map(task => task.status)).toEqual(['failed'])
  restore()
  await service.retry('a', '1', 'worldAssets')
  expect(await db.table('extractionReceipts').get('1:worldAssets')).toBeDefined()
  expect((await db.table('extractionTasks').toCollection().sortBy('ordinal')).map(task => task.status)).toEqual(['failed', 'completed'])
  expect(await db.table('extractionInputs').count()).toBe(1)
})
