import type { EventNode } from '../assets/types'
import type { Row } from '../agents/repository'
import type { StoryWindow } from './windows'
import { windowKey } from './windows'

export interface StoryCheckpoint {
  id: string; bookId: string; sessionId: string; stage: 'P3'; phase: 'window_link'; scopeIds: string[]; sourceFingerprint: string
  status: 'completed' | 'failed' | 'cancelled'; memberships: Record<string, string[]>; updatedAt: string; window: { start: number; end: number }
}
export interface StoryProgress { bookId: string; stage: 'P3'; status: string; phase: string; runId: string; editorSessionId: string; planKey: string; updatedAt: string; validity?: string }
export const checkpointId = (sessionId: string, planKey: string, window: StoryWindow) => `window:${sessionId}:${planKey}:${windowKey(window)}`
export const membershipsOf = (nodes: EventNode[]) => Object.fromEntries(nodes.map(node => [node.id, [...(node.eventLineIds ?? [])].sort()]))
export function evidenceEntries(tasks: Row[], nodes: Row[] = [], lines: Row[] = []) {
  return tasks.filter(task => ['window_link', 'global_review'].includes(String(task.phase))).map(task => {
    const input = task.input as Row | undefined
    const assigned = (Array.isArray(input?.workItems) ? input.workItems : []) as Row[]
    const reviewed = (Array.isArray(task.reviewedItems) ? task.reviewedItems : []) as Row[]
    return { id: String(task.taskId), phase: String(task.phase), status: String(task.status), requests: Number(task.stepsUsed ?? 0), total: assigned.length, remaining: assigned.filter(work => !reviewed.some(item => item.workItemId === work.workItemId)).map(work => String(work.id)),
      reviewed: reviewed.map(item => {
        const work = assigned.find(work => work.workItemId === item.workItemId)
        const row = [...nodes, ...lines].find(row => row.id === work?.id)
        return { ...item, outcome: String(item.outcome), reason: String(item.reason), assetId: String(work?.id ?? item.workItemId), title: String(row?.name ?? row?.title ?? ''), lineTitles: lines.filter(line => Array.isArray(line.nodeIds) && line.nodeIds.includes(work?.id)).map(line => String(line.title)) }
      }), commits: Array.isArray(task.appliedCommitIds) ? task.appliedCommitIds as string[] : [], error: task.lastError && typeof task.lastError === 'object' ? String((task.lastError as Row).message) : '' }
  })
}
