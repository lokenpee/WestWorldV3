import Dexie from 'dexie'
import type { Chapter, createWorkspace } from '../../lib/storage/workspace'
import type { EventNode } from '../assets/types'
import type { ModelService } from '../models/service'
import { coverage, type Receipt } from '../extraction/recovery'
import { createBookAgentRepository, type Row } from '../agents/repository'
import { checkpointId, evidenceEntries, membershipsOf, type StoryCheckpoint, type StoryProgress } from './checkpoints'
import { createStoryWindows, windowKey, windowNodes, type StoryWindow } from './windows'
import { runGlobalReview, reviewQueue } from './review'
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
      const [{ createAgentRuntime }, { hash, records, strings, text }, { resolveSession }] = await Promise.all([import('../agents/runtime'), import('../agents/contracts'), import('../agents/sessions')])
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
          if (checkpoint?.status !== 'completed' || previous?.phase !== 'global_review' && checkpoint.sourceFingerprint !== await store.wait(hash({ window, nodes: windowNodes(window, chapters, await store.rows('nodes') as unknown as EventNode[]) }))) throw new Error('请先完成当前资料的窗口串联。')
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
      if (phase === 'global_review') {
        await runGlobalReview(repo, runtime, { runId, sessionId, owner, signal: controller.signal, check, onProgress: (processed, nodeTotal, queue) => set(bookId, { processed, nodeTotal, queue }) })
        set(bookId, { message: '全书复核完成。' })
        return
      }
      const saveCheckpoint = async (window: StoryWindow, status: StoryCheckpoint['status']) => {
        const nodes = await nodesFor(window)
        const sourceFingerprint = await Dexie.waitFor(hash({ window, nodes }))
        await db.table('storyEditorCheckpoints').put({ id: checkpointId(sessionId, planKey, window), bookId, sessionId, stage: 'P3', phase: 'window_link', scopeIds: nodes.map(row => row.id), sourceFingerprint, status, memberships: membershipsOf(nodes), updatedAt: new Date().toISOString(), window: { start: window.start, end: window.end } } satisfies StoryCheckpoint)
      }
      for (const [windowIndex, window] of windows.entries()) {
        await check(); activeWindow = window
        set(bookId, { window: windowIndex + 1, total: windows.length, processed: 0 })
        const existing = await db.table<StoryCheckpoint>('storyEditorCheckpoints').get(checkpointId(sessionId, planKey, window))
        const initialNodes = await nodesFor(window)
        if (!recheck && existing?.status === 'completed' && existing.sourceFingerprint === await hash({ window, nodes: initialNodes })) continue
        const covered = new Map<string, string>(), readLines = new Set<string>(); let noProgress = 0
        for (;;) {
          await check()
          const current = await nodesFor(window)
          const fingerprints = new Map(await Promise.all(current.map(async row => [row.id, await hash(row)] as const)))
          const pending = current.filter(row => covered.get(row.id) !== fingerprints.get(row.id))
          const lines = await db.table('eventLines').toArray()
          const unreadLines = lines.filter(row => !readLines.has(String(row.id)))
          set(bookId, { nodeTotal: current.length, processed: current.length - pending.length })
          if (!current.length || !pending.length && !unreadLines.length) break
          const batch = (pending.length ? pending : current).slice(0, 100)
          const taskId = crypto.randomUUID(), operationKey = crypto.randomUUID()
          const workItems = batch.map(row => ({ workItemId: `window_link:${windowKey(window)}:node:${encodeURIComponent(row.id)}`, kind: 'node', id: row.id, revision: row.revision, factFingerprint: fingerprints.get(row.id)! }))
          const memory = await db.table('storyEditorMemory').get(sessionId) ?? { id: sessionId, bookId, sessionId, revision: 0, workingSummary: '', dataFingerprint: '', updatedAt: '' }
          const input = { bookId, runId, taskId, planVersion: '2.2', remainingCount: pending.length, resume: { reason: existing ? 'continuation' : 'initial', appliedCommitIds: [], nextOperationKey: operationKey, remainingWorkIds: workItems.map(row => row.workItemId) }, stage: 'P3', phase: 'window_link', sessionId, queue: 'window_nodes', window, workItems, existingLines: lines.slice(0, 50).map(row => ({ id: row.id, title: row.title, lineStatus: row.lineStatus, nodeIds: strings(row.nodeIds), chapters: strings(row.chapters), cause: String(row.cause ?? '').slice(0, 100), result: String(row.result ?? '').slice(0, 100), revision: row.revision })), memory, afterWorkItemId: null }
          const result = await runtime.run(repo, { profile: 'story_editor', phase: 'window_link', sessionId, runId, taskId, leaseOwner: owner, retainLease: true, workItems, input, requiredLineIds: unreadLines.map(row => String(row.id)), businessPrompt: storyPrompt, prompt: taskTemplate.replace('{taskJson}', JSON.stringify(input)), signal: controller.signal })
          await check()
          if (!result.ok) throw new Error(result.error ?? '窗口串联失败。')
          const after = await nodesFor(window)
          const afterHash = new Map(await Promise.all(after.map(async row => [row.id, await hash(row)] as const)))
          const { task } = await repo.transaction(false, async store => { const run = (await store.get('pipelineRuns', runId))!; return { task: records(run.tasks).find(row => row.taskId === taskId)! } })
          const reads = task.readSet as { records: Row[]; queries: Row[] }
          let gained = 0
          for (const read of reads.records.filter(row => row.table === 'eventLines')) { const id = String(read.resolvedId ?? read.id); if (!readLines.has(id)) gained++; readLines.add(id) }
          const previousLineIds = new Set(lines.map(row => String(row.id)))
          for (const line of await db.table('eventLines').toArray()) if (!previousLineIds.has(String(line.id))) readLines.add(String(line.id))
          const reviewed = result.summary?.reviewedItems ?? []
          const items = reviewed.map(item => {
            const work = workItems.find(work => work.workItemId === item.workItemId)!
            const row = after.find(row => row.id === work.id)
            const currentHash = afterHash.get(work.id) ?? 'deleted'
            if (covered.get(work.id) !== currentHash) gained++
            covered.set(work.id, currentHash)
            return { workItemId: work.workItemId, phase: 'window_link', kind: 'node', id: work.id, status: row ? 'checked' : 'skipped', inputRevision: work.revision, inputFingerprint: work.factFingerprint, coveredRevision: row?.revision ?? 0, coveredFingerprint: currentHash, dependencies: reads, taskId, outcome: row ? item.outcome : 'deleted', reason: item.reason, invalidations: 0, updatedAt: new Date().toISOString() }
          })
          await db.transaction('rw', db.table('pipelineRuns'), db.table('storySessions'), async () => { await check(); const run = (await db.table('pipelineRuns').get(runId))!; const old = records(run.coverageItems); const keys = new Set(items.map(item => item.workItemId)); await db.table('pipelineRuns').update(runId, { status: 'running', phase: 'window_link', coverageItems: [...old.filter(item => !keys.has(text(item.workItemId))), ...items] }) })
          noProgress = gained ? 0 : noProgress + 1
          if (noProgress >= 3) throw new Error('连续尝试未取得节点覆盖进展，请查看依据后继续。')
        }
        await db.transaction('rw', db.tables, async () => { await check(); await saveCheckpoint(window, 'completed'); await db.table('compileProgress').update('P3', { lastWindowIndex: windowIndex, updatedAt: new Date().toISOString() }) })
      }
      await db.transaction('rw', db.tables, async () => {
        await check()
        for (const window of windows) {
          const checkpoint = await db.table<StoryCheckpoint>('storyEditorCheckpoints').get(checkpointId(sessionId, planKey, window))
          if (checkpoint?.status !== 'completed' || checkpoint.sourceFingerprint !== await Dexie.waitFor(hash({ window, nodes: await nodesFor(window) }))) throw new Error('已处理窗口的资料发生变化，请继续核对受影响的窗口。')
        }
        await db.table('compileProgress').update('P3', { status: 'paused', phase: 'window_link_complete', validity: 'current', updatedAt: new Date().toISOString() })
        await db.table('pipelineRuns').update(runId, { status: 'paused', phase: 'window_link_complete', finishedAt: new Date().toISOString(), coverage: { total: windows.length, checked: windows.length, pendingIds: [] } })
      })
      set(bookId, { message: '窗口串联完成。', processed: states.get(bookId)?.nodeTotal ?? 0 })
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
      const leases = await store.rows('pipelineRuns')
      const covered = coverage(chapters, await store.rows('extractionReceipts') as unknown as Receipt[]).allCovered
      const locked = leases.some(row => row.recordType === 'lease' && ['narrative', 'extraction'].includes(String(row.lockKey)) && (typeof row.expiresAt !== 'number' || row.expiresAt > Date.now()))
      const entries = progress?.editorSessionId ? (await store.rows('storySessionEntries')).filter(row => row.sessionId === progress.editorSessionId).sort((a, b) => Number(a.ordinal) - Number(b.ordinal)) : []
      const compact = entries.findLast(row => row.type === 'compaction')
      const review = run ? await reviewQueue(store, progress!.runId, progress!.editorSessionId) : undefined
      const memory = progress?.editorSessionId ? await store.get('storyEditorMemory', progress.editorSessionId) : undefined
      return { progress, windows, covered, locked, checkpoints, completed: checkpoints.filter(row => row.status === 'completed').length, tasks: evidenceEntries((run?.tasks as Row[] | undefined) ?? []), usage: run?.usage as { totalTokens: number; cost: number; costStatus?: string } | undefined, commits: (run?.appliedCommands as Row[] | undefined) ?? [], memory, notes: review?.items.filter(row => row.queue === 'review_notes').map(row => row.row) ?? [], session: { id: progress?.editorSessionId, entryCount: entries.length, compactions: entries.filter(row => row.type === 'compaction').length, compact }, review: { total: review?.items.length ?? 0, pending: review?.pending.length ?? 0, conclusions: review?.coverage ?? [] } }
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
