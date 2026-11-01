import Dexie from 'dexie'
import type { Chapter, createWorkspace } from '../../lib/storage/workspace'
import type { EventNode } from '../assets/types'
import type { ModelService } from '../models/service'
import { coverage, type Receipt } from '../extraction/recovery'
import { createBookAgentRepository, type Row } from '../agents/repository'
import { checkpointId, evidenceEntries, membershipsOf, type StoryCheckpoint, type StoryProgress } from './checkpoints'
import { createStoryWindows, windowKey, windowNodes, type StoryWindow } from './windows'
import { runGlobalReview, reviewQueue } from './review'
import { recoverStoryCoverage, saveStoryCoverage, storyFingerprint, validStoryCoverage, windowFingerprint } from './coverage'
import { hash } from '../agents/contracts'
import { buildStoryContext, lineDigest, selectStoryBatch, storyBatchBudget } from './retrieval'
import type { SessionStatus } from '../agents/compaction'
import storyPrompt from '../../../docs/v2/resources/v2.2/prompts/active/p3-story.md?raw'
import taskTemplate from '../../../docs/v2/resources/v2.2/prompts/active/story.txt?raw'

type Workspace = ReturnType<typeof createWorkspace>
interface StoryState { running: boolean; window: number; total: number; processed: number; nodeTotal: number; error?: string; message?: string; phase?: string; queue?: string; sessionStatus?: SessionStatus }
export function createStoryService(workspace: Workspace, models: Pick<ModelService, 'agent' | 'settings' | 'generate'>) {
  const states = new Map<string, StoryState>(), controllers = new Map<string, AbortController>(), listeners = new Set<() => void>()
  const set = (bookId: string, changes: Partial<StoryState>) => { states.set(bookId, { ...(states.get(bookId) ?? { running: false, window: 0, total: 0, processed: 0, nodeTotal: 0 }), ...changes }); listeners.forEach(listener => listener()) }
  async function start(bookId: string, phase: 'window_link' | 'global_review' = 'window_link') {
    if (controllers.has(bookId)) return
    const controller = new AbortController(); controllers.set(bookId, controller)
    const db = workspace.openBook(bookId), repo = createBookAgentRepository(workspace, bookId)
    let runId: string = crypto.randomUUID(), sessionId = '', planKey = ''
    const owner = crypto.randomUUID(); let acquired = false; let recheck = false; let timer: ReturnType<typeof setInterval> | undefined
    let chapters: Chapter[] = [], windows: StoryWindow[] = [], activeWindow: StoryWindow | undefined
    set(bookId, { running: true, phase, window: 0, total: 0, processed: 0, nodeTotal: 0, error: undefined, message: undefined, sessionStatus: undefined })
    const check = async () => {
      controller.signal.throwIfAborted()
      const lease = await db.table('pipelineRuns').get('lease:narrative')
      const session = await db.table('storySessions').get(sessionId)
      if (lease?.owner !== owner || lease.runId !== runId || lease.expiresAt <= Date.now() || session?.leaseOwner !== owner || session.leaseUntil <= Date.now()) throw new Error('本书叙事任务的执行权已失效。')
    }
    const nodesFor = async (window: StoryWindow) => windowNodes(window, chapters, await db.table<EventNode>('nodes').toArray())
    try {
      const [{ createAgentRuntime }, { records, text }, { resolveSession }] = await Promise.all([import('../agents/runtime'), import('../agents/contracts'), import('../agents/sessions')])
      if (!await workspace.settings.books.get(bookId)) throw new Error('书籍不存在。')
      const settings = await models.settings.read()
      if (!settings.configured || !settings.config.aggregationModel) throw new Error('请先保存整理模型与密钥。')
      chapters = await db.chapters.orderBy('order').toArray(); windows = createStoryWindows(chapters)
      if (!windows.length) throw new Error('请先导入章节。')
      planKey = await hash({ version: '2.2', size: 100, overlap: 20, windows, chapters })
      const runtime = createAgentRuntime(models.agent, { generate: models.generate, onStatus: sessionStatus => set(bookId, { sessionStatus }) })
      await repo.transaction(true, async store => {
        const leases = await store.rows('pipelineRuns')
        if (leases.some(row => row.recordType === 'lease' && ['extraction', 'narrative'].includes(text(row.lockKey)) && Number(row.expiresAt ?? Infinity) > Date.now())) throw new Error('本书已有叙事或提取任务，请等待其结束。')
        if (!coverage(chapters, await store.rows('extractionReceipts') as unknown as Receipt[]).allCovered) throw new Error('请先完成全书逐章提取。')
        const session = await resolveSession(store, bookId)
        if (session.leaseOwner && Number(session.leaseUntil) > Date.now()) throw new Error('本书会话正在其他窗口运行。')
        sessionId = session.id
        const previous = await store.get('compileProgress', 'P3')
        recheck = previous?.validity === 'stale' && ['window_link_complete', 'global_review'].includes(text(previous.phase))
        const previousRun = previous?.runId ? await store.get('pipelineRuns', text(previous.runId)) : undefined
        if (previous?.planKey === planKey && previous.editorSessionId === sessionId && previousRun?.stage === 'P3') runId = text(previousRun.id)
        if (phase === 'global_review') for (const window of windows) {
          const checkpoint = await store.get('storyEditorCheckpoints', checkpointId(sessionId, planKey, window))
          const nodes = windowNodes(window, chapters, await store.rows('nodes') as unknown as EventNode[])
          if (checkpoint?.status !== 'completed' || previous?.phase !== 'global_review' && ![await store.wait(windowFingerprint(window, nodes)), await store.wait(hash({ window, nodes }))].includes(text(checkpoint.sourceFingerprint))) throw new Error('请先完成当前资料的窗口串联。')
        }
        const now = new Date().toISOString()
        const run = runId === previousRun?.id ? previousRun : { id: runId, bookId, recordType: 'run', stage: 'P3', startedAt: now, planVersion: '2.2', scope: 'fullBook', tasks: [], commandIntents: [], appliedCommands: [], coverageItems: [], aiMode: 'agent' }
        const { finishedAt: _finishedAt, ...resumed } = run
        await store.put('pipelineRuns', { ...resumed, status: 'running', phase })
        await store.put('pipelineRuns', { id: 'lease:narrative', bookId, recordType: 'lease', lockKey: 'narrative', owner, runId, expiresAt: Date.now() + 30000 })
        await store.put('storySessions', { ...session, leaseOwner: owner, leaseUntil: Date.now() + 30000 })
        await store.put('compileProgress', { bookId, stage: 'P3', status: 'running', phase, runId, editorSessionId: sessionId, planKey, totalChapters: chapters.length, completedChapters: [], failedChapters: [], updatedAt: now, scope: 'fullBook', planVersion: '2.2', unit: phase === 'global_review' ? 'item' : 'window', validity: 'current' })
      }); acquired = true
      timer = setInterval(() => { void repo.transaction(true, async store => {
        const lease = await store.get('pipelineRuns', 'lease:narrative'); const session = await store.get('storySessions', sessionId)
        if (lease?.owner !== owner || session?.leaseOwner !== owner) throw new Error('叙事执行权已变化。')
        await store.put('pipelineRuns', { ...lease, expiresAt: Date.now() + 30000 }); await store.put('storySessions', { ...session, leaseUntil: Date.now() + 30000 })
      }).catch(() => controller.abort()) }, 8000)
      await repo.transaction(true, store => recoverStoryCoverage(store, runId))
      if (phase === 'global_review') {
        const completed = await runGlobalReview(repo, runtime, { runId, sessionId, owner, signal: controller.signal, check, contextWindow: settings.config.aggregationContextWindow, onProgress: (processed, nodeTotal, queue) => set(bookId, { processed, nodeTotal, queue }) })
        if (completed) await db.transaction('rw', db.tables, async () => {
          await check()
          for (const window of windows) {
            const id = checkpointId(sessionId, planKey, window)
            const checkpoint = await db.table<StoryCheckpoint>('storyEditorCheckpoints').get(id)
            const nodes = await nodesFor(window)
            if (checkpoint) await db.table('storyEditorCheckpoints').put({ ...checkpoint, scopeIds: nodes.map(row => row.id), sourceFingerprint: await Dexie.waitFor(windowFingerprint(window, nodes)), memberships: membershipsOf(nodes), updatedAt: new Date().toISOString() })
          }
        })
        set(bookId, { message: completed ? '全书复核完成。' : '本轮复核已保存，剩余项可继续。' })
        return
      }
      const saveCheckpoint = async (window: StoryWindow, status: StoryCheckpoint['status']) => {
        const nodes = await nodesFor(window)
        const sourceFingerprint = await Dexie.waitFor(windowFingerprint(window, nodes))
        await db.table('storyEditorCheckpoints').put({ id: checkpointId(sessionId, planKey, window), bookId, sessionId, stage: 'P3', phase: 'window_link', scopeIds: nodes.map(row => row.id), sourceFingerprint, status, memberships: membershipsOf(nodes), updatedAt: new Date().toISOString(), window: { start: window.start, end: window.end } } satisfies StoryCheckpoint)
      }
      const windowCoverage = async (window: StoryWindow) => repo.transaction(false, async store => {
        const current = windowNodes(window, chapters, await store.rows('nodes') as unknown as EventNode[])
        const run = (await store.get('pipelineRuns', runId))!
        const saved = records(run.coverageItems)
        const covered = new Set<string>()
        for (const row of current) {
          const item = saved.find(item => item.workItemId === `window_link:${windowKey(window)}:node:${encodeURIComponent(row.id)}`)
          if (item && await validStoryCoverage(store, item, row as unknown as Row)) covered.add(row.id)
        }
        return { current, covered, run }
      })
      let completedWindows = 0
      for (const [windowIndex, window] of windows.entries()) {
        await check(); activeWindow = window
        set(bookId, { window: windowIndex + 1, total: windows.length, processed: 0 })
        const existing = await db.table<StoryCheckpoint>('storyEditorCheckpoints').get(checkpointId(sessionId, planKey, window))
        const initial = await windowCoverage(window)
        if (!recheck && existing?.status === 'completed' && initial.covered.size === initial.current.length &&
          [await windowFingerprint(window, initial.current), await hash({ window, nodes: initial.current })].includes(existing.sourceFingerprint)) { completedWindows++; continue }
        const attempted = new Set<string>(), readLines = new Set<string>()
        for (const task of records(initial.run.tasks)) {
          const prior = (task.input as Row)?.window as Row | undefined
          if (task.phase !== 'window_link' || prior?.start !== window.start || prior?.end !== window.end) continue
          for (const read of records((task.readSet as Row)?.records).filter(row => row.table === 'eventLines')) {
            const row = await db.table('eventLines').get(text(read.resolvedId ?? read.id))
            if (row && [await hash(row), await storyFingerprint('eventLines', row)].includes(text(read.factFingerprint))) readLines.add(text(row.id))
          }
        }
        let complete = false
        for (;;) {
          await check()
          const state = await windowCoverage(window)
          const pending = state.current.filter(row => !state.covered.has(row.id))
          const lines = await db.table('eventLines').toArray()
          const unreadLines = lines.filter(row => !readLines.has(String(row.id)))
          set(bookId, { nodeTotal: state.current.length, processed: state.covered.size })
          if (!state.current.length || !pending.length && !unreadLines.length) { complete = true; break }
          const kind = pending.some(row => !attempted.has(`node:${row.id}`)) ? 'node' : 'eventLine'
          const batch = selectStoryBatch((kind === 'node' ? pending as unknown as Row[] : unreadLines).filter(row => !attempted.has(`${kind}:${row.id}`)), storyBatchBudget(settings.config.aggregationContextWindow))
          if (!batch.length) break
          for (const row of batch) attempted.add(`${kind}:${row.id}`)
          const taskId = crypto.randomUUID(), operationKey = crypto.randomUUID()
          const workItems = await Promise.all(batch.map(async row => ({ workItemId: `window_link:${windowKey(window)}:${kind}:${encodeURIComponent(text(row.id))}`, kind, id: text(row.id), revision: Number(row.revision), factFingerprint: await storyFingerprint(kind === 'node' ? 'nodes' : 'eventLines', row) })))
          const memory = await db.table('storyEditorMemory').get(sessionId) ?? { id: sessionId, bookId, sessionId, revision: 0, workingSummary: '', dataFingerprint: '', updatedAt: '' }
          const contextHints = await repo.transaction(false, store => buildStoryContext(store, bookId, sessionId, batch, kind))
          const relatedLineIds = contextHints.related.filter(row => row.kind === 'eventLine').map(row => row.id)
          const lineHints = [...lines].sort((a, b) => Number(relatedLineIds.includes(b.id)) - Number(relatedLineIds.includes(a.id))).slice(0, 6).map(lineDigest)
          const input = { bookId, runId, taskId, planVersion: '2.2', remainingCount: pending.length, resume: { reason: existing ? 'continuation' : 'initial', appliedCommitIds: [], nextOperationKey: operationKey, remainingWorkIds: workItems.map(row => row.workItemId) }, stage: 'P3', phase: 'window_link', sessionId, queue: 'window_nodes', window, workItems, existingLines: lineHints, contextHints, memory, afterWorkItemId: null }
          const result = await runtime.run(repo, { profile: 'story_editor', phase: 'window_link', sessionId, runId, taskId, leaseOwner: owner, retainLease: true, workItems, input, requiredLineIds: unreadLines.map(row => String(row.id)), businessPrompt: storyPrompt, prompt: taskTemplate.replace('{taskJson}', JSON.stringify(input)), signal: controller.signal })
          await check()
          if (!result.ok) throw new Error(result.error ?? '窗口串联失败。')
          const task = await repo.transaction(true, async store => {
            const run = (await store.get('pipelineRuns', runId))!
            const task = records(run.tasks).find(row => row.taskId === taskId)!
            await saveStoryCoverage(store, runId, task, result.summary?.reviewedItems as unknown as Row[] ?? [])
            return task
          })
          for (const read of records((task.readSet as Row)?.records).filter(row => row.table === 'eventLines')) readLines.add(text(read.resolvedId ?? read.id))
          const previousLineIds = new Set(lines.map(row => String(row.id)))
          for (const line of await db.table('eventLines').toArray()) if (!previousLineIds.has(String(line.id))) readLines.add(String(line.id))
        }
        if (complete) completedWindows++
        await db.transaction('rw', db.tables, async () => { await check(); await saveCheckpoint(window, complete ? 'completed' : 'failed'); await db.table('compileProgress').update('P3', { lastWindowIndex: windowIndex, updatedAt: new Date().toISOString() }) })
      }
      await db.transaction('rw', db.tables, async () => {
        await check()
        const pendingWindows: string[] = []
        for (const window of windows) {
          const checkpoint = await db.table<StoryCheckpoint>('storyEditorCheckpoints').get(checkpointId(sessionId, planKey, window))
          const nodes = await nodesFor(window)
          if (checkpoint?.status !== 'completed' || ![await Dexie.waitFor(windowFingerprint(window, nodes)), await Dexie.waitFor(hash({ window, nodes }))].includes(checkpoint.sourceFingerprint)) pendingWindows.push(windowKey(window))
        }
        completedWindows = windows.length - pendingWindows.length
        const finalPhase = pendingWindows.length ? 'window_link' : 'window_link_complete'
        await db.table('compileProgress').update('P3', { status: 'paused', phase: finalPhase, validity: pendingWindows.length ? 'stale' : 'current', updatedAt: new Date().toISOString() })
        await db.table('pipelineRuns').update(runId, { status: 'paused', phase: finalPhase, finishedAt: new Date().toISOString(), coverage: { total: windows.length, checked: completedWindows, pendingIds: pendingWindows } })
      })
      set(bookId, { message: completedWindows === windows.length ? '窗口串联完成。' : '本轮串联已保存，剩余项可继续。', processed: states.get(bookId)?.processed ?? 0 })

    } catch (error) {
      const message = controller.signal.aborted ? '整理已取消，已提交的资料和依据保留。' : error instanceof Error ? error.message : '叙事整理失败。'
      set(bookId, { error: message })
      if (acquired) await db.transaction('rw', db.tables, async () => {
        if ((await db.table('pipelineRuns').get('lease:narrative'))?.owner !== owner) return
        const status = controller.signal.aborted ? 'cancelled' : 'paused'
        if (activeWindow) { const previous = await db.table<StoryCheckpoint>('storyEditorCheckpoints').get(checkpointId(sessionId, planKey, activeWindow)); if (previous?.status !== 'completed') await db.table('storyEditorCheckpoints').put({ id: checkpointId(sessionId, planKey, activeWindow), bookId, sessionId, stage: 'P3', phase: 'window_link', scopeIds: (await nodesFor(activeWindow)).map(row => row.id), sourceFingerprint: '', status: controller.signal.aborted ? 'cancelled' : 'failed', memberships: membershipsOf(await nodesFor(activeWindow)), updatedAt: new Date().toISOString(), window: { start: activeWindow.start, end: activeWindow.end } } satisfies StoryCheckpoint) }
        await db.table('compileProgress').update('P3', { status, phase, validity: 'stale', updatedAt: new Date().toISOString() })
        await db.table('pipelineRuns').update(runId, { status, phase, finishedAt: new Date().toISOString() })
      }).catch(() => set(bookId, { error: `${message} 进度保存失败，请检查本地存储。` }))
    } finally {
      clearInterval(timer)
      if (acquired) await db.transaction('rw', db.table('pipelineRuns'), db.table('storySessions'), async () => {
        if ((await db.table('pipelineRuns').get('lease:narrative'))?.owner === owner) await db.table('pipelineRuns').delete('lease:narrative')
        const session = await db.table('storySessions').get(sessionId)
        if (session?.leaseOwner === owner) { const { leaseOwner: _owner, leaseUntil: _until, ...saved } = session; await db.table('storySessions').put(saved) }
      }).catch(() => set(bookId, { error: '执行权释放失败，等待到期后可重试。' }))
      controllers.delete(bookId); set(bookId, { running: false })
    }
  }
  async function read(bookId: string) {
    return createBookAgentRepository(workspace, bookId).transaction(false, async store => {
      const chapters = (await store.rows('chapters') as unknown as Chapter[]).sort((a, b) => a.order - b.order), windows = createStoryWindows(chapters)
      const progress = await store.get('compileProgress', 'P3') as unknown as StoryProgress | undefined
      const run = progress?.runId ? await store.get('pipelineRuns', progress.runId) : undefined
      const checkpoints = (await store.rows('storyEditorCheckpoints') as unknown as StoryCheckpoint[]).filter(row => row.phase === 'window_link' && row.sessionId === progress?.editorSessionId && windows.some(window => row.id === checkpointId(progress.editorSessionId, progress.planKey, window)))
      const nodes = await store.rows('nodes'), lines = await store.rows('eventLines')
      for (const checkpoint of checkpoints) {
        const window = windows.find(window => window.start === checkpoint.window.start && window.end === checkpoint.window.end)!
        const current = windowNodes(window, chapters, nodes as unknown as EventNode[])
        if (checkpoint.status === 'completed' && ![await store.wait(windowFingerprint(window, current)), await store.wait(hash({ window, nodes: current }))].includes(checkpoint.sourceFingerprint)) checkpoint.status = 'failed'
      }
      const leases = await store.rows('pipelineRuns')
      const covered = coverage(chapters, await store.rows('extractionReceipts') as unknown as Receipt[]).allCovered
      const locked = leases.some(row => row.recordType === 'lease' && ['narrative', 'extraction'].includes(String(row.lockKey)) && (typeof row.expiresAt !== 'number' || row.expiresAt > Date.now()))
      const leaseExpiry = leases.filter(row => row.recordType === 'lease' && ['narrative', 'extraction'].includes(String(row.lockKey)) && typeof row.expiresAt === 'number' && row.expiresAt > Date.now()).reduce<number | undefined>((expiry, row) => Math.min(expiry ?? Infinity, Number(row.expiresAt)), undefined)
      const entries = progress?.editorSessionId ? (await store.rows('storySessionEntries')).filter(row => row.sessionId === progress.editorSessionId).sort((a, b) => Number(a.ordinal) - Number(b.ordinal)) : []
      const compact = entries.findLast(row => row.type === 'compaction')
      const review = run ? await reviewQueue(store, progress!.runId, progress!.editorSessionId) : undefined
      const memory = progress?.editorSessionId ? await store.get('storyEditorMemory', progress.editorSessionId) : undefined
      return { progress, windows, covered, locked, leaseExpiry, checkpoints, completed: checkpoints.filter(row => row.status === 'completed').length, tasks: evidenceEntries((run?.tasks as Row[] | undefined) ?? [], nodes, lines), usage: run?.usage as { totalTokens: number; cost: number; costStatus?: string } | undefined, commits: (run?.appliedCommands as Row[] | undefined) ?? [], memory, notes: review?.items.filter(row => row.queue === 'review_notes').map(row => row.row) ?? [], session: { id: progress?.editorSessionId, entryCount: entries.length, compactions: entries.filter(row => row.type === 'compaction').length, compact }, review: { total: review?.items.length ?? 0, pending: review?.pending.length ?? 0, conclusions: review?.coverage ?? [] } }
    })
  }
  async function history(bookId: string, offset = 0) {
    const db = workspace.openBook(bookId)
    const sessions = await db.table('storySessions').toArray()
    const session = sessions.find(row => row.profile === 'story_editor' && row.status === 'active')
    const entries = session ? await db.table<Row>('storySessionEntries').where('sessionId').equals(session.id).sortBy('ordinal') : []
    return { sessionId: session?.id as string | undefined, total: entries.length, entries: entries.slice(offset, offset + 20) }
  }
  return { start: (bookId: string) => start(bookId), review: (bookId: string) => start(bookId, 'global_review'), read, history, state: (bookId: string) => states.get(bookId), cancel: (bookId: string) => controllers.get(bookId)?.abort(), subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } } }
}
export type StoryService = ReturnType<typeof createStoryService>
