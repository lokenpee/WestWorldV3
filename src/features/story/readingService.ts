import type { createWorkspace } from '../../lib/storage/workspace'
import type { ModelService } from '../models/service'
import type { createWindowStoryService } from './service'
import { createBookAgentRepository, type Row, type AgentStore } from '../agents/repository'
import { createAgentRuntime } from '../agents/runtime'
import { resolveSession } from '../agents/sessions'
import { text } from '../agents/contracts'
import { coverage, type Receipt } from '../extraction/recovery'
import { readingBrief, readingProgress, refreshReading, saveReading } from './reading'
import storyPrompt from '../../../docs/v2/resources/v2.2/prompts/active/p3-story.md?raw'
import reviewPrompt from '../../../docs/v2/resources/v2.2/prompts/active/p3-review.md?raw'
import type { SessionStatus } from '../agents/compaction'

type Legacy = ReturnType<typeof createWindowStoryService>
type State = NonNullable<ReturnType<Legacy['state']>>
export function createReadingStoryService(workspace: ReturnType<typeof createWorkspace>, models: Pick<ModelService, 'agent' | 'settings' | 'generate'>, legacy: Legacy) {
  const states = new Map<string, State>(), controllers = new Map<string, AbortController>(), listeners = new Set<() => void>()
  const set = (bookId: string, change: Partial<State>) => { states.set(bookId, { ...(states.get(bookId) ?? { running: false, window: 0, total: 0, processed: 0, nodeTotal: 0 }), ...change }); listeners.forEach(listener => listener()) }
  async function start(bookId: string, phase: 'window_link' | 'global_review' = 'window_link') {
    if (controllers.has(bookId)) return
    const controller = new AbortController(); controllers.set(bookId, controller)
    set(bookId, { running: true, phase, error: undefined, message: undefined, sessionStatus: undefined })
    const repo = createBookAgentRepository(workspace, bookId), owner = crypto.randomUUID()
    let runId = '', sessionId = '', acquired = false, timer: ReturnType<typeof setInterval> | undefined, heartbeatError = ''
    const check = async (store: AgentStore) => {
      controller.signal.throwIfAborted()
      const lease = await store.get('pipelineRuns', 'lease:narrative'), session = await store.get('storySessions', sessionId)
      if (lease?.owner !== owner || lease.runId !== runId || Number(lease.expiresAt) <= Date.now() || session?.leaseOwner !== owner || Number(session.leaseUntil) <= Date.now()) throw new Error('本书叙事执行权已变化，进度保留。')
    }
    try {
      if (!await workspace.settings.books.get(bookId)) throw new Error('书籍不存在。')
      const settings = await models.settings.read()
      if (!settings.configured || !settings.config.aggregationModel) throw new Error('请先保存整理模型与密钥。')
      let state = await repo.transaction(true, async store => {
        const chapters = await store.rows('chapters')
        if (!chapters.length) throw new Error('请先导入章节。')
        if (!coverage(chapters as never, await store.rows('extractionReceipts') as unknown as Receipt[]).allCovered) throw new Error('请先完成全书逐章提取。')
        if ((await store.rows('pipelineRuns')).some(row => row.recordType === 'lease' && ['world', 'narrative', 'extraction', 'extraction:worldAssets', 'extraction:narrativeAssets'].includes(text(row.lockKey)) && Number(row.expiresAt ?? Infinity) > Date.now())) throw new Error('本书已有叙事、世界或提取任务，请等待其结束。')
        const session = await resolveSession(store, bookId); sessionId = session.id
        if (session.leaseOwner && Number(session.leaseUntil) > Date.now()) throw new Error('本书会话正在其他窗口运行。')
        const progress = await store.get('compileProgress', 'P3')
        const old = progress?.runId ? await store.get('pipelineRuns', text(progress.runId)) : undefined
        runId = old?.stage === 'P3' && progress?.editorSessionId === sessionId ? text(old.id) : crypto.randomUUID()
        const now = new Date().toISOString()
        await store.put('pipelineRuns', { ...(old?.id === runId ? old : { id: runId, bookId, recordType: 'run', stage: 'P3', startedAt: now, planVersion: '2.2', scope: 'fullBook', tasks: [], commandIntents: [], appliedCommands: [], coverageItems: [], aiMode: 'agent' }), status: 'running', phase })
        const linked = await refreshReading(store, runId, sessionId, 'window_link')
        if (phase === 'global_review' && !readingProgress(linked).complete) throw new Error('请先完成当前资料的节点阅读与串联。')
        await saveReading(store, runId, 'window_link', linked)
        const reading = phase === 'window_link' ? linked : await refreshReading(store, runId, sessionId, phase)
        if (!readingProgress(reading).complete && !reading.pages.some(page => page.id === reading.currentPageId && page.fingerprint !== page.checkedFingerprint)) reading.currentPageId = reading.pages.find(page => page.fingerprint !== page.checkedFingerprint)?.id ?? null
        await saveReading(store, runId, phase, reading)
        await store.put('pipelineRuns', { id: 'lease:narrative', bookId, recordType: 'lease', lockKey: 'narrative', runId, owner, expiresAt: Date.now() + 30000 })
        await store.put('storySessions', { ...session, leaseOwner: owner, leaseUntil: Date.now() + 30000 })
        await store.put('compileProgress', { bookId, stage: 'P3', status: 'running', phase, runId, editorSessionId: sessionId, planKey: 'story-pages-v3', totalChapters: chapters.length, completedChapters: [], failedChapters: [], updatedAt: now, scope: 'fullBook', planVersion: '2.2', unit: 'item', validity: 'current' })
        return reading
      }); acquired = true
      let heartbeatFailures = 0
      timer = setInterval(() => { void repo.transaction(true, async store => {
        await check(store)
        const lease = (await store.get('pipelineRuns', 'lease:narrative'))!, session = (await store.get('storySessions', sessionId))!
        await store.put('pipelineRuns', { ...lease, expiresAt: Date.now() + 30000 }); await store.put('storySessions', { ...session, leaseUntil: Date.now() + 30000 })
      }).then(() => { heartbeatFailures = 0 }).catch(error => { if (++heartbeatFailures >= 3) { heartbeatError = error instanceof Error ? error.message : '执行权续期失败'; controller.abort() } }) }, 8000)
      if (!readingProgress(state).complete) {
        const taskId = crypto.randomUUID()
        const { brief, memory, count } = await repo.transaction(false, async store => ({ brief: await readingBrief(store, bookId, sessionId, phase, state), memory: await store.get('storyEditorMemory', sessionId) ?? { id: sessionId, sessionId, bookId, revision: 0, workingSummary: '', dataFingerprint: '', updatedAt: '' }, count: (await store.rows('chapters')).length }))
        const input = { bookId, runId, taskId, planVersion: '2.2', remainingCount: state.pages.filter(page => page.fingerprint !== page.checkedFingerprint).length, resume: { reason: 'continuation', appliedCommitIds: [], nextOperationKey: crypto.randomUUID(), remainingWorkIds: [] }, stage: 'P3', phase, sessionId, queue: text(brief?.queue) || 'window_nodes', window: phase === 'window_link' ? { start: 0, end: count, chapterIndices: [] } : null, workItems: [], existingLines: [], memory, afterWorkItemId: null }
        const runtime = createAgentRuntime(models.agent, { generate: models.generate, onStatus: (sessionStatus: SessionStatus) => set(bookId, { sessionStatus }) })
        const result = await runtime.run(repo, { profile: 'story_editor', workflow: 'story_pages_v3', phase, sessionId, runId, taskId, leaseOwner: owner, retainLease: true, workItems: [], input, businessPrompt: phase === 'global_review' ? reviewPrompt : storyPrompt, prompt: `【当前阅读页】\n${JSON.stringify(brief)}`, signal: controller.signal })
        if (!result.ok) throw new Error(result.error ?? '本轮阅读未完成，进度已保留。')
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
      set(bookId, { message: readingProgress(state).complete ? phase === 'window_link' ? '串联完成，可继续全书复核。' : '全书复核完成，已记录的疑点保留。' : '本轮成果已保存，当前页可继续。' })
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
      controllers.delete(bookId); set(bookId, { running: false })
    }
  }
  async function read(bookId: string) {
    const value = await legacy.read(bookId)
    if (!value.progress?.runId) return { ...value, reading: undefined as ReturnType<typeof readingProgress> & { pages: Row[]; lineTitle: string } | undefined }
    return createBookAgentRepository(workspace, bookId).transaction(false, async store => {
      const run = await store.get('pipelineRuns', value.progress!.runId)
      const phase = value.progress!.phase === 'global_review' ? 'global_review' : 'window_link'
      if (!(run?.storyReading as Row | undefined)?.[phase]) return { ...value, reading: undefined }
      const current = await refreshReading(store, value.progress!.runId, value.progress!.editorSessionId, phase), progress = readingProgress(current)
      const line = progress.lineId ? await store.get('eventLines', progress.lineId) : undefined
      const reading = { ...progress, pages: current.pages.map(page => ({ id: page.id, type: page.type, reason: page.reason, checked: page.checkedFingerprint === page.fingerprint })), lineTitle: text(line?.title) }
      return { ...value, reading, completed: progress.checked, review: phase === 'global_review' ? { ...value.review, total: progress.totalPages, pending: progress.totalPages - progress.checked } : value.review }
    })
  }
  return { ...legacy, start: (bookId: string) => start(bookId), review: (bookId: string) => start(bookId, 'global_review'), read, state: (bookId: string) => states.get(bookId), cancel: (bookId: string) => controllers.get(bookId)?.abort(), subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } } }
}
