import type { ModelService } from '../models/service'
import type { AgentRepository, Row } from '../agents/repository'
import { records, text } from '../agents/contracts'
import { coverageFingerprint } from './queue'
import type { AssetReviewItem, ReviewMode, ReviewScope, WorldRun } from './types'
import { effectivePairs, pairKeyOf, syncRelations } from '../assets/relations'
import { normalizeCharacterNames } from '../assets/characterNames'
import type { Character, CharacterRelation, CharacterRelationEdit, EventLine, EventNode, LegacyRelationRecord, Lifecycle } from '../assets/types'
import prompt from '../../../docs/v2/resources/v2.2/prompts/active/p2-asset-review.md?raw'
import relationPrompt from '../../../docs/v2/resources/v2.2/prompts/active/p2-relation-review.md?raw'

const batchSize = 50
const sampleSize = 10
const prefix = (scope: ReviewScope) => scope === 'relations' ? 'asset_review:relations' : 'asset_review:fullBook'
const workId = (kind: string, id: string, scope: ReviewScope = 'all_assets') => `${prefix(scope)}:${kind}:${encodeURIComponent(id)}`

async function buildItems(store: { get(table: string, id: string): Promise<Row | undefined>; rows(table: string): Promise<Row[]> }, reviewScope: ReviewScope = 'all_assets'): Promise<AssetReviewItem[]> {
  const characters = (await store.rows('characters')) as unknown as Character[]
  const lifecycle = (await store.rows('assetLifecycle')) as unknown as Lifecycle[]
  const relations = (await store.rows('characterRelations')) as unknown as CharacterRelation[]
  const edits = (await store.rows('characterRelationEdits')) as unknown as CharacterRelationEdit[]
  const normalized = characters.map(normalizeCharacterNames)
  const pairs = effectivePairs(syncRelations(relations, normalized, lifecycle).relations, edits, normalized).filter(pair => pair.state === 'active')
  const items: AssetReviewItem[] = []
  const now = new Date().toISOString()
  if (reviewScope === 'relations') {
    const pairKeys = new Set(pairs.map(pair => pair.pairKey))
    const priority = (item: AssetReviewItem) => item.kind === 'relation' && item.factFingerprint && pairs.find(pair => pair.pairKey === item.id)?.directionUnclear ? 0
      : item.kind === 'legacy_relation' ? 1
        : item.kind === 'relation' ? 2 : 3
    for (const pair of pairs) items.push({ workItemId: workId('relation', pair.pairKey, reviewScope), kind: 'relation', id: pair.pairKey, fromId: pair.fromId, toId: pair.toId, revision: Math.max(Number(pair.endpointRevisions[pair.fromId] ?? 0), Number(pair.endpointRevisions[pair.toId] ?? 0)), factFingerprint: pair.fingerprint, status: 'pending', updatedAt: now })
    const legacy = (await store.rows('legacyRelationRecords')) as unknown as LegacyRelationRecord[]
    for (const record of legacy) {
      if (record.pairKeys.some(key => pairKeys.has(key))) continue
      if (record.disposition === 'converted' && !record.issues.length) continue
      items.push({ workItemId: workId('legacy_relation', record.id, reviewScope), kind: 'legacy_relation', id: record.id, revision: 0, factFingerprint: await coverageFingerprint('legacyRelationRecords', record as unknown as Row), status: 'pending', updatedAt: now })
    }
    for (const row of characters) items.push({ workItemId: workId('character_relation_scan', row.id, reviewScope), kind: 'character_relation_scan', id: row.id, revision: Number(row.revision ?? 1), factFingerprint: await coverageFingerprint('characters', row as unknown as Row), status: 'pending', updatedAt: now })
    return items.sort((a, b) => priority(a) - priority(b) || a.id.localeCompare(b.id) || a.kind.localeCompare(b.kind))
  }
  const locations = await store.rows('locations')
  const nodes = (await store.rows('nodes')) as unknown as EventNode[]
  const lines = (await store.rows('eventLines')) as unknown as EventLine[]
  for (const row of characters) items.push({ workItemId: workId('character', row.id), kind: 'character', id: row.id, revision: Number(row.revision ?? 1), factFingerprint: await coverageFingerprint('characters', row as unknown as Row), status: 'pending', updatedAt: now })
  for (const row of locations) items.push({ workItemId: workId('location', text(row.id)), kind: 'location', id: text(row.id), revision: Number(row.revision ?? 1), factFingerprint: await coverageFingerprint('locations', row), status: 'pending', updatedAt: now })
  for (const row of nodes) items.push({ workItemId: workId('node', row.id), kind: 'node', id: row.id, revision: Number(row.revision ?? 1), factFingerprint: await coverageFingerprint('nodes', row as unknown as Row), status: 'pending', updatedAt: now })
  for (const row of lines) items.push({ workItemId: workId('eventLine', row.id), kind: 'eventLine', id: row.id, revision: Number(row.revision ?? 1), factFingerprint: await coverageFingerprint('eventLines', row as unknown as Row), status: 'pending', updatedAt: now })
  for (const pair of pairs) items.push({ workItemId: workId('relation', pair.pairKey), kind: 'relation', id: pair.pairKey, fromId: pair.fromId, toId: pair.toId, revision: Math.max(Number(pair.endpointRevisions[pair.fromId] ?? 0), Number(pair.endpointRevisions[pair.toId] ?? 0)), factFingerprint: pair.fingerprint, status: 'pending', updatedAt: now })
  return items.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
}

async function refreshItems(repo: AgentRepository, runId: string, reviewScope: ReviewScope = 'all_assets'): Promise<AssetReviewItem[]> {
  const snapshot = await repo.transaction(false, async store => ({ run: await store.get('pipelineRuns', runId)!, items: await buildItems(store, reviewScope) }))
  const previous = new Map<string, AssetReviewItem>(((snapshot.run?.assetReview as { items?: AssetReviewItem[] } | undefined)?.items ?? []).map(item => [item.workItemId, item]))
  const current = new Set(snapshot.items.map(item => item.workItemId))
  const next = snapshot.items.map(item => {
    const old = previous.get(item.workItemId) as AssetReviewItem | undefined
    if (!old) return item
    if (old.status === 'checked' && ['changed', 'no_change'].includes(old.outcome ?? '') && old.factFingerprint === item.factFingerprint && old.revision === item.revision) return old
    return { ...item, status: 'pending' as const }
  })
  for (const [id, old] of previous) if (!current.has(id) && old.status !== 'skipped') next.push({ ...old, status: 'skipped', outcome: 'deleted', reason: '资料已合并或删除。', updatedAt: new Date().toISOString() })
  return next
}

async function saveItems(repo: AgentRepository, runId: string, owner: string, items: AssetReviewItem[], reviewScope: ReviewScope = 'all_assets', reviewMode: ReviewMode = 'full'): Promise<AssetReviewItem[]> {
  return repo.transaction(true, async store => {
    const lease = await store.get('pipelineRuns', 'lease:world')
    if (lease?.owner !== owner || lease.runId !== runId || Number(lease.expiresAt) <= Date.now()) throw new Error('CONFLICT:资产核对执行权已变化，请继续AI整理。')
    const run = (await store.get('pipelineRuns', runId)) as unknown as WorldRun
    const current = new Map((await buildItems(store, reviewScope)).map(item => [item.workItemId, item]))
    const next = items.map(item => item.status === 'checked' && current.has(item.workItemId) ? { ...item, revision: current.get(item.workItemId)!.revision, factFingerprint: current.get(item.workItemId)!.factFingerprint } : item)
    await store.put('pipelineRuns', { ...run, phase: 'asset_review', reviewScope, reviewMode, ...(reviewScope === 'relations' ? { relationReviewVersion: 1 } : {}), assetReview: { version: 1, items: next, updatedAt: new Date().toISOString() } })
    return next
  })
}

export interface AssetReviewOptions {
  owner: string; signal: AbortSignal; models: Pick<ModelService, 'agent'>
  reviewScope?: ReviewScope; reviewMode?: ReviewMode
  onPhase?: (message: string) => void
  onProgress?: (checked: number, total: number) => void
}
export interface AssetReviewResult { total: number; checked: number; deferred: boolean }

/** P2全资产核对：按当前编号分页，模型逐项读取、编辑或暂缓；结果写入运行记录。 */
export async function runAssetReview(repo: AgentRepository, runId: string, options: AssetReviewOptions): Promise<AssetReviewResult> {
  const { createAgentRuntime } = await import('../agents/runtime')
  const runtime = createAgentRuntime(options.models.agent)
  const reviewScope = options.reviewScope ?? 'all_assets'
  const reviewMode = options.reviewMode ?? 'full'
  const businessPrompt = reviewScope === 'relations' ? relationPrompt : prompt
  let items = await refreshItems(repo, runId, reviewScope)
  items = await saveItems(repo, runId, options.owner, items, reviewScope, reviewMode)
  const total = items.length
  options.onProgress?.(items.filter(item => item.status === 'checked').length, total)
  let sampleRemaining = reviewMode === 'sample' ? sampleSize : Infinity
  for (;;) {
    options.signal.throwIfAborted()
    // 暂缓项留待用户继续；本次运行仍可核对后续未尝试的批次。
    const pending = items.filter(item => item.status === 'pending')
    if (!pending.length || sampleRemaining <= 0) break
    const size = Math.min(batchSize, sampleRemaining)
    const batch = pending.slice(0, size)
    sampleRemaining -= batch.length
    const taskId = crypto.randomUUID()
    const workItems = batch.map(item => ({ workItemId: item.workItemId, kind: item.kind, id: item.id, revision: item.revision, factFingerprint: item.factFingerprint, ...(item.fromId && item.toId ? { fromId: item.fromId, toId: item.toId } : {}) }))
    const input = {
      bookId: repo.bookId, runId, taskId, stage: 'P2', phase: 'asset_review', planVersion: '2.2',
      workItems, remainingCount: pending.length,
      resume: { reason: items.some(item => item.status === 'checked') ? 'continuation' : 'initial', appliedCommitIds: [], nextOperationKey: crypto.randomUUID(), remainingWorkIds: pending.map(item => item.workItemId) },
      afterWorkItemId: null, pageLimit: batch.length,
      reviewScope, reviewMode,
    }
    options.onPhase?.(reviewScope === 'relations' ? `按原文核对人物关系 · ${batch.length} 项 · ${reviewMode === 'sample' ? '先核对10项' : '全书核对'}` : `核对人物、地点、节点、事件线与关系 · ${batch.length} 项 · 目标5分钟内收尾`)
    const result = await runtime.run(repo, { profile: 'asset_editor', phase: 'asset_review', runId, taskId, leaseOwner: options.owner, retainLease: true, workItems, input, businessPrompt, prompt: JSON.stringify(input), signal: options.signal, reviewScope })
    const reviewed = new Map(records(result.summary?.reviewedItems).map(row => [text(row.workItemId), row]))
    const rejected = await repo.transaction(false, async store => {
      const run = await store.get('pipelineRuns', runId)
      return records(run?.commandIntents).filter(row => row.taskId === taskId && row.state === 'rejected')
    })
    const deferredIds = new Set<string>()
    for (const intent of rejected) {
      const message = text((intent.error as Row | undefined)?.message)
      if (!/ASSET_DOMAIN_LOCKED|叙事任务/.test(message)) continue
      const payload = (intent.payload ?? {}) as Row
      if (payload.id) {
        const work = batch.find(item => item.id === text(payload.id))
        if (work) deferredIds.add(work.workItemId)
      }
      if (payload.fromId && payload.toId) deferredIds.add(workId('relation', pairKeyOf(text(payload.fromId), text(payload.toId)), reviewScope))
    }
    const failure = result.error ?? result.itemFailure ?? ''
    const locked = /ASSET_DOMAIN_LOCKED|叙事任务/.test(failure)
    const remaining = new Set(result.summary?.remainingWorkIds ?? batch.map(item => item.workItemId))
    items = items.map(item => {
      if (!batch.some(row => row.workItemId === item.workItemId)) return item
      if (deferredIds.has(item.workItemId)) {
        return { ...item, status: 'deferred' as const, outcome: 'deferred', reason: '叙事任务正在运行，待稍后继续。', taskId, updatedAt: new Date().toISOString() }
      }
      const reviewedItem = reviewed.get(item.workItemId)
      const outcome = text(reviewedItem?.outcome)
      const checked = result.ok && !remaining.has(item.workItemId) && ['changed', 'no_change'].includes(outcome)
      return { ...item, status: checked ? 'checked' as const : 'deferred' as const, outcome: outcome || 'needs_review', reason: text(reviewedItem?.reason) || failure || (locked ? '叙事任务正在运行，待稍后继续。' : '本项尚未核对完成，请继续AI整理。'), taskId, updatedAt: new Date().toISOString() }
    })
    items = await saveItems(repo, runId, options.owner, items, reviewScope, reviewMode)
    options.onProgress?.(items.filter(item => item.status === 'checked').length, total)
    if (reviewMode === 'sample') break
  }
  return { total, checked: items.filter(item => item.status === 'checked').length, deferred: items.some(item => item.status === 'pending' || item.status === 'deferred') }
}
