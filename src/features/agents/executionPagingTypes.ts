import type { ExecutionRow as Row } from './executionTypes.ts'
import type { ExecutionEvent } from './executionChain.ts'
import type { executionStats } from './executionStats.ts'

export interface ExecutionCursor { startedAt: string; requestId: string }
export interface ExecutionQuery { runId: string; unitId?: string; sessionId?: string; contextId?: string; before?: ExecutionCursor; since?: number; limit?: number }
export interface ExecutionSummary { stats: ReturnType<typeof executionStats>; duration: string; model: string }
export interface ExecutionGroup { request: Row; events: ExecutionEvent[] }
export interface ExecutionPageResult {
  legacy?: boolean; groups: ExecutionGroup[]; validRequestIds: string[]; summary: ExecutionSummary
  version: number; hasEarlier: boolean; nextBefore?: ExecutionCursor
}
