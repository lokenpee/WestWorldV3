import { twoStepMode } from './twoStepReview'
import { eventCandidateSection, lineCandidateSection, reviewMaterialSections } from './narrativeInput'
import { receiptOutcome, reviewReceiptOutcome, type Outcome } from './narrativeOutcome'
import type { createWorkspace } from '../../lib/storage/workspace'
import type { NarrativePlan, NarrativeTask } from './narrativePlan'
import { records, text } from '../agents/contracts'
import type { StoryExecutionPhase } from '../agents/executionPagingTypes'
import { readExecutionChain } from '../agents/trace'
import { buildEventTaskOutcome } from './eventTaskOutcome'

export async function readStoryExecution(workspace: ReturnType<typeof createWorkspace>, bookId: string, phase: StoryExecutionPhase) {
  const db = workspace.openBook(bookId)
  const runs = await db.table('pipelineRuns').where('stage').equals('P3').toArray()
  const run = runs.sort((a, b) => text(b.startedAt).localeCompare(text(a.startedAt)))
    .find(row => records(row.tasks).some(task => task.phase === phase))
  if (!run) return null

  const runId = text(run.id)
  const chain = await readExecutionChain(workspace, bookId, runId, { storyPhase: phase })
  return { runId, chain }
}

export async function readNarrativeTasks(workspace: ReturnType<typeof createWorkspace>, bookId: string, runId: string) {
  const run = await workspace.openBook(bookId).table('pipelineRuns').get(runId)
  if (!run?.narrative || run.bookId !== bookId) return []
  const active = (run.narrative as NarrativePlan).active?.id
  return records(run.tasks).map(task => {
    const input = task.input as NarrativeTask
    const status = task.taskId === active && ['running','paused','cancelled'].includes(text(run.status))
      ? run.status : text(task.status)
    let displayNames=''
    if (twoStepMode(input.mode)) {
      const material=JSON.parse(input.prompt)
      displayNames=input.orphanIds ? '未归属节点' : records(material.本组事件 ?? [material.主审事件]).map(e=>text(e.name)).join('、')
    }
    return { displayNames,id: text(task.taskId), mode: input.mode, degraded:input.retrieval?.degraded, part: input.part, ids: input.ids, phase: task.phase, status }
  })
}

export type StoryExecution = Awaited<ReturnType<typeof readStoryExecution>>

export async function readNarrativeOutcome(workspace: ReturnType<typeof createWorkspace>, bookId: string, runId: string, taskId: string) {
  const db = workspace.openBook(bookId)
  const table = db.table('pipelineRuns')
  const saved = await table.get(taskId)
  if (saved?.runId !== runId || saved.recordType !== 'narrative_task') return null
  const task = saved.snapshot as NarrativeTask
  const receipts = (await table.where('id').startsWith(taskId + ':').toArray())
    .filter(r => r.runId === runId && r.taskId === taskId && r.recordType === 'narrative_receipt')
    .sort((a,b) => text(a.startedAt).localeCompare(text(b.startedAt)))
  const confirm = receipts.find(r => r.name === 'confirm' && r.status === 'completed')
  if (twoStepMode(task.mode) || task.mode === 'link_node' || task.mode === 'review_event') {
    const eventOutcome = buildEventTaskOutcome(task,receipts,Array.isArray(saved.outcome) ? saved.outcome as Outcome : [])
    return {eventOutcome,label:'处理结果',groups:[],notes:[],review:undefined}
  }
  if (Array.isArray(saved.outcome)) return {label:'确认时的归属', groups:saved.outcome as Outcome, notes:[], review:undefined}
  if (task.part !== 'batch') {
    const material = JSON.parse(task.prompt)
    const targets = records(material[eventCandidateSection] ?? material[lineCandidateSection] ?? material[reviewMaterialSections[task.part]] ?? material.本段复核资料 ?? material.targets)
    const tables = { node: 'nodes', event: 'storyEvents', line: 'eventLines', doubt: 'storyEditorNotes' } as const
    const review = await reviewReceiptOutcome(task, material, targets, receipts.filter(r => r.status === 'completed'),
      confirm, async (ids, kind) => {
        if (!ids.length) return []
        return (await db.table(tables[kind]).bulkGet(ids)).flatMap(row =>
          row ? [{ id: text(row.id), title: text(row.title ?? row.name ?? row.statement) }] : [])
      })
    return {label:'复核成果',groups:[],notes:[],review}
  }
  const args = confirm?.arguments as Record<string,unknown> | undefined
  const notes = records(args?.retained_unassigned_nodes).map(r => text(r.node_id) + ' · ' + text(r.note))
  return {label:'本批已保存的成员变更',groups:receiptOutcome(receipts,task),notes,review:undefined}
}
