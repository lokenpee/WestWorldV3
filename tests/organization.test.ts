import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createAssetService } from '../src/features/assets/service'
import { createModelService } from '../src/features/models/service'
import { createWorldService } from '../src/features/world/service'
import { defaultConfig } from '../src/features/models/types'
import { createOrganizationState } from '../src/features/world/organization'
import { createBackupService } from '../src/features/backup/service'
import { createImportService } from '../src/lib/storage/importService'
import type { Character } from '../src/features/assets/types'
import { agentStream } from './support/agent-protocol'
import { organizationResponse } from './support/organization-streams'
import { appendEntry } from '../src/features/agents/commands'
import { createBookAgentRepository } from '../src/features/agents/repository'

const opened: ReturnType<typeof createWorkspace>[] = []
const person = (id: string, name: string, extra = {}): Character => ({ id, bookId: 'a', name, aliases: [], confidence: 1, revision: 1, createdBy: 'P1', chapterIndex: '1', chapterName: '第1章', ...extra })
const contentOf = (content: unknown) => typeof content === 'string' ? content : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? '').join('') : ''
const parse = (value: unknown) => { try { return JSON.parse(contentOf(value)) as Record<string, unknown> } catch { return {} } }
const key = () => crypto.randomUUID()
const isInput = (message: { role: string; content: unknown }) => { if (message.role !== 'user') return false; const value = parse(message.content); return typeof value.step === 'string' && Array.isArray(value.workItems) }
const respond = (init?: RequestInit) => organizationResponse(JSON.parse(init?.body as string))!

function organizationFetcher() {
  return vi.fn<typeof fetch>().mockImplementation(async (_url, init) => respond(init))
}

async function setup(fetcher = organizationFetcher()) {
  const id = crypto.randomUUID(); const workspace = createWorkspace({ settingsName: `organization-${id}`, bookPrefix: `organization-book-${id}-` }); opened.push(workspace)
  const book = { id: 'a', title: '人物整理样本', sourceFileName: 'organization.txt', createdAt: new Date().toISOString() }; await workspace.settings.books.put(book)
  const db = workspace.openBook('a'); const text = '沈青又叫老沈，两人都是青石渡的船夫。张三和李四是同乡。'
  await db.chapters.put({ bookId: 'a', chapterIndex: '1', chapterName: '第1章', order: 0, charCount: text.length }); await db.table('chapterTexts').put({ bookId: 'a', chapterIndex: '1', text })
  await db.table('characters').bulkPut([person('C1-P001', '沈青', { identity: '青石渡船夫' }), person('C1-P002', '老沈', { identity: '沈青的别名' }), person('C1-P003', '张三', { identity: '同乡' }), person('C1-P004', '李四', { identity: '同乡' })])
  await db.table('extractionReceipts').bulkPut(['worldAssets', 'narrativeAssets'].map(step => ({ key: `1:${step}`, bookId: 'a', chapterIndex: '1', substep: step, inputFingerprint: 'fixture', originIds: [], committedAt: book.createdAt, runId: 'extract-fixture' })))
  const assets = createAssetService(workspace); const models = createModelService(workspace, { fetch: fetcher, wait: async (_ms, signal) => signal.throwIfAborted() })
  const service = createWorldService(workspace, models, assets, { assetReview: false })
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://organization-fixture.invalid/v1', aggregationContextWindow: 65536 }, 'fake-key')
  return { workspace, db, models, service }
}
afterEach(async () => { vi.restoreAllMocks(); for (const workspace of opened.splice(0)) { workspace.close(); for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name) } })

it('人物目录按稳定编号每100人一页，页码与下一页游标连续', () => {
  const state = createOrganizationState(['P10', 'P2', 'P1', ...Array.from({ length: 98 }, (_, index) => `X${index}`)])
  expect(state.scanIds[0]).toBe('P1')
  expect(state.scanIds[2]).toBe('P10')
  expect(state.scanPages).toHaveLength(2)
  expect(state.scanPages[0]).toMatchObject({ pageId: 'scan:0', nextCursor: '1', status: 'issued' })
  expect(state.scanPages[0].ids).toHaveLength(100)
  expect(state.scanPages[1]).toMatchObject({ pageId: 'scan:1', nextCursor: null })
})

it('同一持续会话完成扫描、合并、资料、关系和统计，报告保留疑似组结论', async () => {
  const { db, service } = await setup()
  await service.startOrganization('a')
  expect(service.state('a')?.error).toBeUndefined()
  const runs = await service.reports('a')
  const run = runs.find(row => row.workflow === 'character_organization_v1')!
  expect(run.status).toBe('completed')
  expect(run.report.status).toBe('completed')
  expect(await db.table('characters').count()).toBe(3)
  expect((await db.table('characters').get('C1-P001')).name).toBe('沈青')
  expect(run.organization?.step).toBe('done')
  expect(run.organization?.candidateDecisions).toMatchObject([{ outcome: 'merged', memberIds: ['C1-P001', 'C1-P002'] }])
  expect(run.report.organizationSummary).toMatchObject({ scannedPages: 1, candidateGroups: 1, merged: 1, profilesChecked: 3, relationsChecked: 3, statistics: 'completed' })
  const traceRows = (await db.table('storySessionEntries').toArray()).filter(row => row.type === 'request_trace' && typeof row.requestId === 'string')
  expect(traceRows.length).toBeGreaterThan(0)
  expect(traceRows.every(row => row.runId === run.id && typeof row.executionId === 'string' && row.input && row.status === 'succeeded')).toBe(true)
  expect(traceRows.some(row => Array.isArray(row.toolCalls) && row.toolCalls.some((tool: { name?: string }) => tool.name?.startsWith('submit_')))).toBe(true)
  expect((await db.table('storySessionEntries').toArray()).filter(row => row.type === 'prompt_snapshot' || row.type === 'tool_snapshot').length).toBeGreaterThan(0)
  const sessions = await db.table('storySessions').toArray()
  expect(sessions).toHaveLength(1)
  expect(sessions[0]).toMatchObject({ profile: 'asset_editor', workflow: 'character_organization_v1', runId: run.id })
}, 120000)

it('格式10备份保留人物整理会话、候选和进度，恢复为新书后暂停在原轮', async () => {
  const { workspace, db, service } = await setup()
  await service.startOrganization('a')
  expect(service.state('a')?.error).toBeUndefined()
  const source = (await db.table('compileProgress').get('P2')) as { runId: string }
  const before = await db.table('pipelineRuns').get(source.runId) as Record<string, unknown>
  const organizationBefore = before.organization as Record<string, unknown>
  await db.table('pipelineRuns').update(source.runId, { status: 'paused', organization: { ...organizationBefore, step: 'profiles' } })
  const importer = createImportService(workspace)
  try {
    const backups = createBackupService(workspace, importer)
    const exported = await backups.exportBook('a')
    expect(exported.manifest.formatVersion).toBe(11)
    const inspected = await backups.inspectBackup(exported.bytes)
    expect(inspected.errors).toEqual([])
    const imported = await backups.importBackup(exported.bytes)
    const restored = workspace.openBook(imported.id)
    const run = (await restored.table('pipelineRuns').get(source.runId)) as Record<string, unknown>
    expect(run).toMatchObject({ bookId: imported.id, workflow: 'character_organization_v1', status: 'paused' })
    const organization = run.organization as Record<string, unknown>
    expect(organization).toMatchObject({ step: 'profiles' })
    expect((organization.candidateDecisions as { outcome: string }[])[0].outcome).toBe('merged')
    const sessions = await restored.table('storySessions').toArray() as { bookId: string; profile: string; runId: string; id: string }[]
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ bookId: imported.id, profile: 'asset_editor', runId: source.runId })
    expect(run.sessionId).toBe(sessions[0].id)
    const restoredEntries = await restored.table('storySessionEntries').toArray()
    expect(restoredEntries.some(row => row.type === 'request_trace' && row.bookId === imported.id && row.requestId)).toBe(true)
    expect(restoredEntries.some(row => row.type === 'prompt_snapshot' && row.bookId === imported.id)).toBe(true)
    expect((await restored.table('pipelineRuns').where('recordType').equals('lease').toArray())).toEqual([])
    expect(before.workflow).toBe('character_organization_v1')
    const resumedModels = createModelService(workspace, { fetch: async (_url, init) => organizationResponse(JSON.parse(init!.body as string))!, wait: async (_ms, signal) => signal.throwIfAborted() })
    const resumed = createWorldService(workspace, resumedModels, createAssetService(workspace), { assetReview: false })
    await resumed.startOrganization(imported.id)
    expect(resumed.state(imported.id)?.error).toBeUndefined()
    const completed = (await resumed.reports(imported.id))[0]!
    expect(completed).toMatchObject({ id: source.runId, sessionId: sessions[0]!.id, status: 'completed', organization: { step: 'done', reviewVersion: 2 } })
    expect(completed.organization?.repairNotice).toBeUndefined()
    expect(completed.report.groups).toHaveLength(1)
  } finally { importer.close() }
}, 120000)

it('定时器未运行而时钟跨过租期时，模型工具及下一批仍沿同轮续做', async () => {
  let clock = Date.now(), calls = 0, handoffs = 0
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    clock += 31000; calls++
    return respond(init)
  })
  const { db, service } = await setup(fetcher)
  let phase = ''
  const unsubscribe = service.subscribe(() => {
    const current = service.state('a')?.phase ?? ''
    if (current !== phase && ['优化人物资料', '整理人物关系'].includes(current)) { clock += 31000; handoffs++ }
    phase = current
  })
  try { await service.startOrganization('a') } finally { unsubscribe() }
  expect(service.state('a')?.error).toBeUndefined()
  expect(calls).toBeGreaterThan(10)
  expect(handoffs).toBe(2)
  const run = (await service.reports('a'))[0]!
  expect(run.organization?.step).toBe('done')
  expect(run.report.organizationSummary?.statistics).toBe('completed')
  expect(await db.table('characters').count()).toBe(3)
  expect(await db.table('storySessions').count()).toBe(1)
}, 120000)

it.each(['world_owner', 'world_run', 'session_owner', 'removed', 'extraction'] as const)('晚到模型返回前执行权发生%s变化时拒绝业务写入', async kind => {
  const { db, workspace } = await setup()
  let changed = false
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    if (!changed) {
      changed = true
      const lease = await db.table('pipelineRuns').get('lease:world')
      if (kind === 'world_owner') await db.table('pipelineRuns').update('lease:world', { owner: 'other-owner' })
      if (kind === 'world_run') await db.table('pipelineRuns').update('lease:world', { runId: 'other-run' })
      if (kind === 'session_owner') {
        const run = await db.table('pipelineRuns').get(lease.runId)
        await db.table('storySessions').update(run.sessionId, { leaseOwner: 'other-owner' })
      }
      if (kind === 'removed') await db.table('pipelineRuns').delete('lease:world')
      if (kind === 'extraction') await db.table('pipelineRuns').put({ id: 'lease:extraction', recordType: 'lease', bookId: 'a', lockKey: 'extraction', owner: 'other-owner', runId: 'extract-other', expiresAt: Date.now() + 30000 })
    }
    return respond(init)
  })
  const executingModels = createModelService(workspace, { fetch: fetcher, wait: async (_ms, signal) => signal.throwIfAborted() })
  const service = createWorldService(workspace, executingModels, createAssetService(workspace), { assetReview: false })
  const before = await db.table('characters').toArray()
  await service.startOrganization('a')
  expect(changed).toBe(true)
  expect(service.state('a')?.error).toMatch(/执行权|会话/)
  expect(await db.table('characters').toArray()).toEqual(before)
  const run = (await db.table('pipelineRuns').toArray()).find(row => row.workflow === 'character_organization_v1')!
  expect(run.organization.revision).toBe(1)
  expect(run.appliedCommands).toEqual([])
  if (kind === 'world_owner') expect((await db.table('pipelineRuns').get('lease:world')).owner).toBe('other-owner')
  if (kind === 'world_run') expect((await db.table('pipelineRuns').get('lease:world')).runId).toBe('other-run')
  if (kind === 'session_owner') expect((await db.table('storySessions').get(run.sessionId)).leaseOwner).toBe('other-owner')
}, 120000)

it('不再使用固定请求次数上限，持续有进展即可完成', async () => {
  let calls = 0
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    calls++
    const body = JSON.parse(init!.body as string) as { messages: { role: string; content: unknown }[] }
    const input = parse([...body.messages].reverse().find(isInput)?.content)
    const work = input.work as Record<string, unknown> | undefined
    if (work?.kind === 'directory') {
      const results = body.messages.slice(body.messages.findLastIndex(isInput)).filter(message => message.role === 'tool').map(message => parse(message.content))
      if (results.length < 25) return agentStream([{ name: 'query_character_catalog', args: { cursor: JSON.stringify({ page: 0, offset: 0 }), limit: 100 } }])
      const record = results.find(result => result.summary === '整理进度已更新。')
      if (!record) return agentStream([{ name: 'record_organization_progress', args: { operationKey: key(), action: 'check_item', kind: 'scan_page', id: String((work.data as Record<string, unknown>).pageId) } }])
      return agentStream([{ name: 'submit_result', args: { status: 'completed', commitIds: [record.commitId], summary: '目录页已核对', remainingWorkIds: [], reviewedItems: [{ workItemId: String((input.workItems as Record<string, unknown>[])[0].workItemId), outcome: 'no_change', reason: '目录页已核对' }] } }])
    }
    return respond(init)
  })
  const { service } = await setup(fetcher)
  await service.startOrganization('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect(calls).toBeGreaterThan(25)
  expect((await service.reports('a'))[0]!.organization?.step).toBe('done')
}, 120000)

it('submit_profile_review一次保存修改并完成，无需另行登记', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init!.body as string) as { messages: { role: string; content: unknown }[] }
    const input = parse([...body.messages].reverse().find(isInput)?.content)
    const work = input.work as Record<string, unknown> | undefined
    const data = work?.data as Record<string, unknown> | undefined
    if (work?.kind === 'profile' && data?.id === 'C1-P001') return agentStream([{ name: 'submit_profile_review', args: { patch: { personality: '性情沉稳，处事果断，精于谋略' }, done: true, reason: '归纳重复性格' } }])
    return respond(init)
  })
  const { db, service } = await setup(fetcher)
  await service.startOrganization('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect((await db.table('characters').get('C1-P001')).personality).toBe('性情沉稳，处事果断，精于谋略')
  const run = (await service.reports('a'))[0]!
  expect(run.report.assetEdits?.some(edit => edit.id === 'C1-P001' && edit.fieldChanges.some(change => change.field === 'personality'))).toBe(true)
  expect(run.organization?.profileItems.find(item => item.id === 'C1-P001')).toMatchObject({ status: 'checked', outcome: 'changed' })
}, 120000)

it('submit_profile_review的done=false保存部分修改，done=true结束并保留前面修改', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init!.body as string) as { messages: { role: string; content: unknown }[] }
    const input = parse([...body.messages].reverse().find(isInput)?.content)
    const work = input.work as Record<string, unknown> | undefined
    const data = work?.data as Record<string, unknown> | undefined
    if (work?.kind === 'profile' && data?.id === 'C1-P001') {
      if (!body.messages.some(message => message.role === 'tool')) return agentStream([{ name: 'submit_profile_review', args: { patch: { personality: '第一次部分整理' }, done: false, reason: '先保存已确定部分' } }])
      if (!body.messages.some(message => message.role === 'tool' && contentOf(message.content).includes('"complete":true'))) return agentStream([{ name: 'submit_profile_review', args: { patch: {}, done: true, reason: '当前人物完成' } }])
    }
    return respond(init)
  })
  const { db, service } = await setup(fetcher)
  await service.startOrganization('a')
  expect(service.state('a')?.error).toBeUndefined()
  expect((await db.table('characters').get('C1-P001')).personality).toBe('第一次部分整理')
  const run = (await service.reports('a'))[0]!
  expect(run.organization?.profileItems.find(item => item.id === 'C1-P001')).toMatchObject({ status: 'checked', outcome: 'changed' })
  expect(run.report.assetEdits?.filter(edit => edit.id === 'C1-P001')).toHaveLength(1)
}, 120000)

it('相同工具参数重复失败且没有进展时留待该人物，继续处理其他人并暂停为部分完成', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init!.body as string) as { messages: { role: string; content: unknown }[] }
    const input = parse([...body.messages].reverse().find(isInput)?.content)
    const work = input.work as Record<string, unknown> | undefined
    if (work?.kind === 'profile') return agentStream([{ name: 'submit_relation_review', args: { changes: [{ targetId: 'C1-P004', action: 'delete' }], done: true, reason: '错误阶段调用' } }])
    return respond(init)
  })
  const { service } = await setup(fetcher)
  await service.startOrganization('a')
  const run = (await service.reports('a'))[0]!
  expect(run.status).toBe('paused')
  expect(run.organization?.step).toBe('profiles')
  expect(run.organization?.profileItems.filter(item => item.status === 'pending' && item.lastError).length).toBeGreaterThan(0)
  expect(run.organization?.relationItems).toHaveLength(0)
}, 120000)


it('每个工作项使用独立上下文，切换不压缩且旧历史不重送', async () => {
  const requests: { unitId: string; contextId: string; messages: { role: string; content: unknown }[] }[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init!.body as string) as { messages: { role: string; content: unknown }[] }
    const input = parse([...body.messages].reverse().find(isInput)?.content)
    if (typeof input.unitId === 'string') requests.push({ unitId: input.unitId, contextId: String(input.contextId), messages: body.messages })
    return respond(init)
  })
  const { service, db, workspace } = await setup(fetcher)
  await service.startOrganization('a')
  expect(service.state('a')?.error).toBeUndefined()
  const units = [...new Set(requests.map(request => request.unitId))]
  expect(units.length).toBeGreaterThan(4)
  expect(new Set(requests.map(request => request.contextId))).toEqual(new Set(['identity', 'profiles', 'relations']))
  expect(JSON.stringify(requests)).not.toContain('【需要压缩的原始会话数据】')
  for (const unit of units) {
    const first = requests.find(request => request.unitId === unit)!
    expect(first.messages.filter(message => message.role === 'tool')).toHaveLength(0)
  }
  const profileUnits = units.filter(unit => unit.startsWith('profile:'))
  const relationUnits = units.filter(unit => unit.startsWith('relations:'))
  expect(profileUnits.length).toBeGreaterThan(0)
  expect(relationUnits.length).toBeGreaterThan(0)
  for (const unit of profileUnits) {
    const body = requests.filter(request => request.unitId === unit)
    expect(body).toHaveLength(1)
    const prompt = contentOf(body[0].messages.find(isInput)!.content)
    expect(prompt).toContain('"kind":"profile"')
    expect(prompt).toContain('"identity"')
    expect(prompt).toContain('"mergeFacts"')
  }
  for (const unit of relationUnits) {
    const body = requests.filter(request => request.unitId === unit)
    expect(body).toHaveLength(1)
    const prompt = contentOf(body[0].messages.find(isInput)!.content)
    expect(prompt).toContain('"kind":"relations"')
    expect(prompt).toContain('"relations"')
  }
  const before = (await service.reports('a'))[0]!
  expect(before.organization?.contexts).toMatchObject({ identity: { status: 'completed' }, profiles: { status: 'completed' }, relations: { status: 'completed' } })
  expect(before.organization?.activeWork ?? null).toBeNull()
  expect(before.requestLedger?.length).toBeGreaterThanOrEqual(units.length)
  expect(before.requestLedger?.every(entry => typeof entry.attemptId === 'string' && entry.purpose && entry.usageStatus)).toBe(true)
  for (const unit of profileUnits) expect(before.requestLedger?.filter(entry => entry.workId === unit)).toHaveLength(1)
  const repo = createBookAgentRepository(workspace, 'a')
  await repo.transaction(true, store => appendEntry(store, { bookId: 'a', runId: before.id, taskId: '', owner: '', sessionId: before.sessionId, profile: 'asset_editor', phase: 'character_organization', workItemIds: [], contextId: 'profiles', unitId: 'archived:old' }, { type: 'message', message: { role: 'user', content: `人物整理历史原标记：${'此前完整资料和依据已归档，恢复仍须处理持久待办。'.repeat(7000)}`, timestamp: Date.now() } }))
  await db.table('pipelineRuns').update(before.id, { status: 'paused', organization: { ...before.organization, step: 'profiles', profileItems: before.organization!.profileItems.map(item => ({ ...item, status: 'pending', outcome: null, readRefs: [], commitIds: [] })), relationItems: [], pairChecks: [], activeWork: null } })
  const resumedRequests: string[] = []
  const resumedFetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => { resumedRequests.push(String(init!.body)); return respond(init) })
  const resumed = createWorldService(workspace, createModelService(workspace, { fetch: resumedFetcher, wait: async (_ms, signal) => signal.throwIfAborted() }), createAssetService(workspace), { assetReview: false })
  await resumed.startOrganization('a')
  expect(resumed.state('a')?.error).toBeUndefined()
  expect(resumedRequests.join('\n')).not.toContain('人物整理历史原标记')
  const after = (await resumed.reports('a'))[0]!
  expect(after).toMatchObject({ id: before.id, sessionId: before.sessionId, status: 'completed', organization: { step: 'done' } })
  const entries = await db.table('storySessionEntries').toArray()
  expect(entries.some(row => JSON.stringify(row).includes('人物整理历史原标记'))).toBe(true)
  expect(entries.some(row => row.type === 'compaction')).toBe(false)
  expect(after.report.groups).toHaveLength(1)
}, 120000)

it.each(['done', 'relations'] as const)('旧规则%s轮保留合并和会话，从资料重新核对而不重复合并', async step => {
  let repair = false
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => repair ? organizationResponse(JSON.parse(init!.body as string))! : respond(init))
  const { service, db } = await setup(fetcher)
  await service.startOrganization('a')
  const before = (await service.reports('a'))[0]!
  const start = fetcher.mock.calls.length
  const state = { ...before.organization!, step }
  delete state.reviewVersion
  await db.table('pipelineRuns').update(before.id, { organization: state, status: step === 'done' ? 'completed' : 'failed' })
  repair = true
  await service.startOrganization('a')
  expect(service.state('a')?.error).toBeUndefined()
  const after = (await service.reports('a'))[0]!
  expect(after).toMatchObject({ id: before.id, sessionId: before.sessionId, status: 'completed', organization: { step: 'done', reviewVersion: 2 } })
  expect(after.organization?.repairNotice).toContain('从人物资料重新检查')
  expect(after.report.groups).toHaveLength(1)
  expect(after.organization?.candidateDecisions).toEqual(before.organization?.candidateDecisions)
  expect(await db.table('characters').count()).toBe(3)
  const calls = fetcher.mock.calls.slice(start).map(([, init]) => JSON.parse(init!.body as string))
  const inputs = calls.map(body => parse(body.messages.findLast(isInput)?.content))
  expect(inputs.at(-1)?.step).toBe('relations')
  expect(inputs.filter((input: Record<string, unknown>) => input.step === 'scan')).toHaveLength(0)
}, 120000)

