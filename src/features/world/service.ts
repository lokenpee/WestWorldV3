import type { createWorkspace } from '../../lib/storage/workspace'
import type { ModelService } from '../models/service'
import type { AssetService } from '../assets/service'
import type { Character, LocationAsset } from '../assets/types'
import type { MergeRequest, WorldKind } from '../assets/merge'
import { findCandidates, type Candidate } from './candidates'
import { emptyReport, type WorldReport, type WorldRun, type ReviewMode, type ReviewScope } from './types'
import { coverage, type Receipt } from '../extraction/recovery'
import { createBookAgentRepository, type Row } from '../agents/repository'
import { records, text } from '../agents/contracts'
import { coverageFingerprint, identityBatchSize, identityDependencies, saveIdentityQueue } from './queue'
import { createFrequencyCounter } from '../assets/derive'
import { normalizeCharacterNames } from '../assets/characterNames'
import { createMechanicalQueue } from './mechanical'
import { repairAutomaticProtection } from './protection'
import { runAssetReview } from './assetReview'
import prompt from '../../../docs/v2/resources/v2.2/prompts/active/p2-identity.md?raw'

type Workspace = ReturnType<typeof createWorkspace>
type Entity = Character | LocationAsset
interface WorldState { running: boolean; phase: string; processed: number; total: number; error?: string; reportId?: string; reportType?: 'code' | 'ai'; mode?: 'ai' | 'mechanical' }
export function createWorldService(workspace: Workspace, models: Pick<ModelService, 'agent' | 'generate' | 'settings'>, assets: AssetService, options: { assetReview?: boolean } = {}) {
  const states = new Map<string, WorldState>(); const controllers = new Map<string, AbortController>(); const listeners = new Set<() => void>()
  const set = (bookId: string, change: Partial<WorldState>) => { states.set(bookId, { ...(states.get(bookId) ?? { running: false, phase: '', processed: 0, total: 0 }), ...change }); listeners.forEach(listener => listener()) }
  const mechanical = createMechanicalQueue(workspace, assets, (bookId, state) => set(bookId, { ...state, mode: 'mechanical' }), bookId => controllers.has(bookId))
  async function eligibility(bookId: string) {
    if (!await workspace.settings.books.get(bookId)) throw new Error('书籍不存在。')
    const db = workspace.openBook(bookId)
    return db.transaction('r', db.chapters, db.table('extractionReceipts'), db.table('pipelineRuns'), db.table('compileProgress'), async () => {
      const allCovered = coverage(await db.chapters.toArray(), await db.table<Receipt>('extractionReceipts').toArray()).allCovered
      const locks = (await db.table('pipelineRuns').where('recordType').equals('lease').toArray()).filter(row => ['world', 'extraction'].includes(row.lockKey) && (typeof row.expiresAt !== 'number' || row.expiresAt > Date.now()))
      const locked = locks.length > 0
      const progress = await db.table('compileProgress').get('P2')
      return { ready: allCovered && !locked, covered: allCovered, locked, resumable: !!progress && ['running', 'paused', 'cancelled', 'failed'].includes(progress.status), leaseExpiry: locks.filter(row => typeof row.expiresAt === 'number').reduce<number | undefined>((at, row) => Math.min(at ?? Infinity, row.expiresAt), undefined) }
    })
  }
  async function assertReady(bookId: string) { const state = await eligibility(bookId); if (!state.covered) throw new Error('请先完成全书逐章提取。'); if (state.locked) throw new Error('本书世界资产或提取任务正在运行。') }
  const counts = async (bookId: string) => { const db = workspace.openBook(bookId); return { characters: await db.table('characters').count(), locations: await db.table('locations').count() } }
  async function worldRows(bookId: string) {
    if (!await workspace.settings.books.get(bookId)) throw new Error('书籍不存在。')
    const db = workspace.openBook(bookId)
    return db.transaction('r', db.table('characters'), db.table('locations'), async () => ({ characters: (await db.table<Character>('characters').toArray()).map(normalizeCharacterNames), locations: await db.table<LocationAsset>('locations').toArray() }))
  }
  async function scan(bookId: string, saveReport = true) {
    await assertReady(bookId)
    const snapshot = await worldRows(bookId)
    const candidates = [...findCandidates('character', snapshot.characters), ...findCandidates('location', snapshot.locations)]
    if (!saveReport) return candidates
    const id = crypto.randomUUID(), now = new Date().toISOString(); const report = emptyReport({ characters: snapshot.characters.length, locations: snapshot.locations.length })
    report.status = 'completed'
    const names = (kind: 'character' | 'location') => new Map((kind === 'character' ? snapshot.characters : snapshot.locations).map(row => [row.id, row.name]))
    report.skipped = candidates.map(row => {
      const nameOf = names(row.kind)
      return `${row.kind === 'character' ? '人物' : '地点'}候选：${row.memberIds.map(id => `${nameOf.get(id) ?? id}（${id}）`).join('、')}；${row.reason}`
    })
    await workspace.openBook(bookId).table('pipelineRuns').put({ id, recordType: 'run', bookId, stage: 'P2', phase: 'mechanical', status: 'completed', startedAt: now, finishedAt: now, planVersion: '2.2', report })
    set(bookId, { reportId: id, reportType: 'code', error: undefined })
    return candidates
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
    const check = async () => {
      controller.signal.throwIfAborted()
      const lease = await db.table('pipelineRuns').get('lease:world')
      if (lease?.owner !== owner || lease.runId !== runId || lease.expiresAt <= Date.now()) throw new Error('世界资产整理执行权已失效。')
    }
    const addMessage = async (field: 'failed' | 'skipped' | 'conflicted', message: string) => {
      await db.transaction('rw', db.table('pipelineRuns'), async () => { await check(); const run = (await db.table('pipelineRuns').get(runId)) as WorldRun; await db.table('pipelineRuns').put({ ...run, report: { ...run.report, [field]: [...run.report[field], message] } }) })
    }
    try {
      await assertReady(bookId)
      const [{ createAgentRuntime }, { needsOptimization, optimizeAsset }, { resolveModel }] = await Promise.all([import('../agents/runtime'), import('./optimizeAsset'), import('../models/registry')])
      const settings = await models.settings.load()
      if (!settings.apiKey || !settings.config.aggregationModel) throw new Error('请先在设置页保存整理模型与密钥。')
      const resolved = await resolveModel(settings.config, settings.apiKey, 'aggregation')
      await db.transaction('rw', db.tables, async () => {
        const leases = await db.table('pipelineRuns').toArray()
        if (leases.some(row => row.recordType === 'lease' && ['world', 'extraction'].includes(row.lockKey) && (typeof row.expiresAt !== 'number' || row.expiresAt > Date.now()))) throw new Error('本书已有处理任务。')
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
          await db.table('pipelineRuns').put({ ...restored, phase: reviewScope === 'relations' ? 'asset_review' : 'ai_identity', status: 'running', reviewScope, reviewMode, ...(reviewScope === 'relations' ? { relationReviewVersion: 1 } : {}), report: { ...existing.report, status: 'running', failed: [] }, tasks: records(existing.tasks).map(task => task.status === 'running' ? { ...task, status: 'partial' } : task) })
        } else await db.table('pipelineRuns').put({ id: runId, recordType: 'run', bookId, stage: 'P2', phase: reviewScope === 'relations' ? 'asset_review' : 'ai_identity', status: 'running', startedAt: now, planVersion: '2.2', scope: 'fullBook', reviewScope, reviewMode, ...(reviewScope === 'relations' ? { relationReviewVersion: 1 } : {}), report: emptyReport(await counts(bookId)), tasks: [], commandIntents: [], appliedCommands: [], coverageItems: [], aiMode: 'agent' })
        await db.table('pipelineRuns').put({ id: 'lease:world', recordType: 'lease', bookId, lockKey: 'world', owner, runId, expiresAt: Date.now() + 30000 })
        await db.table('compileProgress').put({ bookId, stage: 'P2', status: 'running', runId, totalChapters: (await db.chapters.count()), completedChapters: [], failedChapters: [], updatedAt: now, scope: 'fullBook', planVersion: '2.2', unit: 'item', validity: 'current' })
      }); acquired = true
      timer = setInterval(() => { void db.transaction('rw', db.table('pipelineRuns'), async () => { const lease = await db.table('pipelineRuns').get('lease:world'); if (lease?.owner !== owner) throw new Error('执行权已变化'); await db.table('pipelineRuns').update('lease:world', { expiresAt: Date.now() + 30000 }) }).catch(() => controller.abort()) }, 8000)
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
      await db.transaction('rw', db.table('pipelineRuns'), db.table('characters'), db.table('locations'), async () => {
        await check()
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
          await db.transaction('rw', db.table('characters'), db.table('locations'), db.table('pipelineRuns'), async () => {
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
      if (acquired) await db.transaction('rw', db.tables, async () => {
        const lease = await db.table('pipelineRuns').get('lease:world'); if (lease?.owner !== owner) return
        const run = (await db.table('pipelineRuns').get(runId)) as WorldRun & { usage?: WorldReport['usage'] }
        const report = run.report; const error = states.get(bookId)?.error
        const status = controller.signal.aborted ? 'cancelled' : paused ? report.failed.length ? 'degraded' : 'paused' : error ? 'failed' : report.failed.length || report.conflicted.length ? 'degraded' : 'completed'
        const usage = { input: report.usage.input + Math.max(0, (run.usage?.input ?? 0) - Number(initialAgentUsage?.input ?? 0)), output: report.usage.output + Math.max(0, (run.usage?.output ?? 0) - Number(initialAgentUsage?.output ?? 0)), totalTokens: report.usage.totalTokens + Math.max(0, (run.usage?.totalTokens ?? 0) - Number(initialAgentUsage?.totalTokens ?? 0)), cost: report.usage.cost + Math.max(0, (run.usage?.cost ?? 0) - Number(initialAgentUsage?.cost ?? 0)), costStatus: run.usage?.costStatus === 'unknown' || report.usage.costStatus === 'unknown' ? 'unknown' : 'estimated' }
        const completedReport = { ...report, afterCounts: await counts(bookId), status, usage, cost: usage.cost, skipped: paused && error ? [...new Set([...report.skipped, error])] : report.skipped, failed: error && !controller.signal.aborted && !paused ? [...new Set([...report.failed, error])] : report.failed }
        await db.table('pipelineRuns').put({ ...run, phase: 'ai', status, finishedAt: new Date().toISOString(), report: completedReport })
        await db.table('compileProgress').update('P2', { status: status === 'degraded' ? 'failed' : status, validity: status === 'completed' ? 'current' : 'stale', updatedAt: new Date().toISOString() })
        await db.table('pipelineRuns').delete('lease:world')
        set(bookId, { reportId: runId, reportType: 'ai' })
      }).catch(() => set(bookId, { error: '报告保存失败，请检查本地存储。' }))
      controllers.delete(bookId); set(bookId, { running: false })
    }
  }
  return { scan, organize, confirm, start, continueRelations: (bookId: string) => start(bookId, { reviewScope: 'relations', reviewMode: 'full' }), mechanical, eligibility, worldRows, state: (bookId: string) => states.get(bookId), cancel: (bookId: string) => { if (mechanical.isRunning(bookId)) void mechanical.stop(bookId); else controllers.get(bookId)?.abort() }, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }, async reports(bookId: string) { return (await workspace.openBook(bookId).table<WorldRun>('pipelineRuns').where('stage').equals('P2').toArray()).filter(row => !!row.report).sort((a, b) => (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt)) } }
}
export type WorldService = ReturnType<typeof createWorldService>
export type { Candidate }
