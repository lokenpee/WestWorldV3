import type { AgentRepository, AgentStore, Row } from '../agents/repository'
import type { createAgentRuntime } from '../agents/runtime'
import { hash, records, strings, text } from '../agents/contracts'
import { noteFingerprint } from '../agents/queries'
import { saveStoryCoverage, storyFingerprint, validStoryCoverage } from './coverage'
import { buildStoryContext, selectStoryBatch, storyBatchBudget } from './retrieval'
import storyPrompt from '../../../docs/v2/resources/v2.2/prompts/active/p3-story.md?raw'
import taskTemplate from '../../../docs/v2/resources/v2.2/prompts/active/story.txt?raw'

type Queue = 'orphans' | 'event_lines' | 'review_notes'
interface ReviewItem { queue: Queue; table: string; row: Row; workItemId: string; kind: string; fingerprint: string }
async function reviewItems(store: AgentStore, sessionId: string): Promise<ReviewItem[]> {
  const nodes = await store.rows('nodes'), lines = await store.rows('eventLines')
  const linked = new Set(lines.flatMap(row => strings(row.nodeIds)))
  const notes = []
  for (const row of await store.rows('storyEditorNotes')) if (row.sessionId === sessionId && (row.status === 'active' || await noteFingerprint(store, row) !== row.basisFingerprint)) notes.push({ ...row, validity: await noteFingerprint(store, row) === row.basisFingerprint ? 'current' : 'stale' })
  const groups: [Queue, string, string, Row[]][] = [['orphans', 'nodes', 'node', nodes.filter(row => !linked.has(text(row.id)))], ['event_lines', 'eventLines', 'eventLine', lines], ['review_notes', 'storyEditorNotes', 'note', notes]]
  return (await Promise.all(groups.map(async ([queue, table, kind, rows]) => Promise.all(rows.sort((a, b) => text(a.id) < text(b.id) ? -1 : text(a.id) > text(b.id) ? 1 : 0).map(async row => ({ queue, table, row, kind, workItemId: `global_review:${queue}:${encodeURIComponent(text(row.id))}`, fingerprint: await store.wait(storyFingerprint(table, row)) })))))).flat()
}
export async function reviewQueue(store: AgentStore, runId: string, sessionId: string) {
  const run = (await store.get('pipelineRuns', runId))!
  const items = await reviewItems(store, sessionId)
  const coverage = records(run.coverageItems).filter(row => row.phase === 'global_review')
  const pending: ReviewItem[] = []
  for (const item of items) {
    const previous = coverage.find(row => row.workItemId === item.workItemId)
    if (!previous || !await validStoryCoverage(store, previous, item.row)) pending.push(item)
  }
  return { run, items, pending, coverage }
}
export async function runGlobalReview(repo: AgentRepository, runtime: ReturnType<typeof createAgentRuntime>, options: {
  runId: string; sessionId: string; owner: string; contextWindow?: number; signal: AbortSignal; check: () => Promise<void>; onProgress: (checked: number, total: number, queue: string) => void
}) {
  const attempted = new Set<string>()
  for (;;) {
    await options.check()
    const state = await repo.transaction(false, store => reviewQueue(store, options.runId, options.sessionId))
    options.onProgress(state.items.length - state.pending.length, state.items.length, state.pending[0]?.queue ?? '')
    await repo.transaction(true, async store => {
      await options.check()
      const run = (await store.get('pipelineRuns', options.runId))!
      const coverage = records(run.coverageItems)
      for (const item of state.pending) {
        const at = coverage.findIndex(row => row.workItemId === item.workItemId)
        const old = coverage[at]
        const entry = { workItemId: item.workItemId, phase: 'global_review', kind: item.kind, id: text(item.row.id), status: 'pending', inputRevision: Number(item.row.revision ?? 0), inputFingerprint: item.fingerprint, coveredRevision: Number(old?.coveredRevision ?? 0), coveredFingerprint: text(old?.coveredFingerprint), dependencies: old?.dependencies ?? { records: [], queries: [] }, taskId: old?.taskId ?? null, outcome: old?.outcome ?? null, reason: text(old?.reason), invalidations: Number(old?.invalidations ?? 0), updatedAt: new Date().toISOString() }
        if (at < 0) coverage.push(entry); else coverage[at] = entry
      }
      await store.put('pipelineRuns', { ...run, phase: 'global_review', coverageItems: coverage, coverage: { total: state.items.length, checked: state.items.length - state.pending.length, pendingIds: state.pending.map(row => row.workItemId) } })
    })
    if (!state.pending.length) {
      await repo.transaction(true, async store => {
        await options.check()
        const latest = await reviewQueue(store, options.runId, options.sessionId)
        if (latest.pending.length) throw new Error('复核资料有更新，请继续核对。')
        const liveIds = new Set(latest.items.map(row => row.workItemId))
        const previous = records(latest.run.coverageItems).map(row => row.phase === 'global_review' && !liveIds.has(text(row.workItemId)) ? { ...row, status: 'skipped', outcome: 'deleted', reason: '该项已删除、已归线或已解决，当前复核队列已更新。' } : row)
        await store.put('pipelineRuns', { ...latest.run, coverageItems: previous, status: 'completed', phase: 'global_review', noProgressTasks: 0, finishedAt: new Date().toISOString(), coverage: { total: latest.items.length, checked: latest.items.length, pendingIds: [] } })
        const progress = (await store.get('compileProgress', 'P3'))!
        await store.put('compileProgress', { ...progress, status: 'completed', phase: 'global_review', validity: 'current', updatedAt: new Date().toISOString() })
        const nodes = await store.rows('nodes')
        await store.put('storyEditorCheckpoints', { id: `review:${options.sessionId}:${options.runId}`, bookId: repo.bookId, sessionId: options.sessionId, stage: 'P3', phase: 'global_review', status: 'completed', scopeIds: latest.items.map(row => text(row.row.id)), sourceFingerprint: await store.wait(hash(latest.items)), memberships: Object.fromEntries(nodes.map(row => [text(row.id), strings(row.eventLineIds)])), updatedAt: new Date().toISOString() })
      })
      return true
    }
    const eligible = state.pending.filter(item => !attempted.has(item.workItemId))
    if (!eligible.length) {
      await repo.transaction(true, async store => {
        await options.check()
        const run = (await store.get('pipelineRuns', options.runId))!
        await store.put('pipelineRuns', { ...run, status: 'paused', phase: 'global_review', finishedAt: new Date().toISOString() })
        const progress = (await store.get('compileProgress', 'P3'))!
        await store.put('compileProgress', { ...progress, status: 'paused', validity: 'stale', updatedAt: new Date().toISOString() })
      })
      return false
    }
    const queue = eligible[0].queue
    const candidates = eligible.filter(row => row.queue === queue)
    const chosen = new Set(selectStoryBatch(candidates.map(item => item.row), storyBatchBudget(options.contextWindow)).map(row => row.id))
    const batch = candidates.filter(item => chosen.has(item.row.id))
    for (const item of batch) attempted.add(item.workItemId)
    const taskId = crypto.randomUUID(), operationKey = crypto.randomUUID()
    const workItems = batch.map(item => ({ workItemId: item.workItemId, kind: item.kind, id: text(item.row.id), revision: Number(item.row.revision ?? 0), factFingerprint: item.fingerprint }))
    const memory = await repo.transaction(false, store => store.get('storyEditorMemory', options.sessionId)) ?? { id: options.sessionId, bookId: repo.bookId, sessionId: options.sessionId, revision: 0, workingSummary: '', dataFingerprint: '', updatedAt: '' }
    const contextHints = await repo.transaction(false, store => buildStoryContext(store, repo.bookId, options.sessionId, batch.map(item => item.row), batch[0].kind, true))
    const input = { bookId: repo.bookId, runId: options.runId, taskId, planVersion: '2.2', remainingCount: state.pending.length, resume: { reason: state.coverage.length ? 'continuation' : 'initial', appliedCommitIds: [], nextOperationKey: operationKey, remainingWorkIds: workItems.map(row => row.workItemId) }, stage: 'P3', phase: 'global_review', sessionId: options.sessionId, queue, window: null, workItems, existingLines: [], contextHints, memory, afterWorkItemId: null }
    const result = await runtime.run(repo, { profile: 'story_editor', phase: 'global_review', sessionId: options.sessionId, runId: options.runId, taskId, leaseOwner: options.owner, retainLease: true, workItems, input, businessPrompt: storyPrompt, prompt: taskTemplate.replace('{taskJson}', JSON.stringify(input)), signal: options.signal })
    await options.check()
    if (!result.ok) throw new Error(result.error ?? '全书复核失败。')
    await repo.transaction(true, async store => {
      await options.check()
      const run = (await store.get('pipelineRuns', options.runId))!
      const task = records(run.tasks).find(row => row.taskId === taskId)!
      await saveStoryCoverage(store, options.runId, task, result.summary?.reviewedItems as unknown as Row[] ?? [])
      const latest = (await store.get('pipelineRuns', options.runId))!
      await store.put('pipelineRuns', { ...latest, phase: 'global_review', status: 'running' })
    })
  }
}
