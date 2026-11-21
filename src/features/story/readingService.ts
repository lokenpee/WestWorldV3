import { briefItems } from './views'
import { storyPagePrompt } from './readingPresentation'
import { readReadingStatus } from './readingStatus'
import { inheritedReadingChecks } from './reuse'
import type { RestartMode } from '../world/reuse'
import type { createWorkspace } from '../../lib/storage/workspace'
import type { ModelService } from '../models/service'
import type { createWindowStoryService } from './service'
import { createBookAgentRepository, type Row, type AgentStore } from '../agents/repository'
import { createAgentRuntime } from '../agents/runtime'
import { resolveSession } from '../agents/sessions'
import { records, text } from '../agents/contracts'
import { coverage, type Receipt } from '../extraction/recovery'
import { checked, readingBrief, readingProgress, refreshReading, saveReading, scheduleQuickPages, type ReadingState } from './reading'
import { createReviewSession, restartLinkingSession } from './linkingRestart'
import storyPrompt from '../../../docs/v2/resources/v2.2/prompts/active/p3-story.md?raw'
import reviewPrompt from '../../../docs/v2/resources/v2.2/prompts/active/p3-review.md?raw'
import outlineStoryPrompt from '../../../docs/v2/resources/v2.2/prompts/active/p3-outline-story.md?raw'
import outlineReviewPrompt from '../../../docs/v2/resources/v2.2/prompts/active/p3-outline-review.md?raw'
import quickStoryPrompt from '../../../docs/v2/resources/v2.2/prompts/active/p3-quick-check.md?raw'
import type { SessionStatus } from '../agents/compaction'
import { storageChanged } from '../local-storage/client'

type Legacy = ReturnType<typeof createWindowStoryService>
type LinkingMode = RestartMode | 'replace' | 'quick'
type StopAction = 'pause' | 'cancel'
type Control = { controller: AbortController; phase: 'window_link' | 'global_review'; stop?: StopAction }
type State = NonNullable<ReturnType<Legacy['state']>> & { runId?: string; stopping?: StopAction }
export function createReadingStoryService(workspace: ReturnType<typeof createWorkspace>, models: Pick<ModelService, 'agent' | 'settings' | 'generate'>, legacy: Legacy) {
  const states = new Map<string, State>(), controls = new Map<string, Control>(), listeners = new Set<() => void>()
  const set = (bookId: string, change: Partial<State>) => { states.set(bookId, { ...(states.get(bookId) ?? { running: false, window: 0, total: 0, processed: 0, nodeTotal: 0 }), ...change }); listeners.forEach(listener => listener()) }
  const publish = (bookId: string, tables: string[]) => {
    if (!workspace.disk) storageChanged({ targets: tables.map(table => ({ scope: `book:${bookId}`, table, category: 'business' })) })
  }
  async function start(bookId: string, phase: 'window_link' | 'global_review' = 'window_link', restart?: LinkingMode) {
    if (controls.has(bookId)) return
    const controller = new AbortController(), control: Control = { controller, phase }
    controls.set(bookId, control)
    set(bookId, { running: true, phase, stopping: undefined, runId: undefined, error: undefined, message: undefined, sessionStatus: undefined })
    const repo = createBookAgentRepository(workspace, bookId), owner = crypto.randomUUID()
    let runId = '', sessionId = '', acquired = false, outline = false, timer: ReturnType<typeof setInterval> | undefined, heartbeatError = ''
    const check = async (store: AgentStore) => {
      controller.signal.throwIfAborted()
      const lease = await store.get('pipelineRuns', 'lease:narrative'), session = await store.get('storySessions', sessionId)
      if (lease?.owner !== owner || lease.runId !== runId || Number(lease.expiresAt) <= Date.now() || session?.leaseOwner !== owner || Number(session.leaseUntil) <= Date.now()) throw new Error('本书叙事执行权已变化，进度保留。')
    }
    try {
      if (!await workspace.settings.books.get(bookId)) throw new Error('书籍不存在。')
      const settings = await models.settings.read()
      if (!settings.configured || !settings.config.aggregationModel) throw new Error('请先保存整理模型与密钥。')
      controller.signal.throwIfAborted()
      let state = await repo.transaction(true, async store => {
        controller.signal.throwIfAborted()
        const chapters = await store.rows('chapters')
        if (!chapters.length) throw new Error('请先导入章节。')
        if (!coverage(chapters as never, await store.rows('extractionReceipts') as unknown as Receipt[]).allCovered) throw new Error('请先完成全书逐章提取。')
        if ((await store.rows('pipelineRuns')).some(row => row.recordType === 'lease' && ['world', 'narrative', 'extraction', 'extraction:worldAssets', 'extraction:narrativeAssets'].includes(text(row.lockKey)) && Number(row.expiresAt ?? Infinity) > Date.now())) throw new Error('本书已有叙事、世界或提取任务，请等待其结束。')
        const progress = await store.get('compileProgress', 'P3')
        const activeSession = await resolveSession(store, bookId, text(progress?.editorSessionId) || undefined)
        const currentSession = activeSession.kind === 'review' && activeSession.parentSessionId
          ? await resolveSession(store, bookId, text(activeSession.parentSessionId)) : activeSession
        if (currentSession.leaseOwner && Number(currentSession.leaseUntil) > Date.now()) throw new Error('本书会话正在其他窗口运行。')
        const old = progress?.runId ? await store.get('pipelineRuns', text(progress.runId)) : undefined
        const reviewing = phase === 'global_review'
        const previousReview = (old?.storyReading as Record<string, ReadingState> | undefined)?.global_review
        const resumeReview = reviewing && !restart && activeSession.kind === 'review' && previousReview?.independent
        const newReview = reviewing && !resumeReview
        const reusedChecks = !reviewing && restart === 'reuse' ? await inheritedReadingChecks(store, phase, id => refreshReading(store, id, currentSession.id, phase), true) : []
        const previousLinking = old && (newReview || restart === 'quick') ? await refreshReading(store, text(old.id), currentSession.id, 'window_link') : undefined
        runId = !restart && !newReview && old?.stage === 'P3' ? text(old.id) : crypto.randomUUID()
        let session = currentSession
        if (newReview) session = await createReviewSession(store, bookId, runId, currentSession, activeSession)
        else if (resumeReview) session = activeSession
        else if (restart === 'replace' || restart === 'quick' || activeSession.kind === 'review') {
          session = await restartLinkingSession(store, bookId, runId, currentSession, restart !== 'replace', activeSession.id)
        }
        sessionId = session.id
        outline = reviewing || old?.id !== runId || old.storyOutlineVersion === 1
        const now = new Date().toISOString()
        await store.put('pipelineRuns', { ...(old?.id === runId ? old : { id: runId, bookId, recordType: 'run', stage: 'P3', startedAt: now, planVersion: '2.2', scope: 'fullBook', tasks: [], commandIntents: [], appliedCommands: [], coverageItems: [], aiMode: 'agent' }), ...(outline ? { storyOutlineVersion: 1 } : {}), status: 'running', phase })
        if (newReview) {
          const last = restart === 'reuse' && previousReview?.independent ? previousReview : undefined
          await saveReading(store, runId, phase, { independent: true, pages: last?.pages ?? [], currentPageId: null, receipts: [], decisions: last?.decisions ?? {}, questions: last?.questions ?? {} })
        } else if (restart) await saveReading(store, runId, phase, { pages: [], currentPageId: null, receipts: [], reusedChecks })
        if (previousLinking && phase === 'global_review') await saveReading(store, runId, 'window_link', previousLinking)
        const linked = await refreshReading(store, runId, sessionId, 'window_link')
        if (restart === 'quick' && previousLinking) await scheduleQuickPages(store, linked, previousLinking)
        if (reviewing && !previousReview && progress?.phase !== 'global_review' && !readingProgress(linked).complete) throw new Error('请先完成当前资料的节点阅读与串联。')
        await saveReading(store, runId, 'window_link', linked)
        const reading = phase === 'window_link' ? linked : await refreshReading(store, runId, sessionId, phase)
        if (!readingProgress(reading).complete && !reading.pages.some(page => page.id === reading.currentPageId && page.fingerprint !== page.checkedFingerprint)) reading.currentPageId = reading.pages.find(page => page.fingerprint !== page.checkedFingerprint)?.id ?? null
        await saveReading(store, runId, phase, reading)
        await store.put('pipelineRuns', { id: 'lease:narrative', bookId, recordType: 'lease', lockKey: 'narrative', runId, owner, expiresAt: Date.now() + 30000 })
        await store.put('storySessions', { ...session, leaseOwner: owner, leaseUntil: Date.now() + 30000 })
        await store.put('compileProgress', { bookId, stage: 'P3', status: 'running', phase, runId, editorSessionId: sessionId, planKey: 'story-pages-v3', totalChapters: chapters.length, completedChapters: [], failedChapters: [], updatedAt: now, scope: 'fullBook', planVersion: '2.2', unit: 'item', validity: 'current' })
        return reading
      }); acquired = true
      set(bookId, { runId }); publish(bookId, ['compileProgress', 'pipelineRuns', 'storySessions', 'nodes', 'eventLines', 'storyEvents', 'storyEditorNotes', 'assetLifecycle'])
      let heartbeatFailures = 0
      timer = setInterval(() => { void repo.transaction(true, async store => {
        await check(store)
        const lease = (await store.get('pipelineRuns', 'lease:narrative'))!, session = (await store.get('storySessions', sessionId))!
        await store.put('pipelineRuns', { ...lease, expiresAt: Date.now() + 30000 }); await store.put('storySessions', { ...session, leaseUntil: Date.now() + 30000 })
      }).then(() => { heartbeatFailures = 0 }).catch(error => { if (++heartbeatFailures >= 3) { heartbeatError = error instanceof Error ? error.message : '执行权续期失败'; controller.abort() } }) }, 8000)
      const runtime = createAgentRuntime(models.agent, { generate: models.generate, onStatus: (sessionStatus: SessionStatus) => set(bookId, { sessionStatus }) })
      while (!control.stop && !readingProgress(state).complete) {
        const pendingQuick = state.pages.filter(page => page.quickCheck && !checked(page))
        const quick = pendingQuick.length > 0
        if (quick && !pendingQuick.some(page => page.id === state.currentPageId)) {
          state.currentPageId = pendingQuick[0].id
          await repo.transaction(true, async store => { await check(store); await saveReading(store, runId, phase, state) })
        }
        const taskId = crypto.randomUUID()
        const { brief, memory, count } = await repo.transaction(false, async store => ({ brief: await readingBrief(store, bookId, sessionId, phase, state, outline, quick), memory: await store.get('storyEditorMemory', sessionId) ?? { id: sessionId, sessionId, bookId, revision: 0, workingSummary: '', dataFingerprint: '', updatedAt: '' }, count: (await store.rows('chapters')).length }))
        const input = { bookId, runId, taskId, planVersion: '2.2', remainingCount: state.pages.filter(page => page.fingerprint !== page.checkedFingerprint).length, resume: { reason: 'continuation', appliedCommitIds: [], nextOperationKey: crypto.randomUUID(), remainingWorkIds: [] }, stage: 'P3', phase, sessionId, queue: text(brief?.queue) || 'window_nodes', window: phase === 'window_link' ? { start: 0, end: count, chapterIndices: [] } : null, workItems: [], existingLines: [], memory, afterWorkItemId: null }
        const businessPrompt = quick ? quickStoryPrompt : outline ? (phase === 'global_review' ? outlineReviewPrompt : outlineStoryPrompt) : (phase === 'global_review' ? reviewPrompt : storyPrompt)
        const result = await runtime.run(repo, { profile: 'story_editor', workflow: 'story_pages_v3', outline, quickStoryCheck: quick, phase, sessionId, runId, taskId, leaseOwner: owner, retainLease: true, workItems: [], providedStoryItems: briefItems(brief), input, businessPrompt, prompt: storyPagePrompt(brief), signal: controller.signal, shouldPause: () => control.stop === 'pause', afterCommit: async () => publish(bookId, ['pipelineRuns', 'nodes', 'eventLines', 'storyEvents', 'storyEditorNotes', 'storyEditorMemory']) })
        if (control.stop === 'pause') break
        if (result.itemFailure || !result.ok) throw new Error(result.itemFailure ?? result.error ?? '本轮阅读未完成，进度已保留。')
        if (!quick || result.summary?.status !== 'completed') break
        state = await repo.transaction(false, store => refreshReading(store, runId, sessionId, phase))
      }
      state = await repo.transaction(true, async store => {
        await check(store)
        const current = await refreshReading(store, runId, sessionId, phase)
        await saveReading(store, runId, phase, current)
        const complete = readingProgress(current).complete, now = new Date().toISOString(), finalPhase = complete && phase === 'window_link' ? 'window_link_complete' : phase
        const run = (await store.get('pipelineRuns', runId))!, progress = (await store.get('compileProgress', 'P3'))!
        await store.put('pipelineRuns', { ...run, status: complete ? 'completed' : 'paused', phase: finalPhase, finishedAt: now })
        await store.put('compileProgress', { ...progress, status: complete ? 'completed' : 'paused', phase: finalPhase, validity: complete ? 'current' : 'stale', updatedAt: now })
        return current
      })
      set(bookId, { message: readingProgress(state).complete ? phase === 'window_link' ? '串联完成，可继续全书复核。' : '全书复核完成，已记录的疑点保留。' : control.stop === 'pause' ? (phase === 'global_review' ? '复核已暂停，可继续本轮。' : '串联已暂停，可继续本轮。') : '本轮成果已保存，当前页可继续。' })
    } catch (error) {
      set(bookId, { error: heartbeatError || (controller.signal.aborted ? '整理已取消，已保存成果和当前页保留。' : error instanceof Error ? error.message : '阅读暂停。') })
      if (acquired) await repo.transaction(true, async store => {
        if ((await store.get('pipelineRuns', 'lease:narrative'))?.owner !== owner) return
        const run = (await store.get('pipelineRuns', runId))!, progress = (await store.get('compileProgress', 'P3'))!
        const status = controller.signal.aborted && !heartbeatError ? 'cancelled' : 'paused'
        await store.put('pipelineRuns', { ...run, status, finishedAt: new Date().toISOString() })
        await store.put('compileProgress', { ...progress, status, validity: 'stale' })
      }).catch(() => set(bookId, { error: '进度保存失败，请检查本地存储。' }))
    } finally {
      clearInterval(timer)
      if (acquired) await repo.transaction(true, async store => {
        if ((await store.get('pipelineRuns', 'lease:narrative'))?.owner === owner) await store.remove('pipelineRuns', 'lease:narrative')
        const session = await store.get('storySessions', sessionId)
        if (session?.leaseOwner === owner) { const { leaseOwner: _owner, leaseUntil: _until, ...rest } = session; await store.put('storySessions', rest) }
      }).catch(() => set(bookId, { error: '执行权释放失败，请稍后继续。' }))
      controls.delete(bookId); set(bookId, { running: false, stopping: undefined })
      if (acquired) publish(bookId, ['compileProgress', 'pipelineRuns', 'storySessions', 'nodes', 'eventLines', 'storyEvents'])
    }
  }
  async function read(bookId: string) {
    const current = await readReadingStatus(workspace, bookId)
    if (current) return current
    const value = await legacy.read(bookId)
    if (!value.progress?.runId) return { ...value, activityTasks: [] as Row[], reading: undefined as ReturnType<typeof readingProgress> & { pages: Row[]; lineTitle: string; eventTitle: string } | undefined }
    return createBookAgentRepository(workspace, bookId).transaction(false, async store => {
      const run = await store.get('pipelineRuns', value.progress!.runId)
      const phase = value.progress!.phase === 'global_review' ? 'global_review' : 'window_link'
      const activityTasks = records(run?.tasks).filter(task => task.phase === phase).map(task => ({ taskId: task.taskId, stepsUsed: task.stepsUsed, lastError: task.lastError, status: task.status }))
      if (!(run?.storyReading as Row | undefined)?.[phase]) return { ...value, activityTasks, reading: undefined }
      const current = await refreshReading(store, value.progress!.runId, value.progress!.editorSessionId, phase), progress = readingProgress(current)
      const line = progress.lineId ? await store.get('eventLines', progress.lineId) : undefined
        const event = progress.eventId ? await store.get('storyEvents', progress.eventId) : undefined
        const reading = { ...progress, pages: current.pages.map(page => ({ id: page.id, type: page.type, reason: page.reason, checked: page.checkedFingerprint === page.fingerprint })), lineTitle: text(line?.title), eventTitle: text(event?.title) }
      return { ...value, activityTasks, reading, completed: progress.checked, review: phase === 'global_review' ? { ...value.review, total: progress.totalPages, pending: progress.totalPages - progress.checked } : value.review }
    })
  }
  function pause(bookId: string) {
    const control = controls.get(bookId)
    if (!control || control.stop) return
    control.stop = 'pause'
    set(bookId, { stopping: 'pause' })
  }
  async function cancel(bookId: string) {
    const control = controls.get(bookId)
    if (control) {
      control.stop = 'cancel'
      set(bookId, { stopping: 'cancel' })
      control.controller.abort()
      return
    }
    if (states.get(bookId)?.stopping === 'cancel') return
    set(bookId, { stopping: 'cancel' })
    const repo = createBookAgentRepository(workspace, bookId)
    await repo.transaction(true, async store => {
      const progress = await store.get('compileProgress', 'P3')
      if (progress?.status !== 'paused' || progress.phase !== 'window_link') return
      const run = await store.get('pipelineRuns', text(progress.runId))
      const lease = await store.get('pipelineRuns', 'lease:narrative')
      if (!run || lease && Number(lease.expiresAt) > Date.now()) return
      const now = new Date().toISOString()
      await store.put('pipelineRuns', { ...run, status: 'cancelled', finishedAt: now })
      await store.put('compileProgress', { ...progress, status: 'cancelled', updatedAt: now })
    }).catch(error => set(bookId, { error: error instanceof Error ? error.message : '暂停任务取消失败。' }))
    publish(bookId, ['compileProgress', 'pipelineRuns'])
    set(bookId, { stopping: undefined })
  }
  return { ...legacy, start: (bookId: string, restart?: LinkingMode) => start(bookId, 'window_link', restart), review: (bookId: string, restart?: RestartMode) => start(bookId, 'global_review', restart), read, state: (bookId: string) => states.get(bookId), pause, cancel, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } } }
}
