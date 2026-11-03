import type { MergeGroup } from '../assets/merge'
import type { AssetEditRecord } from '../assets/types'
import type { Row } from '../agents/repository'
import type { MergeRequest, WorldKind } from '../assets/merge'
export interface MechanicalQueueItem {
  id: string; kind: WorldKind; request: MergeRequest; memberNames: string[]; approvalFingerprints: Record<string, string>
  status: 'pending' | 'running' | 'completed' | 'failed'; confirmedAt: string; error?: string; commitId?: string
  confirmation?: 'manual' | 'exact_name'
  manualSelection?: boolean
  protectionVersion?: 1
}
export interface MechanicalQueue { items: MechanicalQueueItem[]; stopRequested: boolean; statisticsPending: boolean; current: boolean }
export interface Counts { characters: number; locations: number }
export interface ProtectionRepair { kind: WorldKind; id: string; name: string; beforeNameSource: string; beforeManualKeep: boolean; reason: string }
export interface AliasDecision { alias: string; decision: 'keep' | 'remove'; confidence: number; reason: string; evidence: { chapterIndex: string; quote: string }[]; referentId?: string }
export interface AliasCheckRecord { id: string; kind: WorldKind; assetId: string; name: string; beforeAliases: string[]; afterAliases: string[]; verifiedAliases: string[]; decisions: AliasDecision[]; taskId: string; commitId: string; createdAt: string; affectedNodeIds?: string[] }
export interface QualityIssue { kind: 'omission' | 'duplicate' | 'contradiction' | 'unsupported' | 'alias_error' | 'composite_entity'; field: string; factIds: string[]; message: string }
export interface QualityReview { approved: boolean; summary: string; issues: QualityIssue[] }
export interface OptimizationDraft {
  id: string; kind: WorldKind; assetId: string; name: string; basisFingerprint: string; rulesFingerprint: string
  before: Record<string, string>; after: Record<string, string>; beforeAliases: string[]; afterAliases: string[]
  proposedName: string; notes: string[]; factIds: string[]; createdAt: string; appliedAt?: string
  status: 'pending_review' | 'applied' | 'no_change' | 'rejected' | 'stale'
  review?: QualityReview; reviewError?: string
}
export interface WorldReport {
  beforeCounts: Counts; afterCounts: Counts; groups: (Omit<MergeGroup, 'method'> & { method: 'manual' | 'mechanical' | 'ai_identity' })[]
  optimizedIds: string[]; skipped: string[]; failed: string[]; conflicted: string[]; status: 'running' | 'completed' | 'degraded' | 'failed' | 'cancelled' | 'paused'
  protectionRepairs?: ProtectionRepair[]
  aliasChecks?: AliasCheckRecord[]
  optimizations?: OptimizationDraft[]
  assetEdits?: AssetEditRecord[]
  cost: number; usage: { input: number; output: number; totalTokens: number; cost: number; costStatus?: 'estimated' | 'unknown' }; externalChanges: string[]
}
export interface AssetReviewItem { workItemId: string; kind: string; id: string; fromId?: string; toId?: string; revision: number; factFingerprint: string; status: 'pending' | 'checked' | 'deferred' | 'skipped'; outcome?: string; reason?: string; taskId?: string; updatedAt: string }
export interface WorldRun { id: string; bookId: string; recordType: 'run'; stage: 'P2'; phase: string; status: WorldReport['status']; startedAt: string; finishedAt?: string; report: WorldReport; commandIntents?: Row[]; tasks?: Row[]; coverage?: { total: number; checked: number; pendingIds: string[] }; mechanicalQueue?: MechanicalQueue; assetReview?: { version: 1; items: AssetReviewItem[]; updatedAt: string } }
export const emptyReport = (counts: Counts): WorldReport => ({ beforeCounts: counts, afterCounts: counts, groups: [], optimizedIds: [], skipped: [], failed: [], conflicted: [], status: 'running', cost: 0, usage: { input: 0, output: 0, totalTokens: 0, cost: 0, costStatus: 'estimated' }, externalChanges: [] })
