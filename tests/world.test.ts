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
import { emptyTables, tableNames, validateBookData } from '../src/features/backup/data'

const opened: ReturnType<typeof createWorkspace>[] = []
const person = (id: string, name: string, extra = {}): Character => ({ id, bookId: 'a', name, aliases: [], confidence: 1, revision: 1, createdBy: 'P1', chapterIndex: '1', chapterName: '第1章', ...extra })
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
    if (replies.length && (commit || input.kind === 'location' || !['C1-P001', 'C1-P002'].every(id => input.workItems.some((work: { id: string }) => work.id === id)))) return agentStream([{ name: 'submit_result', args: { status: 'completed', commitIds: commit ? [commit.commitId] : [], summary: '已核对同人多名与同名异人', remainingWorkIds: [], reviewedItems: input.workItems.map((work: { id: string; workItemId: string }) => ({ workItemId: work.workItemId, outcome: commit && ['C1-P001', 'C1-P002'].includes(work.id) ? 'changed' : 'no_change', reason: '核对原文后确认' })) } }])
    if (replies.length && input.kind === 'character') return agentStream([{ name: 'commit_asset_changes', args: { operationKey: input.resume.nextOperationKey, payload: { groups: [{ kind: 'character', keepId: 'C1-P001', memberIds: ['C1-P001', 'C1-P002'], canonicalName: '沈青', confidence: 1, reason: '原文说明同人', evidence: [{ chapterIndex: '1', quote: '沈青又叫老沈，两人所指均为同一位船夫。', memberIds: ['C1-P001', 'C1-P002'] }] }] } } }])
    return agentStream([{ name: input.kind === 'character' ? 'get_character_detail' : 'get_location_detail', args: { ids: input.workItems.map((work: { id: string }) => work.id) } }, ...(input.kind === 'character' ? [{ name: 'read_original', args: { chapter_range: ['1', '1'] } }] : [])])
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
  expect((await service.reports('a'))[0].report.optimizedIds).toHaveLength(2)
  const tables = emptyTables(); for (const name of tableNames) tables[name] = await db.table(name).toArray()
  expect(await validateBookData({ book, tables })).toEqual([])
  await db.table('locations').update('C1-L001', { description: '新增事实需要整理', mergeFacts: [{ id: 'new-fact', field: 'description', text: '新增事实需要整理', chapters: ['1'] }] })
  omitFacts = true
  await service.start('a')
  expect((await service.reports('a'))[0].status).toBe('degraded')
  expect(await db.table('locations').get('C1-L001')).toMatchObject({ description: '新增事实需要整理' })
})
