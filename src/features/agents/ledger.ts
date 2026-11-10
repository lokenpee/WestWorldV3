import type { Attempt } from '../models/types'
import type { AgentStore, Row } from './repository'
import type { Scope } from './queries'
import { usageCost } from '../models/policy'
import { records, text } from './contracts'

export async function appendRequestLedger(store: AgentStore, scope: Scope, attempts: Attempt[], snapshot: Row | undefined, purpose: 'work' | 'compaction' | 'compaction_repair' | 'repair' = 'work') {
  if (!attempts.length) return
  const run = await store.get('pipelineRuns', scope.runId)
  if (!run) return
  const now = Date.now()
  const characterId = scope.unitId?.startsWith('profile:') || scope.unitId?.startsWith('relations:') ? scope.unitId.split(':')[1] : undefined
  const rows = attempts.map(attempt => {
    const usage = attempt.usage as Row | undefined
    const total = usage ? Number((usage as { totalTokens?: number }).totalTokens ?? 0) : null
    const inputValue = usage ? Number(usage.input ?? 0) : null
    const outputValue = usage ? Number(usage.output ?? 0) : null
    const cacheWriteValue = usage ? Number(usage.cacheWrite ?? 0) : null
    const reportedCacheRead = usage ? Number(usage.cacheRead ?? 0) : null
    const derivedCacheRead = total !== null && inputValue !== null && outputValue !== null && cacheWriteValue !== null ? Math.max(0, total - inputValue - outputValue - cacheWriteValue) : 0
    const cacheReadValue = reportedCacheRead === null ? null : Math.max(reportedCacheRead, derivedCacheRead)
    const costValue = usageCost(attempt.usage)
    const pricing = text(snapshot?.pricingStatus)
    return {
      attemptId: attempt.attemptId ?? crypto.randomUUID(), ...(attempt.requestId ? { requestId: attempt.requestId } : {}), executionId: scope.executionId ?? scope.runId, stage: 'P2', ...(scope.unitId ? { workId: scope.unitId } : {}), ...(characterId ? { characterId } : {}), ...(scope.contextId ? { contextId: scope.contextId } : {}), ordinal: attempt.ordinal, turn: attempt.turn, ...(attempt.requestId ? { traceEntryId: `trace:${attempt.requestId}` } : {}),
      purpose,
      status: attempt.errorKind ? 'failed' as const : 'succeeded' as const,
      startedAt: attempt.startedAt ?? new Date(now - Number(attempt.elapsedMs ?? 0)).toISOString(), finishedAt: attempt.finishedAt ?? new Date(now).toISOString(),
      estimatedInput: typeof attempt.estimatedInput === 'number' ? attempt.estimatedInput : null,
      outputReserve: typeof attempt.outputReserve === 'number' ? attempt.outputReserve : null,
      input: inputValue,
      cacheRead: cacheReadValue,
      cacheWrite: cacheWriteValue,
      output: outputValue,
      totalTokens: total,
      usageStatus: usage && total ? 'reported' as const : 'missing' as const,
      cost: pricing === 'estimated' && costValue !== null ? costValue : null,
      ...(snapshot?.pricingCurrency ? { currency: snapshot.pricingCurrency as 'USD' } : {}),
      costStatus: pricing === 'estimated' && costValue !== null ? 'estimated' as const : 'unknown' as const,
      ...(snapshot ? { modelSnapshot: `${text(snapshot.providerId)}/${text(snapshot.modelId)}` } : {}),
      ...(attempt.errorKind ? { errorCode: attempt.errorKind } : {}),
    }
  })
  await store.put('pipelineRuns', { ...run, requestLedger: [...records(run.requestLedger), ...rows] })
}
