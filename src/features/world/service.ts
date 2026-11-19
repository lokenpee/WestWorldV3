import { transact } from '../../lib/storage/transaction'
import type { createWorkspace } from '../../lib/storage/workspace'
import type { ModelService } from '../models/service'
import type { AssetService } from '../assets/service'
import type { Character, LocationAsset } from '../assets/types'
import type { MergeRequest, WorldKind } from '../assets/merge'
import type { Candidate } from './candidates'
import { candidateInput, scanCandidateRows } from './candidateScanner'
import { emptyReport, type WorldReport, type WorldRun, type ReviewMode, type ReviewScope, type OrganizationRunStep } from './types'
import { coverage, type Receipt } from '../extraction/recovery'
import { createBookAgentRepository, type Row } from '../agents/repository'
import { records, text } from '../agents/contracts'
import { coverageFingerprint, identityBatchSize, identityDependencies, saveIdentityQueue } from './queue'
import { createFrequencyCounter } from '../assets/derive'
import { createMechanicalQueue } from './mechanical'
import { repairAutomaticProtection } from './protection'
import { runAssetReview } from './assetReview'
import { createLeaseHeartbeat, leaseFailureKind } from './leaseHeartbeat'
import { createCharacterOrganizationState, createOrganizationState, createOrganizationStepState, runCharacterOrganization } from './organization'
import { resolveSession } from '../agents/sessions'
import { renewOrganizationLease } from '../agents/organizationLease'
import { buildProfileReview, organizationReviewVersion, refreshReview } from '../agents/organizationReview'
import { updateCharacterTiers } from './statistics'
import { readIdentityCandidates, dismissIdentityCandidate } from './identityReview'
import { pruneOrganizationHistory } from '../agents/p2History'
import { readBookTrace, readExecutionChain, readOrganizationRequests, readOrganizationStepIndex } from '../agents/trace'
import prompt from '../../../docs/v2/resources/v2.2/prompts/active/p2-identity.md?raw'

type Workspace = ReturnType<typeof createWorkspace>
type Entity = Character | LocationAsset
interface WorldState { running: boolean; phase: string; processed: number; total: number; error?: string; reportId?: string; reportType?: 'code' | 'ai'; mode?: 'ai' | 'mechanical' | 'targeted'; runId?: string; targetKind?: 'profile' | 'relations'; organizationStep?: OrganizationRunStep; paused?: boolean }
export function createWorldService(workspace: Workspace, models: Pick<ModelService, 'agent' | 'generate' | 'settings'>, assets: AssetService, options: { assetReview?: boolean } = {}) {
  const states = new Map<string, WorldState>(); const controllers = new Map<string, AbortController>(); const activeRuns = new Map<string, string>(); const pauseRequests = new Set<string>(); const hardCancelled = new Set<string>(); const listeners = new Set<() => void>()
  const set = (bookId: string, change: Partial<WorldState>) => { states.set(bookId, { ...(states.get(bookId) ?? { running: false, phase: '', processed: 0, total: 0 }), ...change }); listeners.forEach(listener => listener()) }
  const mechanical = createMechanicalQueue(workspace, assets, (bookId, state) => set(bookId, { ...state, mode: 'mechanical' }), bookId => controllers.has(bookId))
  async function eligibility(bookId: string) {
    if (!await workspace.settings.books.get(bookId)) throw new Error('书籍不存在。')
    const db = workspace.openBook(bookId)
    return transact(db, 'r', [db.chapters, db.table('extractionReceipts'), db.table('pipelineRuns'), db.table('compileProgress')], async (db) => {
      const allCovered = coverage(await db.chapters.toArray(), await db.table<Receipt>('extractionReceipts').toArray()).allCovered
      const locks = (await db.table('pipelineRuns').where('recordType').equals('lease').toArray()).filter(row => ['world', 'narrative', 'extraction', 'extraction:worldAssets', 'extraction:narrativeAssets'].includes(row.lockKey) && (typeof row.expiresAt !== 'number' || row.expiresAt > Date.now()))
      const locked = locks.length > 0
      const progress = await db.table('compileProgress').get('P2')
      return { ready: allCovered && !locked, covered: allCovered, locked, resumable: !!progress && ['running', 'paused', 'cancelled', 'failed'].includes(progress.status), leaseExpiry: locks.filter(row => typeof row.expiresAt === 'number').reduce<number | undefined>((at, row) => Math.min(at ?? Infinity, row.expiresAt), undefined) }
    })
  }
  async function assertReady(bookId: string) { const state = await eligibility(bookId); if (!state.covered) throw new Error('请先完成全书逐章提取。'); if (state.locked) throw new Error('本书已有世界、叙事或提取任务正在运行。') }
  const counts = async (bookId: string, db = workspace.openBook(bookId)) => ({ characters: await db.table('characters').count(), locations: await db.table('locations').count() })
  async function worldRows(bookId: string) {
    if (!await workspace.settings.books.get(bookId)) throw new Error('书籍不存在。')
    const db = workspace.openBook(bookId)
    return transact(db, 'r', [db.table('characters'), db.table('locations')], async (db) => ({ characters: await db.table<Character>('characters').toArray(), locations: await db.table<LocationAsset>('locations').toArray() }))
  }
  const scans = new Map<string, AbortController>()
  async function scan(bookId: string, saveReport = true) {
    scans.get(bookId)?.abort(new DOMException('候选扫描已取消，已保存的合并结果保留。', 'AbortError'))
    const controller = new AbortController(); scans.set(bookId, controller)
    try {
      await assertReady(bookId)
      const snapshot = await worldRows(bookId)
      const candidates = await scanCandidateRows(bookId, snapshot, controller.signal)
      controller.signal.throwIfAborted()
      await assertReady(bookId)
      const db = workspace.openBook(bookId)
      let reportId: string | undefined
      await transact(db, 'rw', [db.tables], async db => {
        controller.signal.throwIfAborted()
        const current = { characters: await db.table<Character>('characters').toArray(), locations: await db.table<LocationAsset>('locations').toArray() }
        if (JSON.stringify(candidateInput(current)) !== JSON.stringify(candidateInput(snapshot))) throw new Error('扫描期间人物或地点名称已变化，请重新扫描。')
        if (!saveReport) return
        const id = crypto.randomUUID(), now = new Date().toISOString()
        const report = emptyReport({ characters: snapshot.characters.length, locations: snapshot.locations.length })
        report.status = 'completed'
        const names = { character: new Map(snapshot.characters.map(row => [row.id, row.name])), location: new Map(snapshot.locations.map(row => [row.id, row.name])) }
        report.skipped = candidates.map(row => `${row.kind === 'character' ? '人物' : '地点'}候选：${row.memberIds.map(id => `${names[row.kind].get(id) ?? id}（${id}）`).join('、')}；${row.reason}`)
        controller.signal.throwIfAborted()
        await db.table('pipelineRuns').put({ id, recordType: 'run', bookId, stage: 'P2', phase: 'mechanical', status: 'completed', startedAt: now, finishedAt: now, planVersion: '2.2', report })
        reportId = id
      })
      controller.signal.throwIfAborted()
      if (reportId) set(bookId, { reportId, reportType: 'code', error: undefined })
      return candidates
    } finally { if (scans.get(bookId) === controller) scans.delete(bookId) }
  }
  async function confirm<K extends WorldKind>(bookId: string, kind: K, request: MergeRequest) {
    await assertReady(bookId)
    const result = await assets.confirmMerge(bookId, kind, request, 'mechanical')
    set(bookId, { reportId: result.reportId, reportType: 'code', error: undefined })
    return result
  }
  async function organize(bookId: string) {
    await assertReady(bookId)
    const automatic = await mechanical.mergeExactNames(bookId)
    return { ...automatic, candidates: await scan(bookId, true) }
  }
  async function start(bookId: string, startOptions: { reviewScope?: ReviewScope; reviewMode?: ReviewMode } = {}) {
    if (controllers.has(bookId) || mechanical.isRunning(bookId)) return
    const controller = new AbortController(); controllers.set(bookId, controller)
    const db = workspace.openBook(bookId); let runId: string = crypto.randomUUID(); const owner = crypto.randomUUID()
    let paused = false; let initialAgentUsage: Row | undefined
    let reviewScope: ReviewScope = startOptions.reviewScope ?? 'all_assets'
    let reviewMode: ReviewMode = startOptions.reviewMode ?? (reviewScope === 'relations' ? 'sample' : 'full')
    let acquired = false; let timer: ReturnType<typeof setInterval> | undefined
    set(bookId, { running: true, phase: '准备', processed: 0, total: 0, error: undefined, reportId: undefined, mode: 'ai' })
    const check = async (scopeDb = db) => {
      controller.signal.throwIfAborted()
      const lease = await scopeDb.table('pipelineRuns').get('lease:world')
      if (lease?.owner !== owner || lease.runId !== runId || lease.expiresAt <= Date.now()) throw new Error('世界资产整理执行权已失效。')
    }
    const addMessage = async (field: 'failed' | 'skipped' | 'conflicted', message: string) => {
      await transact(db, 'rw', [db.table('pipelineRuns')], async (db) => { await check(db); const run = (await db.table('pipelineRuns').get(runId)) as WorldRun; await db.table('pipelineRuns').put({ ...run, report: { ...run.report, [field]: [...run.report[field], message] } }) })
    }
    try {
      await assertReady(bookId)
      const [{ createAgentRuntime }, { needsOptimization, optimizeAsset }, { resolveModel }] = await Promise.all([import('../agents/runtime'), import('./optimizeAsset'), import('../models/registry')])
      const settings = await models.settings.load()
      if (!settings.apiKey || !settings.config.aggregationModel) throw new Error('请先在设置页保存整理模型与密钥。')
      const resolved = await resolveModel(settings.config, settings.apiKey, 'aggregation')
      await transact(db, 'rw', [db.tables], async (db) => {
        const leases = await db.table('pipelineRuns').toArray()
        if (leases.some(row => row.recordType === 'lease' && ['world', 'narrative', 'extraction', 'extraction:worldAssets', 'extraction:narrativeAssets'].includes(row.lockKey) && (typeof row.expiresAt !== 'number' || row.expiresAt > Date.now()))) throw new Error('本书已有处理任务。')
        if (!coverage(await db.chapters.toArray(), await db.table<Receipt>('extractionReceipts').toArray()).allCovered) throw new Error('请先完成全书逐章提取。')
        const now = new Date().toISOString()
        const previous = await db.table('compileProgress').get('P2')
        const existing = previous?.runId ? await db.table('pipelineRuns').get(previous.runId) : undefined
        const canResume = existing?.stage === 'P2' && ['ai', 'ai_identity', 'optimize', 'asset_review'].includes(existing.phase) && existing.status !== 'completed' && existing.report
          && (!startOptions.reviewScope || (existing.reviewScope ?? 'all_assets') === startOptions.reviewScope)
        if (canResume && existing) {
          runId = String(existing.id); initialAgentUsage = existing.usage
          reviewScope = (existing.reviewScope as ReviewScope | undefined) ?? 'all_assets'
          reviewMode = startOptions.reviewMode ?? (existing.reviewMode as ReviewMode | undefined) ?? (reviewScope === 'relations' ? 'sample' : 'full')
          const { finishedAt: _finishedAt, ...restored } = existing
          await db.table('pipelineRuns').put({ ...restored, phase: reviewScope === 'relations' ? 'asset_review' : 'ai_identity', status: 'running', reviewScope, reviewMode, report: { ...existing.report, status: 'running', failed: [] }, tasks: records(existing.tasks).map(task => task.status === 'running' ? { ...task, status: 'partial' } : task) })
        } else await db.table('pipelineRuns').put({ id: runId, recordType: 'run', bookId, stage: 'P2', phase: reviewScope === 'relations' ? 'asset_review' : 'ai_identity', status: 'running', startedAt: now, planVersion: '2.2', scope: 'fullBook', reviewScope, reviewMode, ...(reviewScope === 'relations' ? { relationReviewVersion: 2 } : {}), report: emptyReport(await counts(bookId, db)), tasks: [], commandIntents: [], appliedCommands: [], coverageItems: [], aiMode: 'agent' })
        await db.table('pipelineRuns').put({ id: 'lease:world', recordType: 'lease', bookId, lockKey: 'world', owner, runId, expiresAt: Date.now() + 30000 })
        await db.table('compileProgress').put({ bookId, stage: 'P2', status: 'running', runId, totalChapters: (await db.chapters.count()), completedChapters: [], failedChapters: [], updatedAt: now, scope: 'fullBook', planVersion: '2.2', unit: 'item', validity: 'current' })
      }); acquired = true
      timer = setInterval(() => { void transact(db, 'rw', [db.table('pipelineRuns')], async (db) => { const lease = await db.table('pipelineRuns').get('lease:world'); if (lease?.owner !== owner) throw new Error('执行权已变化'); await db.table('pipelineRuns').update('lease:world', { expiresAt: Date.now() + 30000 }) }).catch(error => { if (leaseFailureKind(error) === 'lost') controller.abort() }) }, 8000)
      const repo = createBookAgentRepository(workspace, bookId); const runtime = createAgentRuntime(models.agent)
      if (reviewScope === 'relations') {
        set(bookId, { phase: reviewMode === 'sample' ? '按原文核对人物关系（先10项）' : '按原文核对人物关系（全书）', processed: 0, total: 0 })
        const review = await runAssetReview(repo, runId, {
          owner, signal: controller.signal, models,
          reviewScope, reviewMode,
          onPhase: phase => set(bookId, { phase }),
          onProgress: (processed, total) => set(bookId, { processed, total }),
        })
        if (review.deferred) {
          paused = true
          await addMessage('skipped', reviewMode === 'sample' ? `人物关系小批核对完成 ${review.checked}/${review.total} 项，等待用户确认后继续全书。` : `人物关系核对已完成 ${review.checked}/${review.total} 项，剩余项待继续。`)
        }
        return
      }
      set(bookId, { phase: '核对自动合并与人工保留来源' })
      await repairAutomaticProtection(workspace, bookId, runId, owner)
      const initialQueue = await saveIdentityQueue(repo, runId, { owner, signal: controller.signal })
      const remaining = initialQueue.pending.map(row => text(row.workItemId))
      let scheduled: string[] = []
      for (;;) {
        await check()
        set(bookId, { phase: '读取已保存的核实进度' })
        const queue = await saveIdentityQueue(repo, runId, { owner, signal: controller.signal })
        set(bookId, { processed: queue.coverage.checked, total: queue.coverage.total })
        if (!queue.pending.length) break
        if (!scheduled.length) scheduled = remaining.splice(0, identityBatchSize)
        if (!scheduled.length) { paused = true; break }
        const nextId = scheduled.shift()!
        const batch = queue.pending.filter(row => row.workItemId === nextId)
        if (!batch.length) continue
        const kind = text(batch[0].kind)
        const taskId = crypto.randomUUID(), operationKey = crypto.randomUUID()
        const workItems = batch.map(row => ({ workItemId: row.workItemId, kind, id: row.id, revision: row.inputRevision, factFingerprint: row.inputFingerprint }))
        const input = { bookId, runId, taskId, planVersion: '2.2', remainingCount: queue.pending.length, resume: { reason: records(queue.run.tasks).length ? 'continuation' : 'initial', appliedCommitIds: records(queue.run.appliedCommands).map(row => text(row.commitId)), nextOperationKey: operationKey, remainingWorkIds: workItems.map(row => row.workItemId) }, stage: 'P2', phase: 'ai_identity', kind, scope: 'fullBook', workItems, afterId: null, pageLimit: 100 }
        set(bookId, { phase: `${kind === 'character' ? '核实人物身份' : '核实地点身份'} · ${batch[0].id} · 目标3分钟内收尾` })
        const result = await runtime.run(repo, { profile: 'asset_editor', phase: 'ai_identity', runId, taskId, leaseOwner: owner, retainLease: true, workItems, input, businessPrompt: prompt, prompt: JSON.stringify(input), signal: controller.signal })
        await check()
        const exhausted = !result.ok && result.result?.error?.kind === 'budget'
        await repo.transaction(true, async store => {
          const run = (await store.get('pipelineRuns', runId))!
          const task = records(run.tasks).find(row => row.taskId === taskId)!
          const saved = records(run.coverageItems)
          const reviewed = result.summary?.reviewedItems ?? (exhausted ? records(task.reviewedItems).filter(row => row.outcome === 'changed') : [])
          for (const item of reviewed) {
            const work = batch.find(row => row.workItemId === item.workItemId)
            if (!work) continue
            const row = await store.get(kind === 'character' ? 'characters' : 'locations', text(work.id))
            const fingerprint = await store.wait(coverageFingerprint(kind === 'character' ? 'characters' : 'locations', row ?? null))
            const dependencies = identityDependencies(task.readSet)
            for (const dependency of records(dependencies.records)) dependency.factFingerprint = await store.wait(coverageFingerprint(text(dependency.table), await store.get(text(dependency.table), text(dependency.resolvedId ?? dependency.id)) ?? null))
            const at = saved.findIndex(row => row.workItemId === item.workItemId)
            if (at < 0) continue
            saved[at] = { ...saved[at], status: row ? 'checked' : 'skipped', coveredRevision: Number(row?.revision ?? 0), coveredFingerprint: fingerprint, dependencies, taskId, outcome: row ? item.outcome : 'deleted', reason: item.reason, updatedAt: new Date().toISOString() }
          }
          await store.put('pipelineRuns', { ...run, status: 'running', phase: 'ai_identity', coverageItems: saved })
        })
        await saveIdentityQueue(repo, runId, { owner, signal: controller.signal })
        for (const item of result.summary?.reviewedItems ?? []) if (item.outcome === 'needs_review') await addMessage('skipped', `${item.workItemId}：${item.reason}`)
        if (result.itemFailure) await addMessage('failed', `${batch[0].id}：${result.itemFailure}`)
        if (!result.ok && !exhausted) { await addMessage('failed', result.error ?? '身份核实失败'); throw new Error(result.error ?? '身份核实失败。') }
      }
      set(bookId, { phase: '读取已保存的核实进度' })
      const identityCoverage = await saveIdentityQueue(repo, runId, { owner, signal: controller.signal })
      if (options.assetReview !== false && !identityCoverage.pending.length) {
        set(bookId, { phase: '核对全部资产与人物关系', processed: 0, total: 0 })
        const review = await runAssetReview(repo, runId, {
          owner, signal: controller.signal, models,
          reviewScope: 'all_assets', reviewMode: 'full',
          onPhase: phase => set(bookId, { phase }),
          onProgress: (processed, total) => set(bookId, { processed, total }),
        })
        if (review.deferred) {
          paused = true
          await addMessage('skipped', `全资产核对已完成 ${review.checked}/${review.total} 项，剩余项待继续；若叙事任务正在运行，请在其结束后继续。`)
        }
      }
      set(bookId, { phase: '按需整编详细资料', processed: 0 })
      await transact(db, 'rw', [db.table('pipelineRuns'), db.table('characters'), db.table('locations')], async (db) => {
        await check(db)
        const run = (await db.table<WorldRun>('pipelineRuns').get(runId))!
        const optimizations = []
        for (const draft of run.report.optimizations ?? []) {
          const exists = draft.status !== 'pending_review' || await db.table(draft.kind === 'character' ? 'characters' : 'locations').get(draft.assetId)
          optimizations.push(exists ? draft : { ...draft, status: 'stale' as const, reviewError: '该资产已合并或删除，旧稿已过期。' })
        }
        if (run.report.optimizations) await db.table('pipelineRuns').update(runId, { report: { ...run.report, optimizations } })
      })
      const checked = new Set(identityCoverage.items.filter(item => item.status === 'checked').map(item => `${item.kind}:${item.id}`))
      const all: { kind: WorldKind; row: Entity }[] = [...(await db.table<Character>('characters').toArray()).map(row => ({ kind: 'character' as const, row })), ...(await db.table<LocationAsset>('locations').toArray()).map(row => ({ kind: 'location' as const, row }))].filter(({ kind, row }) => checked.has(`${kind}:${row.id}`))
      const pendingDrafts = new Set((await db.table<WorldRun>('pipelineRuns').get(runId))?.report.optimizations?.filter(item => item.status === 'pending_review').map(item => `${item.kind}:${item.assetId}`) ?? [])
      set(bookId, { total: all.length })
      for (const [index, { kind, row }] of all.entries()) {
        await check()
        if (!needsOptimization(kind, row) && !pendingDrafts.has(`${kind}:${row.id}`)) { set(bookId, { processed: index + 1 }); continue }
        await optimizeAsset(workspace, models, bookId, runId, owner, kind, row, resolved.model, controller.signal, phase => set(bookId, { phase }))
        set(bookId, { processed: index + 1 })
      }

    } catch (error) { paused = false; const detail = error instanceof Error ? error.message || error.name : String(error); set(bookId, { error: controller.signal.aborted ? '整理已取消，已提交成果保留。' : `${states.get(bookId)?.phase ?? '整理'}：${detail}` }) }
    finally {
      if (acquired) try {
        const currentRun = await db.table('pipelineRuns').get(runId)
        if (currentRun?.report.groups.length || currentRun?.report.optimizedIds.length || currentRun?.report.aliasChecks?.length) {
          set(bookId, { phase: '更新出场统计' })
          const people = await db.table<Character>('characters').toArray(), places = await db.table<LocationAsset>('locations').toArray()
          const peopleCounter = createFrequencyCounter(people, true), placeCounter = createFrequencyCounter(places, false)
          for (const key of await db.table('chapterTexts').toCollection().primaryKeys()) {
            const source = await db.table<{ chapterIndex: string; text: string }>('chapterTexts').get(key)
            if (source) { peopleCounter.add(source); placeCounter.add(source) }
            await new Promise(resolve => setTimeout(resolve, 0))
          }
          const updates = [...peopleCounter.result().map((row, index) => ({ table: 'characters', row, before: people[index] })), ...placeCounter.result().map((row, index) => ({ table: 'locations', row, before: places[index] }))].filter(({ row, before }) => JSON.stringify(row) !== JSON.stringify(before))
          await transact(db, 'rw', [db.table('characters'), db.table('locations'), db.table('pipelineRuns')], async (db) => {
            const lease = await db.table('pipelineRuns').get('lease:world')
            if (lease?.owner !== owner || lease.expiresAt <= Date.now()) throw new Error('统计写入前执行权已变化。')
            for (const { table, row, before } of updates) {
              const current = await db.table(table).get(row.id)
              if (current?.revision !== before.revision) throw new Error('统计期间资产已变化。')
              await db.table(table).put({ ...row, revision: row.revision + 1 })
            }
          })
        }
      } catch (error) { set(bookId, { error: error instanceof Error ? error.message : '出场统计失败。' }) }
      clearInterval(timer)
      if (acquired) await transact(db, 'rw', [db.tables], async (db) => {
        const lease = await db.table('pipelineRuns').get('lease:world'); if (lease?.owner !== owner) return
        const run = (await db.table('pipelineRuns').get(runId)) as WorldRun & { usage?: WorldReport['usage'] }
        const report = run.report; const error = states.get(bookId)?.error
        const status = controller.signal.aborted ? 'cancelled' : paused ? report.failed.length ? 'degraded' : 'paused' : error ? 'failed' : report.failed.length || report.conflicted.length ? 'degraded' : 'completed'
        const usage = { input: report.usage.input + Math.max(0, (run.usage?.input ?? 0) - Number(initialAgentUsage?.input ?? 0)), output: report.usage.output + Math.max(0, (run.usage?.output ?? 0) - Number(initialAgentUsage?.output ?? 0)), totalTokens: report.usage.totalTokens + Math.max(0, (run.usage?.totalTokens ?? 0) - Number(initialAgentUsage?.totalTokens ?? 0)), cost: report.usage.cost + Math.max(0, (run.usage?.cost ?? 0) - Number(initialAgentUsage?.cost ?? 0)), costStatus: run.usage?.costStatus === 'unknown' || report.usage.costStatus === 'unknown' ? 'unknown' : 'estimated' }
        const completedReport = { ...report, afterCounts: await counts(bookId, db), status, usage, cost: usage.cost, skipped: paused && error ? [...new Set([...report.skipped, error])] : report.skipped, failed: error && !controller.signal.aborted && !paused ? [...new Set([...report.failed, error])] : report.failed }
        await db.table('pipelineRuns').put({ ...run, phase: 'ai', status, finishedAt: new Date().toISOString(), report: completedReport })
        await db.table('compileProgress').update('P2', { status: status === 'degraded' ? 'failed' : status, validity: status === 'completed' ? 'current' : 'stale', updatedAt: new Date().toISOString() })
        await db.table('pipelineRuns').delete('lease:world')
        set(bookId, { reportId: runId, reportType: 'ai' })
      }).catch(() => set(bookId, { error: '报告保存失败，请检查本地存储。' }))
      controllers.delete(bookId); set(bookId, { running: false })
    }
  }
  async function startCharacterOrganization(bookId: string, characterId: string, kind: 'profile' | 'relations'): Promise<string> {
    if (controllers.has(bookId) || mechanical.isRunning(bookId)) throw new Error('本书已有处理任务。')
    const db = workspace.openBook(bookId)
    await assertReady(bookId)
    const target = await db.table<Character>('characters').get(characterId)
    if (!target || target.bookId !== bookId) throw new Error('人物不存在或不属于本书。')
    const settings = await models.settings.load()
    if (!settings.apiKey || !settings.config.aggregationModel) throw new Error('请先在设置页保存整理模型与密钥。')
    const repo = createBookAgentRepository(workspace, bookId)
    const organization = await repo.transaction(false, store => createCharacterOrganizationState(store, characterId, kind))
    const runId = crypto.randomUUID(), owner = crypto.randomUUID(), now = new Date().toISOString()
    let sessionId = ''
    let heartbeatFailure = ''
    const controller = new AbortController()
    controllers.set(bookId, controller)
    set(bookId, { running: true, phase: kind === 'profile' ? '整理人物资料' : '整理人物关系', processed: 0, total: 1, error: undefined, reportId: undefined, mode: 'targeted', runId, targetKind: kind })
    try {
      await transact(db, 'rw', [db.tables], async (db) => {
        const leases = await db.table('pipelineRuns').toArray()
        if (leases.some(row => row.recordType === 'lease' && ['world', 'narrative', 'extraction', 'extraction:worldAssets', 'extraction:narrativeAssets'].includes(row.lockKey) && (typeof row.expiresAt !== 'number' || row.expiresAt > Date.now()))) throw new Error('本书已有处理任务。')
        await db.table('pipelineRuns').put({
          id: runId, bookId, recordType: 'run', stage: 'P2', phase: 'character_organization', workflow: 'character_organization_v1',
          scope: 'character', organization, status: 'running', startedAt: now, planVersion: '2.2', report: emptyReport(await counts(bookId, db)),
          tasks: [], commandIntents: [], appliedCommands: [], coverageItems: [], aiMode: 'agent',
        })
        await db.table('pipelineRuns').put({ id: 'lease:world', recordType: 'lease', bookId, lockKey: 'world', owner, runId, expiresAt: Date.now() + 30000 })
      })
      sessionId = await repo.transaction(true, async store => {
        await renewOrganizationLease(store, { bookId, runId, owner })
        const session = await resolveSession(store, bookId, undefined, 'asset_editor', 'character_organization_v1', runId)
        await store.put('storySessions', { ...session, leaseOwner: owner, leaseUntil: Date.now() + 30000 })
        return text(session.id)
      })
      await db.table('pipelineRuns').update(runId, { sessionId })
      const heartbeat = createLeaseHeartbeat(
        () => repo.transaction(true, store => renewOrganizationLease(store, { bookId, runId, owner, sessionId })),
        (error, consecutive) => {
          const message = error instanceof Error ? error.message : '人物整理执行权续租失败。'
          if (leaseFailureKind(error) === 'lost' || consecutive >= 3) { heartbeatFailure = message; controller.abort() }
        },
      )
      void (async () => {
        try {
          await runCharacterOrganization(workspace, bookId, {
            runId, owner, signal: controller.signal, models, shouldPause: () => pauseRequests.has(runId),
            onPhase: phase => set(bookId, { phase }),
            onProgress: (processed, total) => set(bookId, { processed, total }),
          })
        } catch (error) {
          set(bookId, { error: heartbeatFailure ? `单人物整理已暂停：${heartbeatFailure}` : controller.signal.aborted ? '单人物整理已取消，已提交成果保留。' : error instanceof Error ? error.message : '单人物整理失败。' })
        } finally {
          heartbeat.close()
          await transact(db, 'rw', [db.tables], async (db) => {
            const lease = await db.table('pipelineRuns').get('lease:world')
            if (lease?.owner !== owner || lease.runId !== runId) return
            const run = (await db.table<WorldRun>('pipelineRuns').get(runId))!
            const organization = run.organization
            const error = states.get(bookId)?.error
            const status = heartbeatFailure ? 'paused' : controller.signal.aborted ? 'cancelled' : error ? 'failed' : organization?.step === 'done' ? 'completed' : 'paused'
            const usage = (run as WorldRun & { usage?: WorldReport['usage'] }).usage
            const report = { ...run.report, afterCounts: await counts(bookId, db), ...(usage ? { usage: { input: usage.input, output: usage.output, totalTokens: usage.totalTokens, cost: usage.cost, costStatus: usage.costStatus ?? 'estimated' as const }, cost: usage.cost } : {}), status }
            await db.table('pipelineRuns').put({ ...run, status, finishedAt: new Date().toISOString(), report })
            await db.table('pipelineRuns').delete('lease:world')
            const session = sessionId ? await db.table('storySessions').get(sessionId) : undefined
            if (session?.leaseOwner === owner) {
              const { leaseOwner: _owner, leaseUntil: _until, ...saved } = session
              await db.table('storySessions').put(saved)
            }
          }).catch(() => set(bookId, { error: '单人物整理结果保存失败，请检查本地存储。' }))
          controllers.delete(bookId)
          set(bookId, { running: false, runId: undefined, targetKind: undefined })
        }
      })()
      return runId
    } catch (error) {
      controllers.delete(bookId)
      set(bookId, { running: false, error: error instanceof Error ? error.message : '单人物整理启动失败。', runId: undefined, targetKind: undefined })
      throw error
    }
  }

  async function latestOrganizationRun(bookId: string, statuses?: string[]) {
    const rows = await workspace.openBook(bookId).table<WorldRun>('pipelineRuns').where('stage').equals('P2').toArray()
    return rows.filter(row => row.workflow === 'character_organization_v1' && (!statuses || statuses.includes(text(row.status))))
      .sort((a, b) => text(b.startedAt).localeCompare(text(a.startedAt)))[0]
  }

  async function finalizeStepRun(bookId: string, runId: string, owner: string, controller: AbortController, sessionId: string, error?: string) {
    const db = workspace.openBook(bookId)
    const run = await db.table<WorldRun>('pipelineRuns').get(runId)
    if (!run) return
    const organization = run.organization
    const cancelled = hardCancelled.has(runId)
    const abortedWithoutCancel = controller.signal.aborted && !cancelled
    const paused = pauseRequests.has(runId) && !cancelled && !abortedWithoutCancel
    const failure = error || (abortedWithoutCancel ? '执行器被中止，可能是会话执行权或运行租约变化。' : '')
    const status = cancelled ? 'cancelled' : paused || abortedWithoutCancel ? 'paused' : failure ? 'failed' : organization?.step === 'done' ? 'completed' : 'paused'
    const usage = (run as WorldRun & { usage?: WorldReport['usage'] }).usage
    const report = { ...run.report, afterCounts: await counts(bookId), ...(usage ? { usage: { input: usage.input, output: usage.output, totalTokens: usage.totalTokens, cost: usage.cost, costStatus: usage.costStatus ?? 'estimated' as const }, cost: usage.cost } : {}), status }
    let saveError = ''
    await transact(db, 'rw', [db.tables], async (db) => {
      const latest = await db.table<WorldRun>('pipelineRuns').get(runId)
      if (!latest) return
      await db.table('pipelineRuns').put({ ...latest, ...(latest.organization ? { organization: { ...latest.organization, pauseRequested: paused } } : {}), status, finishedAt: new Date().toISOString(), report })
      const progress = await db.table('compileProgress').get('P2')
      if (progress?.runId === runId) await db.table('compileProgress').update('P2', { status, validity: status === 'completed' ? 'current' : 'stale', updatedAt: new Date().toISOString() })
      const lease = await db.table('pipelineRuns').get('lease:world')
      if (lease?.owner === owner && lease.runId === runId) await db.table('pipelineRuns').delete('lease:world')
      const session = sessionId ? await db.table('storySessions').get(sessionId) : undefined
      if (session?.leaseOwner === owner) {
        const { leaseOwner: _owner, leaseUntil: _until, ...saved } = session
        await db.table('storySessions').put(saved)
      }
    }).catch(() => { saveError = '人物整理结果保存失败，请检查本地存储后继续。' })
    pauseRequests.delete(runId); hardCancelled.delete(runId)
    if (activeRuns.get(bookId) === runId) activeRuns.delete(bookId)
    // A cancelled executor may finish after a new run has started. Its cleanup must not
    // clear the new controller or announce that the new run has stopped.
    if (controllers.get(bookId) !== controller) return
    controllers.delete(bookId)
    const needsResume = !!saveError || status === 'paused'
    set(bookId, { running: false, paused: needsResume, organizationStep: needsResume ? organization?.runStep : undefined, runId: needsResume ? runId : undefined, phase: needsResume ? '已暂停' : '', ...(saveError || failure ? { error: saveError || failure } : {}) })
  }

  async function executeStep(bookId: string, runId: string, owner: string, controller: AbortController, sessionId: string) {
    const repo = createBookAgentRepository(workspace, bookId)
    let failure = ''
    let consecutive = 0
    const timer = setInterval(() => { void repo.transaction(true, store => renewOrganizationLease(store, { bookId, runId, owner, sessionId })).then(() => { consecutive = 0 }).catch(error => {
      const message = error instanceof Error ? error.message : '人物整理执行权续租失败。'
      if (leaseFailureKind(error) === 'lost' || ++consecutive >= 3) { failure = message; controller.abort() }
    }) }, 8000)
    try {
      await runCharacterOrganization(workspace, bookId, {
        runId, owner, signal: controller.signal, models, shouldPause: () => pauseRequests.has(runId),
        onPhase: phase => set(bookId, { phase }),
        onProgress: (processed, total) => set(bookId, { processed, total }),
      })
    } catch (error) {
      if (!hardCancelled.has(runId) && !controller.signal.aborted && !pauseRequests.has(runId)) failure = error instanceof Error ? error.message : '人物整理失败。'
    } finally {
      clearInterval(timer)
      await finalizeStepRun(bookId, runId, owner, controller, sessionId, failure || undefined)
    }
  }

  async function recoverOrganization(bookId: string) {
    if (controllers.has(bookId)) return
    const run = await latestOrganizationRun(bookId, ['running'])
    if (!run) return
    const db = workspace.openBook(bookId)
    const lease = await db.table('pipelineRuns').get('lease:world')
    if (lease && lease.runId === run.id && Number(lease.expiresAt) > Date.now()) return
    await transact(db, 'rw', [db.tables], async (db) => {
      const current = await db.table<WorldRun>('pipelineRuns').get(run.id)
      if (!current) return
      await db.table('pipelineRuns').put({ ...current, status: 'paused', report: { ...current.report, status: 'paused' } })
      await db.table('compileProgress').update('P2', { status: 'paused', validity: 'stale', updatedAt: new Date().toISOString() })
      await db.table('pipelineRuns').delete('lease:world')
    })
    const legacyStep = !run.organization?.runStep ? (['scan', 'resolve'].includes(String(run.organization?.step)) ? 'scan' : run.organization?.step === 'profiles' ? 'profiles' : run.organization?.step === 'relations' ? 'relations' : undefined) : run.organization?.runStep
    set(bookId, { running: false, paused: true, runId: run.id, organizationStep: legacyStep, phase: '已中断，可继续' })
  }

  async function startOrganizationStep(bookId: string, step: OrganizationRunStep, restart: import('./reuse').RestartMode = 'all'): Promise<string> {
    if (controllers.has(bookId) || mechanical.isRunning(bookId)) throw new Error('本书已有处理任务。')
    const active = await latestOrganizationRun(bookId, ['running', 'paused'])
    if (active) throw new Error('本书已有运行中或已暂停的人物整理任务，请先继续或取消。')
    await assertReady(bookId)
    const settings = await models.settings.load()
    if (!settings.apiKey || !settings.config.aggregationModel) throw new Error('请先在设置页保存整理模型与密钥。')
    const repo = createBookAgentRepository(workspace, bookId)
    const organization = await repo.transaction(false, store => createOrganizationStepState(store, step, restart))
    const runId = crypto.randomUUID(), owner = crypto.randomUUID(), now = new Date().toISOString()
    const controller = new AbortController()
    controllers.set(bookId, controller); activeRuns.set(bookId, runId)
    set(bookId, { running: true, phase: `准备第${step === 'scan' ? '一' : step === 'profiles' ? '二' : '三'}步`, processed: 0, total: 0, error: undefined, reportId: undefined, mode: 'ai', organizationStep: step, paused: false })
    try {
      const db = workspace.openBook(bookId)
      await transact(db, 'rw', [db.tables], async (db) => {
        const leases = await db.table('pipelineRuns').toArray()
        if (leases.some(row => row.recordType === 'lease' && ['world', 'narrative', 'extraction', 'extraction:worldAssets', 'extraction:narrativeAssets'].includes(row.lockKey) && (typeof row.expiresAt !== 'number' || row.expiresAt > Date.now()))) throw new Error('本书已有处理任务。')
        await db.table('pipelineRuns').put({ id: runId, recordType: 'run', bookId, stage: 'P2', phase: 'character_organization', workflow: 'character_organization_v1', scope: 'fullBook', organization, status: 'running', startedAt: now, planVersion: '2.2', report: emptyReport(await counts(bookId, db)), tasks: [], commandIntents: [], appliedCommands: [], coverageItems: [], aiMode: 'agent' })
        await db.table('pipelineRuns').put({ id: 'lease:world', recordType: 'lease', bookId, lockKey: 'world', owner, runId, expiresAt: Date.now() + 30000 })
        await db.table('compileProgress').put({ bookId, stage: 'P2', status: 'running', runId, totalChapters: await db.chapters.count(), completedChapters: [], failedChapters: [], updatedAt: now, scope: 'fullBook', planVersion: '2.2', unit: 'item', validity: 'current' })
      })
      const sessionId = await repo.transaction(true, async store => {
        await renewOrganizationLease(store, { bookId, runId, owner })
        const session = await resolveSession(store, bookId, undefined, 'asset_editor', 'character_organization_v1', runId)
        await store.put('storySessions', { ...session, leaseOwner: owner, leaseUntil: Date.now() + 30000 })
        return text(session.id)
      })
      await workspace.openBook(bookId).table('pipelineRuns').update(runId, { sessionId })
      void executeStep(bookId, runId, owner, controller, sessionId)
      return runId
    } catch (error) {
      controllers.delete(bookId); activeRuns.delete(bookId)
      set(bookId, { running: false, error: error instanceof Error ? error.message : '人物整理启动失败。', organizationStep: step })
      throw error
    }
  }

  async function pauseOrganization(bookId: string) {
    const runId = activeRuns.get(bookId) || states.get(bookId)?.runId
    if (!runId || !controllers.has(bookId)) throw new Error('当前没有运行中的人物整理任务。')
    pauseRequests.add(runId)
    set(bookId, { phase: '暂停中，等待当前操作结束' })
  }

  async function continueOrganization(bookId: string, requestedRunId?: string): Promise<string> {
    if (controllers.has(bookId) || mechanical.isRunning(bookId)) throw new Error('本书已有处理任务。')
    const db = workspace.openBook(bookId)
    const run = requestedRunId ? await db.table<WorldRun>('pipelineRuns').get(requestedRunId) : await latestOrganizationRun(bookId, ['paused'])
    if (!run || run.status !== 'paused') throw new Error('没有可继续的暂停任务。')
    const currentLease = await db.table('pipelineRuns').get('lease:world')
    if (currentLease && currentLease.runId === run.id && Number(currentLease.expiresAt ?? 0) > Date.now()) throw new Error('人物整理正在其他窗口运行或暂停，请先关闭其他窗口。')
    if (controllers.has(bookId) || mechanical.isRunning(bookId)) throw new Error('本书已有处理任务。')
    const controller = new AbortController(), owner = crypto.randomUUID()
    pauseRequests.delete(run.id); hardCancelled.delete(run.id)
    controllers.set(bookId, controller); activeRuns.set(bookId, run.id)
    const ownsStartup = () => controllers.get(bookId) === controller && activeRuns.get(bookId) === run.id
    const assertStarting = () => {
      controller.signal.throwIfAborted()
      if (hardCancelled.has(run.id) || !ownsStartup()) throw new Error('人物整理启动已取消。')
    }
    let sessionId = '', committed = false
    try {
      await transact(db, 'rw', [db.tables], async (db) => {
        assertStarting()
        const leases = await db.table('pipelineRuns').toArray()
        if (leases.some(row => row.recordType === 'lease' && ['world', 'narrative', 'extraction', 'extraction:worldAssets', 'extraction:narrativeAssets'].includes(row.lockKey) && (typeof row.expiresAt !== 'number' || row.expiresAt > Date.now()))) throw new Error('本书已有处理任务。')
        const current = await db.table<WorldRun>('pipelineRuns').get(run.id)
        if (!current || current.bookId !== bookId || current.status !== 'paused') throw new Error('人物整理状态已变化，请重新读取后继续。')
        const organization = current.organization as (Record<string, unknown> & { pauseRequested?: boolean }) | undefined
        if (organization) {
          organization.pauseRequested = false
          // 用户明确继续时重试未完成项；历史任务错误留在原记录中。
          for (const field of ['scanPages', 'profileItems', 'relationItems', 'candidateGroups']) {
            for (const item of records(organization[field])) if (item.status !== 'checked' && item.status !== 'resolved') delete item.lastError
          }
          delete organization.pauseNotice
        }
        await db.table('pipelineRuns').put({ ...current, ...(organization ? { organization } : {}), status: 'running', finishedAt: undefined })
        await db.table('pipelineRuns').put({ id: 'lease:world', recordType: 'lease', bookId, lockKey: 'world', owner, runId: run.id, expiresAt: Date.now() + 30000 })
        await db.table('compileProgress').update('P2', { status: 'running', validity: 'current', updatedAt: new Date().toISOString() })
        sessionId = text(current.sessionId)
        if (sessionId) {
          const session = await db.table('storySessions').get(sessionId)
          if (!session || session.bookId !== bookId || session.runId !== run.id || session.profile !== 'asset_editor') throw new Error('人物整理会话与当前任务不一致，请重新读取后继续。')
          await db.table('storySessions').put({ ...session, leaseOwner: owner, leaseUntil: Date.now() + 30000 })
        }
        assertStarting()
      })
      committed = true
      assertStarting()
      set(bookId, { running: true, paused: false, phase: '继续人物整理', error: undefined, runId: run.id, organizationStep: run.organization?.runStep })
      void executeStep(bookId, run.id, owner, controller, sessionId)
      return run.id
    } catch (error) {
      // 取消流程负责自己的落库；晚返回的旧启动不能清理或覆盖新执行器。
      let saveFailure = ''
      try {
        if (committed && ownsStartup() && controller.signal.aborted && !hardCancelled.has(run.id)) await finalizeStepRun(bookId, run.id, owner, controller, sessionId)
      } catch (saveError) { saveFailure = saveError instanceof Error ? saveError.message : '启动状态保存失败。' }
      if (ownsStartup()) {
        controllers.delete(bookId); activeRuns.delete(bookId)
        const message = error instanceof Error ? error.message : '人物整理继续启动失败。'
        if (!hardCancelled.has(run.id)) set(bookId, { running: false, paused: true, phase: '已暂停', runId: run.id, organizationStep: run.organization?.runStep, error: saveFailure ? `${message}；启动状态保存失败：${saveFailure}` : message })
      }
      throw error
    }
  }

  async function characterOrganizationRun(bookId: string, characterId: string) {
    const runs = await workspace.openBook(bookId).table<WorldRun>('pipelineRuns').where('stage').equals('P2').toArray()
    return runs.filter(row => row.workflow === 'character_organization_v1' && row.scope === 'character' && row.status === 'paused' && row.organization?.targetCharacterId === characterId)
      .sort((a, b) => text(b.startedAt).localeCompare(text(a.startedAt)))[0]
  }

  async function characterResume(bookId: string): Promise<string | undefined> {
    const runs = await workspace.openBook(bookId).table<WorldRun>('pipelineRuns').where('stage').equals('P2').toArray()
    return runs.filter(row => row.workflow === 'character_organization_v1' && row.scope === 'character' && row.status === 'paused' && row.organization?.targetCharacterId)
      .sort((a, b) => text(b.startedAt).localeCompare(text(a.startedAt)))[0]?.organization?.targetCharacterId
  }

  async function continueCharacterOrganization(bookId: string, characterId: string): Promise<string> {
    const run = await characterOrganizationRun(bookId, characterId)
    if (!run) throw new Error('这个人物没有可继续的 AI 整理任务，请重新开始。')
    return continueOrganization(bookId, run.id)
  }

  async function cancelOrganization(bookId: string) {
    const runId = activeRuns.get(bookId) || (await latestOrganizationRun(bookId, ['running', 'paused']))?.id
    if (!runId) throw new Error('当前没有可取消的人物整理任务。')
    hardCancelled.add(runId); pauseRequests.delete(runId)
    const db = workspace.openBook(bookId)
    await transact(db, 'rw', [db.tables], async (db) => {
      const run = await db.table<WorldRun>('pipelineRuns').get(runId)
      if (run) await db.table('pipelineRuns').put({ ...run, status: 'cancelled', finishedAt: new Date().toISOString(), report: { ...run.report, status: 'cancelled' } })
      await db.table('pipelineRuns').delete('lease:world')
      await db.table('compileProgress').update('P2', { status: 'cancelled', validity: 'stale', updatedAt: new Date().toISOString() })
      const runSession = run?.sessionId
      if (runSession) {
        const session = await db.table('storySessions').get(runSession)
        if (session) { const { leaseOwner: _owner, leaseUntil: _until, ...saved } = session; await db.table('storySessions').put(saved) }
      }
    })
    controllers.get(bookId)?.abort(); controllers.delete(bookId); activeRuns.delete(bookId)
    set(bookId, { running: false, paused: false, phase: '已取消', runId: undefined, organizationStep: undefined })
  }

  async function updateOrganizationStatistics(bookId: string) {
    if (controllers.has(bookId) || mechanical.isRunning(bookId)) throw new Error('本书已有处理任务。')
    const controller = new AbortController()
    controllers.set(bookId, controller)
    set(bookId, { running: true, phase: '人物自动分层', error: undefined })
    try {
      return await updateCharacterTiers(workspace, bookId, controller)
    } finally {
      controllers.delete(bookId)
      set(bookId, { running: false, phase: '' })
    }
  }

  async function startOrganization(bookId: string) {
    if (controllers.has(bookId) || mechanical.isRunning(bookId)) return
    const controller = new AbortController(); controllers.set(bookId, controller)
    const db = workspace.openBook(bookId)
    let runId: string = crypto.randomUUID(), sessionId: string | undefined, owner = crypto.randomUUID()
    let acquired = false, timer: ReturnType<typeof setInterval> | undefined
    let heartbeatFailure = ''
    set(bookId, { running: true, phase: '准备人物整理', processed: 0, total: 0, error: undefined, reportId: undefined, mode: 'ai' })
    try {
      await assertReady(bookId)
      const settings = await models.settings.load()
      if (!settings.apiKey || !settings.config.aggregationModel) throw new Error('请先在设置页保存整理模型与密钥。')
      await transact(db, 'rw', [db.tables], async (db) => {
        const leases = await db.table('pipelineRuns').toArray()
        if (leases.some(row => row.recordType === 'lease' && ['world', 'narrative', 'extraction', 'extraction:worldAssets', 'extraction:narrativeAssets'].includes(row.lockKey) && (typeof row.expiresAt !== 'number' || row.expiresAt > Date.now()))) throw new Error('本书已有处理任务。')
        if (!coverage(await db.chapters.toArray(), await db.table<Receipt>('extractionReceipts').toArray()).allCovered) throw new Error('请先完成全书逐章提取。')
        const previous = await db.table<WorldRun>('compileProgress').get('P2') as unknown as { runId?: string; status?: string }
        const existing = previous?.runId ? await db.table<WorldRun>('pipelineRuns').get(previous.runId) : undefined
        const resumable = existing?.workflow === 'character_organization_v1' && existing.organization && (existing.status !== 'completed' || existing.organization.reviewVersion !== organizationReviewVersion)
        if (resumable && existing) {
          runId = existing.id; sessionId = text(existing.sessionId) || undefined
          await db.table('pipelineRuns').put({ ...existing, status: 'running', phase: 'character_organization', finishedAt: undefined, tasks: records(existing.tasks).map(task => task.status === 'running' ? { ...task, status: 'partial' } : task) })
        } else {
          if (existing && existing.status !== 'completed') await db.table('pipelineRuns').put({ ...existing, status: 'paused' })
          const characters = await db.table<Character>('characters').toArray()
          const organization = createOrganizationState(characters.map(row => row.id))
          await db.table('pipelineRuns').put({ id: runId, recordType: 'run', bookId, stage: 'P2', phase: 'character_organization', workflow: 'character_organization_v1', organization, status: 'running', startedAt: new Date().toISOString(), planVersion: '2.2', scope: 'fullBook', report: emptyReport(await counts(bookId, db)), tasks: [], commandIntents: [], appliedCommands: [], coverageItems: [], aiMode: 'agent' })
        }
        await db.table('pipelineRuns').put({ id: 'lease:world', recordType: 'lease', bookId, lockKey: 'world', owner, runId, expiresAt: Date.now() + 30000 })
        await db.table('compileProgress').put({ bookId, stage: 'P2', status: 'running', runId, totalChapters: await db.chapters.count(), completedChapters: [], failedChapters: [], updatedAt: new Date().toISOString(), scope: 'fullBook', planVersion: '2.2', unit: 'item', validity: 'current' })
      })
      acquired = true
      const repo = createBookAgentRepository(workspace, bookId)
      await repo.transaction(true, async store => {
        await renewOrganizationLease(store, { bookId, runId, owner })
        const run = (await store.get('pipelineRuns', runId))!, organization = run.organization as Row
        if (Number(organization.reviewVersion) !== organizationReviewVersion) {
          if (!['scan', 'resolve'].includes(text(organization.step))) {
            await buildProfileReview(store, organization)
            organization.repairNotice = '已保留第一步合并和疑似组结论；旧版资料与关系完成标记已重置，从人物资料重新检查。'
          }
          organization.reviewVersion = organizationReviewVersion
          organization.revision = Number(organization.revision) + 1
        } else await refreshReview(store, organization)
        for (const field of ['profileItems', 'relationItems'] as const) for (const item of records(organization[field])) if (item.status === 'pending') delete item.lastError
        for (const group of records(organization.candidateGroups)) delete group.lastError
        for (const page of records(organization.scanPages)) delete page.lastError
        delete organization.pauseNotice
        await store.put('pipelineRuns', { ...run, organization })
      })
      sessionId = await repo.transaction(true, async store => {
        await renewOrganizationLease(store, { bookId, runId, owner })
        const session = await resolveSession(store, bookId, sessionId, 'asset_editor', 'character_organization_v1', runId)
        await store.put('storySessions', { ...session, leaseOwner: owner, leaseUntil: Date.now() + 30000 })
        return text(session.id)
      })
      await db.table('pipelineRuns').update(runId, { sessionId })
      let heartbeatFailures = 0
      timer = setInterval(() => { void repo.transaction(true, store => renewOrganizationLease(store, { bookId, runId, owner, sessionId })).then(() => { heartbeatFailures = 0 }).catch(error => {
        const message = error instanceof Error ? error.message : '人物整理执行权续租失败。'
        if (leaseFailureKind(error) === 'lost' || ++heartbeatFailures >= 3) { heartbeatFailure = message; controller.abort() }
      }) }, 8000)
      await runCharacterOrganization(workspace, bookId, {
        runId, owner, signal: controller.signal, models,
        onPhase: phase => set(bookId, { phase }),
        onProgress: (processed, total) => set(bookId, { processed, total }),
      })
    } catch (error) {
      set(bookId, { error: heartbeatFailure ? `人物整理已暂停：${heartbeatFailure}` : controller.signal.aborted ? '人物整理已取消，已提交成果保留。' : error instanceof Error ? error.message : '人物整理失败。' })
    } finally {
      clearInterval(timer)
      if (acquired) await transact(db, 'rw', [db.tables], async (db) => {
        const lease = await db.table('pipelineRuns').get('lease:world')
        if (lease?.owner !== owner || lease.runId !== runId) return
        const run = (await db.table<WorldRun>('pipelineRuns').get(runId))!
        const organization = run.organization
        const error = states.get(bookId)?.error
        const status = heartbeatFailure ? 'paused' : controller.signal.aborted ? 'cancelled' : error ? 'paused' : organization?.step === 'done' ? 'completed' : 'paused'
        const usage = (run as WorldRun & { usage?: WorldReport['usage'] }).usage
        const report = { ...run.report, afterCounts: await counts(bookId, db), ...(usage ? { usage: { input: usage.input, output: usage.output, totalTokens: usage.totalTokens, cost: usage.cost, costStatus: usage.costStatus ?? 'estimated' as const }, cost: usage.cost } : {}), status, organizationSummary: organization ? { scannedPages: organization.scanPages.filter(row => row.status === 'checked').length, candidateGroups: organization.candidateGroups.length + organization.candidateDecisions.length, merged: organization.candidateDecisions.filter(row => row.outcome === 'merged' || row.outcome === 'partial').length, uncertain: organization.candidateDecisions.filter(row => row.outcome === 'uncertain').length, profilesChecked: organization.profileItems.filter(row => row.status === 'checked').length, relationsChecked: organization.relationItems.filter(row => row.status === 'checked').length, statistics: organization.step === 'done' && !organization.statisticsPending ? 'completed' as const : 'pending' as const } : undefined, candidateDecisions: organization?.candidateDecisions }
        await db.table('pipelineRuns').put({ ...run, status, finishedAt: new Date().toISOString(), report })
        await db.table('compileProgress').update('P2', { status: status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'paused', validity: status === 'completed' ? 'current' : 'stale', updatedAt: new Date().toISOString() })
        await db.table('pipelineRuns').delete('lease:world')
        if (sessionId) {
          const session = await db.table('storySessions').get(sessionId)
          if (session?.leaseOwner === owner) {
            const { leaseOwner: _owner, leaseUntil: _until, ...saved } = session
            await db.table('storySessions').put(saved)
          }
        }
        set(bookId, { reportId: runId, reportType: 'ai' })
      }).catch(() => set(bookId, { error: '报告保存失败，请检查本地存储。' }))
      controllers.delete(bookId); set(bookId, { running: false })
    }
  }

  return { identityCandidates: (bookId: string) => readIdentityCandidates(workspace, bookId), dismissIdentityCandidate: async (bookId: string, candidate: Candidate) => { await assertReady(bookId); await dismissIdentityCandidate(workspace, bookId, candidate) }, maintainOrganizationHistory: (bookId: string) => pruneOrganizationHistory(workspace, bookId), mergeHistory: async (bookId: string) => (await workspace.openBook(bookId).table('pipelineRuns').where('stage').anyOf(['P2', 'manual_merge']).toArray()).filter(row => row.report).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))), scan, cancelScan: (bookId: string) => scans.get(bookId)?.abort(new DOMException('候选扫描已取消，已保存的合并结果保留。', 'AbortError')), organize, confirm, start, startOrganization, startOrganizationStep, recoverOrganization, updateOrganizationStatistics, pauseOrganization, continueOrganization, continueCharacterOrganization, characterResume, cancelOrganization, startCharacterOrganization, continueRelations: (bookId: string) => start(bookId, { reviewScope: 'relations', reviewMode: 'full' }), mechanical, eligibility, worldRows, state: (bookId: string) => states.get(bookId), cancel: (bookId: string) => { if (mechanical.isRunning(bookId)) void mechanical.stop(bookId); else controllers.get(bookId)?.abort() }, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }, trace: (bookId: string, runId?: string) => readBookTrace(workspace, bookId, runId), organizationIndex: (bookId: string, step: 'scan' | 'profiles' | 'relations') => readOrganizationStepIndex(workspace, bookId, step), organizationRequests: (bookId: string, query: { runId: string; step: 'scan' | 'profiles' | 'relations'; objectKey: string; before?: { startedAt: string; requestId: string }; limit?: number }) => readOrganizationRequests(workspace, bookId, query), execution: (bookId: string, runId: string, options?: { unitId?: string; contextId?: string; sessionId?: string }) => readExecutionChain(workspace, bookId, runId, options), async reports(bookId: string) { return (await workspace.openBook(bookId).table<WorldRun>('pipelineRuns').where('stage').equals('P2').toArray()).filter(row => !!row.report).sort((a, b) => (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt)) } }
}
export type WorldService = ReturnType<typeof createWorldService>
export type { Candidate }
