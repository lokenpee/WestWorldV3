import type { createWorkspace } from '../../lib/storage/workspace'
import type { ModelService } from '../models/service'
import { createAgentRuntime } from '../agents/runtime'
import { createBookAgentRepository } from '../agents/repository'
import { appendEntry } from '../agents/commands'
import { hash, text } from '../agents/contracts'
import { createFrequencyCounter } from '../assets/derive'
import type { Character, LocationAsset } from '../assets/types'
import type { ActiveWork, OrganizationState, WorkKind } from './types'
import { renewOrganizationLease } from '../agents/organizationLease'
import { buildRelationReview, buildProfileReview, organizationReviewVersion } from '../agents/organizationReview'
import { profileWork, relationWork } from '../agents/organizationData'
import prompt from '../../../docs/v2/resources/v2.2/prompts/active/p2-character-organization.md?raw'

type Workspace = ReturnType<typeof createWorkspace>
type Store = import('../agents/repository').AgentStore
const pageSize = 100
const pageId = (index: number) => `scan:${index}`
export const organizationExecutionVersion = 4
const stageOf = (step: OrganizationState['step']) => step === 'scan' || step === 'resolve' ? 'identity' : step === 'profiles' ? 'profiles' : step === 'relations' ? 'relations' : undefined
const contextIdOf = (kind: WorkKind) => kind === 'directory' || kind === 'candidate' ? 'identity' : kind === 'profile' ? 'profiles' : 'relations'

export function createOrganizationState(characterIds: string[]): OrganizationState {
  const ids = [...new Set(characterIds)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const pages = Array.from({ length: Math.ceil(ids.length / pageSize) }, (_, index) => ({
    pageId: pageId(index), ids: ids.slice(index * pageSize, (index + 1) * pageSize),
    nextCursor: index + 1 < Math.ceil(ids.length / pageSize) ? String(index + 1) : null, status: 'issued' as const,
  }))
  return {
    version: 1, reviewVersion: organizationReviewVersion, executionVersion: organizationExecutionVersion,
    contexts: { identity: { id: 'identity', status: 'active', pendingWorkId: null }, profiles: { id: 'profiles', status: 'pending', pendingWorkId: null }, relations: { id: 'relations', status: 'pending', pendingWorkId: null } },
    activeWork: null, step: 'scan', revision: 1, scanIds: ids, scanPages: pages, candidateGroups: [], candidateDecisions: [], profileItems: [], relationItems: [], pairChecks: [], statisticsPending: false,
  }
}

async function organizationOf(repo: ReturnType<typeof createBookAgentRepository>, runId: string) {
  return repo.transaction(false, async store => {
    const run = await store.get('pipelineRuns', runId)
    if (!run?.organization) throw new Error('CONFLICT:人物整理进度不存在。')
    return { run, organization: run.organization as unknown as OrganizationState }
  })
}

function syncContexts(organization: OrganizationState) {
  if (!organization.contexts) organization.contexts = { identity: { id: 'identity', status: 'pending', pendingWorkId: null }, profiles: { id: 'profiles', status: 'pending', pendingWorkId: null }, relations: { id: 'relations', status: 'pending', pendingWorkId: null } }
  const current = stageOf(organization.step), order = ['identity', 'profiles', 'relations']
  for (const id of order) {
    const context = organization.contexts[id as keyof typeof organization.contexts]
    context.status = organization.step === 'done' || organization.step === 'finalize' || !current ? 'completed' : id === current ? 'active' : order.indexOf(id) < order.indexOf(current) ? 'completed' : 'pending'
    context.pendingWorkId = id === current ? organization.activeWork?.id ?? null : null
  }
}

async function ensureExecution(organization: OrganizationState) {
  if (Number(organization.executionVersion) === organizationExecutionVersion) { syncContexts(organization); return false }
  organization.executionVersion = organizationExecutionVersion
  organization.activeWork = null
  syncContexts(organization)
  return true
}

interface WorkUnit { id: string; kind: WorkKind; characterId?: string; summary: string; data: Record<string, unknown>; version: number }

async function nextUnit(store: Store, organization: OrganizationState): Promise<WorkUnit | null> {
  for (let guard = 0; guard < 8; guard++) {
    if (organization.step === 'scan') {
      const page = organization.scanPages.find(row => row.status !== 'checked' && !row.lastError)
      if (page) return { id: `directory:${page.pageId}`, kind: 'directory', summary: `目录页 ${page.pageId}（${page.ids.length}人）`, data: { pageId: page.pageId, ids: page.ids, nextCursor: page.nextCursor }, version: 0 }
      if (organization.scanPages.some(row => row.status !== 'checked')) return null
      organization.step = 'resolve'; syncContexts(organization); continue
    }
    if (organization.step === 'resolve') {
      const group = organization.candidateGroups.find(row => row.status === 'pending' && !row.lastError)
      if (group) return { id: `candidate:${group.id}`, kind: 'candidate', summary: `疑似组 ${group.memberNames?.join('、') || group.memberIds.join('、')}`, data: { group }, version: Number(group.revision) }
      if (organization.candidateGroups.some(row => row.status === 'pending')) return null
      if (organization.candidateGroups.length) organization.candidateGroups = []
      await buildProfileReview(store, organization as unknown as Record<string, unknown>)
      syncContexts(organization); continue
    }
    if (organization.step === 'profiles') {
      const item = organization.profileItems.find(row => row.status === 'pending' && !row.lastError)
      if (item) {
        const row = await store.get('characters', text(item.id)) as unknown as Character | undefined
        if (!row) return { id: `profile:${item.id}`, kind: 'profile', characterId: item.id, summary: `人物 ${item.id}（已不可用）`, data: { id: item.id, revision: 0 }, version: 0 }
        return { id: `profile:${item.id}`, kind: 'profile', characterId: item.id, summary: `人物 ${row.name}（${row.id}）`, data: await profileWork(row), version: Number(row.revision ?? 0) }
      }
      if (organization.profileItems.some(row => row.status === 'pending')) return null
      await buildRelationReview(store, organization as unknown as Record<string, unknown>)
      syncContexts(organization); continue
    }
    if (organization.step === 'relations') {
      const item = organization.relationItems.find(row => row.status === 'pending' && !row.lastError)
      if (item) {
        const data = await relationWork(store, item.id, organization.pairChecks as unknown as Record<string, unknown>[])
        if (!data) return { id: `relations:${item.id}`, kind: 'relations', characterId: item.id, summary: `人物关系 ${item.id}（已不可用）`, data: { id: item.id, revision: 0 }, version: 0 }
        return { id: `relations:${item.id}`, kind: 'relations', characterId: item.id, summary: `人物关系 ${data.name}（${data.id}）`, data, version: Number(data.revision ?? 0) }
      }
      if (organization.relationItems.some(row => row.status === 'pending')) return null
      organization.step = 'finalize'; organization.statisticsPending = true; syncContexts(organization); continue
    }
    return null
  }
  throw new Error('CONFLICT:人物整理步骤无法推进，请查看当前进度。')
}

function unitComplete(organization: OrganizationState, work: ActiveWork) {
  if (work.kind === 'directory') return organization.scanPages.find(row => row.pageId === work.targetId)?.status === 'checked'
  if (work.kind === 'candidate') return organization.candidateGroups.find(row => row.id === work.targetId)?.status === 'resolved' || !organization.candidateGroups.some(row => row.id === work.targetId)
  if (work.kind === 'profile') return organization.profileItems.find(row => row.id === work.characterId)?.status === 'checked'
  if (work.kind === 'relations') return organization.relationItems.find(row => row.id === work.characterId)?.status === 'checked'
  return false
}

async function finalizeStatistics(repo: ReturnType<typeof createBookAgentRepository>, runId: string, owner: string, sessionId: string, signal: AbortSignal, timestamp: string) {
  const snapshot = await repo.transaction(false, async store => ({
    people: await store.rows('characters') as unknown as Character[],
    places: await store.rows('locations') as unknown as LocationAsset[],
    texts: await store.rows('chapterTexts') as unknown as { chapterIndex: string; text: string }[],
  }))
  const peopleCounter = createFrequencyCounter(snapshot.people, true)
  const placeCounter = createFrequencyCounter(snapshot.places, false)
  for (const textRow of snapshot.texts) { peopleCounter.add(textRow); placeCounter.add(textRow) }
  const updates = [...peopleCounter.result().map((row, index) => ({ table: 'characters', row: row as Character, before: snapshot.people[index] })), ...placeCounter.result().map((row, index) => ({ table: 'locations', row: row as unknown as LocationAsset, before: snapshot.places[index] }))]
    .filter(({ row, before }) => JSON.stringify(row) !== JSON.stringify(before))
  await repo.transaction(true, async store => {
    signal.throwIfAborted()
    await renewOrganizationLease(store, { bookId: repo.bookId, runId, owner, sessionId })
    for (const { table, row, before } of updates) {
      const current = await store.get(table, text(row.id))
      if (!current || Number(current.revision) !== Number(before.revision)) throw new Error('CONFLICT:统计期间资料已变化，请继续整理。')
      await store.put(table, { ...current, frequency: row.frequency, ...(table === 'characters' ? { roleWeight: (row as Character).roleWeight ?? current.roleWeight, roleWeightSource: (row as Character).roleWeightSource ?? current.roleWeightSource } : {}), revision: Number(current.revision) + 1, updatedAt: timestamp })
    }
    const run = await store.get('pipelineRuns', runId)
    if (!run?.organization) throw new Error('CONFLICT:人物整理进度不存在。')
    const organization = run.organization as unknown as OrganizationState
    signal.throwIfAborted()
    organization.step = 'done'; organization.statisticsPending = false; organization.activeWork = null
    organization.revision += 1
    syncContexts(organization)
    await store.put('pipelineRuns', { ...run, organization })
  })
}

export interface OrganizationRunOptions {
  runId: string; owner: string; signal: AbortSignal
  models: Pick<ModelService, 'agent' | 'generate'>
  onPhase?: (phase: string) => void
  onProgress?: (processed: number, total: number) => void
}

export async function runCharacterOrganization(workspace: Workspace, bookId: string, options: OrganizationRunOptions) {
  const repo = createBookAgentRepository(workspace, bookId)
  const runtime = createAgentRuntime(options.models.agent, { generate: options.models.generate })
  for (let guard = 0; guard < 100000; guard++) {
    options.signal.throwIfAborted()
    await repo.transaction(true, store => renewOrganizationLease(store, { bookId, runId: options.runId, owner: options.owner }))
    const prepared = await repo.transaction(true, async store => {
      const run = await store.get('pipelineRuns', options.runId)
      if (!run?.organization) throw new Error('CONFLICT:人物整理进度不存在。')
      const organization = run.organization as unknown as OrganizationState
      await ensureExecution(organization)
      const unit = organization.step === 'finalize' || organization.step === 'done' ? null : await nextUnit(store, organization)
      await store.put('pipelineRuns', { ...run, organization })
      return { run, organization, unit }
    })
    const { run, organization, unit } = prepared
    if (organization.step === 'done' && !unit) return organization
    if (organization.step === 'finalize') {
      options.onPhase?.('更新出场统计')
      await finalizeStatistics(repo, options.runId, options.owner, text(run.sessionId), options.signal, new Date().toISOString())
      continue
    }
    if (!unit) {
      const pending = organization.step === 'scan' ? organization.scanPages.filter(row => row.status !== 'checked') : organization.step === 'resolve' ? organization.candidateGroups.filter(row => row.status === 'pending') : organization.step === 'profiles' ? organization.profileItems.filter(row => row.status === 'pending') : organization.relationItems.filter(row => row.status === 'pending')
      if (pending.length) {
        options.onPhase?.(`部分完成：${pending.length}项待处理，可继续`)
        await repo.transaction(true, async store => {
          const current = (await store.get('pipelineRuns', options.runId))!
          const state = current.organization as unknown as OrganizationState
          state.activeWork = null
          state.pauseNotice = `${pending.length}项待处理：${pending.slice(0, 5).map(item => 'id' in item ? item.id : (item as { pageId: string }).pageId).join('、')}`
          syncContexts(state)
          await store.put('pipelineRuns', { ...current, organization: state })
        })
        return organization
      }
      throw new Error('CONFLICT:当前步骤没有可处理的工作项，请查看进度。')
    }
    const taskId = crypto.randomUUID(), contextId = contextIdOf(unit.kind)
    const workId = unit.id
    const activeWork: ActiveWork = {
      id: workId, kind: unit.kind, ...(unit.characterId ? { characterId: unit.characterId } : {}), contextId,
      status: 'running', requestCount: 0, draft: null, commitIds: [], dataVersion: unit.version,
      targetIds: unit.characterId ? [unit.characterId] : [], targetId: unit.characterId ?? (unit.data.pageId as string | undefined),
    }
    await repo.transaction(true, async store => {
      const current = (await store.get('pipelineRuns', options.runId))!
      const state = current.organization as unknown as OrganizationState
      await appendEntry(store, { bookId, profile: 'asset_editor', phase: 'character_organization', runId: options.runId, taskId, owner: options.owner, sessionId: text(run.sessionId), workItemIds: [], contextId, unitId: workId }, { type: 'work_input', workId, contextId, ...(unit.characterId ? { characterId: unit.characterId } : {}), data: unit.data })
      state.activeWork = activeWork
      syncContexts(state)
      await store.put('pipelineRuns', { ...current, status: 'running', organization: state })
    })
    const workItem = { workItemId: `organization:${workId}`, kind: 'organization', id: unit.characterId ?? workId, revision: unit.version, factFingerprint: await hash(unit.data) }
    const total = organization.profileItems.length + organization.relationItems.length + organization.scanPages.length + organization.candidateGroups.length
    const done = organization.scanPages.filter(item => item.status === 'checked').length + organization.candidateDecisions.length + organization.profileItems.filter(item => item.status === 'checked').length + organization.relationItems.filter(item => item.status === 'checked').length
    const input = {
      bookId, runId: options.runId, taskId, planVersion: '2.2', stage: 'P2', phase: 'character_organization',
      remainingCount: Math.max(0, total - done), resume: { reason: guard ? 'continuation' : 'initial', appliedCommitIds: [], nextOperationKey: crypto.randomUUID(), remainingWorkIds: [workItem.workItemId] },
      workItems: [workItem], step: organization.step, organizationRevision: organization.revision, sessionId: text(run.sessionId), contextId, unitId: workId,
      work: { id: workId, kind: unit.kind, stage: organization.step, targetIds: unit.characterId ? [unit.characterId] : [], contextId, summary: unit.summary, data: unit.data, ...(unit.characterId ? { characterId: unit.characterId } : {}) },
    }
    options.onPhase?.(organization.step === 'scan' ? '识别人物与疑似同人' : organization.step === 'resolve' ? '核实疑似组并合并' : organization.step === 'profiles' ? '优化人物资料' : '整理人物关系')
    options.onProgress?.(done, total)
    const result = await runtime.run(repo, {
      profile: 'asset_editor', phase: 'character_organization', workflow: 'character_organization_v1',
      runId: options.runId, taskId, sessionId: text(run.sessionId), leaseOwner: options.owner, retainLease: true,
      workItems: [workItem], input, businessPrompt: prompt, prompt: JSON.stringify(input), signal: options.signal,
      contextId, unitId: workId,
    })
    const next = await organizationOf(repo, options.runId)
    if (unitComplete(next.organization, activeWork)) {
      await repo.transaction(true, async store => {
        const current = (await store.get('pipelineRuns', options.runId))!
        const state = current.organization as unknown as OrganizationState
        state.activeWork = null
        syncContexts(state)
        await store.put('pipelineRuns', { ...current, organization: state })
      })
      const completed = await organizationOf(repo, options.runId)
      const nextDone = completed.organization.scanPages.filter(item => item.status === 'checked').length + completed.organization.candidateDecisions.length + completed.organization.profileItems.filter(item => item.status === 'checked').length + completed.organization.relationItems.filter(item => item.status === 'checked').length
      options.onProgress?.(nextDone, total)
      continue
    }
    const message = result.error ?? result.itemFailure ?? '当前工作项未提交完成结果。'
    const global = /执行权|会话|租约|密钥|存储|网络|Connection|连接|超时|SCOPE|CONFLICT:任务|取消/.test(message)
    if (global) throw new Error(message)
    await repo.transaction(true, async store => {
      const current = (await store.get('pipelineRuns', options.runId))!
      const state = current.organization as unknown as OrganizationState
      const error = { code: 'WORK_ERROR', message, action: 'defer' as const, ...(result.itemFailure ? { tool: result.itemFailure.split(':')[0] } : {}) }
      if (state.activeWork) { state.activeWork.status = 'error'; state.activeWork.lastError = error }
      if (unit.kind === 'profile') { const item = state.profileItems.find(row => row.id === unit.characterId); if (item) item.lastError = error }
      if (unit.kind === 'relations') { const item = state.relationItems.find(row => row.id === unit.characterId); if (item) item.lastError = error }
      if (unit.kind === 'directory') { const page = state.scanPages.find(row => row.pageId === String((unit.data as Record<string, unknown>).pageId)); if (page) page.lastError = error }
      if (unit.kind === 'candidate') { const group = state.candidateGroups.find(row => row.id === (unit.data.group as Record<string, unknown>)?.id); if (group) (group as unknown as Record<string, unknown>).lastError = error }
      state.activeWork = null
      await store.put('pipelineRuns', { ...current, organization: state })
    })
  }
  throw new Error('CONFLICT:本轮整理工作项过多，请在报告中继续。')
}
