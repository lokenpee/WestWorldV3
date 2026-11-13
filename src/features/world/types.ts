import type { MergeGroup } from '../assets/merge'
import type { AssetEditRecord, Basis } from '../assets/types'
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
  candidateDecisions?: CandidateDecision[]
  organizationSummary?: OrganizationSummary
  cost: number; usage: { input: number; output: number; totalTokens: number; cost: number; costStatus?: 'estimated' | 'unknown' }; externalChanges: string[]
}
export type OrganizationStep = 'scan' | 'resolve' | 'profiles' | 'relations' | 'finalize' | 'done'
export type OrganizationMode = 'full' | 'profile' | 'relations'
export type OrganizationRunStep = 'scan' | 'profiles' | 'relations'
export interface ScanPage { pageId: string; ids: string[]; nextCursor: string | null; status: 'issued' | 'checked'; lastError?: { code: string; message: string; action: 'retry' | 'reload' | 'defer' | 'pause'; tool?: string } }
export interface CandidateGroup { id: string; memberIds: string[]; memberNames?: string[]; reason: string; status: 'pending' | 'resolved'; revision: number; createdAt: string; updatedAt: string; originStep?: OrganizationStep; lastError?: { code: string; message: string; action: 'retry' | 'reload' | 'defer' | 'pause'; tool?: string } }
export interface CandidateDecision { groupId: string; memberIds: string[]; memberNames: string[]; outcome: 'merged' | 'not_same' | 'uncertain' | 'partial'; reason: string; basis: Basis[]; commitIds: string[]; createdAt: string; originStep?: OrganizationStep }
export interface OrganizationItem { id: string; name?: string; status: 'pending' | 'checked'; outcome: 'changed' | 'no_change' | 'uncertain' | 'unavailable' | null; reason: string; contentFingerprint: string; readRefs: string[]; commitIds: string[]; uncertainFields?: string[]; lastError?: { code: string; message: string; action: 'retry' | 'reload' | 'defer' | 'pause'; tool?: string } }
export interface PairCheck { pairKey: string; fingerprint: string; readFingerprint?: string; outcome: 'changed' | 'no_change' | 'uncertain' | null; reason: string; basis: Basis[]; commitIds: string[]; evidenceStatus?: 'verified' | 'unverified' | 'partial' }
export interface OrganizationContext { id: string; status: 'pending' | 'active' | 'completed'; pendingWorkId: string | null; pendingUnitId?: string | null }
export interface OrganizationContexts { identity: OrganizationContext; profiles: OrganizationContext; relations: OrganizationContext }
export type WorkKind = 'directory' | 'candidate' | 'profile' | 'relations'
export interface ActiveWork {
  id: string; kind: WorkKind; characterId?: string; contextId: string
  status: 'pending' | 'running' | 'completed' | 'error'
  requestCount: number; draft: Row | null; commitIds: string[]; dataVersion?: number
  lastError?: { code: string; message: string; action: 'retry' | 'reload' | 'defer' | 'pause'; tool?: string }
  targetIds?: string[]; targetId?: string; snapshotId?: string; consecutiveNoProgress?: number; readCoverage?: Record<string, string[]>
}
export interface WorkSnapshot {
  id: string; bookId: string; runId: string; contextId: string; targetIds: string[]
  revisions: Record<string, number>; fields: string[]; factIds: string[]
  ranges: { id: string; from: number; to: number }[]; contentFingerprint: string; deliveredAttemptIds: string[]
}
export interface OrganizationState {
  version: 1; step: OrganizationStep; revision: number; mode?: OrganizationMode; targetCharacterId?: string; runStep?: OrganizationRunStep; pauseRequested?: boolean
  scanIds: string[]; scanPages: ScanPage[]; candidateGroups: CandidateGroup[]; candidateDecisions: CandidateDecision[]
  identityPageId?: string; seenIdentityPageIds?: string[]
  identityChecks?: { id: string; fingerprint: string }[]; reusedCount?: number
  originalReadUnits?: string[]
  profileItems: OrganizationItem[]; relationItems: OrganizationItem[]; pairChecks: PairCheck[]
  statisticsPending: boolean
  reviewVersion?: number; reviewStartedAt?: string; repairNotice?: string; pauseNotice?: string
  executionVersion?: number; contexts?: OrganizationContexts; activeWork?: ActiveWork | null
}
export interface RequestLedgerEntry {
  attemptId: string; requestId?: string; executionId?: string; stage: string; workId?: string; characterId?: string; contextId?: string
  purpose: "work" | "retry" | "compaction" | "compaction_repair" | "repair"
  status: "succeeded" | "failed" | "cancelled"
  ordinal?: number; turn?: number
  startedAt: string; finishedAt: string
  estimatedInput: number | null; outputReserve: number | null
  input: number | null; cacheRead: number | null; cacheWrite: number | null; output: number | null; totalTokens: number | null
  usageStatus: "reported" | "partial" | "missing"
  cost: number | null; currency?: "USD"; costStatus: "estimated" | "unknown"
  modelSnapshot?: string; traceEntryId?: string; errorCode?: string
}
export interface OrganizationSummary { scannedPages: number; candidateGroups: number; merged: number; uncertain: number; profilesChecked: number; relationsChecked: number; statistics: 'pending' | 'completed' }
export interface AssetReviewItem {
  workItemId: string; kind: string; id: string; fromId?: string; toId?: string; revision: number; factFingerprint: string
  status: 'pending' | 'checked' | 'deferred' | 'skipped'; outcome?: string; reason?: string; taskId?: string; updatedAt: string
  sourceFingerprint?: string
  evidenceReads?: { chapterIndex: string; offset: number; length: number }[]
  commitIds?: string[]
  resolvedPairs?: { pairKey: string; fingerprint: string }[]
}
export type ReviewScope = 'all_assets' | 'relations'
export type ReviewMode = 'sample' | 'full'
export interface WorldRun {
  id: string; bookId: string; recordType: 'run'; stage: 'P2'; phase: string; scope?: 'fullBook' | 'character'; status: WorldReport['status']; startedAt: string; finishedAt?: string; report: WorldReport
  commandIntents?: Row[]; tasks?: Row[]; coverage?: { total: number; checked: number; pendingIds: string[] }; mechanicalQueue?: MechanicalQueue
  assetReview?: { version: 1; items: AssetReviewItem[]; updatedAt: string }
  reviewScope?: ReviewScope; reviewMode?: ReviewMode; relationReviewVersion?: 1 | 2
  workflow?: 'character_organization_v1'; sessionId?: string; organization?: OrganizationState; requestLedger?: RequestLedgerEntry[]
}
export const emptyReport = (counts: Counts): WorldReport => ({ beforeCounts: counts, afterCounts: counts, groups: [], optimizedIds: [], skipped: [], failed: [], conflicted: [], status: 'running', cost: 0, usage: { input: 0, output: 0, totalTokens: 0, cost: 0, costStatus: 'estimated' }, externalChanges: [] })
