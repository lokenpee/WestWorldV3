import type { MergeGroup } from '../assets/merge'
import type { Row } from '../agents/repository'
import type { MergeRequest, WorldKind } from '../assets/merge'
export interface MechanicalQueueItem {
  id: string; kind: WorldKind; request: MergeRequest; memberNames: string[]; approvalFingerprints: Record<string, string>
  status: 'pending' | 'running' | 'completed' | 'failed'; confirmedAt: string; error?: string; commitId?: string
  confirmation?: 'manual' | 'exact_name'
}
export interface MechanicalQueue { items: MechanicalQueueItem[]; stopRequested: boolean; statisticsPending: boolean; current: boolean }
export interface Counts { characters: number; locations: number }
export interface WorldReport {
  beforeCounts: Counts; afterCounts: Counts; groups: (Omit<MergeGroup, 'method'> & { method: 'manual' | 'mechanical' | 'ai_identity' })[]
  optimizedIds: string[]; skipped: string[]; failed: string[]; conflicted: string[]; status: 'running' | 'completed' | 'degraded' | 'failed' | 'cancelled' | 'paused'
  cost: number; usage: { input: number; output: number; totalTokens: number; cost: number; costStatus?: 'estimated' | 'unknown' }; externalChanges: string[]
}
export interface WorldRun { id: string; bookId: string; recordType: 'run'; stage: 'P2'; phase: string; status: WorldReport['status']; startedAt: string; finishedAt?: string; report: WorldReport; commandIntents?: Row[]; tasks?: Row[]; coverage?: { total: number; checked: number; pendingIds: string[] }; mechanicalQueue?: MechanicalQueue }
export const emptyReport = (counts: Counts): WorldReport => ({ beforeCounts: counts, afterCounts: counts, groups: [], optimizedIds: [], skipped: [], failed: [], conflicted: [], status: 'running', cost: 0, usage: { input: 0, output: 0, totalTokens: 0, cost: 0, costStatus: 'estimated' }, externalChanges: [] })
