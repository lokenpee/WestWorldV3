import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createAssetService } from '../src/features/assets/service'
import { createModelService } from '../src/features/models/service'
import { createWorldService } from '../src/features/world/service'
import { defaultConfig } from '../src/features/models/types'
import { createOrganizationState, nextUnit } from '../src/features/world/organization'
import { createBackupService } from '../src/features/backup/service'
import { createImportService } from '../src/lib/storage/importService'
import type { Character } from '../src/features/assets/types'
import { agentStream } from './support/agent-protocol'
import { organizationResponse, organizationPromptParts } from './support/organization-streams'
import { appendEntry } from '../src/features/agents/commands'
import { reconcileOrganizationAfterWrite } from '../src/features/agents/organizationCommands'
import { createBookAgentRepository, createMemoryAgentRepository } from '../src/features/agents/repository'
import { createAgentTools } from '../src/features/agents/tools'
import { saveCharacterPair } from '../src/features/assets/relationEdits'
import { relationWork } from '../src/features/agents/organizationData'

const opened: ReturnType<typeof createWorkspace>[] = []
const person = (id: string, name: string, extra = {}): Character => ({ id, bookId: 'a', name, aliases: [], confidence: 1, revision: 1, createdBy: 'P1', chapterIndex: '1', chapterName: '第1章', ...extra })
const contentOf = (content: unknown) => typeof content === 'string' ? content : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? '').join('') : ''
const parse = (value: unknown) => {
  const textValue = contentOf(value)
  try { return JSON.parse(textValue) as Record<string, unknown> } catch { /* 新任务简报不是 JSON */ }
  const parts = organizationPromptParts(value)
  if (!parts) return {}
  const step = parts.kind === 'directory' ? 'scan' : parts.kind === 'profile' ? 'profiles' : parts.kind === 'relations' ? 'relations' : 'resolve'
  const contextId = parts.kind === 'profile' ? 'profiles' : parts.kind === 'relations' ? 'relations' : 'identity'
  return { step, unitId: `${parts.kind}:${parts.id}`, contextId, work: { kind: parts.kind, data: parts.data }, workItems: [{ workItemId: parts.workItemId }] }
}
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

it('人物整理的最终请求不重复注入任务，系统提示词不含旧预算和最后只能submit_result规则', async () => {
  const fetcher = organizationFetcher()
  const { service } = await setup(fetcher)
  await service.startOrganization('a')
  const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(init?.body as string) as { messages: { role: string; content: unknown }[] })
  const system = bodies.flatMap(body => body.messages.filter(message => message.role === 'system').map(message => contentOf(message.content))).join('\n')
  expect(system).not.toContain('100000')
  expect(system).not.toContain('最后一次只能调用submit_result')
  for (const body of bodies) {
    const users = body.messages.filter(message => message.role === 'user').map(message => contentOf(message.content))
    const tasks = users.filter(text => text.includes('任务类型：'))
    expect(tasks.length, '每次请求的任务简报数').toBe(new Set(tasks).size)
  }
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
    if (work?.kind === 'profile') return agentStream([{ name: 'submit_profile_review', args: { patch: {}, done: false, reason: '无修改反复提交' } }])
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
  const requests: { unitId: string; contextId: string; messages: { role: string; content: unknown }[]; tools: string[]; system: string }[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init!.body as string) as { messages: { role: string; content: unknown }[] }
    const input = parse([...body.messages].reverse().find(isInput)?.content)
    if (typeof input.unitId === 'string') requests.push({ unitId: input.unitId, contextId: String(input.contextId), messages: body.messages, tools: (body as { tools?: { function?: { name?: string } }[] }).tools?.map(tool => tool.function?.name).filter((name): name is string => !!name) ?? [], system: contentOf(body.messages.find(message => message.role === 'system')?.content) })
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
    expect(body[0].tools).not.toContain('submit_result')
    expect(body[0].tools).not.toContain('submit_relation_review')
    expect(body[0].tools).toContain('query_character_profile')
    expect(body[0].tools).toContain('edit_character')
    expect(body[0].tools).toContain('submit_profile_review')
    expect(body[0].tools).toContain('get_tools')
    expect(body[0].tools).toContain('get_tools_detail')
    expect(body[0].tools).not.toContain('merge_assets')
    expect(body[0].system).not.toContain('第一步：目录页')
    expect(body[0].system).not.toContain('第三步：整理人物关系')
    expect(body[0].system).not.toContain('submit_relation_review')
    expect(body[0].system).toContain('submit_profile_review')
    expect(body).toHaveLength(1)
    const prompt = contentOf(body[0].messages.find(isInput)!.content)
    expect(prompt).toContain('任务类型：profile')
    expect(prompt).toContain('"identity"')
    expect(prompt).toContain('"mergeFacts"')
  }
  for (const unit of relationUnits) {
    const body = requests.filter(request => request.unitId === unit)
    expect(body[0].tools).not.toContain('submit_result')
    expect(body[0].tools).not.toContain('submit_profile_review')
    expect(body[0].tools).toContain('submit_relation_review')
    expect(body[0].tools).toContain('query_relation_work')
    expect(body[0].tools).toContain('get_character_relation')
    expect(body[0].tools).toContain('get_tools')
    expect(body[0].tools).toContain('get_tools_detail')
    expect(body[0].tools).not.toContain('merge_assets')
    expect(body[0].system).not.toContain('第一步：目录页')
    expect(body[0].system).not.toContain('第二步：优化人物资料')
    expect(body[0].system).not.toContain('submit_profile_review')
    expect(body[0].system).toContain('submit_relation_review')
    expect(body[0].system).toContain('已有连线不代表关系一定成立')
    expect(body[0].system).toContain('必须指定 `targetIds`')
    expect(body[0].system).toContain('正向是“族弟”')
    expect(body[0].system).toContain('反向是“族兄”')
    expect(body[0].system).toContain('get_tools_detail')
    expect(body).toHaveLength(1)
    const prompt = contentOf(body[0].messages.find(isInput)!.content)
    expect(prompt).toContain('任务类型：relations')
    expect(prompt).toContain('已有关系')
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

it('第二步/第三步的 pending 候选优先作为 candidate 工作项，完成后恢复原资料项', async () => {
  const store = { get: async (table: string, id: string) => table === 'characters' && id === 'C1-P001' ? person('C1-P001', '甲') : undefined } as never
  const organization = createOrganizationState(['C1-P001'])
  organization.step = 'profiles'
  organization.profileItems = [{ id: 'C1-P001', name: '甲', status: 'pending', outcome: null, reason: '', contentFingerprint: '', readRefs: [], commitIds: [] }]
  organization.candidateGroups = [{ id: 'g1', memberIds: ['C1-P001', 'C1-P002'], memberNames: ['甲', '乙'], reason: '疑似同人', status: 'pending', revision: 1, createdAt: 'x', updatedAt: 'x' }]
  organization.activeWork = null
  const candidate = await nextUnit(store, organization)
  expect(candidate).toMatchObject({ kind: 'candidate', data: { group: { id: 'g1' } } })
  organization.candidateGroups[0]!.status = 'resolved'
  const profile = await nextUnit(store, organization)
  expect(profile?.kind).toBe('profile')
  expect(profile?.id).toBe('profile:C1-P001')
})

it('写后只更新当前工作项版本并只失效受影响的资料/关系项', async () => {
  const store = { get: async (table: string, id: string) => table === 'characters' && id === 'C1-P001' ? { ...person('C1-P001', '甲'), revision: 4 } : table === 'characters' && id === 'C1-P002' ? { ...person('C1-P002', '乙'), revision: 2 } : undefined } as never
  const run: Record<string, unknown> = { bookId: 'a', organization: {
    revision: 1, step: 'profiles', activeWork: { kind: 'profile', characterId: 'C1-P001', dataVersion: 1, targetIds: ['C1-P001'] },
    profileItems: [{ id: 'C1-P001', status: 'checked' }, { id: 'C1-P002', status: 'checked' }],
    relationItems: [{ id: 'C1-P002', status: 'checked' }],
    pairChecks: [{ pairKey: '["C1-P001","C1-P002"]', outcome: 'no_change' }, { pairKey: '["C1-P002","C1-P003"]', outcome: 'no_change' }],
  } }
  await reconcileOrganizationAfterWrite(store, { phase: 'character_organization' } as never, run, 'edit_character', { id: 'C1-P001' }, { affected: [{ kind: 'character', id: 'C1-P001', revision: 4 }] })
  const organization = run.organization as { activeWork: { dataVersion: number }; profileItems: Array<{ id: string; status: string }>; relationItems: Array<{ id: string; status: string }>; pairChecks: Array<{ pairKey: string; outcome: string | null }> }
  expect(organization.activeWork.dataVersion).toBe(4)
  expect(organization.profileItems.find((item: { id: string }) => item.id === 'C1-P001')!.status).toBe('checked')
  await reconcileOrganizationAfterWrite(store, { phase: 'character_organization' } as never, run, 'merge_assets', { kind: 'character', keepId: 'C1-P001', memberIds: ['C1-P001', 'C1-P002'] }, { affected: [{ kind: 'character', id: 'C1-P001', revision: 5 }] })
  expect(organization.profileItems.find((item: { id: string }) => item.id === 'C1-P001')!.status).toBe('checked')
  expect(organization.profileItems.find((item: { id: string }) => item.id === 'C1-P002')!.status).toBe('pending')
  expect(organization.relationItems.find((item: { id: string }) => item.id === 'C1-P002')!.status).toBe('pending')
  expect(organization.pairChecks.find((pair: { pairKey: string }) => pair.pairKey === '["C1-P001","C1-P002"]')!.outcome).toBeNull()
  expect(organization.pairChecks.find((pair: { pairKey: string }) => pair.pairKey === '["C1-P002","C1-P003"]')!.outcome).toBeNull()
})

it('关系编辑只失效对应人物对，不重置无关资料和关系项', async () => {
  const run: Record<string, unknown> = { bookId: 'a', organization: {
    revision: 1, step: 'relations', activeWork: { kind: 'relations', characterId: 'C1-P002', dataVersion: 1, targetIds: ['C1-P002'] },
    profileItems: [{ id: 'C1-P001', status: 'checked' }, { id: 'C1-P002', status: 'checked' }],
    relationItems: [{ id: 'C1-P002', status: 'pending' }, { id: 'C1-P003', status: 'checked' }],
    pairChecks: [{ pairKey: '["C1-P002","C1-P003"]', outcome: 'no_change' }, { pairKey: '["C1-P001","C1-P003"]', outcome: 'no_change' }],
  } }
  await reconcileOrganizationAfterWrite({ get: async () => undefined } as never, { phase: 'character_organization' } as never, run, 'set_character_relation', {}, { pair: { pairKey: '["C1-P002","C1-P003"]' } })
  const organization = run.organization as { profileItems: Array<{ id: string; status: string }>; relationItems: Array<{ id: string; status: string }>; pairChecks: Array<{ pairKey: string; outcome: string | null }> }
  expect(organization.profileItems.map(item => item.status)).toEqual(['checked', 'checked'])
  expect(organization.relationItems.map(item => item.status)).toEqual(['pending', 'checked'])
  expect(organization.pairChecks.find(pair => pair.pairKey === '["C1-P002","C1-P003"]')!.outcome).toBeNull()
  expect(organization.pairChecks.find(pair => pair.pairKey === '["C1-P001","C1-P003"]')!.outcome).toBe('no_change')
})

it('当前人物合并到已有条目时改指保留编号并重查该条目', async () => {
  const store = { get: async (table: string, id: string) => table === 'characters' && id === 'C1-P002' ? { ...person('C1-P002', '乙'), revision: 2 } : undefined } as never
  const run: Record<string, unknown> = { bookId: 'a', organization: {
    revision: 1, step: 'profiles', activeWork: { id: 'profile:C1-P001', kind: 'profile', characterId: 'C1-P001', dataVersion: 1, targetIds: ['C1-P001'], targetId: 'C1-P001' },
    profileItems: [{ id: 'C1-P001', name: '甲', status: 'pending' }, { id: 'C1-P002', name: '乙', status: 'checked' }],
    relationItems: [], pairChecks: [],
  } }
  await reconcileOrganizationAfterWrite(store, { phase: 'character_organization' } as never, run, 'merge_assets', { kind: 'character', keepId: 'C1-P002', memberIds: ['C1-P001', 'C1-P002'] }, { affected: [{ kind: 'character', id: 'C1-P002', revision: 2 }] })
  const organization = run.organization as { activeWork: { id: string; characterId: string; targetId: string; dataVersion: number }; profileItems: Array<{ id: string; status: string }> }
  expect(organization.activeWork).toMatchObject({ id: 'profile:C1-P002', characterId: 'C1-P002', targetId: 'C1-P002', dataVersion: 2 })
  expect(organization.profileItems).toEqual([{ id: 'C1-P002', name: '乙', status: 'pending', outcome: null, reason: '人物已合并到当前条目，需要重新核对。', lastError: null }])
})

it('单人物资料整理创建独立运行并复用 P2 profile 工作项', async () => {
  const fetcher = organizationFetcher()
  const { db, service } = await setup(fetcher)
  const beforeProgress = await db.table('compileProgress').get('P2')
  let started = false
  const finished = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('单人物整理超时。')), 120000)
    const unsubscribe = service.subscribe(() => {
      const state = service.state('a')
      if (state?.running) started = true
      if (started && !state?.running) { clearTimeout(timeout); unsubscribe(); resolve() }
    })
  })
  const runId = await service.startCharacterOrganization('a', 'C1-P001', 'profile')
  await finished
  const run = await db.table('pipelineRuns').get(runId)
  expect(run.scope).toBe('character')
  expect(run.organization.mode).toBe('profile')
  expect(run.organization.targetCharacterId).toBe('C1-P001')
  expect(run.organization.profileItems).toHaveLength(1)
  expect(run.organization.profileItems[0]).toMatchObject({ id: 'C1-P001', status: 'checked' })
  expect(run.organization.relationItems).toHaveLength(0)
  expect(run.organization.step).toBe('done')
  expect(await db.table('compileProgress').get('P2')).toEqual(beforeProgress)
}, 120000)

it('单人物关系整理创建独立运行并归入 relations 工作项', async () => {
  const fetcher = organizationFetcher()
  const { db, service } = await setup(fetcher)
  let started = false
  const finished = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('单人物关系整理超时。')), 120000)
    const unsubscribe = service.subscribe(() => {
      const state = service.state('a')
      if (state?.running) started = true
      if (started && !state?.running) { clearTimeout(timeout); unsubscribe(); resolve() }
    })
  })
  const runId = await service.startCharacterOrganization('a', 'C1-P001', 'relations')
  await finished
  const run = await db.table('pipelineRuns').get(runId)
  expect(run.scope).toBe('character')
  expect(run.organization.mode).toBe('relations')
  expect(run.organization.targetCharacterId).toBe('C1-P001')
  expect(run.organization.profileItems).toHaveLength(0)
  expect(run.organization.relationItems).toHaveLength(1)
  expect(run.organization.relationItems[0]).toMatchObject({ id: 'C1-P001', status: 'checked' })
  expect(run.organization.step).toBe('done')
}, 120000)

it('单人物整理不改变完整三步统计和 compileProgress', async () => {
  const { db, service } = await setup()
  await service.startOrganization('a')
  const full = (await service.reports('a')).find(row => row.workflow === 'character_organization_v1' && row.scope !== 'character')!
  const summary = full.report.organizationSummary
  const progress = await db.table('compileProgress').get('P2')
  let started = false
  const finished = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('单人物整理超时。')), 120000)
    const unsubscribe = service.subscribe(() => {
      const state = service.state('a')
      if (state?.running) started = true
      if (started && !state?.running) { clearTimeout(timeout); unsubscribe(); resolve() }
    })
  })
  await service.startCharacterOrganization('a', 'C1-P001', 'profile')
  await finished
  const after = (await service.reports('a')).find(row => row.id === full.id)!
  expect(after.report.organizationSummary).toEqual(summary)
  expect(await db.table('compileProgress').get('P2')).toEqual(progress)
  expect((await service.reports('a')).filter(row => row.scope === 'character')).toHaveLength(1)
}, 120000)

it('三个步骤可以独立启动且不会自动串到下一步', async () => {
  const { db, service } = await setup()
  const wait = () => new Promise<void>((resolve, reject) => {
    let started = false
    const timeout = setTimeout(() => reject(new Error('步骤运行超时。')), 120000)
    const unsubscribe = service.subscribe(() => {
      const state = service.state('a')
      if (state?.running) started = true
      if (started && !state?.running) { clearTimeout(timeout); unsubscribe(); resolve() }
    })
  })
  const scan = wait(); const scanId = await service.startOrganizationStep('a', 'scan'); await scan
  const scanRun = await db.table('pipelineRuns').get(scanId)
  expect(scanRun.organization.runStep).toBe('scan')
  expect(scanRun.organization.step).toBe('done')
  expect(scanRun.organization.profileItems).toHaveLength(0)
  expect(scanRun.organization.relationItems).toHaveLength(0)

  const profiles = wait(); const profileId = await service.startOrganizationStep('a', 'profiles'); await profiles
  const profileRun = await db.table('pipelineRuns').get(profileId)
  expect(profileRun.organization.runStep).toBe('profiles')
  expect(profileRun.organization.profileItems.length).toBeGreaterThan(0)
  expect(profileRun.organization.relationItems).toHaveLength(0)
  expect(profileRun.organization.step).toBe('done')

  const relations = wait(); const relationId = await service.startOrganizationStep('a', 'relations'); await relations
  const relationRun = await db.table('pipelineRuns').get(relationId)
  expect(relationRun.organization.runStep).toBe('relations')
  expect(relationRun.organization.profileItems).toHaveLength(0)
  expect(relationRun.organization.relationItems.length).toBeGreaterThan(0)
  expect(relationRun.organization.step).toBe('done')
  expect(relationRun.organization.statisticsPending).toBe(false)
}, 120000)

it('暂停保留同一运行，继续后不新建任务', async () => {
  let held = false, release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string) as { messages: { role: string; content: unknown }[] }
    const input = parse([...body.messages].reverse().find(isInput)?.content)
    const work = input.work as Record<string, unknown> | undefined
    if (!held && work?.kind === 'relations') { held = true; await gate }
    return respond(init)!
  })
  const { db, service } = await setup(fetcher)
  const wait = () => new Promise<void>((resolve, reject) => {
    let started = false
    const timeout = setTimeout(() => reject(new Error('步骤运行超时。')), 120000)
    const unsubscribe = service.subscribe(() => {
      const state = service.state('a')
      if (state?.running) started = true
      if (started && !state?.running) { clearTimeout(timeout); unsubscribe(); resolve() }
    })
  })
  const first = wait(); const runId = await service.startOrganizationStep('a', 'relations')
  await expect.poll(() => held, { timeout: 10000 }).toBe(true)
  await service.pauseOrganization('a')
  release()
  await first
  const paused = await db.table('pipelineRuns').get(runId)
  expect(paused.status).toBe('paused')
  expect(service.state('a')?.paused).toBe(true)
  const second = wait(); const continued = await service.continueOrganization('a'); await second
  expect(continued).toBe(runId)
  expect((await db.table('pipelineRuns').get(runId)).status).toBe('completed')
}, 120000)

it('取消废弃旧队列，下一次开始创建新 runId', async () => {
  let held = false, release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string) as { messages: { role: string; content: unknown }[] }
    const input = parse([...body.messages].reverse().find(isInput)?.content)
    const work = input.work as Record<string, unknown> | undefined
    if (!held && work?.kind === 'relations') { held = true; await gate }
    return respond(init)!
  })
  const { db, service } = await setup(fetcher)
  const wait = () => new Promise<void>((resolve, reject) => {
    let started = false
    const timeout = setTimeout(() => reject(new Error('步骤运行超时。')), 120000)
    const unsubscribe = service.subscribe(() => {
      const state = service.state('a')
      if (state?.running) started = true
      if (started && !state?.running) { clearTimeout(timeout); unsubscribe(); resolve() }
    })
  })
  const first = wait(); const oldId = await service.startOrganizationStep('a', 'relations')
  await expect.poll(() => held, { timeout: 10000 }).toBe(true)
  await service.cancelOrganization('a')
  release()
  await first
  expect((await db.table('pipelineRuns').get(oldId)).status).toBe('cancelled')
  const second = wait(); const newId = await service.startOrganizationStep('a', 'relations'); await second
  expect(newId).not.toBe(oldId)
  expect((await db.table('pipelineRuns').get(newId)).status).toBe('completed')
}, 120000)

it('窗口关闭后租约过期，恢复为可继续并保留当前人物', async () => {
  const { db, service } = await setup()
  const organization = createOrganizationState(['C1-P001'])
  organization.mode = 'profile'
  organization.targetCharacterId = 'C1-P001'
  organization.step = 'profiles'
  organization.scanPages = []
  organization.profileItems = [{ id: 'C1-P001', name: '沈青', status: 'pending', outcome: null, reason: '', contentFingerprint: '', readRefs: [], commitIds: [] }]
  organization.activeWork = { id: 'profile:C1-P001', kind: 'profile', characterId: 'C1-P001', contextId: 'profiles', status: 'running', requestCount: 0, draft: null, commitIds: [], dataVersion: 1 }
  const runId = 'crashed-run'
  await db.table('pipelineRuns').put({
    id: runId, recordType: 'run', bookId: 'a', stage: 'P2', phase: 'character_organization', workflow: 'character_organization_v1', scope: 'character',
    organization, status: 'running', startedAt: new Date().toISOString(), planVersion: '2.2', tasks: [], commandIntents: [], appliedCommands: [], coverageItems: [], aiMode: 'agent',
    report: { status: 'running', failed: [], conflicted: [], groups: [], optimizedIds: [], skipped: [], beforeCounts: { characters: 4, locations: 0 }, afterCounts: { characters: 4, locations: 0 }, cost: 0, usage: { input: 0, output: 0, totalTokens: 0, cost: 0 }, externalChanges: [] },
  })
  await db.table('pipelineRuns').put({ id: 'lease:world', recordType: 'lease', bookId: 'a', lockKey: 'world', owner: 'old', runId, expiresAt: Date.now() - 1 })
  await service.recoverOrganization('a')
  const recovered = await db.table('pipelineRuns').get(runId)
  expect(recovered.status).toBe('paused')
  expect(recovered.organization.activeWork).toMatchObject({ kind: 'profile', characterId: 'C1-P001' })
  expect(await db.table('pipelineRuns').get('lease:world')).toBeUndefined()
  const finished = new Promise<void>((resolve, reject) => {
    let started = false
    const timeout = setTimeout(() => reject(new Error('恢复人物整理超时。')), 120000)
    const unsubscribe = service.subscribe(() => {
      const state = service.state('a')
      if (state?.running) started = true
      if (started && !state?.running) { clearTimeout(timeout); unsubscribe(); resolve() }
    })
  })
  expect(await service.continueCharacterOrganization('a', 'C1-P001')).toBe(runId)
  await finished
  const completed = await db.table('pipelineRuns').get(runId)
  expect(completed.status).toBe('completed')
  expect(completed.organization.profileItems[0]).toMatchObject({ id: 'C1-P001', status: 'checked' })
}, 120000)

it('P2 全书、按步骤和单人物入口都只有一套周期心跳', async () => {
  const original = globalThis.setInterval
  const intervals: number[] = []
  const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (timeout === 8000) intervals.push(timeout)
    return original(handler, timeout, ...args)
  }) as typeof setInterval)
  const wait = (service: ReturnType<typeof createWorldService>) => new Promise<void>((resolve, reject) => {
    let started = false
    const timeout = setTimeout(() => reject(new Error('人物整理超时。')), 120000)
    const unsubscribe = service.subscribe(() => {
      const state = service.state('a')
      if (state?.running) started = true
      if (started && !state?.running) { clearTimeout(timeout); unsubscribe(); resolve() }
    })
  })
  try {
    for (const mode of ['full', 'step', 'character'] as const) {
      intervals.length = 0
      const { service } = await setup()
      const finished = wait(service)
      if (mode === 'full') await service.startOrganization('a')
      else if (mode === 'step') await service.startOrganizationStep('a', 'profiles')
      else await service.startCharacterOrganization('a', 'C1-P001', 'profile')
      await finished
      expect(intervals, mode).toHaveLength(1)
    }
  } finally { spy.mockRestore() }
}, 180000)

it('连续三次心跳只暂时无法确认执行权时，保留当前人物并暂停而不是取消', async () => {
  let failing = false
  let first = true
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init!.body as string) as { messages: { role: string; content: unknown }[] }
    const input = parse([...body.messages].reverse().find(isInput)?.content)
    const work = input.work as Record<string, unknown> | undefined
    if (first && work?.kind === 'profile') {
      first = false
      failing = true
      await new Promise<void>((_, reject) => init!.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
    }
    return respond(init)!
  })
  const fixture = await setup(fetcher)
  const table = fixture.db.table('pipelineRuns') as unknown as { hook(name: string, fn?: (...args: unknown[]) => void): { unsubscribe(fn: unknown): void } }
  const hook = (...args: unknown[]) => {
    const mods = args[0] as Record<string, unknown>
    if (failing && mods.expiresAt !== undefined) throw new Error('CONFLICT:资料在提交前持续变化，请重新读取后继续。')
  }
  table.hook('updating', hook)
  const original = globalThis.setInterval
  const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => original(handler, timeout === 8000 ? 20 : timeout, ...args)) as typeof setInterval)
  const finished = new Promise<void>((resolve, reject) => {
    let started = false
    const timeout = setTimeout(() => reject(new Error('心跳暂停超时。')), 120000)
    const unsubscribe = fixture.service.subscribe(() => {
      const state = fixture.service.state('a')
      if (state?.running) started = true
      if (started && !state?.running) { clearTimeout(timeout); unsubscribe(); resolve() }
    })
  })
  const runId = await fixture.service.startCharacterOrganization('a', 'C1-P001', 'profile')
  await finished
  spy.mockRestore(); table.hook('updating').unsubscribe(hook)
  const paused = await fixture.db.table('pipelineRuns').get(runId)
  expect(paused.status).toBe('paused')
  expect(fixture.service.state('a')?.error).toContain('暂停')
  expect(fixture.service.state('a')?.error).not.toContain('取消')
  expect(paused.organization.activeWork).toMatchObject({ kind: 'profile', characterId: 'C1-P001' })
  expect(paused.organization.profileItems[0].status).toBe('pending')
  failing = false
  const resumed = new Promise<void>((resolve, reject) => {
    let started = false
    const timeout = setTimeout(() => reject(new Error('心跳暂停继续超时。')), 120000)
    const unsubscribe = fixture.service.subscribe(() => {
      const state = fixture.service.state('a')
      if (state?.running) started = true
      if (started && !state?.running) { clearTimeout(timeout); unsubscribe(); resolve() }
    })
  })
  expect(await fixture.service.continueCharacterOrganization('a', 'C1-P001')).toBe(runId)
  await resumed
  const completed = await fixture.db.table('pipelineRuns').get(runId)
  expect(completed.status).toBe('completed')
  expect(completed.organization.profileItems[0]).toMatchObject({ id: 'C1-P001', status: 'checked' })
}, 180000)

it('关系视角按当前人物输出，贾珩对贾珍的正反向不互换', async () => {
  const repo = createMemoryAgentRepository('a', {
    characters: [person('A', '贾珩'), person('B', '贾珍')].map(row => row as unknown as Record<string, unknown>),
  })
  await repo.transaction(true, async store => {
    await saveCharacterPair(store as never, { bookId: 'a', fromId: 'A', toId: 'B', forwardLabels: ['族弟'], reverseLabels: ['族兄'], reason: '原文为族兄', actor: 'manual', commitId: crypto.randomUUID(), tool: 'test' })
  })
  const fromJiaHeng = await repo.transaction(false, store => relationWork(store, 'A'))
  const fromJiaZhen = await repo.transaction(false, store => relationWork(store, 'B'))
  expect(fromJiaHeng?.relations.find(row => row.targetId === 'B')).toMatchObject({ forward: ['族弟'], reverse: ['族兄'] })
  expect(fromJiaZhen?.relations.find(row => row.targetId === 'A')).toMatchObject({ forward: ['族兄'], reverse: ['族弟'] })
})

it('没有证据的关系修改返回 unverified，方向对调也会被标出', async () => {
  const character = (id: string, name: string) => ({ ...person(id, name), revision: 1 } as unknown as Record<string, unknown>)
  const run = { id: 'run', bookId: 'a', recordType: 'run', stage: 'P2', phase: 'character_organization', workflow: 'character_organization_v1', status: 'running', report: {}, tasks: [{ taskId: 'task', workItemIds: ['organization:relations:A'], phase: 'character_organization', input: { workItems: [] }, appliedCommitIds: [], reviewedItems: [], readSet: { records: [], queries: [] } }], commandIntents: [], appliedCommands: [] }
  const repo = createMemoryAgentRepository('a', {
    characters: [character('A', '贾珩'), character('B', '贾珍')],
    pipelineRuns: [run, { id: 'lease:world', bookId: 'a', recordType: 'lease', lockKey: 'world', owner: 'owner', runId: 'run', expiresAt: Date.now() + 30000 }],
  })
  await repo.transaction(true, async store => {
    await saveCharacterPair(store as never, { bookId: 'a', fromId: 'A', toId: 'B', forwardLabels: ['族弟'], reverseLabels: ['族兄'], reason: '原文为族兄', actor: 'manual', commitId: crypto.randomUUID(), tool: 'test' })
    const current = (await store.get('pipelineRuns', 'run'))!
    await store.put('pipelineRuns', { ...current, organization: {
      version: 1, step: 'relations', revision: 1, mode: 'relations', targetCharacterId: 'A', executionVersion: 4,
      scanIds: [], scanPages: [], candidateGroups: [], candidateDecisions: [], profileItems: [],
      relationItems: [{ id: 'A', name: '贾珩', status: 'pending', outcome: null, reason: '', contentFingerprint: '', readRefs: [], commitIds: [] }],
      pairChecks: [], statisticsPending: false,
      activeWork: { id: 'relations:A', kind: 'relations', characterId: 'A', contextId: 'relations', status: 'running', requestCount: 0, draft: null, commitIds: [], dataVersion: 1 },
    } })
  })
  const scope = { bookId: 'a', profile: 'asset_editor' as const, phase: 'character_organization', workflow: 'character_organization_v1' as const, runId: 'run', taskId: 'task', owner: 'owner', workItemIds: ['organization:relations:A'], contextId: 'relations', unitId: 'relations:A', organizationWorkKind: 'relations' as const }
  const tool = createAgentTools(repo, scope).tools.find(row => row.name === 'submit_relation_review')!
  const result = await tool.execute('submit', { changes: [{ targetId: 'B', action: 'set', forwardLabels: ['族兄'], reverseLabels: ['族弟'], reason: '可能方向对调' }], done: true, reason: '测试' }) as { content: { text: string }[] }
  const ack = JSON.parse(result.content[0]!.text) as { unverified: string[]; applied: string[] }
  expect(ack.applied).toContain('B')
  expect(ack.unverified).toContain('B')
  const saved = await repo.transaction(false, store => store.get('pipelineRuns', 'run'))
  const organization = saved?.organization as { pairChecks: { pairKey: string; outcome: string }[] }
  expect(organization.pairChecks.find(row => row.pairKey.includes('A') && row.pairKey.includes('B'))).toMatchObject({ outcome: 'changed', evidenceStatus: 'unverified' })
}, 120000)

it('提交成功但回执丢失时，恢复入口不会重复写库', async () => {
  const character = { ...person('C1-P001', '沈青'), personality: '旧资料' }
  const activeWork = { id: 'profile:C1-P001', kind: 'profile', characterId: 'C1-P001', contextId: 'profiles', status: 'running', requestCount: 0, draft: null, commitIds: [], dataVersion: 1 }
  const organization = {
    version: 1, step: 'profiles', revision: 1, mode: 'profile', targetCharacterId: 'C1-P001', scanIds: [], scanPages: [], candidateGroups: [], candidateDecisions: [],
    profileItems: [{ id: 'C1-P001', name: '沈青', status: 'pending', outcome: null, reason: '', contentFingerprint: '', readRefs: [], commitIds: [] }],
    relationItems: [], pairChecks: [], statisticsPending: false, activeWork,
    contexts: { identity: { id: 'identity', status: 'completed', pendingWorkId: null }, profiles: { id: 'profiles', status: 'active', pendingWorkId: 'profile:C1-P001' }, relations: { id: 'relations', status: 'pending', pendingWorkId: null } },
    executionVersion: 4,
  }
  const task = (taskId: string) => ({ taskId, ordinal: 0, callId: crypto.randomUUID(), phase: 'character_organization', status: 'running', workItemIds: ['organization:profile:C1-P001'], input: { workItems: [] }, inputFingerprint: '', promptHash: '', attempt: 0, repairCount: 0, stepsUsed: 0, appliedCommitIds: [], reviewedItems: [], readSet: { records: [], queries: [] }, createdAt: '', updatedAt: '' })
  const run = { id: 'run', bookId: 'a', recordType: 'run', stage: 'P2', phase: 'character_organization', workflow: 'character_organization_v1', status: 'running', startedAt: '', report: {}, organization, tasks: [task('task-1'), task('task-2')], commandIntents: [], appliedCommands: [] }
  const repo = createMemoryAgentRepository('a', {
    characters: [character],
    pipelineRuns: [run, { id: 'lease:world', bookId: 'a', recordType: 'lease', lockKey: 'world', owner: 'owner', runId: 'run', expiresAt: Date.now() + 30000 }],
    storySessions: [{ id: 'session', bookId: 'a', profile: 'asset_editor', workflow: 'character_organization_v1', runId: 'run', leaseOwner: 'owner', leaseUntil: Date.now() + 30000, nextOrdinal: 0, leafId: null }],
  })
  const scope = (taskId: string) => ({ bookId: 'a', profile: 'asset_editor' as const, phase: 'character_organization', workflow: 'character_organization_v1' as const, runId: 'run', taskId, owner: 'owner', sessionId: 'session', workItemIds: ['organization:profile:C1-P001'], contextId: 'profiles', unitId: 'profile:C1-P001', organizationWorkKind: 'profile' as const })
  const args = { patch: { personality: '新资料' }, done: true, reason: '整理人物资料' }
  const first = createAgentTools(repo, scope('task-1')).tools.find(tool => tool.name === 'submit_profile_review')!
  await first.execute('call-1', args)
  const afterFirst = await repo.transaction(false, store => store.get('characters', 'C1-P001'))
  expect(afterFirst).toMatchObject({ personality: '新资料', revision: 2 })
  const second = createAgentTools(repo, scope('task-2')).tools.find(tool => tool.name === 'submit_profile_review')!
  const result = await second.execute('call-2', args) as { content: { type: string; text: string }[] }
  const ack = JSON.parse(result.content[0]!.text) as { alreadyApplied?: boolean }
  expect(ack.alreadyApplied).toBe(true)
  expect(await repo.transaction(false, store => store.get('characters', 'C1-P001'))).toMatchObject({ personality: '新资料', revision: 2 })
  const saved = await repo.transaction(false, store => store.get('pipelineRuns', 'run'))
  expect(saved?.appliedCommands).toHaveLength(1)
}, 120000)

it('人物资料提交前发生快照冲突时保留当前人物，继续后仍处理同一人物', async () => {
  let block = true
  let failures = 0
  const requests: string[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init!.body as string) as { messages: { role: string; content: unknown }[] }
    const input = parse([...body.messages].reverse().find(isInput)?.content)
    const work = input.work as Record<string, unknown> | undefined
    if (work?.kind === 'profile') requests.push(String((work.data as Record<string, unknown>).id))
    return respond(init)!
  })
  const fixture = await setup(fetcher)
  const hook = (...args: unknown[]) => {
    const mods = args[0] as Record<string, unknown>
    const current = args[2] as Record<string, unknown>
    const before = Array.isArray(current?.appliedCommands) ? current.appliedCommands.length : 0
    const after = Array.isArray(mods.appliedCommands) ? mods.appliedCommands.length : before
    if (!block || after <= before) return
    if (++failures > 3) return
    throw new Error('CONFLICT:资料在提交前持续变化，请重新读取后继续。')
  }
  const table = fixture.db.table('pipelineRuns') as unknown as { hook(name: string, fn?: (...args: unknown[]) => void): { unsubscribe(fn: unknown): void } }
  table.hook('updating', hook)
  const finished = new Promise<void>((resolve, reject) => {
    let started = false
    const timeout = setTimeout(() => reject(new Error('单人物整理超时。')), 120000)
    const unsubscribe = fixture.service.subscribe(() => {
      const state = fixture.service.state('a')
      if (state?.running) started = true
      if (started && !state?.running) { clearTimeout(timeout); unsubscribe(); resolve() }
    })
  })
  const runId = await fixture.service.startCharacterOrganization('a', 'C1-P001', 'profile')
  await finished
  block = false
  const paused = await fixture.db.table('pipelineRuns').get(runId)
  expect(paused.status).toBe('paused')
  expect(paused.organization.activeWork).toMatchObject({ kind: 'profile', characterId: 'C1-P001' })
  expect(paused.organization.profileItems[0].status).toBe('pending')
  const before = requests.filter(id => id === 'C1-P001').length
  const resumedFinished = new Promise<void>((resolve, reject) => {
    let started = false
    const timeout = setTimeout(() => reject(new Error('继续整理超时。')), 120000)
    const unsubscribe = fixture.service.subscribe(() => {
      const state = fixture.service.state('a')
      if (state?.running) started = true
      if (started && !state?.running) { clearTimeout(timeout); unsubscribe(); resolve() }
    })
  })
  expect(await fixture.service.continueCharacterOrganization('a', 'C1-P001')).toBe(runId)
  await resumedFinished
  expect(requests.filter(id => id === 'C1-P001').length).toBeGreaterThan(before)
  const completed = await fixture.db.table('pipelineRuns').get(runId)
  expect(completed.status).toBe('completed')
  expect(completed.organization.profileItems[0]).toMatchObject({ id: 'C1-P001', status: 'checked' })
  table.hook('updating').unsubscribe(hook)
}, 120000)
