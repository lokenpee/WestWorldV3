import type { createWorkspace } from '../../lib/storage/workspace'
import Dexie from 'dexie'
import type { ModelService } from '../models/service'
import type { AssetService } from '../assets/service'
import type { Character, LocationAsset } from '../assets/types'
import type { MergeRequest, WorldKind } from '../assets/merge'
import { findCandidates, type Candidate } from './candidates'
import { emptyReport, type WorldReport, type WorldRun } from './types'
import { coverage, type Receipt } from '../extraction/recovery'
import { createBookAgentRepository } from '../agents/repository'
import { updateFrequencies } from '../assets/derive'
import prompt from '../../../docs/v2/resources/v2.2/prompts/active/p2-identity.md?raw'

type Workspace = ReturnType<typeof createWorkspace>
type Entity = Character | LocationAsset
interface WorldState { running: boolean; phase: string; processed: number; total: number; error?: string; reportId?: string; reportType?: 'code' | 'ai' }
export function createWorldService(workspace: Workspace, models: Pick<ModelService, 'agent' | 'generate' | 'settings'>, assets: AssetService) {
  const states = new Map<string, WorldState>(); const controllers = new Map<string, AbortController>(); const listeners = new Set<() => void>()
  const set = (bookId: string, change: Partial<WorldState>) => { states.set(bookId, { ...(states.get(bookId) ?? { running: false, phase: '', processed: 0, total: 0 }), ...change }); listeners.forEach(listener => listener()) }
  async function eligibility(bookId: string) {
    if (!await workspace.settings.books.get(bookId)) throw new Error('书籍不存在。')
    const db = workspace.openBook(bookId)
    return db.transaction('r', db.chapters, db.table('extractionReceipts'), db.table('pipelineRuns'), async () => {
      const allCovered = coverage(await db.chapters.toArray(), await db.table<Receipt>('extractionReceipts').toArray()).allCovered
      const locked = (await db.table('pipelineRuns').toArray()).some(row => row.recordType === 'lease' && ['world', 'extraction'].includes(row.lockKey) && (typeof row.expiresAt !== 'number' || row.expiresAt > Date.now()))
      return { ready: allCovered && !locked, covered: allCovered, locked }
    })
  }
  async function assertReady(bookId: string) { const state = await eligibility(bookId); if (!state.covered) throw new Error('请先完成全书逐章提取。'); if (state.locked) throw new Error('本书世界资产或提取任务正在运行。') }
  const counts = async (bookId: string) => { const db = workspace.openBook(bookId); return { characters: await db.table('characters').count(), locations: await db.table('locations').count() } }
  async function scan(bookId: string, saveReport = true) {
    await assertReady(bookId)
    const snapshot = await assets.read(bookId)
    const candidates = [...findCandidates('character', snapshot.characters), ...findCandidates('location', snapshot.locations)]
    if (!saveReport) return candidates
    const id = crypto.randomUUID(), now = new Date().toISOString(); const report = emptyReport({ characters: snapshot.characters.length, locations: snapshot.locations.length })
    report.status = 'completed'; report.skipped = candidates.map(row => `${row.kind === 'character' ? '人物' : '地点'}候选：${row.memberIds.join('、')}`)
    await workspace.openBook(bookId).table('pipelineRuns').put({ id, recordType: 'run', bookId, stage: 'P2', phase: 'mechanical', status: 'completed', startedAt: now, finishedAt: now, planVersion: '2.2', report })
    return candidates
  }
  async function confirm<K extends WorldKind>(bookId: string, kind: K, request: MergeRequest) {
    await assertReady(bookId)
    const result = await assets.confirmMerge(bookId, kind, request, 'mechanical')
    set(bookId, { reportId: result.reportId, reportType: 'code', error: undefined })
    return result
  }
  async function start(bookId: string) {
    if (controllers.has(bookId)) return
    const controller = new AbortController(); controllers.set(bookId, controller)
    const db = workspace.openBook(bookId); const runId = crypto.randomUUID(), owner = crypto.randomUUID()
    let acquired = false; let timer: ReturnType<typeof setInterval> | undefined
    set(bookId, { running: true, phase: '准备', processed: 0, total: 0, error: undefined, reportId: undefined })
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
      const [{ createAgentRuntime }, { hash }, { needsOptimization, optimizationRequest }, { resolveModel }] = await Promise.all([import('../agents/runtime'), import('../agents/contracts'), import('./optimization'), import('../models/registry')])
      const settings = await models.settings.load()
      if (!settings.apiKey || !settings.config.aggregationModel) throw new Error('请先在设置页保存整理模型与密钥。')
      const resolved = await resolveModel(settings.config, settings.apiKey, 'aggregation')
      await db.transaction('rw', db.tables, async () => {
        const leases = await db.table('pipelineRuns').toArray()
        if (leases.some(row => row.recordType === 'lease' && ['world', 'extraction'].includes(row.lockKey) && (typeof row.expiresAt !== 'number' || row.expiresAt > Date.now()))) throw new Error('本书已有处理任务。')
        if (!coverage(await db.chapters.toArray(), await db.table<Receipt>('extractionReceipts').toArray()).allCovered) throw new Error('请先完成全书逐章提取。')
        const now = new Date().toISOString()
        await db.table('pipelineRuns').put({ id: runId, recordType: 'run', bookId, stage: 'P2', phase: 'ai_identity', status: 'running', startedAt: now, planVersion: '2.2', scope: 'fullBook', report: emptyReport(await counts(bookId)), tasks: [], commandIntents: [], appliedCommands: [] })
        await db.table('pipelineRuns').put({ id: 'lease:world', recordType: 'lease', bookId, lockKey: 'world', owner, runId, expiresAt: Date.now() + 30000 })
        await db.table('compileProgress').put({ bookId, stage: 'P2', status: 'running', runId, totalChapters: (await db.chapters.count()), completedChapters: [], failedChapters: [], updatedAt: now, scope: 'fullBook', planVersion: '2.2', unit: 'item', validity: 'current' })
      }); acquired = true
      timer = setInterval(() => { void db.transaction('rw', db.table('pipelineRuns'), async () => { const lease = await db.table('pipelineRuns').get('lease:world'); if (lease?.owner !== owner) throw new Error('执行权已变化'); await db.table('pipelineRuns').update('lease:world', { expiresAt: Date.now() + 30000 }) }).catch(() => controller.abort()) }, 8000)
      const repo = createBookAgentRepository(workspace, bookId); const runtime = createAgentRuntime(models.agent)
      const checked = new Map<string, number>(); let noProgress = 0
      for (const kind of ['character', 'location'] as const) {
        const table = kind === 'character' ? 'characters' : 'locations'
        for (;;) {
          await check()
          const current = (await db.table<Entity>(table).toArray()).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
          const pending = current.filter(row => checked.get(`${kind}:${row.id}`) !== row.revision)
          if (!pending.length) break
          const start = current.findIndex(row => row.id === pending[0].id)
          const overlap = current.slice(Math.max(0, start - 20), start).filter(row => !pending.some(item => item.id === row.id))
          const batch = [...overlap, ...pending.slice(0, 180 - overlap.length)]
          const workItems = await Promise.all(batch.map(async row => ({ workItemId: `ai_identity:fullBook:${kind}:${encodeURIComponent(row.id)}`, kind, id: row.id, revision: row.revision, factFingerprint: await hash(row) })))
          const taskId = crypto.randomUUID(); const operationKey = crypto.randomUUID()
          const input = { bookId, runId, taskId, planVersion: '2.2', remainingCount: pending.length, resume: { reason: 'initial', appliedCommitIds: [], nextOperationKey: operationKey, remainingWorkIds: workItems.map(row => row.workItemId) }, stage: 'P2', phase: 'ai_identity', kind, scope: 'fullBook', workItems, afterId: null, pageLimit: 100 }
          set(bookId, { phase: kind === 'character' ? '核实人物身份' : '核实地点身份', total: checked.size + pending.length, processed: checked.size })
          const result = await runtime.run(repo, { profile: 'asset_editor', phase: 'ai_identity', runId, taskId, leaseOwner: owner, retainLease: true, workItems, input, businessPrompt: prompt, prompt: JSON.stringify(input), signal: controller.signal })
          await check()
          if (!result.ok) { await addMessage('failed', result.error ?? '身份核实失败'); throw new Error(result.error ?? '身份核实失败。') }
          const after = await db.table<Entity>(table).toArray()
          let gained = 0
          for (const item of result.summary?.reviewedItems ?? []) {
            const work = workItems.find(work => work.workItemId === item.workItemId)!
            const row = after.find(row => row.id === work.id)
            const revision = row?.revision ?? -1
            if (checked.get(`${kind}:${work.id}`) !== revision) gained++
            checked.set(`${kind}:${work.id}`, revision)
            if (item.outcome === 'needs_review') await addMessage('skipped', `${work.id}：${item.reason}`)
          }
          noProgress = gained || result.commitIds.length ? 0 : noProgress + 1
          if (noProgress >= 3) throw new Error('连续尝试未取得进展，请查看报告后继续。')
          set(bookId, { processed: checked.size })
        }
      }
      await db.transaction('rw', db.table('pipelineRuns'), db.table('characters'), db.table('locations'), async () => {
        await check()
        const pendingIds: string[] = []
        let total = 0
        for (const [table, kind] of [['characters', 'character'], ['locations', 'location']] as const) for (const row of await db.table<Entity>(table).toArray()) { total++; if (checked.get(`${kind}:${row.id}`) !== row.revision) pendingIds.push(`${kind}:${row.id}`) }
        await db.table('pipelineRuns').update(runId, { coverage: { total, checked: total - pendingIds.length, pendingIds } })
        if (pendingIds.length) throw new Error('资料覆盖仍有缺口，请查看报告后重新整理。')
      })
      set(bookId, { phase: '按需整编详细资料', processed: 0 })
      const all: { kind: WorldKind; row: Entity }[] = [...(await db.table<Character>('characters').toArray()).map(row => ({ kind: 'character' as const, row })), ...(await db.table<LocationAsset>('locations').toArray()).map(row => ({ kind: 'location' as const, row }))]
      set(bookId, { total: all.length })
      for (const [index, { kind, row }] of all.entries()) {
        await check()
        if (!needsOptimization(kind, row)) { set(bookId, { processed: index + 1 }); continue }
        const request = await optimizationRequest(kind, row)
        if (row.optimizationFingerprint === request.fingerprint) { set(bookId, { processed: index + 1 }); continue }
        const reserve = Math.min(8192, resolved.model.maxTokens, Math.floor(resolved.model.contextWindow * 0.35))
        const capacity = resolved.model.contextWindow - reserve - 1024
        if (request.estimatedTokens > Math.min(6000, Math.floor(capacity * 0.45))) { await addMessage('failed', `${row.name}：资料超出本次整编输入预算，保留原资料。`); continue }
        const result = await models.generate({ role: 'aggregation', context: { systemPrompt: request.prompt, messages: [{ role: 'user', content: JSON.stringify(request.input), timestamp: Date.now() }], tools: [{ name: 'submit_result', description: '提交完整事实覆盖的整编资料', parameters: request.schema, constrainedSampling: { type: 'json_schema', strict: 'prefer' } }] }, validate: request.validate, repairPrompt: '唯一一次修正机会，请完整保留全部事实编号及既有称呼，补齐有事实的字段。', signal: controller.signal, maxTokens: reserve, temperature: 0 })
        await check()
        await db.transaction('rw', db.tables, async () => {
          await check()
          const run = await db.table<WorldRun>('pipelineRuns').get(runId)
          if (!run) throw new Error('整理报告不存在。')
          const report = run.report
          const usage = { input: report.usage.input + result.usage.input, output: report.usage.output + result.usage.output, totalTokens: report.usage.totalTokens + result.usage.totalTokens, cost: report.usage.cost + (result.usage.cost ?? 0), costStatus: result.usage.costStatus }
          if (!result.ok || !result.value) { await db.table('pipelineRuns').update(runId, { report: { ...report, usage, cost: usage.cost, failed: [...report.failed, `${row.name}：${result.error?.message ?? '整编失败'}`] } }); return }
          const table = kind === 'character' ? 'characters' : 'locations'; const current = await db.table<Entity>(table).get(row.id)
          if (!current || current.revision !== row.revision) { await db.table('pipelineRuns').update(runId, { report: { ...report, usage, cost: usage.cost, conflicted: [...report.conflicted, `${row.id}：整编期间资料已变化。`] } }); return }
          const output = result.value
          if ('name' in output && current.nameSource === 'manual' && output.name !== current.name) throw new Error('整编须保留人工指定的主名。')
          const next = { ...current, ...output.fields, ...('name' in output ? { name: output.name, aliases: [...new Set([current.name, ...(current.aliases ?? []), ...(output.aliases ?? [])])].filter(name => name !== output.name) } : {}), mergeFacts: request.facts, mergeNotes: [...new Set([...(current.mergeNotes ?? []), ...(output.notes ?? [])])], optimizedFactIds: request.facts.map(fact => fact.id), revision: current.revision + 1, updatedAt: new Date().toISOString() }
          const nextRequest = await Dexie.waitFor(optimizationRequest(kind, next))
          await db.table(table).put({ ...next, optimizationFingerprint: nextRequest.fingerprint })
          await db.table('pipelineRuns').update(runId, { report: { ...report, usage, cost: usage.cost, optimizedIds: [...report.optimizedIds, row.id] } })
        })
        set(bookId, { processed: index + 1 })
      }
      await db.transaction('rw', db.tables, async () => {
        await check()
        const texts = await db.table<{ chapterIndex: string; text: string }>('chapterTexts').toArray()
        for (const [table, people] of [['characters', true], ['locations', false]] as const) {
          const before = await db.table<Entity>(table).toArray(); const after = updateFrequencies(before, texts, people)
          for (const [index, row] of after.entries()) if (JSON.stringify(row) !== JSON.stringify(before[index])) await db.table(table).put({ ...row, revision: row.revision + 1 })
        }
      })
    } catch (error) { set(bookId, { error: controller.signal.aborted ? '整理已取消，已提交成果保留。' : error instanceof Error ? error.message : '整理失败。' }) }
    finally {
      clearInterval(timer)
      if (acquired) await db.transaction('rw', db.tables, async () => {
        const lease = await db.table('pipelineRuns').get('lease:world'); if (lease?.owner !== owner) return
        const run = (await db.table('pipelineRuns').get(runId)) as WorldRun & { usage?: WorldReport['usage'] }
        const report = run.report; const error = states.get(bookId)?.error
        const status = controller.signal.aborted ? 'cancelled' : error ? 'failed' : report.failed.length || report.conflicted.length ? 'degraded' : 'completed'
        const usage = { input: report.usage.input + (run.usage?.input ?? 0), output: report.usage.output + (run.usage?.output ?? 0), totalTokens: report.usage.totalTokens + (run.usage?.totalTokens ?? 0), cost: report.usage.cost + (run.usage?.cost ?? 0), costStatus: run.usage?.costStatus === 'unknown' || report.usage.costStatus === 'unknown' ? 'unknown' : 'estimated' }
        const completedReport = { ...report, afterCounts: await counts(bookId), status, usage, cost: usage.cost, failed: error && !controller.signal.aborted ? [...new Set([...report.failed, error])] : report.failed }
        await db.table('pipelineRuns').put({ ...run, phase: 'ai', status, finishedAt: new Date().toISOString(), report: completedReport })
        await db.table('compileProgress').update('P2', { status: status === 'degraded' ? 'failed' : status, validity: status === 'completed' ? 'current' : 'stale', updatedAt: new Date().toISOString() })
        await db.table('pipelineRuns').delete('lease:world')
        set(bookId, { reportId: runId, reportType: 'ai' })
      }).catch(() => set(bookId, { error: '报告保存失败，请检查本地存储。' }))
      controllers.delete(bookId); set(bookId, { running: false })
    }
  }
  return { scan, confirm, start, eligibility, state: (bookId: string) => states.get(bookId), cancel: (bookId: string) => controllers.get(bookId)?.abort(), subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }, async reports(bookId: string) { return (await workspace.openBook(bookId).table<WorldRun>('pipelineRuns').where('stage').equals('P2').toArray()).filter(row => !!row.report).sort((a, b) => b.startedAt.localeCompare(a.startedAt)) } }
}
export type WorldService = ReturnType<typeof createWorldService>
export type { Candidate }
