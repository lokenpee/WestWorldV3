import type { Chapter, createWorkspace } from '../../lib/storage/workspace'
import type { ModelService } from '../models/service'
import type { CallResult, CallProgress } from '../models/types'
import { bindNodeCharacters } from '../assets/characterLinks'
import { rebuildFacts, updateFrequencies } from '../assets/derive'
import type { Character, EventNode, LocationAsset } from '../assets/types'
import { stepLabels, substeps, type ExtractionData, type ExtractedRow, type Substep } from './types'
import { checkReceiptSources, coverage, withExtractionLock, type Lease, type Progress, type Receipt, type Run, type SavedUsage, type StoredTask } from './recovery'

type Workspace = ReturnType<typeof createWorkspace>
export interface StepResult { chapterIndex: string; step: Substep; ok: boolean; message: string; attempts: number; tokens: number; cost?: number; elapsedMs: number }
export interface ExtractionState { running: boolean; chapter?: string; step?: Substep; progress?: CallProgress; results: StepResult[]; error?: string }
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value)
const distinct = (rows: ExtractedRow[]) => [...new Map(rows.map(row => [canonical(row), row])).values()]

export function createExtractionService(workspace: Workspace, models: Pick<ModelService, 'generate' | 'settings'>) {
  const states = new Map<string, ExtractionState>()
  const controllers = new Map<string, AbortController>()
  const listeners = new Set<() => void>()
  const set = (bookId: string, change: Partial<ExtractionState>) => { states.set(bookId, { ...(states.get(bookId) ?? { running: false, results: [] }), ...change }); listeners.forEach(listener => listener()) }
  async function execute(bookId: string) {
    if (controllers.has(bookId)) return
    const controller = new AbortController(); controllers.set(bookId, controller)
    const db = workspace.openBook(bookId)
    let runId: string = crypto.randomUUID(); const owner = crypto.randomUUID()
    let acquired = false
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let chapters: Chapter[] = []
    const usage: SavedUsage = { input: 0, output: 0, totalTokens: 0, cost: 0, costStatus: 'estimated' }
    const checkLease = async () => {
      controller.signal.throwIfAborted()
      const lease = await db.table<Lease>('pipelineRuns').get('lease:extraction')
      if (lease?.owner !== owner || (lease.expiresAt ?? 0) <= Date.now()) throw new Error('提取任务的执行权已失效。')
      const progress = await db.table<Progress>('compileProgress').get('P1')
      if (progress?.runId !== runId) throw new Error('当前书籍已有其他提取任务。')
    }
    async function saveProgress(status: string) {
      const receipts = await db.table<Receipt>('extractionReceipts').toArray()
      const previous = await db.table<Progress>('compileProgress').get('P1')
      const failed = [...(previous?.failedChapters ?? []), ...(states.get(bookId)?.results ?? []).filter(row => !row.ok).map(row => row.chapterIndex)]
      const { completedChapters, failedChapters, partialChapters } = coverage(chapters, receipts, failed)
      await db.table('compileProgress').put({ bookId, stage: 'P1', status, totalChapters: chapters.length, completedChapters, failedChapters, partialChapters, updatedAt: new Date().toISOString(), runId, scope: 'fullBook', planVersion: '2.2', unit: 'chapter', validity: 'current' })
      return completedChapters.length === chapters.length
    }
    set(bookId, { running: true, results: [], error: undefined, progress: undefined })
    try {
      const { fingerprint, promptOf, schemaOf, validateExtraction } = await import('./contracts')
      if (!await workspace.settings.books.get(bookId)) throw new Error('书籍已删除。')
      const configured = await models.settings.read()
      if (!configured.configured || !configured.config.extractionModel) throw new Error('请先在设置中保存提取模型和密钥。')
      chapters = await db.chapters.orderBy('order').toArray()
      if (!chapters.length) throw new Error('请先导入章节。')
      await db.transaction('r', db.tables, () => checkReceiptSources(db, bookId))
      await db.transaction('rw', db.table('pipelineRuns'), db.table('compileProgress'), async () => {
        const leases = await db.table<Lease>('pipelineRuns').toArray()
        if (leases.some(row => row.recordType === 'lease' && (row.expiresAt === undefined || row.expiresAt > Date.now()))) throw new Error('本书已有处理任务，请等待其结束。')
        await db.table('pipelineRuns').put({ id: 'lease:extraction', recordType: 'lease', bookId, lockKey: 'extraction', owner, runId, expiresAt: Date.now() + 30000 })
        const previous = await db.table<Progress>('compileProgress').get('P1')
        const existing = previous?.runId ? await db.table<Run>('pipelineRuns').get(previous.runId) : undefined
        if (existing?.stage === 'P1' && existing.status !== 'completed') {
          runId = existing.id
          Object.assign(usage, existing.usage)
          const { finishedAt: _finishedAt, ...resumed } = existing
          await db.table('pipelineRuns').put({ ...resumed, status: 'running', tasks: (existing.tasks ?? []).map(task => task.status === 'running' ? { ...task, status: 'partial' } : task) })
        } else await db.table('pipelineRuns').put({ id: runId, recordType: 'run', bookId, stage: 'P1', status: 'running', startedAt: new Date().toISOString(), planVersion: '2.2', aiMode: 'direct', tasks: [] })
        await db.table('pipelineRuns').update('lease:extraction', { runId })
        await db.table('compileProgress').update('P1', { runId })
      }); acquired = true
      heartbeat = setInterval(() => { void db.transaction('rw', db.table('pipelineRuns'), async () => {
        const lease = await db.table<Lease>('pipelineRuns').get('lease:extraction')
        if (lease?.owner !== owner) throw new Error('执行权已变化')
        await db.table('pipelineRuns').update(lease.id, { expiresAt: Date.now() + 30000 })
      }).catch(() => controller.abort()) }, 8000)
      await db.transaction('rw', db.table('extractionReceipts'), db.table('compileProgress'), () => saveProgress('running'))
      for (const chapter of chapters) for (const step of substeps) {
        controller.signal.throwIfAborted()
        await db.transaction('r', db.table('pipelineRuns'), db.table('compileProgress'), checkLease)
        const key = `${chapter.chapterIndex}:${step}`
        if (await db.table('extractionReceipts').get(key)) continue
        set(bookId, { chapter: chapter.chapterName, step, progress: undefined })
        const textRow = await db.table<{ text: string }>('chapterTexts').get(chapter.chapterIndex)
        const text = textRow?.text ?? ''
        const inputFingerprint = await fingerprint(`${step}\n${promptOf(step)}\n${chapter.chapterIndex}\n${chapter.chapterName}\n${text}`)
        const taskId = crypto.randomUUID()
        const promptHash = await fingerprint(promptOf(step))
        await db.transaction('rw', db.table('pipelineRuns'), db.table('compileProgress'), async () => {
          await checkLease()
          const run = (await db.table<Run>('pipelineRuns').get(runId))!
          const timestamp = new Date().toISOString()
          const task: StoredTask = { taskId, ordinal: run.tasks?.length ?? 0, callId: crypto.randomUUID(), phase: step, status: 'running', workItemIds: [`P1:${step}:chapter:${chapter.chapterIndex}`], input: { chapterIndex: chapter.chapterIndex, chapterName: chapter.chapterName, text }, inputFingerprint, promptHash, attempt: 0, repairCount: 0, stepsUsed: 0, appliedCommitIds: [], reviewedItems: [], readSet: { records: [], queries: [] }, createdAt: timestamp, updatedAt: timestamp }
          await db.table('pipelineRuns').update(runId, { tasks: [...(run.tasks ?? []), task] })
        })
        const result: CallResult & { value?: ExtractionData } = !text ? { ok: false, mode: 'direct', text: '', elapsedMs: 0, attempts: [], usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, costStatus: 'unknown' }, error: { kind: 'validation', message: '本章原文缺失。' } } : await models.generate<ExtractionData>({ role: 'extraction', signal: controller.signal,
          context: { systemPrompt: promptOf(step), messages: [{ role: 'user', content: `章节标识：${chapter.chapterIndex}\n章节名：${chapter.chapterName}\n\n--- 正文开始 ---\n${text}\n--- 正文结束 ---`, timestamp: Date.now() }], tools: [{ name: 'submit_result', description: '提交本章提取结果', parameters: schemaOf(step), constrainedSampling: { type: 'json_schema', strict: 'prefer' } }] },
          validate: message => validateExtraction(step, message), repairPrompt: '这是唯一一次修正机会。请按字段要求调用唯一的 submit_result 提交本章结果；其他工具未执行。',
          onProgress: progress => set(bookId, { progress }),
        })
        usage.input += result.usage.input; usage.output += result.usage.output; usage.totalTokens += result.usage.totalTokens; usage.cost += result.usage.cost ?? 0
        if (result.usage.costStatus === 'unknown') usage.costStatus = 'unknown'
        controller.signal.throwIfAborted()
        const entry: StepResult = { chapterIndex: chapter.chapterIndex, step, ok: result.ok, message: result.ok ? `${stepLabels[step]}已保存` : result.error?.message ?? '提取失败', attempts: result.attempts.length, tokens: result.usage.totalTokens, cost: result.usage.cost, elapsedMs: result.elapsedMs }
        const finishTask = async () => {
          const run = (await db.table<Run>('pipelineRuns').get(runId))!
          const tasks = (run.tasks ?? []).map(task => task.taskId === taskId ? { ...task, status: entry.ok ? 'completed' : 'failed', attempt: entry.attempts, repairCount: result.attempts.some(attempt => attempt.turn > 1) ? 1 : 0, stepsUsed: entry.attempts, updatedAt: new Date().toISOString(), ...(entry.ok ? {} : { lastError: { code: result.error?.kind ?? 'validation', message: entry.message } }) } : task)
          await db.table('pipelineRuns').update(runId, { tasks, usage, cost: usage.cost })
        }
        if (result.ok && result.value) {
          await db.transaction('rw', db.tables, async () => {
            await checkLease()
            if (await db.table('extractionReceipts').get(key)) return
            const currentText = await db.table<{ text: string }>('chapterTexts').get(chapter.chapterIndex)
            if (currentText?.text !== text) throw new Error('本章原文已变化，请重新提取。')
            const originIds: string[] = []
            const timestamp = new Date().toISOString()
            async function insert(table: 'characters' | 'locations' | 'nodes', kind: 'character' | 'location' | 'node', code: string, rows: ExtractedRow[]) {
              let sequence = 1
              let nodeOrder = kind === 'node' ? Math.max(-1, ...(await db.table<EventNode>('nodes').toArray()).filter(row => row.chapterIndex === chapter.chapterIndex).map(row => row.order)) + 1 : 0
              for (const source of (kind === 'node' ? rows : distinct(rows))) {
                let id: string
                do { id = `C${chapter.chapterIndex}-${code}${String(sequence++).padStart(3, '0')}` } while (await db.table(table).get(id) || await db.table('assetLifecycle').get(`${kind}:${id}`))
                const row: Record<string, unknown> = { ...source, id, bookId, revision: 1, createdBy: 'P1', chapterIndex: chapter.chapterIndex, chapterName: chapter.chapterName }
                if (kind === 'node') {
                  const quote = source.quote as string; const offset = quote ? text.indexOf(quote) : -1
                  delete row.offset
                  Object.assign(row, { order: nodeOrder++, eventLineIds: [], quoteStatus: !quote ? 'empty' : offset < 0 ? 'unmatched' : 'matched', ...(offset < 0 ? {} : { offset }) })
                  Object.assign(row, bindNodeCharacters(row as unknown as EventNode, await db.table<Character>('characters').toArray()))
                } else {
                  Object.assign(row, { sourceChapters: [chapter.chapterIndex], nameSource: 'extracted' })
                  if (kind === 'character') {
                    row.aliases = source.aliases_mentioned ?? []; delete row.aliases_mentioned
                    if (source.speech_style_sample !== undefined) { row.speechStyleSample = source.speech_style_sample; delete row.speech_style_sample }
                  }
                  row.mergeFacts = rebuildFacts([], Object.fromEntries((kind === 'character' ? ['identity', 'appearance', 'personality', 'background'] : ['description']).filter(field => typeof row[field] === 'string').map(field => [field, row[field] as string])), [chapter.chapterIndex])
                }
                await db.table(table).add(row)
                await db.table('assetLifecycle').add({ key: `${kind}:${id}`, bookId, kind, originId: id, currentId: id, state: 'live', revision: 1, updatedAt: timestamp, sourceChapterIndex: chapter.chapterIndex })
                originIds.push(id)
              }
            }
            await insert('characters', 'character', 'P', result.value!.characters ?? [])
            await insert('locations', 'location', 'L', result.value!.locations ?? [])
            await insert('nodes', 'node', 'N', result.value!.nodes ?? [])
            const texts = await db.table<{ chapterIndex: string; text: string }>('chapterTexts').toArray()
            for (const [table, people] of [['characters', true], ['locations', false]] as const) {
              const before = await db.table<Character | LocationAsset>(table).toArray()
              const after = updateFrequencies(before, texts, people)
              for (const [index, row] of after.entries()) if (JSON.stringify(row) !== JSON.stringify(before[index])) await db.table(table).put({ ...row, revision: row.revision + 1 })
            }
            await db.table('extractionReceipts').add({ key, bookId, chapterIndex: chapter.chapterIndex, substep: step, inputFingerprint, originIds, committedAt: timestamp, runId })
            await saveProgress('running')
            await finishTask()
            controller.signal.throwIfAborted()
          })
        }
        set(bookId, { results: [...states.get(bookId)!.results, entry] })
        await db.transaction('rw', db.table('pipelineRuns'), db.table('extractionReceipts'), db.table('compileProgress'), async () => {
          await checkLease()
          await saveProgress('running')
          await finishTask()
        })
      }
      await db.transaction('rw', db.table('pipelineRuns'), db.table('extractionReceipts'), db.table('compileProgress'), async () => {
        await checkLease()
        const complete = await saveProgress('running')
        const status = complete ? 'completed' : 'failed'
        await db.table('compileProgress').update('P1', { status })
        await db.table('pipelineRuns').update(runId, { status, usage, cost: usage.cost, finishedAt: new Date().toISOString() })
      })
    } catch (error) {
      const message = controller.signal.aborted ? '提取已取消，已保存的成果保留。' : error instanceof Error ? error.message : '提取失败，请重试。'
      set(bookId, { error: message })
      if (acquired) await db.transaction('rw', db.table('pipelineRuns'), db.table('extractionReceipts'), db.table('compileProgress'), async () => {
        if ((await db.table<Lease>('pipelineRuns').get('lease:extraction'))?.owner !== owner) return
        const status = controller.signal.aborted ? 'cancelled' : 'failed'
        await saveProgress(status)
        const run = await db.table<Run>('pipelineRuns').get(runId)
        const tasks = (run?.tasks ?? []).map(task => task.status === 'running' ? { ...task, status: controller.signal.aborted ? 'cancelled' : 'partial', updatedAt: new Date().toISOString(), lastError: { code: controller.signal.aborted ? 'cancelled' : 'interrupted', message } } : task)
        await db.table('pipelineRuns').update(runId, { status, tasks, usage, cost: usage.cost, finishedAt: new Date().toISOString() })
      }).catch(() => set(bookId, { error: `${message}；进度保存失败，请检查本地存储。` }))
    } finally {
      clearInterval(heartbeat)
      if (acquired) await db.transaction('rw', db.table('pipelineRuns'), async () => { if ((await db.table<Lease>('pipelineRuns').get('lease:extraction'))?.owner === owner) await db.table('pipelineRuns').delete('lease:extraction') }).catch(() => set(bookId, { error: '任务已结束，执行锁等待到期释放。' }))
      controllers.delete(bookId); set(bookId, { running: false, progress: undefined })
    }
  }
  async function start(bookId: string) {
    await withExtractionLock(workspace.scope.settingsName, bookId, () => execute(bookId), () => { set(bookId, { error: '本书已有处理任务，请等待其结束。' }) })
  }
  async function recover(bookId: string) {
    if (controllers.has(bookId)) return
    const target = workspace.openBook(bookId)
    const needed = await target.transaction('r', target.chapters, target.table('pipelineRuns'), target.table('extractionReceipts'), target.table('compileProgress'), async () => {
      const previous = await target.table<Progress>('compileProgress').get('P1')
      if (!previous || previous.status === 'idle') return false
      const lease = await target.table<Lease>('pipelineRuns').get('lease:extraction')
      if (lease && (lease.expiresAt === undefined || lease.expiresAt > Date.now())) return false
      if (!lease && !['running', 'cancelling', 'completed'].includes(previous.status)) return false
      if (!lease && previous.status === 'completed' && coverage(await target.chapters.toArray(), await target.table<Receipt>('extractionReceipts').toArray()).allCovered) return false
      return true
    })
    if (!needed) return
    await withExtractionLock(workspace.scope.settingsName, bookId, async () => {
      const db = workspace.openBook(bookId)
      await db.transaction('rw', db.tables, async () => {
        const previous = await db.table<Progress>('compileProgress').get('P1')
        if (!previous) return
        const lease = await db.table<Lease>('pipelineRuns').get('lease:extraction')
        if (lease && (lease.expiresAt === undefined || lease.expiresAt > Date.now())) return
        const receipts = await checkReceiptSources(db, bookId)
        const chapters = await db.chapters.orderBy('order').toArray()
        const { allCovered, completedSteps: _completedSteps, ...counts } = coverage(chapters, receipts, previous.failedChapters)
        const status = allCovered ? 'completed' : ['running', 'cancelling', 'completed'].includes(previous.status) ? 'paused' : previous.status
        const next = { ...previous, ...counts, status }
        if (JSON.stringify(next) !== JSON.stringify(previous)) await db.table('compileProgress').put(next)
        if (lease) await db.table('pipelineRuns').delete(lease.id)
        const run = previous.runId ? await db.table<Run>('pipelineRuns').get(previous.runId) : undefined
        if (run && (run.status === 'running' || run.status === 'completed' && !allCovered)) await db.table('pipelineRuns').update(run.id, { status: allCovered ? 'completed' : 'paused', tasks: (run.tasks ?? []).map(task => task.status === 'running' ? { ...task, status: 'partial', updatedAt: new Date().toISOString(), lastError: { code: 'interrupted', message: '任务中断，可继续处理尚未完成的步骤。' } } : task) })
      })
    }, () => undefined)
  }
  return { start, recover, cancel: (bookId: string) => controllers.get(bookId)?.abort(), state: (bookId: string) => states.get(bookId),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async progress(bookId: string) {
      const db = workspace.openBook(bookId)
      return db.transaction('r', db.chapters, db.table('extractionReceipts'), db.table('compileProgress'), db.table('pipelineRuns'), async () => {
        const progress = await db.table<Progress>('compileProgress').get('P1')
        if (!progress) return undefined
        const run = progress.runId ? await db.table<Run>('pipelineRuns').get(progress.runId) : undefined
        const chapters = await db.chapters.orderBy('order').toArray()
        const receipts = await db.table<Receipt>('extractionReceipts').toArray()
        const lease = await db.table<Lease>('pipelineRuns').get('lease:extraction')
        const { allCovered, ...counts } = coverage(chapters, receipts, progress.failedChapters)
        const status = progress.status === 'completed' && !allCovered ? 'paused' : progress.status
        const failures = [...new Map((run?.tasks ?? []).filter(task => task.status === 'failed' || task.status === 'partial').filter(task => !receipts.some(receipt => receipt.key === `${task.input.chapterIndex}:${task.phase}`)).map(task => [`${task.input.chapterIndex}:${task.phase}`, { chapterIndex: task.input.chapterIndex, step: task.phase, message: task.lastError?.message ?? '任务中断，可继续提取。' }])).values()]
        return { ...progress, ...counts, status, busy: !!lease, canOrganize: allCovered && status === 'completed' && !lease, usage: run?.usage, failures }

      })
    },
  }
}
export type ExtractionService = ReturnType<typeof createExtractionService>
