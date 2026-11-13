import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createAssetService } from '../src/features/assets/service'
import { createModelService } from '../src/features/models/service'
import { defaultConfig } from '../src/features/models/types'
import { createWorldService } from '../src/features/world/service'
import { createOrganizationState, nextUnit } from '../src/features/world/organization'
import { combineCandidates } from '../src/features/world/identityReview'
import { createMemoryAgentRepository, type Row } from '../src/features/agents/repository'
import { createAgentTools } from '../src/features/agents/tools'
import { agentStream } from './support/agent-protocol'
import { organizationPromptParts } from './support/organization-streams'

const opened: ReturnType<typeof createWorkspace>[] = []
afterEach(async () => { for (const w of opened.splice(0)) { w.close(); for (const name of await Dexie.getDatabaseNames()) if (name === w.scope.settingsName || name.startsWith(w.scope.bookPrefix)) await Dexie.delete(name) } })
const id = (index: number) => `P${String(index).padStart(3, '0')}`
const content = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value)
const json = (value: unknown): Row => { try { return JSON.parse(content(value)) as Row } catch { return {} } }

it('保存不翻页，主动前后翻阅显示当前页；回看不完成离开的页，重复前进不重放旧回执', async () => {
  let calls = 0
  const { db, service } = await fixture(async (_url, init) => {
    calls++
    const body = JSON.parse(init!.body as string), messages = body.messages as { role: string; content: unknown }[]
    const work = messages.map(message => organizationPromptParts(message.content)).find(Boolean)!
    const results = messages.filter(message => message.role === 'tool').map(message => json(message.content))
    const page = (results.findLast(row => row.page)?.page ?? work.data) as Row
    expect(messages.filter(message => message.role === 'user' && organizationPromptParts(message.content))).toHaveLength(1)
    expect(page.totalPages).toBe(3)
    expect(page.pageNumber).toBe([1, 1, 2, 1, 2, 3, 2, 3][calls - 1])
    if (calls === 1) return agentStream([{ name: 'save_identity_groups', args: { groups: [{ memberIds: [id(1), id(2)], reason: '可能是同一人物，存疑交人工选择，未提供证据' }] } }])
    const run = (await db.table('pipelineRuns').toArray()).find(row => row.organization)!
    if (calls === 2) {
      expect(run.organization.scanPages.every((page: Row) => page.status === 'issued')).toBe(true)
      expect(results.at(-1)).not.toHaveProperty('page')
      expect(results.at(-1)).not.toHaveProperty('nextPage')
    }
    if (calls === 7) expect(run.organization.scanPages[2].status).toBe('issued')
    if (calls > 8) throw new Error('翻页未正确结束')
    return agentStream([{ name: 'navigate_identity_pages', args: { currentPageId: page.pageId, direction: [3, 6].includes(calls) ? 'previous' : 'next' } }])
  })
  const runId = await service.startOrganizationStep('a', 'scan')
  await vi.waitFor(() => expect(service.state('a')?.running).toBe(false), { timeout: 15000 })
  const run = await db.table('pipelineRuns').get(runId)
  expect(service.state('a')?.error).toBeUndefined(); expect(calls).toBe(8)
  expect(run.status).toBe('completed')
  expect(run.organization.identityPageId).toBe('scan:2')
  expect(run.organization.scanPages.every((page: Row) => page.status === 'checked')).toBe(true)
  expect(run.organization.seenIdentityPageIds).toEqual(['scan:0', 'scan:1', 'scan:2'])
})

it('疑似组可以拆组、移人和撤销，调整后改回也生效，查过候选不会因自身保存而冲突', async () => {
  let calls = 0, original = '', split = ''
  const { db, service } = await fixture(async (_url, init) => {
    calls++
    const body = JSON.parse(init!.body as string), messages = body.messages as { role: string; content: unknown }[]
    const results = messages.filter(message => message.role === 'tool').map(message => json(message.content))
    const save = (groups: Row[]) => agentStream([{ name: 'save_identity_groups', args: { groups } }])
    if (calls === 1) return save([{ memberIds: [id(1), id(2), id(3), id(4)], reason: '初步疑似组' }])
    if (calls === 2 || calls === 4) return agentStream([{ name: 'query_candidate_groups', args: {} }])
    const groups = (results.findLast(row => row.items)?.items ?? []) as Row[]
    if (calls === 3) {
      original = String(groups[0].id)
      return save([{ groupId: original, memberIds: [id(1), id(2)], reason: '证据支持分为两组' }, { memberIds: [id(3), id(4)], reason: '拆出的另一组' }])
    }
    if (calls === 5) split = String(groups.find(group => group.id !== original)!.id)
    if (calls === 5 || calls === 7) return save([{ groupId: split, memberIds: [id(3), id(4), id(5)], reason: '加入相关人物' }])
    if (calls === 6) return save([{ groupId: original, memberIds: [id(1)], reason: '排除第二位，撤销此组' }, { groupId: split, memberIds: [id(3), id(4)], reason: '移出待查成员' }])
    if (calls === 8) {
      const run = (await db.table('pipelineRuns').toArray()).find(row => row.organization)!
      expect(run.organization.candidateGroups).toMatchObject([{ id: split, memberIds: [id(3), id(4), id(5)] }])
      expect(run.organization.candidateGroups).toHaveLength(1)
      expect(run.organization.scanPages[0].status).toBe('issued')
    }
    if (calls > 10) throw new Error('组编辑后未正确结束')
    return agentStream([{ name: 'navigate_identity_pages', args: { currentPageId: `scan:${calls - 8}`, direction: 'next' } }])
  })
  const runId = await service.startOrganizationStep('a', 'scan')
  await vi.waitFor(() => expect(service.state('a')?.running).toBe(false), { timeout: 15000 })
  expect(service.state('a')?.error).toBeUndefined(); expect(calls).toBe(10)
  expect((await db.table('pipelineRuns').get(runId)).status).toBe('completed')
  expect(await db.table('characters').count()).toBe(201)
  expect((await service.identityCandidates('a'))[0].memberIds).toEqual([id(3), id(4), id(5)])
})

async function fixture(fetcher: typeof fetch) {
  const suffix = crypto.randomUUID(), w = createWorkspace({ settingsName: `identity-${suffix}`, bookPrefix: `identity-books-${suffix}-` }); opened.push(w)
  const now = new Date().toISOString(); await w.settings.books.put({ id: 'a', title: '分页识别样本', sourceFileName: 'sample.txt', createdAt: now })
  const db = w.openBook('a')
  await db.chapters.put({ bookId: 'a', chapterIndex: '1', chapterName: '第一章', order: 0, charCount: 2 })
  await db.table('chapterTexts').put({ bookId: 'a', chapterIndex: '1', text: '原文' })
  await db.table('extractionReceipts').bulkPut(['worldAssets', 'narrativeAssets'].map(step => ({ key: `1:${step}`, bookId: 'a', chapterIndex: '1', substep: step, inputFingerprint: 'fixture', originIds: [], committedAt: now, runId: 'extract' })))
  await db.table('characters').bulkPut(Array.from({ length: 201 }, (_, i) => ({ id: id(i + 1), bookId: 'a', name: `人物${i + 1}`, aliases: [], identity: `身份${i + 1}`, revision: 1, confidence: 1, createdBy: 'P1', chapterIndex: '1' })))
  const models = createModelService(w, { fetch: fetcher, wait: async (_, signal) => signal.throwIfAborted() })
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://identity.invalid/v1', aggregationContextWindow: 65536 }, 'fake-key')
  const service = createWorldService(w, models, createAssetService(w), { assetReview: false })
  return { w, db, service }
}

it('连续Agent跨三页扩组、候选合组及追认早页单人；只有人工确认才改变人物', async () => {
  const requests: Row[] = []
  const { w, db, service } = await fixture(async (_url, init) => {
    const body = JSON.parse(init!.body as string); requests.push(body)
    if (requests.length > 6) throw new Error(`识别循环异常：${JSON.stringify(body.messages.slice(-2))}`)
    const tools = body.tools.map((tool: { function: { name: string } }) => tool.function.name)
    expect(tools.sort()).toEqual(['get_character_detail', 'get_character_relation', 'query_candidate_groups', 'query_character_catalog', 'query_locations', 'get_location_detail', 'save_identity_groups', 'navigate_identity_pages'].sort())
    const messages = body.messages as { role: string; content: unknown }[]
    const work = messages.map(message => organizationPromptParts(message.content)).find(Boolean)!
    const results = messages.filter(message => message.role === 'tool').map(message => json(message.content))
    const last = results.findLast(row => row.page) as Row | undefined
    const page = (last?.page ?? work.data) as Row
    const groups = (results.findLast(row => row.groups)?.groups ?? []) as Row[]
    const updates = page.pageId === 'scan:0' ? [{ memberIds: [id(1), id(2)], reason: 'first-page-marker：同一人的明确别名' }]
      : page.pageId === 'scan:1' ? [{ groupId: groups[0].id, memberIds: [id(1), id(2), id(101)], reason: '后页补充同一人物' }, { memberIds: [id(102), id(103)], reason: '另一个候选' }]
        : [{ groupId: groups[0].id, groupIds: groups.map(group => group.id), memberIds: [id(1), id(2), id(101), id(102), id(103)], reason: '核对后合并候选记录' }, { memberIds: [id(100), id(201)], reason: '此前单独人物在最后一页找到对应' }]
    if (page.pageId !== 'scan:0') expect(JSON.stringify(messages)).toContain('first-page-marker')
    return agentStream([{ name: 'save_identity_groups', args: { groups: updates } }, { name: 'navigate_identity_pages', args: { currentPageId: page.pageId, direction: 'next' } }])
  })
  const before = await db.table('characters').toArray()
  const runId = await service.startOrganizationStep('a', 'scan')
  await vi.waitFor(() => expect(service.state('a')?.running).toBe(false), { timeout: 20000 })
  expect(service.state('a')?.error).toBeUndefined()
  expect((await db.table('pipelineRuns').get(runId)).organization.profileItems).toEqual([])
  expect(requests.filter(body => JSON.stringify(body.tools).includes('save_identity_groups'))).toHaveLength(3)
  expect(await db.table('characters').toArray()).toEqual(before)
  const candidates = await service.identityCandidates('a')
  expect(candidates).toHaveLength(2)
  expect(candidates.map(row => row.memberIds.length).sort()).toEqual([2, 5])
  const first = candidates.find(row => row.memberIds.length === 5)!
  expect(combineCandidates([{ ...first, ai: undefined, id: 'code', reason: '代码依据' }], candidates)).toHaveLength(2)
  await service.dismissIdentityCandidate('a', first)
  expect(combineCandidates([], await service.identityCandidates('a'))).toHaveLength(1)
  const pair = candidates.find(row => row.memberIds.length === 2)!
  await service.confirm('a', 'character', { memberIds: pair.memberIds, keepId: id(100), canonicalName: '人物100', expectedRevisions: { [id(100)]: 1, [id(201)]: 1 } })
  expect(await db.table('characters').count()).toBe(200)
  expect(combineCandidates([], await service.identityCandidates('a'))).toHaveLength(0)
  expect((await w.openBook('a').table('pipelineRuns').toArray()).some(row => row.report?.groups?.some((group: Row) => group.method === 'mechanical'))).toBe(true)
}, 30000)

it('第一步可查询地点资产，保存无证据候选不改变人物或地点', async () => {
  let calls = 0
  const { db, service } = await fixture(async (_url, init) => {
    const body = JSON.parse(init!.body as string), names = body.tools.map((tool: { function: { name: string } }) => tool.function.name)
    expect(names).not.toContain('read_original')
    calls++
    if (calls === 1) return agentStream([{ name: 'query_locations', args: { name_like: '渡口' } }])
    if (calls === 2) {
      expect(JSON.stringify(body.messages)).toContain('青石渡口')
      return agentStream([{ name: 'get_location_detail', args: { ids: ['L1'] } }])
    }
    if (calls === 3) {
      expect(JSON.stringify(body.messages)).toContain('城外的渡口')
      return agentStream([{ name: 'save_identity_groups', args: { groups: [{ memberIds: [id(1), id(2)], reason: '疑似同人，交人工选择' }] } }])
    }
    if (calls > 6) throw new Error('查询或保存未按预期完成')
    return agentStream([{ name: 'navigate_identity_pages', args: { currentPageId: `scan:${calls - 4}`, direction: 'next' } }])
  })
  await db.table('locations').put({ id: 'L1', bookId: 'a', name: '青石渡口', description: '城外的渡口', revision: 1, chapterIndex: '1', createdBy: 'P1' })
  const people = await db.table('characters').toArray(), locations = await db.table('locations').toArray()
  const runId = await service.startOrganizationStep('a', 'scan')
  await vi.waitFor(() => expect(service.state('a')?.running).toBe(false), { timeout: 10000 })
  expect((await db.table('pipelineRuns').get(runId)).status).toBe('completed')
  expect((await service.identityCandidates('a'))).toHaveLength(1)
  expect(await db.table('characters').toArray()).toEqual(people)
  expect(await db.table('locations').toArray()).toEqual(locations)
})

it('旧resolve任务不再产生自动合并工作项，疑似组保留', async () => {
  const repo = createMemoryAgentRepository('a')
  const state = createOrganizationState([]); state.step = 'resolve'; state.runStep = 'scan'
  state.candidateGroups = [{ id: 'g', memberIds: ['A', 'B'], reason: '待人工', status: 'pending', revision: 1, createdAt: '', updatedAt: '' }]
  expect(await repo.transaction(false, store => nextUnit(store, state))).toBeNull()
  expect(state.step).toBe('done'); expect(state.candidateGroups).toHaveLength(1)
  const tools = createAgentTools(repo, { bookId: 'a', profile: 'asset_editor', phase: 'character_organization', runId: 'r', taskId: 't', owner: 'o', workItemIds: [], workKind: 'candidate' })
  expect(tools.tools.map(tool => tool.name)).not.toContain('merge_assets')
  expect(tools.tools.map(tool => tool.name)).not.toContain('get_tools_detail')
  tools.activate('read_original')
  expect(tools.currentTools().map(tool => tool.name)).not.toContain('read_original')
  for (const workKind of ['profile', 'relations'] as const) {
    const other = createAgentTools(repo, { bookId: 'a', profile: 'asset_editor', phase: 'character_organization', runId: 'r', taskId: 't', owner: 'o', workItemIds: [], workKind })
    expect(other.currentTools().map(tool => tool.name)).toContain('read_original')
  }
})

it.each([false, true])('后页重复失败暂停在失败页，已完成页和候选保留（参数校验失败：%s）', async invalidArgs => {
  let calls = 0
  const { db, service } = await fixture(async () => {
    calls++
    return agentStream(calls === 1 ? [{ name: 'save_identity_groups', args: { groups: [{ memberIds: [id(1), id(2)], reason: '已保存候选' }] } }, { name: 'navigate_identity_pages', args: { currentPageId: 'scan:0', direction: 'next' } }] : [{ name: 'save_identity_groups', args: invalidArgs ? { groups: 'invalid-groups' } : { groups: [{ memberIds: [id(101), '不存在'], reason: '错误样本' }] } }])
  })
  const runId = await service.startOrganizationStep('a', 'scan')
  await vi.waitFor(() => expect(service.state('a')?.running).toBe(false), { timeout: 10000 })
  const run = await db.table('pipelineRuns').get(runId)
  expect(calls).toBe(3)
  expect(run.status).toBe('paused')
  expect(run.organization.scanPages[0]).toMatchObject({ status: 'checked' })
  expect(run.organization.scanPages[0].lastError).toBeUndefined()
  expect(run.organization.scanPages[1].lastError).toBeDefined()
  expect(run.tasks.at(-1).lastError.message).not.toContain('任务总结')
  expect(run.organization.candidateGroups).toHaveLength(1)
  expect(await db.table('characters').count()).toBe(201)
})

it('页提交后暂停并恢复同一会话，保留候选和跨页信息；新扫描保留人工否决', async () => {
  let requests = 0, release: () => void = () => undefined, held = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const { db, service } = await fixture(async (_url, init) => {
    const body = JSON.parse(init!.body as string), messages = body.messages as { role: string; content: unknown }[]
    const work = messages.map(message => organizationPromptParts(message.content)).findLast(Boolean)!
    const results = messages.filter(message => message.role === 'tool').map(message => json(message.content))
    const page = (results.findLast(row => row.page)?.page ?? work.data) as Row
    requests++
    if (requests === 2) { held = true; await gate }
    if (requests === 3) {
      expect(JSON.stringify(messages)).toContain('pause-memory-marker')
      expect((work.data.people as Row[]).some(person => person.id === id(102))).toBe(false)
    }
    return agentStream([{ name: 'save_identity_groups', args: { groups: page.pageId === 'scan:0' ? [{ memberIds: [id(1), id(2)], reason: 'pause-memory-marker' }] : [] } }, { name: 'navigate_identity_pages', args: { currentPageId: page.pageId, direction: 'next' } }])
  })
  const runId = await service.startOrganizationStep('a', 'scan')
  await vi.waitFor(() => expect(held).toBe(true), { timeout: 10000 })
  expect(await db.table('characters').count()).toBe(201)
  await expect(service.confirm('a', 'character', { memberIds: [id(1), id(2)], keepId: id(1), canonicalName: '人物1', expectedRevisions: { [id(1)]: 1, [id(2)]: 1 } })).rejects.toThrow()
  await service.pauseOrganization('a'); release()
  await vi.waitFor(() => expect(service.state('a')?.running).toBe(false), { timeout: 10000 })
  const paused = await db.table('pipelineRuns').get(runId)
  expect(paused.status).toBe('paused'); expect(paused.organization.scanPages.filter((page: Row) => page.status === 'checked')).toHaveLength(1)
  expect(await service.identityCandidates('a')).toHaveLength(1)
  await service.confirm('a', 'character', { memberIds: [id(101), id(102)], keepId: id(101), canonicalName: '人物101', expectedRevisions: { [id(101)]: 1, [id(102)]: 1 } })
  expect(await db.table('characters').count()).toBe(200)
  expect(await service.continueOrganization('a', runId)).toBe(runId)
  await vi.waitFor(() => expect(service.state('a')?.running).toBe(false), { timeout: 10000 })
  expect((await db.table('pipelineRuns').get(runId)).status).toBe('completed')
  expect((await db.table('pipelineRuns').get(runId)).sessionId).toBe(paused.sessionId)
  const candidate = (await service.identityCandidates('a'))[0]
  await service.dismissIdentityCandidate('a', candidate)
  await service.startOrganizationStep('a', 'scan')
  await vi.waitFor(() => expect(service.state('a')?.running).toBe(false), { timeout: 10000 })
  expect(combineCandidates([], await service.identityCandidates('a'))).toEqual([])
}, 40000)
