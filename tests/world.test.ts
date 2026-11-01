import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createAssetService } from '../src/features/assets/service'
import { createModelService } from '../src/features/models/service'
import { createWorldService } from '../src/features/world/service'
import { aliasScore, findCandidates, normalizeName } from '../src/features/world/candidates'
import { needsOptimization, optimizationRequest } from '../src/features/world/optimization'
import { defaultConfig } from '../src/features/models/types'
import type { Character } from '../src/features/assets/types'
import { agentStream } from './support/agent-protocol'
import { readTool } from '../src/features/agents/queries'
import { createMemoryAgentRepository } from '../src/features/agents/repository'
import { resultContracts, validate } from '../src/features/agents/contracts'
import { createAgentTools } from '../src/features/agents/tools'
import { createBookAgentRepository } from '../src/features/agents/repository'
import { saveIdentityQueue } from '../src/features/world/queue'
import { emptyReport } from '../src/features/world/types'
import { emptyTables, tableNames, validateBookData } from '../src/features/backup/data'
import { hash } from '../src/features/agents/contracts'
import { createBackupService } from '../src/features/backup/service'
import { createImportService } from '../src/lib/storage/importService'

const opened: ReturnType<typeof createWorkspace>[] = []
const person = (id: string, name: string, extra = {}): Character => ({ id, bookId: 'a', name, aliases: [], confidence: 1, revision: 1, createdBy: 'P1', chapterIndex: '1', chapterName: '第1章', ...extra })

it('旧失败报告的61条长资料在事务外计算指纹，恢复后追加小批且保留旧用量', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => reviewedBatch(JSON.parse(init?.body as string)))
  const { workspace, db, models, service } = await setup(fetcher)
  await db.table('characters').clear(); await db.table('locations').clear()
  await db.table('characters').bulkPut(Array.from({ length: 41 }, (_, i) => person(`P${i}`, `人物${i}`, { background: '原文资料。'.repeat(600) })))
  await db.table('locations').bulkPut(Array.from({ length: 20 }, (_, i) => ({ ...person(`L${i}`, `地点${i}`), description: '原文地点资料。'.repeat(100) })))
  const workItems = (await db.table('characters').toArray()).map(row => ({ workItemId: `ai_identity:fullBook:character:${row.id}`, kind: 'character', id: row.id, revision: row.revision, factFingerprint: 'old' }))
  const oldReport = { ...emptyReport({ characters: 41, locations: 20 }), status: 'failed', usage: { input: 96000, output: 489, totalTokens: 96489, cost: 0.009888, costStatus: 'estimated' }, cost: 0.009888, failed: ['旧请求预算耗尽'] }
  await db.table('pipelineRuns').put({ id: 'legacy-run', bookId: 'a', recordType: 'run', stage: 'P2', phase: 'ai', status: 'failed', startedAt: new Date().toISOString(), report: oldReport, usage: oldReport.usage, tasks: [{ taskId: 'legacy-task', phase: 'ai_identity', stepsUsed: 6, status: 'partial', input: { workItems }, workItemIds: workItems.map(row => row.workItemId), readSet: { records: [], queries: [] }, appliedCommitIds: [], reviewedItems: [] }], commandIntents: [], appliedCommands: [] })
  await db.table('compileProgress').put({ bookId: 'a', stage: 'P2', status: 'failed', runId: 'legacy-run' })
  const originalDigest = crypto.subtle.digest.bind(crypto.subtle), contexts: boolean[] = []
  const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation((...args: Parameters<typeof crypto.subtle.digest>) => { contexts.push(!!Dexie.currentTransaction); return originalDigest(...args) })
  try { await saveIdentityQueue(createBookAgentRepository(workspace, 'a'), 'legacy-run') } finally { spy.mockRestore() }
  expect(contexts).toHaveLength(61); expect(contexts.every(value => !value)).toBe(true)
  // Keep the identity-only fixture short enough to skip the independent detail optimization stage.
  await db.table('characters').toCollection().modify({ background: '' }); await db.table('locations').toCollection().modify({ description: '' })
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://world-fixture.invalid/v1' }, 'fake-key')
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  const report = (await service.reports('a'))[0]
  expect(report.id).toBe('legacy-run'); expect(report.coverage).toMatchObject({ checked: 61, pendingIds: [] })
  expect(report.tasks!.slice(1).every(task => (task.workItemIds as string[]).length === 1)).toBe(true)
  expect(report.report.usage.totalTokens).toBe(96489)
}, 30000)

it('三个以上同名人物的查询评分保持有效，身份核实的详情工具明确关闭事实底稿参数', async () => {
  const repo = createMemoryAgentRepository('a', { characters: Array.from({ length: 4 }, (_, i) => person(`person-${i}`, '同名人物')) as unknown as Record<string, unknown>[] })
  const scope = { bookId: 'a', profile: 'asset_editor' as const, phase: 'ai_identity', runId: 'run', taskId: 'task', owner: 'owner', workItemIds: [] }
  const result = await repo.transaction(false, store => readTool(store, scope, 'query_characters', {}))
  expect(() => validate(resultContracts.get('query_characters')!, result)).not.toThrow()
  expect((result.data as { duplicateScore: number }[]).every(row => row.duplicateScore === 1)).toBe(true)
  const tools = createAgentTools(repo, scope)
  expect((tools.tools.find(tool => tool.name === 'get_character_detail')!.parameters as unknown as { properties: Record<string, unknown> }).properties.include_facts).toEqual({ type: 'boolean', const: false })
})
async function setup(fetcher = vi.fn<typeof fetch>(), complete = true) {
  const id = crypto.randomUUID(); const workspace = createWorkspace({ settingsName: `world-${id}`, bookPrefix: `world-book-${id}-` }); opened.push(workspace)
  const book = { id: 'a', title: '世界整理样本', sourceFileName: 'world.txt', createdAt: new Date().toISOString() }; await workspace.settings.books.put(book)
  const db = workspace.openBook('a'); const text = '沈青又叫老沈，两人所指均为同一位船夫。青石客栈也叫青石栈。'
  await db.chapters.put({ bookId: 'a', chapterIndex: '1', chapterName: '第1章', order: 0, charCount: text.length }); await db.table('chapterTexts').put({ bookId: 'a', chapterIndex: '1', text })
  await db.table('characters').bulkPut([person('C1-P001', '沈青'), person('C1-P002', '老沈'), person('C1-P003', '张三'), person('C1-P004', '张三丰')])
  await db.table('locations').bulkPut([{ ...person('C1-L001', '青石客栈'), description: '镇上的客栈' }, { ...person('C1-L002', '青石栈'), description: '同一家客栈' }])
  if (complete) await db.table('extractionReceipts').bulkPut(['worldAssets', 'narrativeAssets'].map(step => ({ key: `1:${step}`, bookId: 'a', chapterIndex: '1', substep: step, inputFingerprint: 'fixture', originIds: [], committedAt: book.createdAt, runId: 'extract-fixture' })))
  const assets = createAssetService(workspace); const models = createModelService(workspace, { fetch: fetcher, wait: async (_ms, signal) => signal.throwIfAborted() })
  const service = createWorldService(workspace, models, assets)
  return { workspace, db, book, models, assets, service, fetcher }
}
afterEach(async () => { for (const workspace of opened.splice(0)) { workspace.close(); for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name) } })
it('名称归一化和严格阈值生成候选，同名和包含均保持原资料', () => {
  expect(normalizeName(' 沈青（修订版） ')).toBe('沈青')
  expect(aliasScore(['abcdefghij'], ['abcdefghiX'])).toBe(0.9)
  expect(findCandidates('character', [person('1', 'abcdefghij'), person('2', 'abcdefghiX')])).toHaveLength(0)
  expect(findCandidates('character', [person('1', '张三'), person('2', '张三丰')])).toHaveLength(1)
  expect(findCandidates('location', [person('1', '王府'), person('2', '王府花园')])).toHaveLength(0)
  expect(findCandidates('character', [person('1', '沈青'), person('2', '沈青')])[0].memberIds).toEqual(['1', '2'])
})
it('代码扫描与预览不调用模型，确认后合并并原子保存报告，过期预览拒绝', async () => {
  const { assets, service, db, fetcher, book } = await setup()
  await db.table('characters').update('C1-P002', { name: '沈青', identity: '同名资料' })
  const candidates = await service.scan('a')
  expect(candidates).toHaveLength(2)
  expect(await db.table('characters').count()).toBe(4)
  const preview = await assets.previewMerge('a', 'character', { memberIds: ['C1-P001', 'C1-P002'], keepId: 'C1-P001', canonicalName: '沈青' })
  await service.confirm('a', 'character', preview.request)
  expect(await db.table('characters').count()).toBe(3)
  expect((await service.reports('a'))[0].report.groups[0].method).toBe('mechanical')
  await expect(service.confirm('a', 'character', preview.request)).rejects.toThrow()
  expect(fetcher).not.toHaveBeenCalled()
  const tables = emptyTables(); for (const name of tableNames) tables[name] = await db.table(name).toArray()
  expect(await validateBookData({ book, tables })).toEqual([])
})
it('未完成提取时两个入口均拒绝，代码整理不要求配置密钥', async () => {
  const { service } = await setup(vi.fn(), false)
  await expect(service.scan('a')).rejects.toThrow('先完成')
  await service.start('a'); expect(service.state('a')?.error).toContain('先完成')
})
function identityFetcher(options: { failureAfterCommit?: boolean } = {}) {
  return vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string)
    const messages = body.messages as { role: string; content: unknown }[]
    const lastUser = messages.filter(row => row.role === 'user').map(row => typeof row.content === 'string' ? row.content : (row.content as { text: string }[]).map(part => part.text).join('')).find(value => value.startsWith('{'))!
    const input = JSON.parse(lastUser)
    const replies = messages.filter(row => row.role === 'tool').map(row => { try { return JSON.parse(String(row.content)) } catch { return {} } })
    const commit = replies.find(row => row.ok)
    if (commit && options.failureAfterCommit) return new Response('{"error":{"message":"invalid key"}}', { status: 401 })
    if (replies.length && (commit || input.kind === 'location' || !['C1-P001', 'C1-P002'].every(id => replies.some(row => row.data?.some((item: { id: string }) => item.id === id))))) return agentStream([{ name: 'submit_result', args: { status: 'completed', commitIds: commit ? [commit.commitId] : [], summary: '已核对同人多名与同名异人', remainingWorkIds: [], reviewedItems: input.workItems.map((work: { id: string; workItemId: string }) => ({ workItemId: work.workItemId, outcome: commit && ['C1-P001', 'C1-P002'].includes(work.id) ? 'changed' : 'no_change', reason: '核对原文后确认' })) } }])
    if (replies.length && input.kind === 'character') return agentStream([{ name: 'commit_asset_changes', args: { operationKey: input.resume.nextOperationKey, payload: { groups: [{ kind: 'character', keepId: 'C1-P001', memberIds: ['C1-P001', 'C1-P002'], canonicalName: '沈青', confidence: 1, reason: '原文说明同人', evidence: [{ chapterIndex: '1', quote: '沈青又叫老沈，两人所指均为同一位船夫。', memberIds: ['C1-P001', 'C1-P002'] }] }] } } }])
    return agentStream([{ name: input.kind === 'character' ? 'get_character_detail' : 'get_location_detail', args: { ids: input.kind === 'character' && input.workItems[0].id === 'C1-P001' ? ['C1-P001', 'C1-P002'] : input.workItems.map((work: { id: string }) => work.id) } }, ...(input.kind === 'character' ? [{ name: 'read_original', args: { asset_ids: input.workItems.map((work: { id: string }) => work.id) } }] : [])])
  })
}
it('AI整理复用Pi按证据合并，保持其他人物与地点，最终报告可备份', async () => {
  const fetcher = identityFetcher(); const { models, service, db, book } = await setup(fetcher)
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://world-fixture.invalid/v1' }, 'fake-key')
  await service.start('a')
  expect(service.state('a')?.error, JSON.stringify(fetcher.mock.calls.map(([, init]) => JSON.parse(init?.body as string).messages.filter((row: { role: string }) => row.role === 'tool')))).toBeUndefined()
  expect(await db.table('characters').count()).toBe(3)
  expect(await db.table('characters').get('C1-P004')).toMatchObject({ name: '张三丰' })
  expect(await db.table('locations').count()).toBe(2)
  const report = (await service.reports('a'))[0]
  expect(report.status).toBe('completed'); expect(report.report.groups).toHaveLength(1)
  expect(report.report.beforeCounts.characters).toBe(4); expect(report.report.afterCounts.characters).toBe(3)
  expect(await db.table('pipelineRuns').get('lease:world')).toBeUndefined()
  const tables = emptyTables(); for (const name of tableNames) tables[name] = await db.table(name).toArray()
  expect(await validateBookData({ book, tables })).toEqual([])
})
it('整编按事实生成约束，短内容跳过，超长内容触发且漏事实被拒绝', async () => {
  expect(needsOptimization('character', person('1', '沈青'))).toBe(false)
  expect(needsOptimization('character', person('1', '沈青', { background: 'a'.repeat(1801), mergeFacts: [{ id: 'F-old', field: 'background', text: '原始事实', chapters: ['1'] }] }))).toBe(true)
  const row = person('1', '沈青', { background: '长篇事实；'.repeat(500), mergeFacts: [{ id: 'first', field: 'background', text: '不可删除的事实', chapters: ['1'] }], mergeNotes: ['背景冲突'] })
  expect(needsOptimization('character', row)).toBe(true)
  const request = await optimizationRequest('character', row)
  const content = { entities: { '1': { entity: { name: '沈青', aliases: [], background: '不可删除的事实' }, covered_fact_ids: ['F1'], merge_notes: [] } } }
  expect(request.validate({ content: [{ type: 'toolCall', id: 'one', name: 'submit_result', arguments: content }] } as never).fields).toMatchObject({ background: '不可删除的事实' })
  content.entities['1'].covered_fact_ids = []
  expect(() => request.validate({ content: [{ type: 'toolCall', id: 'one', name: 'submit_result', arguments: content }] } as never)).toThrow()
})


it('AI写入后失败保留已提交组，报告说明失败且释放锁', async () => {
  const { models, service, db } = await setup(identityFetcher({ failureAfterCommit: true }))
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://world-fixture.invalid/v1' }, 'fake-key')
  await service.start('a')
  expect(service.state('a')?.error).toBeTruthy()
  expect(await db.table('characters').count()).toBe(3)
  const report = (await service.reports('a'))[0]
  expect(report.status).toBe('failed'); expect(report.report.groups).toHaveLength(1)
  expect(report.report.failed.length).toBeGreaterThan(0)
  expect(await db.table('pipelineRuns').get('lease:world')).toBeUndefined()
})

it('运行中锁定同书人物地点、允许其他书操作，取消等待请求停稳', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('已取消', 'AbortError')), { once: true }) }))
  const { models, service, assets, workspace, db } = await setup(fetcher)
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://world-fixture.invalid/v1' }, 'fake-key')
  await workspace.settings.books.put({ id: 'b', title: '另一本', sourceFileName: 'other.txt', createdAt: new Date().toISOString() })
  const running = service.start('a')
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
  await expect(assets.update('a', 'character', 'C1-P001', 1, { identity: '尝试修改' })).rejects.toMatchObject({ code: 'ASSET_DOMAIN_LOCKED' })
  await expect(service.scan('a')).rejects.toThrow('正在运行')
  await assets.create('b', 'character', { name: '他书人物', manualSourceNote: '人工' })
  service.cancel('a'); await running
  expect((await service.reports('a'))[0].status).toBe('cancelled')
  expect(await db.table('pipelineRuns').get('lease:world')).toBeUndefined()
  expect(await db.table('characters').count()).toBe(4)
})

it('人物地点按需整编完整覆盖事实，保留底稿与人工主名，失败保留原文', async () => {
  const identify = identityFetcher(); let omitFacts = false; let optimizationCalls = 0
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const body = JSON.parse(init?.body as string)
    if (body.tools.length !== 1) return identify(url, init)
    if (body.tools[0].function.parameters.properties.approved) return agentStream([{ name: 'submit_result', args: { approved: true, summary: '事实完整，表述清晰。', issues: [] } }])
    optimizationCalls++
    const user = body.messages.find((row: { role: string }) => row.role === 'user')
    const input = JSON.parse(typeof user.content === 'string' ? user.content : user.content.map((part: { text: string }) => part.text).join(''))
    if (input.entities) {
      const row = input.entities[0]
      const fields = Object.fromEntries(row.facts.map((fact: { field: string; text: string }) => [fact.field, fact.text]))
      return agentStream([{ name: 'submit_result', args: { entities: { [row.id]: { entity: { name: row.name, aliases: row.aliases, ...fields }, covered_fact_ids: omitFacts ? [] : row.facts.map((fact: { id: string }) => fact.id), merge_notes: [] } } } }])
    }
    return agentStream([{ name: 'submit_result', args: { description: '镇上的同一间客栈', coveredFactIds: omitFacts ? [] : input.facts.map((fact: { id: string }) => fact.id), conflicts: [] } }])
  })
  const { service, models, db, book } = await setup(fetcher)
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://world-fixture.invalid/v1', aggregationContextWindow: 65536 }, 'fake-key')
  await db.table('characters').update('C1-P003', { nameSource: 'manual', background: '独有背景事实', mergeNotes: ['需整编'], mergeFacts: [{ id: 'F-original', field: 'background', text: '独有背景事实', chapters: ['1'] }] })
  await db.table('locations').update('C1-L001', { mergeNotes: ['需整编'] })
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect(optimizationCalls).toBe(2)
  expect(await db.table('characters').get('C1-P003')).toMatchObject({ name: '张三', background: '独有背景事实', mergeFacts: [{ id: 'F-original', field: 'background', text: '独有背景事实' }], optimizedFactIds: ['F-original'] })
  expect((await service.reports('a'))[0].report.optimizedIds).toHaveLength(1)
  expect((await service.reports('a'))[0].report.optimizations).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'no_change' }), expect.objectContaining({ status: 'applied', review: expect.objectContaining({ approved: true }) })]))
  const tables = emptyTables(); for (const name of tableNames) tables[name] = await db.table(name).toArray()
  expect(await validateBookData({ book, tables })).toEqual([])
  await db.table('locations').update('C1-L001', { description: '新增事实需要整理', mergeFacts: [{ id: 'new-fact', field: 'description', text: '新增事实需要整理', chapters: ['1'] }] })
  omitFacts = true
  await service.start('a')
  expect((await service.reports('a'))[0].status, JSON.stringify({ state: service.state('a'), report: (await service.reports('a'))[0].report.failed })).toBe('degraded')
  expect(await db.table('locations').get('C1-L001')).toMatchObject({ description: '新增事实需要整理' })
})

function taskInput(body: { messages: { role: string; content: string | { text: string }[] }[] }) {
  return JSON.parse(body.messages.filter(row => row.role === 'user').map(row => typeof row.content === 'string' ? row.content : row.content.map(part => part.text).join('')).find(value => value.startsWith('{'))!)
}

it('百万上下文整编超6000的长档案，归并短句且保留底稿，旧规则完成标记可重新整编', async () => {
  let optimizationCalls = 0
  const original = '曾在北地从军，熟悉边塞军务。'.repeat(1200)
  const facts = [{ id: 'bg', field: 'background', text: original, chapters: ['1'] }, { id: 'a', field: 'personality', text: '性情沉稳，处事果断', chapters: ['1'] }, { id: 'b', field: 'personality', text: '为人沉稳，遇事果决', chapters: ['2'] }, { id: 'c', field: 'personality', text: '精于谋略', chapters: ['2'] }]
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string)
    if (body.tools.length !== 1) return reviewedBatch(body)
    if (body.tools[0].function.parameters.properties.approved) return agentStream([{ name: 'submit_result', args: { approved: true, summary: '独有事实保留，近义表述已归并。', issues: [] } }])
    optimizationCalls++
    const input = taskInput(body), row = input.entities[0]
    expect(row.facts).toHaveLength(4)
    expect(row.facts.some((fact: { text: string }) => fact.text === original)).toBe(true)
    expect(JSON.stringify(body).length).toBeGreaterThan(6000)
    return agentStream([{ name: 'submit_result', args: { entities: { [row.id]: { entity: { name: row.name, aliases: row.aliases, background: '曾在北地从军，熟悉边塞军务。', personality: '性情沉稳，处事果断，精于谋略' }, covered_fact_ids: row.facts.map((fact: { id: string }) => fact.id), merge_notes: [] } } } }])
  })
  const { db, service, models, book } = await setup(fetcher)
  await db.table('characters').clear(); await db.table('locations').clear()
  await db.table('characters').put(person('P1', '沈青', { nameSource: 'manual', background: original, personality: '性情沉稳，处事果断；为人沉稳，遇事果决；精于谋略', mergeFacts: facts }))
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://world-fixture.invalid/v1', aggregationContextWindow: 1000000 }, 'fake-key')
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect((await service.reports('a'))[0].status).toBe('completed')
  expect(optimizationCalls).toBe(1)
  const result = await db.table<Character>('characters').get('P1')
  expect(result).toMatchObject({ name: '沈青', nameSource: 'manual', personality: '性情沉稳，处事果断，精于谋略', background: '曾在北地从军，熟悉边塞军务。', mergeFacts: expect.arrayContaining(facts) })
  await service.start('a')
  expect(optimizationCalls).toBe(1)
  const request = await optimizationRequest('character', result!)
  const oldFingerprint = await hash({ version: '2.2', names: ['沈青'], facts: request.facts, notes: result!.mergeNotes ?? [] })
  await db.table('characters').update('P1', { optimizationFingerprint: oldFingerprint })
  await service.start('a')
  expect(optimizationCalls).toBe(2)
  expect(await db.table('characters').get('P1')).toMatchObject({ optimizationFingerprint: request.fingerprint, mergeFacts: expect.arrayContaining(facts) })
  const tables = emptyTables(); for (const name of tableNames) tables[name] = await db.table(name).toArray()
  expect(await validateBookData({ book, tables })).toEqual([])
}, 30000)

it('整编真正超出模型上下文时说明容量与预留，保留原档案而不发送超限请求', async () => {
  let optimizationCalls = 0
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string)
    if (body.tools.length === 1) { optimizationCalls++; throw new Error('超限资料不应请求模型') }
    return reviewedBatch(body)
  })
  const { db, service, models } = await setup(fetcher)
  await db.table('characters').clear(); await db.table('locations').clear()
  const original = '独有的人物背景与经历。'.repeat(1200)
  await db.table('characters').put(person('P1', '沈青', { background: original }))
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://world-fixture.invalid/v1', aggregationContextWindow: 8192 }, 'fake-key')
  await service.start('a')
  expect(optimizationCalls).toBe(0)
  expect((await service.reports('a'))[0]).toMatchObject({ status: 'degraded', report: { failed: [expect.stringContaining('超出整理模型上下文8192 token')] } })
  expect(await db.table('characters').get('P1')).toMatchObject({ background: original })
})
function reviewedBatch(body: Parameters<typeof taskInput>[0], partial = false) {
  const input = taskInput(body)
  const results = body.messages.filter(row => row.role === 'tool')
  if (!results.length) return agentStream([{ name: input.kind === 'character' ? 'get_character_detail' : 'get_location_detail', args: { ids: input.workItems.map((row: { id: string }) => row.id) } }])
  const reviewed = partial ? input.workItems.slice(0, 2) : input.workItems
  return agentStream([{ name: 'submit_result', args: { status: reviewed.length < input.workItems.length ? 'partial' : 'completed', commitIds: [], summary: '本批已核实，剩余资料排队继续。', reviewedItems: reviewed.map((row: { workItemId: string }) => ({ workItemId: row.workItemId, outcome: 'no_change', reason: '当前资料身份不同，保持分开。' })), remainingWorkIds: input.workItems.slice(reviewed.length).map((row: { workItemId: string }) => row.workItemId) } }])
}
function withUsage(response: Response) {
  return response.text().then(text => new Response(text.replace('data: [DONE]', `data: ${JSON.stringify({ id: 'usage', object: 'chat.completion.chunk', model: 'fixture', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]`), { headers: { 'Content-Type': 'text/event-stream' } }))
}

it.each(['rejected', 'failed'] as const)('整编复核%s时保留原资料并继续其他资产，继续处理复用待复核稿', async failure => {
  let failReview = true
  const generated: string[] = [], reviewed: string[] = []
  const facts = [{ id: 'a', field: 'personality', text: '性情沉稳，处事果断', chapters: ['1'] }, { id: 'b', field: 'personality', text: '为人沉稳，遇事果决', chapters: ['1'] }]
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string), input = taskInput(body)
    if (body.tools.length !== 1) return reviewedBatch(body)
    if (input.phase === 'quality_review') {
      reviewed.push(input.name)
      if (failReview && input.name === '甲') {
        if (failure === 'failed') return new Response('{"error":{"message":"fixture rejected key"}}', { status: 401 })
        return withUsage(agentStream([{ name: 'submit_result', args: { approved: false, summary: '遗漏了沉稳性格。', issues: [{ kind: 'omission', field: 'personality', factIds: ['F1', 'F2'], message: '稿件遗漏沉稳，须补回。' }] } }]))
      }
      return withUsage(agentStream([{ name: 'submit_result', args: { approved: true, summary: '事实保留且无近义重复。', issues: [] } }]))
    }
    const row = input.entities[0]; generated.push(row.name)
    return withUsage(agentStream([{ name: 'submit_result', args: { entities: { [row.id]: { entity: { name: row.name, aliases: [], personality: failReview && failure === 'rejected' && row.name === '甲' ? '处事果断' : '性情沉稳，处事果断' }, covered_fact_ids: row.facts.map((fact: { id: string }) => fact.id), merge_notes: [] } } } }]))
  })
  const { service, models, db, book, workspace } = await setup(fetcher)
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://world-fixture.invalid/v1' }, 'fake-key')
  await db.table('characters').clear(); await db.table('locations').clear()
  const original = '性情沉稳，处事果断；为人沉稳，遇事果决'
  await db.table('characters').bulkPut(['甲', '乙'].map((name, index) => person(`P${index + 1}`, name, { personality: original, mergeFacts: facts })))
  await service.start('a')
  const first = (await service.reports('a'))[0]
  expect(first.status).toBe('degraded'); expect(generated).toEqual(['甲', '乙']); expect(reviewed).toEqual(['甲', '乙'])
  expect(await db.table('characters').get('P1')).toMatchObject({ personality: original, mergeFacts: facts })
  expect(await db.table('characters').get('P2')).toMatchObject({ personality: '性情沉稳，处事果断', mergeFacts: facts })
  expect(first.report.optimizations).toEqual([expect.objectContaining({ assetId: 'P1', status: failure === 'failed' ? 'pending_review' : 'rejected', before: { personality: original, identity: '', appearance: '', background: '' } }), expect.objectContaining({ assetId: 'P2', status: 'applied', review: { approved: true, summary: expect.any(String), issues: [] } })])
  const pendingBackup = failure === 'failed' ? await (async () => {
    const importer = createImportService(workspace)
    try { return await createBackupService(workspace, importer).exportBook('a') } finally { importer.close() }
  })() : undefined
  failReview = false
  await service.start('a')
  const last = (await service.reports('a'))[0]
  expect(last.id).toBe(first.id); expect(last.status).toBe('completed')
  expect(generated).toHaveLength(failure === 'failed' ? 2 : 3)
  expect(reviewed).toEqual(['甲', '乙', '甲'])
  expect(last.report.optimizedIds).toEqual(['P2', 'P1'])
  expect(last.report.usage.totalTokens).toBe(failure === 'failed' ? 48 : 72)
  const tables = emptyTables(); for (const name of tableNames) tables[name] = await db.table(name).toArray()
  expect(await validateBookData({ book, tables })).toEqual([])
  if (failure === 'failed') {
    const importer = createImportService(workspace), backups = createBackupService(workspace, importer)
    try {
      const copy = await backups.importBackup(pendingBackup!.bytes)
      const before = generated.length
      const restored = createWorldService(workspace, models, createAssetService(workspace))
      await restored.start(copy.id)
      expect(restored.state(copy.id)?.error).toBeUndefined()
      expect(generated).toHaveLength(before)
      expect((await restored.reports(copy.id))[0].report.optimizations?.map(item => item.status)).toEqual(['applied', 'applied'])
    } finally { importer.close() }
  }
})

it.each(['changed', 'cleared', 'deleted'] as const)('复核中取消保留稿件，人工资料%s后继续按当前资料处理且旧稿过期', async edit => {
  let holdReview = true, generationCalls = 0, reviewCalls = 0
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string), input = taskInput(body)
    if (body.tools.length !== 1) return reviewedBatch(body)
    if (input.phase === 'quality_review') {
      reviewCalls++
      if (holdReview) return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('已取消', 'AbortError')), { once: true }))
      return agentStream([{ name: 'submit_result', args: { approved: true, summary: '事实完整。', issues: [] } }])
    }
    generationCalls++
    const row = input.entities[0]
    return agentStream([{ name: 'submit_result', args: { entities: { [row.id]: { entity: { name: row.name, aliases: row.aliases, personality: generationCalls > 1 ? '沉稳果断，善于谋划' : '沉稳果断' }, covered_fact_ids: row.facts.map((fact: { id: string }) => fact.id), merge_notes: [] } } } }])
  })
  const { service, models, db, assets } = await setup(fetcher)
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://world-fixture.invalid/v1' }, 'fake-key')
  await db.table('characters').clear(); await db.table('locations').clear()
  await db.table('characters').put(person('P1', '沈青', { personality: '沉稳；果断', mergeFacts: [{ id: 'f1', field: 'personality', text: '沉稳', chapters: ['1'] }, { id: 'f2', field: 'personality', text: '果断', chapters: ['1'] }] }))
  const running = service.start('a'); await vi.waitFor(() => expect(reviewCalls).toBe(1))
  service.cancel('a'); await running
  expect((await service.reports('a'))[0]).toMatchObject({ status: 'cancelled', report: { optimizations: [expect.objectContaining({ status: 'pending_review' })] } })
  const row = await db.table('characters').get('P1')
  if (edit === 'deleted') await assets.remove('a', 'character', 'P1', row!.revision)
  else await assets.update('a', 'character', 'P1', row!.revision, { personality: edit === 'changed' ? '沉稳；果断；善于谋划' : '' })
  holdReview = false; await service.start('a')
  expect(generationCalls).toBe(edit === 'changed' ? 2 : 1); expect(reviewCalls).toBe(edit === 'changed' ? 2 : 1)
  if (edit === 'deleted') expect(await db.table('characters').get('P1')).toBeUndefined()
  else expect(await db.table('characters').get('P1')).toMatchObject({ personality: edit === 'changed' ? '沉稳果断，善于谋划' : '' })
  expect((await service.reports('a'))[0].report.optimizations?.map(item => item.status)).toEqual(edit === 'changed' ? ['stale', 'applied'] : ['stale'])
})

it('AI别名纠正使用真实提交，统计核实称呼且报告和备份保存纠正依据', async () => {
  const quote = '沈青又叫老沈，两人所指均为同一位船夫。张三是另一个人，与沈青不同。'
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string), input = taskInput(body)
    if (input.workItems[0].id !== 'C1-P001') return reviewedBatch(body)
    const replies = body.messages.filter((row: { role: string }) => row.role === 'tool').map((row: { content: string }) => JSON.parse(row.content))
    const commit = replies.find((row: { ok?: boolean }) => row.ok)
    if (commit) return agentStream([{ name: 'submit_result', args: { status: 'completed', commitIds: [commit.commitId], summary: '已核实并纠正别名。', remainingWorkIds: [], reviewedItems: [{ workItemId: input.workItems[0].workItemId, outcome: 'changed', reason: '核实老沈并移除张三。' }] } }])
    if (!replies.length) return agentStream([{ name: 'get_character_detail', args: { ids: ['C1-P001', 'C1-P003'] } }, { name: 'read_original', args: { chapter_indices: ['1'] } }])
    return agentStream([{ name: 'commit_asset_changes', args: { operationKey: input.resume.nextOperationKey, payload: { groups: [], aliasChecks: [{ kind: 'character', id: 'C1-P001', decisions: [{ alias: '老沈', decision: 'keep', confidence: 1, reason: '原文确指同一船夫', evidence: [{ chapterIndex: '1', quote: '沈青又叫老沈，两人所指均为同一位船夫。' }] }, { alias: '张三', decision: 'remove', confidence: 1, reason: '原文说明为另一人', referentId: 'C1-P003', evidence: [{ chapterIndex: '1', quote: '张三是另一个人，与沈青不同。' }] }] }] } } }])
  })
  const { service, models, db, book } = await setup(fetcher)
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://world-fixture.invalid/v1' }, 'fake-key')
  await db.table('chapterTexts').update('1', { text: quote }); await db.chapters.update('1', { charCount: quote.length })
  await db.table('characters').update('C1-P001', { aliases: ['老沈', '张三'] })
  await db.table('characters').delete('C1-P002')
  await service.start('a')
  const run = (await service.reports('a'))[0]
  expect(run.status).toBe('completed'); expect(run.report.aliasChecks).toHaveLength(1)
  expect(run.report.aliasChecks![0]).toMatchObject({ beforeAliases: ['老沈', '张三'], afterAliases: ['老沈'], verifiedAliases: ['老沈'], commitId: expect.any(String) })
  expect(await db.table('characters').get('C1-P001')).toMatchObject({ aliases: ['老沈'], verifiedAliases: ['老沈'], frequency: { mentions: 3 } })
  const tables = emptyTables(); for (const name of tableNames) tables[name] = await db.table(name).toArray()
  expect(await validateBookData({ book, tables })).toEqual([])
})

it.each([1, 3])('%i项证据提交失败后继续其余资产，重开时只处理失败项', async failedCount => {
  let rejectEvidence = true
  const failedIds = Array.from({ length: failedCount }, (_, i) => `C1-P${String(i + 1).padStart(3, '0')}`)
  const attempts = new Map<string, number>()
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string), input = taskInput(body)
    if (!rejectEvidence || !failedIds.includes(input.workItems[0].id)) return reviewedBatch(body)
    const attempt = (attempts.get(input.taskId) ?? 0) + 1; attempts.set(input.taskId, attempt)
    if (attempt === 1) return agentStream([
      { name: 'get_character_detail', args: { ids: ['C1-P001', 'C1-P002'] } },
      { name: 'read_original', args: { chapter_indices: ['1'], maxChars: 1 } },
    ])
    return agentStream([{ name: 'commit_asset_changes', args: { operationKey: `${input.resume.nextOperationKey}-${attempt}`, payload: { groups: [{ kind: 'character', keepId: 'C1-P001', memberIds: ['C1-P001', 'C1-P002'], canonicalName: '沈青', confidence: 1, reason: '同人', evidence: [{ chapterIndex: '1', quote: '沈青又叫老沈，两人所指均为同一位船夫。', memberIds: ['C1-P001', 'C1-P002'] }] }] } } }])
  })
  const { service, models, db } = await setup(fetcher)
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://world-fixture.invalid/v1' }, 'fake-key')
  await service.start('a')
  const paused = (await service.reports('a'))[0]
  expect(paused.status).toBe('degraded')
  expect(paused.report.failed).toHaveLength(failedCount)
  expect(paused.report.failed[0]).toContain('C1-P001')
  expect(paused.coverage).toEqual({ total: 6, checked: 6 - failedCount, pendingIds: failedIds.map(id => `ai_identity:fullBook:character:${id}`) })
  expect(paused.tasks?.[0]).toMatchObject({ status: 'failed', stepsUsed: 3 })
  expect(await db.table('characters').count()).toBe(4)
  const count = fetcher.mock.calls.length
  rejectEvidence = false
  await service.start('a')
  expect(fetcher.mock.calls.length - count).toBe(2 * failedCount)
  expect((await service.reports('a'))[0]).toMatchObject({ id: paused.id, status: 'completed', coverage: { checked: 6 } })
})

it('有待办时成功资产仍完成整编，继续时保留成功项覆盖', async () => {
  let leavePending = true, optimizationCalls = 0
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string), input = taskInput(body)
    if (body.tools.length === 1) {
      optimizationCalls++
      const row = input.entities[0]
      return agentStream([{ name: 'submit_result', args: { entities: { [row.id]: { entity: { name: row.name, aliases: row.aliases, background: '独有背景事实' }, covered_fact_ids: row.facts.map((fact: { id: string }) => fact.id), merge_notes: [] } } } }])
    }
    if (leavePending && input.workItems[0].id === 'C1-P001') return agentStream([{ name: 'submit_result', args: { status: 'partial', commitIds: [], summary: '待核实', reviewedItems: [], remainingWorkIds: [input.workItems[0].workItemId] } }])
    return reviewedBatch(body)
  })
  const { service, models, db } = await setup(fetcher)
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://world-fixture.invalid/v1' }, 'fake-key')
  await db.table('characters').update('C1-P003', { background: '独有背景事实', mergeNotes: ['需整编'], mergeFacts: [{ id: 'F-original', field: 'background', text: '独有背景事实', chapters: ['1'] }] })
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect((await service.reports('a'))[0]).toMatchObject({ status: 'paused', coverage: { checked: 5 }, report: { optimizedIds: [], optimizations: [expect.objectContaining({ status: 'no_change' })] } })
  expect(optimizationCalls).toBe(1)
  const count = fetcher.mock.calls.length
  leavePending = false
  await service.start('a')
  expect(fetcher.mock.calls.length - count).toBe(2)
  expect(optimizationCalls).toBe(1)
  expect((await service.reports('a'))[0]).toMatchObject({ status: 'completed', coverage: { checked: 6 } })
})

it('41人物和20地点每批三条排队核实，全部完成后不留待办', async () => {
  const calls = new Map<string, number>(), sizes = new Map<string, number>()
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string); const input = taskInput(body)
    calls.set(input.taskId, (calls.get(input.taskId) ?? 0) + 1); sizes.set(input.taskId, input.workItems.length)
    return reviewedBatch(body, true)
  })
  const { service, db, models, book } = await setup(fetcher)
  await db.table('characters').clear(); await db.table('locations').clear()
  await db.table('characters').bulkPut(Array.from({ length: 41 }, (_, i) => person(`C1-P${String(i).padStart(3, '0')}`, `人物${i}`)))
  await db.table('locations').bulkPut(Array.from({ length: 20 }, (_, i) => ({ ...person(`C1-L${String(i).padStart(3, '0')}`, `地点${i}`), description: '' })))
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://world-fixture.invalid/v1' }, 'fake-key')
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect(Math.max(...calls.values())).toBeLessThanOrEqual(8)
  expect(Math.max(...sizes.values())).toBeLessThanOrEqual(3)
  const report = (await service.reports('a'))[0]
  expect(report.status).toBe('completed')
  expect(report.coverage).toEqual({ total: 61, checked: 61, pendingIds: [] })
  expect(report.report.failed).toEqual([])
  const tables = emptyTables(); for (const name of tableNames) tables[name] = await db.table(name).toArray()
  expect(await validateBookData({ book, tables })).toEqual([])
}, 60000)

it('取消后重建服务从未处理队列继续，复用报告和已核实范围，累计用量不重复计算', async () => {
  let gate = true
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string)
    if (gate && fetcher.mock.calls.length === 3) return new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('取消', 'AbortError')), { once: true }) })
    return withUsage(reviewedBatch(body))
  })
  const { workspace, service, models, assets, db } = await setup(fetcher)
  await db.table('characters').clear(); await db.table('locations').clear()
  await db.table('characters').bulkPut(Array.from({ length: 20 }, (_, i) => person(`C1-P${String(i).padStart(3, '0')}`, `人物${i}`)))
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://world-fixture.invalid/v1' }, 'fake-key')
  const running = service.start('a')
  await vi.waitFor(() => expect(fetcher.mock.calls.length).toBe(3))
  service.cancel('a'); await running
  const previous = (await service.reports('a'))[0]
  expect(previous.coverage?.checked).toBe(1)
  expect(previous.report.usage.totalTokens).toBe(24)
  gate = false
  const restored = createWorldService(workspace, models, assets)
  await restored.start('a')
  expect(restored.state('a')?.error).toBeUndefined()
  const report = (await restored.reports('a'))[0]
  expect(report.id).toBe(previous.id)
  expect(report.coverage).toEqual({ total: 20, checked: 20, pendingIds: [] })
  expect(report.report.usage.totalTokens).toBe(480)
  expect(fetcher.mock.calls).toHaveLength(41)
})

it('未完成项让后续资产继续，全部尝试后保存待办，用户继续后可完成', async () => {
  let partial = true
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string), input = taskInput(body)
    if (!partial) return reviewedBatch(body)
    return agentStream([{ name: 'submit_result', args: { status: 'partial', commitIds: [], summary: '仍需查询', reviewedItems: [], remainingWorkIds: input.workItems.map((row: { workItemId: string }) => row.workItemId) } }])
  })
  const { service, models, db } = await setup(fetcher)
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://world-fixture.invalid/v1' }, 'fake-key')
  await service.start('a')
  expect(fetcher.mock.calls).toHaveLength(6)
  const previous = (await service.reports('a'))[0]
  expect(previous.status).toBe('paused'); expect(previous.coverage?.pendingIds).toHaveLength(6)
  expect(await db.table('pipelineRuns').get('lease:world')).toBeUndefined()
  partial = false; await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect((await service.reports('a'))[0]).toMatchObject({ id: previous.id, status: 'completed', coverage: { checked: 6 } })
})

it.each([false, true])('后续合并同步完成状态和旧失败，目录查询不使队列回头（先失败：%s）', async failFirst => {
  const order: string[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string), input = taskInput(body)
    const id = input.workItems[0].id
    const replies = body.messages.filter((row: { role: string }) => row.role === 'tool').map((row: { content: string }) => { try { return JSON.parse(row.content) } catch { return {} } })
    if (failFirst && id === 'C1-P001') {
      if (!replies.length) order.push(id)
      return agentStream([{ name: 'submit_result', args: { status: 'completed', commitIds: [], summary: '缺少读取依据', remainingWorkIds: [], reviewedItems: [{ workItemId: input.workItems[0].workItemId, outcome: 'no_change', reason: '未读取' }] } }])
    }
    if (!replies.length) {
      order.push(id)
      return agentStream([
        { name: input.kind === 'character' ? 'query_characters' : 'query_locations', args: {} },
        { name: input.kind === 'character' ? 'get_character_detail' : 'get_location_detail', args: { ids: id === 'C1-P004' ? [id, 'C1-P001', 'C1-P002'] : [id] } },
        ...(id === 'C1-P004' ? [{ name: 'read_original', args: { chapter_indices: ['1'] } }] : []),
      ])
    }
    const commit = replies.find((row: { ok?: boolean }) => row.ok)
    if (id === 'C1-P004' && !commit) return agentStream([{ name: 'commit_asset_changes', args: { operationKey: input.resume.nextOperationKey, payload: { groups: [{ kind: 'character', keepId: 'C1-P001', memberIds: ['C1-P001', 'C1-P002'], canonicalName: '沈青', confidence: 1, reason: '原文明示', evidence: [{ chapterIndex: '1', quote: '沈青又叫老沈，两人所指均为同一位船夫。', memberIds: ['C1-P001', 'C1-P002'] }] }] } } }])
    return agentStream([{ name: 'submit_result', args: { status: 'completed', commitIds: commit ? [commit.commitId] : [], summary: '已核实当前项', remainingWorkIds: [], reviewedItems: [{ workItemId: input.workItems[0].workItemId, outcome: 'no_change', reason: '当前分配项保持独立' }] } }])
  })
  const { service, models } = await setup(fetcher)
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://world-fixture.invalid/v1' }, 'fake-key')
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect(order).toEqual(['C1-P001', 'C1-P002', 'C1-P003', 'C1-P004', 'C1-L001', 'C1-L002'])
  expect((await service.reports('a'))[0]).toMatchObject({ status: 'completed', coverage: { total: 5, checked: 5, pendingIds: [] }, report: { failed: [] } })
})

it('提交合并后其余批次继续，不重复合并同一组', async () => {
  const fetcher = identityFetcher()
  const { models, service, db } = await setup(fetcher)
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://world-fixture.invalid/v1' }, 'fake-key')
  await service.start('a')
  expect(service.state('a')?.error).toBeUndefined()
  const report = (await service.reports('a'))[0]
  expect(report.report.groups).toHaveLength(1)
  expect(report.coverage).toMatchObject({ total: 5, checked: 5, pendingIds: [] })
  expect(report.tasks).toHaveLength(5)
  expect(report.tasks!.every(task => task.status === 'completed')).toBe(true)
  expect(await db.table('characters').count()).toBe(3)
})

it('单资产第六轮开始收尾，第八轮返回后保存待办，不重复启动该资产', async () => {
  const notes: string[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string), input = taskInput(body)
    notes.push(JSON.stringify(body.messages.at(-1)))
    return agentStream([{ name: 'get_character_detail', args: { ids: input.workItems.map((row: { id: string }) => row.id) } }])
  })
  const { service, models, db } = await setup(fetcher)
  await db.table('characters').clear(); await db.table('locations').clear()
  await db.table('characters').put(person('one', '单个人物'))
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://world-fixture.invalid/v1' }, 'fake-key')
  await service.start('a')
  expect(fetcher).toHaveBeenCalledTimes(8)
  expect(notes[5]).toContain('进入收尾')
  const report = (await service.reports('a'))[0]
  expect(report.status).toBe('paused')
  expect(report.coverage).toMatchObject({ checked: 0, pendingIds: ['ai_identity:fullBook:character:one'] })
  expect(report.tasks).toHaveLength(1)
  expect(report.report.failed).toEqual([])
})

it('剩余一分钟提醒收尾，跨过目标时间的在途请求正常返回并保存待办', async () => {
  const realNow = Date.now.bind(Date); let elapsed = 0
  const notes: string[] = [], aborted: boolean[] = []
  let db: ReturnType<ReturnType<typeof createWorkspace>['openBook']>
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string), input = taskInput(body)
    notes.push(JSON.stringify(body.messages.at(-1)))
    elapsed = fetcher.mock.calls.length === 1 ? 130000 : 190000
    await db.table('pipelineRuns').update('lease:world', { expiresAt: Date.now() + 30000 })
    aborted.push(!!init?.signal?.aborted)
    return agentStream([{ name: 'get_character_detail', args: { ids: input.workItems.map((row: { id: string }) => row.id) } }])
  })
  const fixture = await setup(fetcher); db = fixture.db
  await db.table('characters').clear(); await db.table('locations').clear()
  await db.table('characters').put(person('one', '单个人物'))
  await fixture.models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://world-fixture.invalid/v1' }, 'fake-key')
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + elapsed)
  try { await fixture.service.start('a') } finally { clock.mockRestore() }
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(notes[1]).toContain('进入收尾')
  expect(aborted).toEqual([false, false])
  expect((await fixture.service.reports('a'))[0]).toMatchObject({ status: 'paused', coverage: { checked: 0 } })
})
