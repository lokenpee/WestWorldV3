import type { createWorkspace } from '../../lib/storage/workspace'
import { records, text } from '../agents/contracts'
import type { StoryExecutionPhase } from '../agents/executionPagingTypes'
import { readExecutionChain } from '../agents/trace'

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

export type StoryExecution = Awaited<ReturnType<typeof readStoryExecution>>
