import type { ExecutionRow as Row } from './executionTypes.ts'
import type { ExecutionEvent } from './executionChain.ts'
import type { executionStats } from './executionStats.ts'

export interface ExecutionCursor { startedAt: string; requestId: string }
export type StoryExecutionPhase = 'window_link' | 'global_review'
export interface ExecutionQuery { runId: string; taskId?: string; unitId?: string; sessionId?: string; contextId?: string; storyPhase?: StoryExecutionPhase; before?: ExecutionCursor; since?: number; limit?: number; includeFirst?: boolean }
export interface ExecutionSummary { stats: ReturnType<typeof executionStats>; duration: string; model: string }
export interface ExecutionGroup { request: Row; events: ExecutionEvent[] }
export interface ExecutionPageResult {
  legacy?: boolean; groups: ExecutionGroup[]; validRequestIds: string[]; summary: ExecutionSummary
  version: number; hasEarlier: boolean; nextBefore?: ExecutionCursor; firstRequest?: Row
}
