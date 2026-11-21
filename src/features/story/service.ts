import { transact } from '../../lib/storage/transaction'
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
import { hash, records, text } from '../agents/contracts'
import { buildStoryContext, lineDigest, selectStoryBatch, storyBatchBudget } from './retrieval'
import type { SessionStatus } from '../agents/compaction'
import { readBookTrace } from '../agents/trace'
import type { StoryExecutionPhase } from '../agents/executionPagingTypes'
import { readStoryExecution } from './execution'
import { isObservationEntry } from '../agents/context'
import storyPrompt from '../../../docs/v2/resources/v2.2/prompts/active/p3-story.md?raw'
import { storyTaskPrompt } from './prompt'
import { leaseFailureKind } from '../world/leaseHeartbeat'
import { createReadingStoryService } from './readingService'

type Workspace = ReturnType<typeof createWorkspace>
interface StoryState { running: boolean; window: number; total: number; processed: number; nodeTotal: number; error?: string; message?: string; phase?: string; queue?: string; sessionStatus?: SessionStatus }
export function createWindowStoryService(workspace: Workspace, models: Pick<ModelService, 'agent' | 'settings' | 'generate'>) {
  const states = new Map<string, StoryState>(), controllers = new Map<string, AbortController>(), listeners = new Set<() => void>()
  const cancelled = new Set<string>()
  const set = (bookId: string, changes: Partial<StoryState>) => { states.set(bookId, { ...(states.get(bookId) ?? { running: false, window: 0, total: 0, processed: 0, nodeTotal: 0 }), ...changes }); listeners.forEach(listener => listener()) }
  async function start(bookId: string, phase: 'window_link' | 'global_review' = 'window_link') {
    if (controllers.has(bookId)) return
    const controller = new AbortController(); controllers.set(bookId, controller); cancelled.delete(bookId)
    const db = workspace.openBook(bookId), repo = createBookAgentRepository(workspace, bookId)
    let runId: string = crypto.randomUUID(), sessionId = '', planKey = ''
    const owner = crypto.randomUUID(); let acquired = false; let recheck = false; let timer: ReturnType<typeof setInterval> | undefined
    let heartbeatFailure = ''
    let chapters: Chapter[] = [], windows: StoryWindow[] = [], activeWindow: StoryWindow | undefined
    set(bookId, { running: true, phase, window: 0, total: 0, processed: 0, nodeTotal: 0, error: undefined, message: undefined, sessionStatus: undefined })
    const check = async (scopeDb = db) => {
      controller.signal.throwIfAborted()
      const lease = await scopeDb.table('pipelineRuns').get('lease:narrative')
      const session = await scopeDb.table('storySessions').get(sessionId)
      if (lease?.owner !== owner || lease.runId !== runId || lease.expiresAt <= Date.now() || session?.leaseOwner !== owner || session.leaseUntil <= Date.now()) throw new Error('本书叙事任务的执行权已失效。')
    }
    const nodesFor = async (window: StoryWindow, scopeDb = db) => windowNodes(window, chapters, await scopeDb.table<EventNode>('nodes').toArray())
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
        if (leases.some(row => row.recordType === 'lease' && ['extraction', 'extraction:worldAssets', 'extraction:narrativeAssets', 'narrative', 'world'].includes(text(row.lockKey)) && Number(row.expiresAt ?? Infinity) > Date.now())) throw new Error('本书已有叙事、世界或提取任务，请等待其结束。')
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
      let heartbeatFailures = 0
      timer = setInterval(() => { void repo.transaction(true, async store => {
        const lease = await store.get('pipelineRuns', 'lease:narrative'); const session = await store.get('storySessions', sessionId)
        if (lease?.owner !== owner || session?.leaseOwner !== owner) throw new Error('叙事执行权已变化。')
        await store.put('pipelineRuns', { ...lease, expiresAt: Date.now() + 30000 }); await store.put('storySessions', { ...session, leaseUntil: Date.now() + 30000 })
      }).then(() => { heartbeatFailures = 0 }).catch(error => {
        const message = error instanceof Error ? error.message : '叙事执行权续租失败。'
        if (leaseFailureKind(error) === 'lost' || ++heartbeatFailures >= 3) { heartbeatFailure = message; controller.abort() }
      }) }, 8000)
      await repo.transaction(true, store => recoverStoryCoverage(store, runId))
      if (phase === 'global_review') {
        const completed = await runGlobalReview(repo, runtime, { runId, sessionId, owner, signal: controller.signal, check, contextWindow: settings.config.aggregationContextWindow, onProgress: (processed, nodeTotal, queue) => set(bookId, { processed, nodeTotal, queue }) })
        if (completed) await transact(db, 'rw', [db.tables], async (db) => {
          await check(db)
          for (const window of windows) {
            const id = checkpointId(sessionId, planKey, window)
            const checkpoint = await db.table<StoryCheckpoint>('storyEditorCheckpoints').get(id)
            const nodes = await nodesFor(window, db)
            if (checkpoint) await db.table('storyEditorCheckpoints').put({ ...checkpoint, scopeIds: nodes.map(row => row.id), sourceFingerprint: await Dexie.waitFor(windowFingerprint(window, nodes)), memberships: membershipsOf(nodes), updatedAt: new Date().toISOString() })
          }
        })
        set(bookId, { message: completed ? '全书复核完成。' : '本轮复核已保存，剩余项可继续。' })
        return
      }
      const saveCheckpoint = async (window: StoryWindow, status: StoryCheckpoint['status'], scopeDb = db) => {
        const nodes = await nodesFor(window, scopeDb)
        const sourceFingerprint = await Dexie.waitFor(windowFingerprint(window, nodes))
        await scopeDb.table('storyEditorCheckpoints').put({ id: checkpointId(sessionId, planKey, window), bookId, sessionId, stage: 'P3', phase: 'window_link', scopeIds: nodes.map(row => row.id), sourceFingerprint, status, memberships: membershipsOf(nodes), updatedAt: new Date().toISOString(), window: { start: window.start, end: window.end } } satisfies StoryCheckpoint)
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
        const attempted = new Set<string>()
        let complete = false
        for (;;) {
          await check()
          const state = await windowCoverage(window)
          const pending = state.current.filter(row => !state.covered.has(row.id))
          const lines = await db.table('eventLines').toArray()
          set(bookId, { nodeTotal: state.current.length, processed: state.covered.size })
          if (!pending.length) { complete = true; break }
          const kind = 'node'
          const batch = selectStoryBatch((pending as unknown as Row[]).filter(row => !attempted.has(`${kind}:${row.id}`)), storyBatchBudget(settings.config.aggregationContextWindow))
          if (!batch.length) break
          for (const row of batch) attempted.add(`${kind}:${row.id}`)
          const taskId = crypto.randomUUID(), operationKey = crypto.randomUUID()
          const workItems = await Promise.all(batch.map(async row => ({ workItemId: `window_link:${windowKey(window)}:${kind}:${encodeURIComponent(text(row.id))}`, kind, id: text(row.id), revision: Number(row.revision), factFingerprint: await storyFingerprint(kind === 'node' ? 'nodes' : 'eventLines', row) })))
          const memory = await db.table('storyEditorMemory').get(sessionId) ?? { id: sessionId, bookId, sessionId, revision: 0, workingSummary: '', dataFingerprint: '', updatedAt: '' }
          const contextHints = await repo.transaction(false, store => buildStoryContext(store, bookId, sessionId, batch, kind))
          const relatedLineIds = contextHints.related.filter(row => row.kind === 'eventLine').map(row => row.id)
          const lineHints = lines.filter(line => relatedLineIds.includes(line.id)).slice(0, 6).map(lineDigest)
          const input = { bookId, runId, taskId, planVersion: '2.2', remainingCount: pending.length, resume: { reason: existing ? 'continuation' : 'initial', appliedCommitIds: [], nextOperationKey: operationKey, remainingWorkIds: workItems.map(row => row.workItemId) }, stage: 'P3', phase: 'window_link', sessionId, queue: 'window_nodes', window, workItems, existingLines: lineHints, contextHints, memory, afterWorkItemId: null }
          const result = await runtime.run(repo, { profile: 'story_editor', workflow: 'story_lines_v2', phase: 'window_link', sessionId, runId, taskId, leaseOwner: owner, retainLease: true, workItems, input, businessPrompt: storyPrompt, prompt: storyTaskPrompt(input), signal: controller.signal })
          await check()
          if (!result.ok) throw new Error(result.error ?? '窗口串联失败。')
          await repo.transaction(true, async store => {
            const run = (await store.get('pipelineRuns', runId))!
            const task = records(run.tasks).find(row => row.taskId === taskId)!
            await saveStoryCoverage(store, runId, task, result.summary?.reviewedItems as unknown as Row[] ?? [])
            return task
          })
        }
        if (complete) completedWindows++
        await transact(db, 'rw', [db.tables], async (db) => { await check(db); await saveCheckpoint(window, complete ? 'completed' : 'failed', db); await db.table('compileProgress').update('P3', { lastWindowIndex: windowIndex, updatedAt: new Date().toISOString() }) })
      }
      await transact(db, 'rw', [db.tables], async (db) => {
        await check(db)
        const pendingWindows: string[] = []
        for (const window of windows) {
          const checkpoint = await db.table<StoryCheckpoint>('storyEditorCheckpoints').get(checkpointId(sessionId, planKey, window))
          const nodes = await nodesFor(window, db)
          if (checkpoint?.status !== 'completed' || ![await Dexie.waitFor(windowFingerprint(window, nodes)), await Dexie.waitFor(hash({ window, nodes }))].includes(checkpoint.sourceFingerprint)) pendingWindows.push(windowKey(window))
        }
        completedWindows = windows.length - pendingWindows.length
        const finalPhase = pendingWindows.length ? 'window_link' : 'window_link_complete'
        await db.table('compileProgress').update('P3', { status: 'paused', phase: finalPhase, validity: pendingWindows.length ? 'stale' : 'current', updatedAt: new Date().toISOString() })
        await db.table('pipelineRuns').update(runId, { status: 'paused', phase: finalPhase, finishedAt: new Date().toISOString(), coverage: { total: windows.length, checked: completedWindows, pendingIds: pendingWindows } })
      })
      set(bookId, { message: completedWindows === windows.length ? '窗口串联完成。' : '本轮串联已保存，剩余项可继续。', processed: states.get(bookId)?.processed ?? 0 })

    } catch (error) {
      const detail = error instanceof Error ? error.message : '叙事整理失败。'
      if (!heartbeatFailure && /执行权|租约|会话/.test(detail) && !cancelled.has(bookId)) heartbeatFailure = detail
      const message = heartbeatFailure ? `整理已暂停：${heartbeatFailure}` : cancelled.has(bookId) ? '整理已取消，已提交的资料和依据保留。' : detail
      set(bookId, { error: message })
      if (acquired) await transact(db, 'rw', [db.tables], async (db) => {
        if ((await db.table('pipelineRuns').get('lease:narrative'))?.owner !== owner) return
        const status = cancelled.has(bookId) ? 'cancelled' : 'paused'
        if (activeWindow) { const previous = await db.table<StoryCheckpoint>('storyEditorCheckpoints').get(checkpointId(sessionId, planKey, activeWindow)); if (previous?.status !== 'completed') await db.table('storyEditorCheckpoints').put({ id: checkpointId(sessionId, planKey, activeWindow), bookId, sessionId, stage: 'P3', phase: 'window_link', scopeIds: (await nodesFor(activeWindow, db)).map(row => row.id), sourceFingerprint: '', status: status === 'cancelled' ? 'cancelled' : 'failed', memberships: membershipsOf(await nodesFor(activeWindow, db)), updatedAt: new Date().toISOString(), window: { start: activeWindow.start, end: activeWindow.end } } satisfies StoryCheckpoint) }
        await db.table('compileProgress').update('P3', { status, phase, validity: 'stale', updatedAt: new Date().toISOString() })
        await db.table('pipelineRuns').update(runId, { status, phase, finishedAt: new Date().toISOString() })
      }).catch(() => set(bookId, { error: `${message} 进度保存失败，请检查本地存储。` }))
    } finally {
      clearInterval(timer)
      if (acquired) await transact(db, 'rw', [db.table('pipelineRuns'), db.table('storySessions')], async (db) => {
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
      const leaseIds = ['lease:narrative', 'lease:world', 'lease:extraction', 'lease:extraction:worldAssets', 'lease:extraction:narrativeAssets']
      const leases = (await Promise.all(leaseIds.map(id => store.get('pipelineRuns', id)))).filter((row): row is Row => !!row)
      const covered = coverage(chapters, await store.rows('extractionReceipts') as unknown as Receipt[]).allCovered
      const locked = leases.some(row => row.recordType === 'lease' && ['narrative', 'world', 'extraction', 'extraction:worldAssets', 'extraction:narrativeAssets'].includes(String(row.lockKey)) && (typeof row.expiresAt !== 'number' || row.expiresAt > Date.now()))
      const leaseExpiry = leases.filter(row => row.recordType === 'lease' && ['narrative', 'world', 'extraction', 'extraction:worldAssets', 'extraction:narrativeAssets'].includes(String(row.lockKey)) && typeof row.expiresAt === 'number' && row.expiresAt > Date.now()).reduce<number | undefined>((expiry, row) => Math.min(expiry ?? Infinity, Number(row.expiresAt)), undefined)
      const entries = progress?.editorSessionId ? (await store.rows('storySessionEntries')).filter(row => row.sessionId === progress.editorSessionId).sort((a, b) => Number(a.ordinal) - Number(b.ordinal)) : []
      const compact = entries.findLast(row => row.type === 'compaction')
      const review = run ? await reviewQueue(store, progress!.runId, progress!.editorSessionId) : undefined
      const memory = progress?.editorSessionId ? await store.get('storyEditorMemory', progress.editorSessionId) : undefined
      return { progress, windows, covered, locked, leaseExpiry, checkpoints, completed: checkpoints.filter(row => row.status === 'completed').length, tasks: evidenceEntries((run?.tasks as Row[] | undefined) ?? [], nodes, lines), usage: run?.usage as { totalTokens: number; cost: number; costStatus?: string } | undefined, requestLedger: (run?.requestLedger as Row[] | undefined) ?? [], runStatus: run?.status as string | undefined, runStartedAt: run?.startedAt as string | undefined, commits: (run?.appliedCommands as Row[] | undefined) ?? [], assetEdits: records(run?.assetEdits), memory, notes: review?.items.filter(row => row.queue === 'review_notes').map(row => row.row) ?? [], session: { id: progress?.editorSessionId, entryCount: entries.length, compactions: entries.filter(row => row.type === 'compaction').length, compact }, review: { total: review?.items.length ?? 0, pending: review?.pending.length ?? 0, conclusions: review?.coverage ?? [] } }
    })
  }
  async function history(bookId: string, offset = 0, selectedId?: string) {
    const db = workspace.openBook(bookId)
    const sessions = await db.table('storySessions').toArray()
    const choices = sessions.filter(row => row.profile === 'story_editor').sort((a, b) => text(b.createdAt).localeCompare(text(a.createdAt)))
    const progress = await db.table('compileProgress').get('P3')
    const session = choices.find(row => row.id === (selectedId || progress?.editorSessionId)) ?? choices[0]
    const entries = session ? await db.table<Row>('storySessionEntries').where('sessionId').equals(session.id).sortBy('ordinal').then(rows => rows.filter(row => !isObservationEntry(row))) : []
    return { sessions: choices.map(row => ({ id: text(row.id), label: row.kind === 'review' ? '全书复核' : '事件串联／历史会话' })), sessionId: session?.id as string | undefined, total: entries.length, entries: entries.slice(offset, offset + 20) }
  }
  return { start: (bookId: string) => start(bookId), review: (bookId: string) => start(bookId, 'global_review'), read, history, trace: (bookId: string, runId?: string) => readBookTrace(workspace, bookId, runId), execution: (bookId: string, phase: StoryExecutionPhase) => readStoryExecution(workspace, bookId, phase), state: (bookId: string) => states.get(bookId), cancel: (bookId: string) => { cancelled.add(bookId); controllers.get(bookId)?.abort() }, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } } }
}
export function createStoryService(workspace: Workspace, models: Pick<ModelService, 'agent' | 'settings' | 'generate'>) {
  return createReadingStoryService(workspace, models, createWindowStoryService(workspace, models))
}
export type StoryService = ReturnType<typeof createStoryService>
