import Dexie from 'dexie'
import type { createWorkspace } from '../../lib/storage/workspace'
import type { ModelService } from '../models/service'
import { ModelError, type UsageSummary } from '../models/types'
import type { Character, LocationAsset } from '../assets/types'
import type { WorldKind } from '../assets/merge'
import type { Row } from '../agents/repository'
import { canonical, records } from '../agents/contracts'
import { estimateTextTokens } from '../agents/context'
import { normalizeCharacterNames } from '../assets/characterNames'
import { coverageFingerprint } from './queue'
import { needsOptimization, optimizationBudget, optimizationRequest } from './optimization'
import { qualityRequest } from './quality'
import type { OptimizationDraft, WorldRun } from './types'
export { needsOptimization } from './optimization'

type Entity = Character | LocationAsset
type Workspace = ReturnType<typeof createWorkspace>
export async function optimizeAsset(workspace: Workspace, models: Pick<ModelService, 'generate'>, bookId: string, runId: string, owner: string, kind: WorldKind, row: Entity, model: { contextWindow: number; maxTokens: number }, signal: AbortSignal, phase: (value: string) => void) {
  const db = workspace.openBook(bookId), table = kind === 'character' ? 'characters' : 'locations', started = Date.now()
  const request = await optimizationRequest(kind, row)
  const basisFingerprint = await coverageFingerprint(table, row as unknown as Row)
  async function lease() {
    const lock = await db.table('pipelineRuns').get('lease:world')
    if (lock?.owner !== owner || lock.runId !== runId || lock.expiresAt <= Date.now()) throw new Error('整编写入前执行权已变化。')
  }
  async function beforeRequest() {
    signal.throwIfAborted(); await lease()
    if (Date.now() - started >= 180000) throw new ModelError('budget', '本项整编已收尾，已保存的稿件可继续复核。')
  }
  async function save(draft?: OptimizationDraft, usage?: UsageSummary, error?: string, apply = false) {
    await db.transaction('rw', db.tables, async () => {
      await lease()
      const run = (await db.table<WorldRun>('pipelineRuns').get(runId))!, report = run.report
      const total = usage ? { input: report.usage.input + usage.input, output: report.usage.output + usage.output, totalTokens: report.usage.totalTokens + usage.totalTokens, cost: report.usage.cost + (usage.cost ?? 0), costStatus: report.usage.costStatus === 'unknown' || usage.costStatus === 'unknown' ? 'unknown' as const : 'estimated' as const } : report.usage
      const current = await db.table<Entity>(table).get(row.id)
      let coverageItems = records((run as unknown as Row).coverageItems)
      if (draft && (!current || await Dexie.waitFor(coverageFingerprint(table, current as unknown as Row)) !== basisFingerprint)) {
        draft = { ...draft, status: 'stale', reviewError: '整编期间资料已变化，请基于当前资料继续。' }; apply = false; error = `${row.name}：整编期间资料已变化。`
      }
      if (apply && draft && current) {
        if (draft.status === 'applied') signal.throwIfAborted()
        const verifiedAliases = [...new Set([...(current.verifiedAliases ?? []), ...(draft.proposedName !== current.name ? [current.name] : [])])].filter(alias => draft!.afterAliases.includes(alias) && alias !== draft!.proposedName)
        const next = { ...current, ...draft.after, name: draft.proposedName, aliases: draft.afterAliases, verifiedAliases, mergeFacts: request.facts, mergeNotes: draft.notes, optimizedFactIds: request.facts.map(fact => fact.id), revision: current.revision + 1, updatedAt: new Date().toISOString() }
        const normalized = kind === 'character' ? normalizeCharacterNames(next) : next
        const nextRequest = await Dexie.waitFor(optimizationRequest(kind, normalized))
        const optimized = { ...normalized, optimizationFingerprint: nextRequest.fingerprint }
        await db.table(table).put(optimized)
        const fingerprint = await Dexie.waitFor(coverageFingerprint(table, optimized as unknown as Row))
        coverageItems = coverageItems.map(item => {
          if (item.status !== 'checked') return item
          const dependencies = structuredClone(item.dependencies) as Row
          for (const dependency of records(dependencies?.records)) if (dependency.table === table && (dependency.resolvedId ?? dependency.id) === row.id) dependency.factFingerprint = fingerprint
          return { ...item, dependencies, ...(item.kind === kind && item.id === row.id ? { coveredFingerprint: fingerprint, coveredRevision: optimized.revision } : {}) }
        })
      }
      const optimizations = [...(report.optimizations ?? [])]
      if (draft) { const draftId = draft.id; const index = optimizations.findIndex(item => item.id === draftId); if (index < 0) optimizations.push(draft); else optimizations[index] = draft }
      await db.table('pipelineRuns').update(runId, { coverageItems, report: { ...report, usage: total, cost: total.cost, optimizations, optimizedIds: apply && draft?.status === 'applied' ? [...new Set([...report.optimizedIds, row.id])] : report.optimizedIds, failed: error ? [...report.failed, error] : report.failed } })
    })
  }
  const prior = (await db.table<WorldRun>('pipelineRuns').get(runId))?.report.optimizations ?? []
  for (const item of prior.filter(item => item.assetId === row.id && item.kind === kind && item.status === 'pending_review' && (item.basisFingerprint !== basisFingerprint || item.rulesFingerprint !== request.fingerprint))) await save({ ...item, status: 'stale', reviewError: '资料或整编规则已变化，旧稿已过期。' })
  if (row.optimizationFingerprint === request.fingerprint) return
  let draft = prior.findLast(item => item.assetId === row.id && item.kind === kind && item.status === 'pending_review' && item.basisFingerprint === basisFingerprint && item.rulesFingerprint === request.fingerprint)
  if (!draft) {
    if (!needsOptimization(kind, row)) return
    const feedback = prior.findLast(item => item.assetId === row.id && item.kind === kind && item.basisFingerprint === basisFingerprint && item.status === 'rejected')?.review
    const budget = optimizationBudget({ ...request, estimatedTokens: request.estimatedTokens + (feedback ? estimateTextTokens(JSON.stringify(feedback)) + 64 : 0) }, model)
    if (!budget.fits) { await save(undefined, undefined, `${row.name}：整编输入估算${budget.inputTokens} token，输出预留${budget.outputTokens} token，超出整理模型上下文${budget.contextWindow} token。`); return }
    phase(`整编资料 · ${row.name}`)
    const result = await models.generate({ role: 'aggregation', context: { systemPrompt: request.prompt, messages: [{ role: 'user', content: JSON.stringify(request.input), timestamp: Date.now() }, ...(feedback ? [{ role: 'user' as const, content: `上次独立复核的问题：${JSON.stringify(feedback)}。请据此重新整编。`, timestamp: Date.now() }] : [])], tools: [{ name: 'submit_result', description: '提交完整事实覆盖的整编资料', parameters: request.schema, constrainedSampling: { type: 'json_schema', strict: 'prefer' } }] }, validate: request.validate, repairPrompt: '请完整保留全部事实编号及既有称呼，补齐有事实的字段。', signal, beforeRequest, cooperativeTimeout: true, timeoutMs: 180000, requestTimeoutMs: 60000, maxRequests: 3, maxTokens: budget.outputTokens, temperature: 0 })
    if (!result.ok || !result.value) { await save(undefined, result.usage, `${row.name}：${result.error?.message ?? '整编失败'}`); signal.throwIfAborted(); return }
    const output = result.value, proposedName = 'name' in output ? output.name! : row.name
    if (row.nameSource === 'manual' && proposedName !== row.name) { await save(undefined, result.usage, `${row.name}：整编须保留人工指定的主名。`); return }
    const fields = kind === 'character' ? ['identity', 'appearance', 'personality', 'background'] : ['description']
    const before = Object.fromEntries(fields.map(field => [field, String((row as unknown as Row)[field] ?? '')]))
    const names = kind === 'character' ? normalizeCharacterNames(row) : row
    const after = { ...before, ...output.fields }, afterAliases = [...new Set([row.name, ...(names.aliases ?? []), ...('aliases' in output ? output.aliases ?? [] : [])])].filter(name => name !== proposedName)
    const notes = [...new Set([...(row.mergeNotes ?? []), ...(output.notes ?? [])])]
    const changed = canonical(before) !== canonical(after) || proposedName !== row.name || canonical([...(row.aliases ?? [])].sort()) !== canonical([...afterAliases].sort()) || canonical(row.mergeNotes ?? []) !== canonical(notes)
    draft = { id: crypto.randomUUID(), kind, assetId: row.id, name: row.name, basisFingerprint, rulesFingerprint: request.fingerprint, before, after, beforeAliases: row.aliases ?? [], afterAliases, proposedName, notes, factIds: request.facts.map(fact => fact.id), createdAt: new Date().toISOString(), status: changed ? 'pending_review' : 'no_change' }
    await save(draft, result.usage, undefined, !changed)
    signal.throwIfAborted()
    if (!changed) return
  }
  signal.throwIfAborted()
  const review = qualityRequest(draft, request.facts), budget = optimizationBudget(review, model), remaining = 180000 - (Date.now() - started)
  if (!budget.fits || remaining < 1000) { await save({ ...draft, reviewError: budget.fits ? '本轮已收尾，继续时复核已保存的稿件。' : '复核资料超出当前模型上下文容量。' }, undefined, `${row.name}：稿件已保存，待继续复核。`); return }
  phase(`复核整编稿 · ${row.name}`)
  const result = await models.generate({ role: 'aggregation', context: { systemPrompt: review.prompt, messages: [{ role: 'user', content: JSON.stringify(review.input), timestamp: Date.now() }], tools: [{ name: 'submit_result', description: '提交独立语义复核结论', parameters: review.schema, constrainedSampling: { type: 'json_schema', strict: 'prefer' } }] }, validate: review.validate, signal, beforeRequest, cooperativeTimeout: true, timeoutMs: remaining, requestTimeoutMs: 60000, maxRequests: 1, maxTokens: budget.outputTokens, temperature: 0 })
  if (!result.ok || !result.value) { await save({ ...draft, reviewError: result.error?.message ?? '复核失败' }, result.usage, `${row.name}：稿件待复核，${result.error?.message ?? '复核失败'}`); signal.throwIfAborted(); return }
  if (signal.aborted) { await save(draft, result.usage); signal.throwIfAborted() }
  const { reviewError: _error, ...clean } = draft
  await save({ ...clean, status: result.value.approved ? 'applied' : 'rejected', review: result.value, ...(result.value.approved ? { appliedAt: new Date().toISOString() } : {}) }, result.usage, result.value.approved ? undefined : `${row.name}：整编稿复核未通过，${result.value.summary}`, result.value.approved)
}
