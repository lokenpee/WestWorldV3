import { transact } from '../../lib/storage/transaction'
import { liveQuery } from '../../lib/storage/observe'
import type { Chapter, createWorkspace } from '../../lib/storage/workspace'
import type { ModelService } from '../models/service'
import type { CallResult, CallProgress } from '../models/types'
import { classifyError } from '../models/policy'
import { bindNodeCharacters, createNodeBindingContext, remapCharacterLinks } from '../assets/characterLinks'
import { dexieMergeStore } from '../assets/mergeCore'
import { invalidateAssetProgress, type AssetChange } from '../assets/invalidate'
import { extractedRelation, syncRelations, type ExtractedRelationInput } from '../assets/relations'
import { rebuildFacts, updateFrequencies, createFrequencyCounter } from '../assets/derive'
import type { Character, CharacterRelation, EventNode, Lifecycle, LocationAsset } from '../assets/types'
import { stepLabels, substeps, type ExtractionData, type ExtractedRow, type Substep } from './types'
import { checkReceiptSources, coverage, withExtractionLock, type Lease, type ExtractionJob, type Progress, type Receipt, type ReExtractScope, type Run, type SavedUsage, type StoredTask } from './recovery'
import { clearReExtractData, previewReExtractData } from './reextract'

type Workspace = ReturnType<typeof createWorkspace>
export interface StepResult { chapterIndex: string; step: Substep; ok: boolean; message: string; attempts: number; tokens: number; cost?: number; elapsedMs: number }
export interface ExtractionState { running: boolean; chapter?: string; step?: Substep; progress?: CallProgress; results: StepResult[]; error?: string }
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value)
const distinct = (rows: ExtractedRow[]) => [...new Map(rows.map(row => [canonical(row), row])).values()]
class ExecutionLost extends Error {}
export type ExtractionStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted'
type Selection = { chapterIndex: string; step: Substep }
export type ReExtractRequest =
  | { scope: 'all'; step: Substep }
  | { scope: 'chapter'; chapterIndex: string; step: Substep }
export interface ReExtractPreview { counts: Awaited<ReturnType<typeof previewReExtractData>>; blockers: string[] }
const scopeComplete = (receipts: Receipt[], chapters: Chapter[], scope: ReExtractScope) => {
  const keys = new Set(receipts.filter(row => row.substep === scope.step).map(row => row.chapterIndex))
  return scope.scope === 'chapter' ? keys.has(scope.chapterIndex ?? '') : chapters.length > 0 && chapters.every(chapter => keys.has(chapter.chapterIndex))
}
const extractionLeaseIds = ['lease:extraction', ...substeps.map(step => `lease:extraction:${step}`)]
const activeLease = (row: Lease) => row.recordType === 'lease' && (row.expiresAt === undefined || Number(row.expiresAt) > Date.now())

async function reExtractTextErrors(db: ReturnType<Workspace['openBook']>, chapters: Chapter[], scope: ReExtractScope): Promise<string[]> {
  const targets = chapters.filter(chapter => scope.scope === 'all' || chapter.chapterIndex === scope.chapterIndex)
  const texts = await db.table<{ text: string }>('chapterTexts').bulkGet(targets.map(chapter => chapter.chapterIndex))
  return targets.filter((_, index) => !texts[index]?.text?.trim()).map(chapter => `第${chapter.chapterIndex}章原文缺失或为空，无法重新提取。`)
}

export function createExtractionService(workspace: Workspace, models: Pick<ModelService, 'generate' | 'settings'>) {
  const states = new Map<string, ExtractionState>()
  const controllers = new Map<string, AbortController>()
  const laneControllers = new Map<string, Map<string, AbortController>>()
  const laneStates = new Map<string, Partial<Record<Substep, ExtractionState>>>()
  const lanePromises = new Map<string, Promise<void>>()
  const pausedLanes = new Set<string>()
  const cancelVersions = new Map<string, number>()
  const listeners = new Set<() => void>()
  const set = (bookId: string, change: Partial<ExtractionState>) => { states.set(bookId, { ...(states.get(bookId) ?? { running: false, results: [] }), ...change }); listeners.forEach(listener => listener()) }
  async function execute(bookId: string, selection?: Selection, options: { reExtract?: ReExtractScope; clear?: boolean; lane?: Substep; job?: ExtractionJob } = {}) {
    const activeControllers = options.lane ? laneControllers.get(bookId) ?? new Map<string, AbortController>() : controllers
    const executionKey = options.lane ?? bookId
    if (activeControllers.has(executionKey) || options.lane && controllers.has(bookId)) return
    if (options.lane) laneControllers.set(bookId, activeControllers)
    const controller = new AbortController(); activeControllers.set(executionKey, controller)
    const leaseId = options.lane ? `lease:extraction:${options.lane}` : 'lease:extraction'
    const pauseKey = `${bookId}:${options.lane}`
    const update = (change: Partial<ExtractionState>) => {
      if (options.lane) {
        const current = laneStates.get(bookId) ?? {}
        current[options.lane] = { ...(current[options.lane] ?? { running: false, results: [] }), ...change }
        laneStates.set(bookId, current)
        set(bookId, { ...change, running: controllers.has(bookId) || Object.values(current).some(state => state?.running) })
      } else set(bookId, change)
    }
    const db = workspace.openBook(bookId)
    let runId: string = crypto.randomUUID(); const owner = crypto.randomUUID()
    let acquired = false
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let heartbeatError: unknown
    let executionWatch: { unsubscribe(): void } | undefined
    let chapters: Chapter[] = []
    let activeScope = options.reExtract
    let domainLease = options.lane ? (options.lane === 'worldAssets' ? 'world' : 'narrative') : activeScope ? (activeScope.step === 'worldAssets' ? 'world' : 'narrative') : undefined
    const usage: SavedUsage = { input: 0, output: 0, totalTokens: 0, cost: 0, costStatus: 'estimated' }
    const checkLease = async (scopeDb = db) => {
      controller.signal.throwIfAborted()
      const lease = await scopeDb.table<Lease>('pipelineRuns').get(leaseId)
      if (lease?.owner !== owner || lease.runId !== runId) throw new ExecutionLost('提取任务已由其他执行者接管，当前任务已停止写入。')
      const progress = await scopeDb.table<Progress>('compileProgress').get('P1')
      if ((options.lane ? progress?.extractionJobs?.[options.lane]?.runId : progress?.runId) !== runId) throw new ExecutionLost('当前书籍已有其他提取任务。')
      if (domainLease) {
        const domain = await scopeDb.table<Lease>('pipelineRuns').get(`lease:${domainLease}`)
        if (domain?.owner !== owner || domain.runId !== runId) throw new ExecutionLost('重提目标范围的执行权已失效。')
      }
      const others = await scopeDb.table<Lease>('pipelineRuns').where('recordType').equals('lease').toArray()
      if (others.some(row => row.recordType === 'lease' && row.id !== lease.id && !(row.owner === owner && row.runId === runId) && !(options.lane && row.extractionStep && row.extractionStep !== options.lane) && (row.expiresAt === undefined || row.expiresAt > Date.now()))) throw new ExecutionLost('本书已有其他处理任务，当前提取已暂停。')
      await scopeDb.table('pipelineRuns').update(lease.id, { expiresAt: Date.now() + 30000 })
      if (domainLease) await scopeDb.table('pipelineRuns').update(`lease:${domainLease}`, { expiresAt: Date.now() + 30000 })
    }
    async function saveProgress(status: string, scopeDb = db) {
      const receipts = await scopeDb.table<Receipt>('extractionReceipts').toArray()
      const keys = new Set(receipts.map(row => row.key))
      const previous = await scopeDb.table<Progress>('compileProgress').get('P1')
      const stepStates = { ...previous?.stepStates }
      const failed = Object.entries(stepStates).filter(([key, item]) => item.status === 'failed' && !keys.has(key)).map(([key]) => key.slice(0, key.lastIndexOf(':')))
      const { completedChapters, failedChapters, partialChapters } = coverage(chapters, receipts, failed)
      const extractionJobs = { ...previous?.extractionJobs }
      let totalUsage = usage
      if (options.lane && options.job) {
        const scope = options.job
        const jobStatus = ['paused', 'cancelled'].includes(status) ? 'paused' : scopeComplete(receipts, chapters, scope) ? 'completed' : status === 'running' ? 'running' : status === 'failed' ? 'failed' : 'paused'
        extractionJobs[options.lane] = { ...options.job, runId, status: jobStatus, usage: { ...usage } }
        if (Object.values(extractionJobs).some(job => job?.status === 'running')) status = 'running'
        totalUsage = Object.values(extractionJobs).reduce<SavedUsage>((sum, job) => ({ input: sum.input + (job?.usage?.input ?? 0), output: sum.output + (job?.usage?.output ?? 0), totalTokens: sum.totalTokens + (job?.usage?.totalTokens ?? 0), cost: sum.cost + (job?.usage?.cost ?? 0), costStatus: sum.costStatus === 'unknown' || job?.usage?.costStatus === 'unknown' ? 'unknown' : 'estimated' }), { input: 0, output: 0, totalTokens: 0, cost: 0, costStatus: 'estimated' })
      }
      await scopeDb.table('compileProgress').put({ ...previous, bookId, stage: 'P1', status, totalChapters: chapters.length, completedChapters, failedChapters, partialChapters, updatedAt: new Date().toISOString(), runId, scope: 'fullBook', planVersion: '2.2', unit: 'chapter', validity: 'current', stepStates, usage: totalUsage, ...(options.lane ? { extractionJobs } : {}) })
      return completedChapters.length === chapters.length
    }
    update({ running: true, results: options.lane ? states.get(bookId)?.results ?? [] : [], error: undefined, progress: undefined })
    try {
      if (!options.lane && !activeScope) activeScope = (await db.table<Progress>('compileProgress').get('P1'))?.reExtract
      domainLease = options.lane ? (options.lane === 'worldAssets' ? 'world' : 'narrative') : activeScope ? (activeScope.step === 'worldAssets' ? 'world' : 'narrative') : undefined
      const { fingerprint, promptOf, schemaOf, validateExtraction } = await import('./contracts')
      if (!await workspace.settings.books.get(bookId)) throw new Error('书籍已删除。')
      const configured = await models.settings.read()
      if (!configured.configured || !configured.config.extractionModel) throw new Error('请先在设置中保存提取模型和密钥。')
      chapters = await db.chapters.orderBy('order').toArray()
      if (!chapters.length) throw new Error('请先导入章节。')
      if (selection && (!chapters.some(chapter => chapter.chapterIndex === selection.chapterIndex) || !substeps.includes(selection.step))) throw new Error('补提取的章节或步骤不存在。')
      if (options.job?.scope === 'chapter' && !chapters.some(chapter => chapter.chapterIndex === options.job?.chapterIndex)) throw new Error('目标章节不存在。')
      if (options.clear && activeScope) {
        const errors = await reExtractTextErrors(db, chapters, activeScope)
        if (errors.length) throw new Error(errors.join('；'))
      }
      await transact(db, 'r', [db.tables], (db) => checkReceiptSources(db, bookId))
      await transact(db, 'rw', [db.table('pipelineRuns'), db.table('compileProgress')], async (db) => {
        const leases = await db.table<Lease>('pipelineRuns').where('recordType').equals('lease').toArray()
        if (leases.some(row => row.recordType === 'lease' && !(options.lane && row.extractionStep && row.extractionStep !== options.lane) && (row.expiresAt === undefined || row.expiresAt > Date.now()))) throw new Error('本书已有处理任务，请等待其结束。')
        await db.table('pipelineRuns').put({ id: leaseId, ...(options.lane ? { extractionStep: options.lane } : {}), recordType: 'lease', bookId, lockKey: options.lane ? `extraction:${options.lane}` : 'extraction', owner, runId, expiresAt: Date.now() + 30000 })
        const previous = await db.table<Progress>('compileProgress').get('P1')
        const existingId = options.lane ? options.job?.runId : previous?.runId
        const existing = existingId ? await db.table<Run>('pipelineRuns').get(existingId) : undefined
        if (existing?.stage === 'P1' && existing.status !== 'completed') {
          runId = existing.id
          Object.assign(usage, existing.usage)
          const { finishedAt: _finishedAt, ...resumed } = existing
          await db.table('pipelineRuns').put({ ...resumed, status: 'running', tasks: (existing.tasks ?? []).map(task => task.status === 'running' ? { ...task, status: 'partial' } : task) })
        } else await db.table('pipelineRuns').put({ id: runId, recordType: 'run', bookId, stage: 'P1', status: 'running', startedAt: new Date().toISOString(), planVersion: '2.2', aiMode: 'direct', tasks: [] })
        await db.table('pipelineRuns').update(leaseId, { runId })
        if (domainLease) await db.table('pipelineRuns').put({ id: `lease:${domainLease}`, ...(options.lane ? { extractionStep: options.lane } : {}), recordType: 'lease', bookId, lockKey: domainLease, owner, runId, expiresAt: Date.now() + 30000 })
        if (options.lane && options.job) {
          const next = { bookId, stage: 'P1', status: 'running', totalChapters: chapters.length, completedChapters: [], failedChapters: [], updatedAt: new Date().toISOString(), ...previous, runId, extractionJobs: { ...previous?.extractionJobs, [options.lane]: { ...options.job, runId, status: 'running' } } }
          if (next.reExtract?.step === options.lane) delete next.reExtract
          await db.table('compileProgress').put(next)
        } else await db.table('compileProgress').update('P1', { runId })
      }); acquired = true
      heartbeat = setInterval(() => { void transact(db, 'rw', [db.table('pipelineRuns'), db.table('compileProgress')], (db) => checkLease(db)).catch(error => { if (error instanceof ExecutionLost) { heartbeatError = error; controller.abort() } }) }, 8000)
      executionWatch = liveQuery(async () => {
        const lease = await db.table<Lease>('pipelineRuns').get(leaseId)
        const progress = await db.table<Progress>('compileProgress').get('P1')
        const currentRun = options.lane ? progress?.extractionJobs?.[options.lane]?.runId : progress?.runId
        return lease?.owner === owner && lease.runId === runId && currentRun === runId
      }).subscribe({
        next: valid => {
          if (valid || controller.signal.aborted) return
          heartbeatError = new ExecutionLost('提取执行权已撤销，已停止请求。')
          controller.abort()
        },
        error: error => { heartbeatError = error; controller.abort() },
      })
      if (options.clear && activeScope) {
        const clearScope = activeScope
        await transact(db, 'rw', [db.tables], async (db) => {
          await checkLease(db)
          const textErrors = await reExtractTextErrors(db, chapters, clearScope)
          if (textErrors.length) throw new Error(textErrors.join('；'))
          await clearReExtractData(db, clearScope, chapters, new Date().toISOString())
          const previous = await db.table<Progress>('compileProgress').get('P1')
          if (previous && !options.lane) await db.table('compileProgress').put({ ...previous, reExtract: activeScope, status: 'running', updatedAt: new Date().toISOString() })
          await saveProgress('running', db)
        })
      }
      await transact(db, 'rw', [db.table('pipelineRuns'), db.table('extractionReceipts'), db.table('compileProgress')], (db) => saveProgress('running', db))
      for (const chapter of chapters) for (const step of substeps) {
        if (selection && (chapter.chapterIndex !== selection.chapterIndex || step !== selection.step)) continue
        if (options.lane && (step !== options.lane || options.job?.scope === 'chapter' && chapter.chapterIndex !== options.job.chapterIndex)) continue
        if (!selection && activeScope && (step !== activeScope.step || activeScope.scope === 'chapter' && chapter.chapterIndex !== activeScope.chapterIndex)) continue
        controller.signal.throwIfAborted()
        await transact(db, 'rw', [db.table('pipelineRuns'), db.table('compileProgress')], (db) => checkLease(db))
        const key = `${chapter.chapterIndex}:${step}`
        if (await db.table('extractionReceipts').get(key)) continue
        update({ chapter: chapter.chapterName, step, progress: undefined })
        const textRow = await db.table<{ text: string }>('chapterTexts').get(chapter.chapterIndex)
        const text = textRow?.text ?? ''
        const inputFingerprint = await fingerprint(`${step}\n${promptOf(step)}\n${chapter.chapterIndex}\n${chapter.chapterName}\n${text}`)
        const taskId = crypto.randomUUID()
        const promptHash = await fingerprint(promptOf(step))
        await transact(db, 'rw', [db.table('pipelineRuns'), db.table('compileProgress')], async (db) => {
          await checkLease(db)
          const run = (await db.table<Run>('pipelineRuns').get(runId))!
          const timestamp = new Date().toISOString()
          const task: StoredTask = { taskId, ordinal: run.tasks?.length ?? 0, callId: crypto.randomUUID(), phase: step, status: 'running', workItemIds: [`P1:${step}:chapter:${chapter.chapterIndex}`], input: { chapterIndex: chapter.chapterIndex, chapterName: chapter.chapterName, text }, inputFingerprint, promptHash, attempt: 0, repairCount: 0, stepsUsed: 0, appliedCommitIds: [], reviewedItems: [], readSet: { records: [], queries: [] }, createdAt: timestamp, updatedAt: timestamp }
          await db.table('pipelineRuns').update(runId, { tasks: [...(run.tasks ?? []), task] })
          const saved = await db.table<Progress>('compileProgress').get('P1')
          await db.table('compileProgress').update('P1', { stepStates: { ...saved?.stepStates, [key]: { status: 'running' } } })
        })
        const failedResult = (error: unknown): CallResult => ({ ok: false, mode: 'direct', text: '', elapsedMs: 0, attempts: [], usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, costStatus: 'unknown' }, error: classifyError(error) })
        const result: CallResult & { value?: ExtractionData } = !text.trim() ? failedResult('本章原文缺失。') : await models.generate<ExtractionData>({ role: 'extraction', signal: controller.signal, repairAttempts: 2, unboundedRequests: true,
          context: { systemPrompt: promptOf(step), messages: [{ role: 'user', content: `${chapter.chapterName}\n\n${text}`, timestamp: Date.now() }], tools: [{ name: 'submit_result', description: '提交本章提取结果', parameters: schemaOf(step), constrainedSampling: { type: 'json_schema', strict: 'prefer' } }] },
          validate: message => validateExtraction(step, message), repairPrompt: '请根据错误修正，并调用 submit_result 提交本章结果。',
          beforeRequest: () => transact(db, 'rw', [db.table('pipelineRuns'), db.table('compileProgress')], (db) => checkLease(db)),
          onProgress: progress => update({ progress }),
        }).catch(error => { if (error instanceof ExecutionLost || controller.signal.aborted) throw error; return failedResult(error) })
        usage.input += result.usage.input; usage.output += result.usage.output; usage.totalTokens += result.usage.totalTokens; usage.cost += result.usage.cost ?? 0
        if (result.usage.costStatus === 'unknown') usage.costStatus = 'unknown'
        controller.signal.throwIfAborted()
        const entry: StepResult = { chapterIndex: chapter.chapterIndex, step, ok: result.ok, message: result.ok ? `${stepLabels[step]}已保存` : result.error?.message ?? '提取失败', attempts: result.attempts.length, tokens: result.usage.totalTokens, cost: result.usage.cost, elapsedMs: result.elapsedMs }
        const finishTask = async (scopeDb = db) => {
          const run = (await scopeDb.table<Run>('pipelineRuns').get(runId))!
          const tasks = (run.tasks ?? []).map(task => task.taskId === taskId ? { ...task, status: entry.ok ? 'completed' : 'failed', attempt: entry.attempts, repairCount: Math.max(0, ...result.attempts.map(attempt => attempt.turn - 1)), stepsUsed: entry.attempts, updatedAt: new Date().toISOString(), ...(entry.ok ? {} : { lastError: { code: result.error?.kind ?? 'validation', message: entry.message } }) } : task)
          await scopeDb.table('pipelineRuns').update(runId, { tasks, usage, cost: usage.cost })
          const saved = await scopeDb.table<Progress>('compileProgress').get('P1')
          await scopeDb.table('compileProgress').update('P1', { stepStates: { ...saved?.stepStates, [key]: { status: entry.ok ? 'completed' : 'failed', ...(!entry.ok ? { message: entry.message } : {}) } } })
        }
        if (result.ok && result.value) {
          try {
          await transact(db, 'rw', [db.tables], async (db) => {
            await checkLease(db)
            if (await db.table('extractionReceipts').get(key)) return
            const currentText = await db.table<{ text: string }>('chapterTexts').get(chapter.chapterIndex)
            if (currentText?.text !== text) throw new Error('本章原文已变化，请重新提取。')
            const originIds: string[] = []
            const beforeCharacters = await db.table<Character>('characters').toArray()
            const pendingRelations: { person: Character; input: ExtractedRelationInput }[] = []
            const bindingContext = createNodeBindingContext(beforeCharacters)
            const timestamp = new Date().toISOString()
            async function insert(table: 'characters' | 'locations' | 'nodes', kind: 'character' | 'location' | 'node', code: string, rows: ExtractedRow[]) {
              let sequence = 1
              let nodeOrder = kind === 'node' ? Math.max(-1, ...(await db.table<EventNode>('nodes').toArray()).filter(row => row.chapterIndex === chapter.chapterIndex).map(row => row.order)) + 1 : 0
              for (const source of (kind === 'node' ? rows : distinct(rows))) {
                let id: string
                do { id = `C${chapter.chapterIndex}-${code}${String(sequence++).padStart(3, '0')}` } while (await db.table(table).get(id) || await db.table('assetLifecycle').get(`${kind}:${id}`))
                const row: Record<string, unknown> = { ...source, id, bookId, revision: 1, createdBy: 'P1', chapterIndex: chapter.chapterIndex, chapterName: chapter.chapterName }
                const relationInputs = kind === 'character' ? (Array.isArray(source.relations) ? source.relations as Record<string, unknown>[] : []) : []
                delete row.relations
                if (kind === 'node') {
                  const quote = source.quote as string; const offset = quote ? text.indexOf(quote) : -1
                  delete row.offset
                  Object.assign(row, { order: nodeOrder++, eventLineIds: [], quoteStatus: !quote ? 'empty' : offset < 0 ? 'unmatched' : 'matched', ...(offset < 0 ? {} : { offset }) })
                  Object.assign(row, bindNodeCharacters(row as unknown as EventNode, beforeCharacters, {}, bindingContext))
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
                for (const input of relationInputs) {
                  const target = String(input.target ?? '').trim()
                  if (!target) continue
                  pendingRelations.push({ person: row as unknown as Character, input: {
                    target, relationType: String(input.relation_type ?? ''), forwardLabel: String(input.relation_label ?? ''), reverseLabel: String(input.reverse_label ?? ''),
                    direction: String(input.direction ?? ''), chapterIndex: chapter.chapterIndex, quote: String(input.quote ?? ''),
                  } })
                }
              }
            }
            await insert('characters', 'character', 'P', result.value!.characters ?? [])
            await insert('locations', 'location', 'L', result.value!.locations ?? [])
            await insert('nodes', 'node', 'N', result.value!.nodes ?? [])
            if (step === 'worldAssets') {
              const people = await db.table<Character>('characters').toArray()
              const mappings = await db.table<Lifecycle>('assetLifecycle').toArray()
              const created = pendingRelations.map(item => extractedRelation(item.person, item.input, people, mappings, timestamp))
              const existing = await db.table<CharacterRelation>('characterRelations').toArray()
              const known = new Map(existing.map(row => [row.id, row]))
              const fresh = created.filter(row => !known.has(row.id))
              if (fresh.length) await db.table('characterRelations').bulkPut(fresh)
              const synced = syncRelations([...existing, ...fresh], people, mappings, timestamp)
              if (synced.changed.length) await db.table('characterRelations').bulkPut(synced.changed)
              const nodes = await db.table<EventNode>('nodes').toArray()
              const changedNodes = remapCharacterLinks(nodes, beforeCharacters, people).filter((node, i) => node !== nodes[i])
              for (const node of changedNodes) await db.table('nodes').put({ ...node, revision: node.revision + 1 })
              const changes: AssetChange[] = changedNodes.map(node => ({ kind: 'node', id: node.id }))
              for (const relation of [...fresh, ...synced.changed]) {
                const before = known.get(relation.id)
                for (const id of [before?.sourceId, ...(before?.targetIds ?? []), relation.sourceId, ...relation.targetIds]) if (id) changes.push({ kind: 'character', id })
              }
              for (const person of people) if (!bindingContext.people.has(person.id)) changes.push({ kind: 'character', id: person.id })
              const dependentRuns = await db.table('pipelineRuns').where('stage').anyOf(['P2', 'P3']).toArray()
              await invalidateAssetProgress(dexieMergeStore(db), changes, timestamp, dependentRuns)
            }
            if (step === 'worldAssets' && !options.lane) {
            const texts = await db.table<{ chapterIndex: string; text: string }>('chapterTexts').toArray()
            for (const [table, people] of [['characters', true], ['locations', false]] as const) {
              const before = await db.table<Character | LocationAsset>(table).toArray()
              const after = updateFrequencies(before, texts, people)
              for (const [index, row] of after.entries()) if (JSON.stringify(row) !== JSON.stringify(before[index])) await db.table(table).put({ ...row, revision: row.revision + 1 })
            }
            }
            await db.table('extractionReceipts').add({ key, bookId, chapterIndex: chapter.chapterIndex, substep: step, inputFingerprint, originIds, committedAt: timestamp, runId })
            await finishTask(db)
            await saveProgress('running', db)
            controller.signal.throwIfAborted()
          })
          } catch (error) {
            if (error instanceof ExecutionLost || controller.signal.aborted || !/^(ConstraintError|DataError|ValidationError)$/.test((error as Error)?.name ?? '')) throw error
            entry.ok = false
            entry.message = error instanceof Error ? error.message : '本章结果保存校验失败。'
          }
        }
        update({ results: [...states.get(bookId)!.results, entry] })
        if (!entry.ok) await transact(db, 'rw', [db.table('pipelineRuns'), db.table('extractionReceipts'), db.table('compileProgress')], async (db) => {
          await checkLease(db)
          await finishTask(db)
          await saveProgress('running', db)
        })
      }
      if (options.lane === 'worldAssets') {
        update({ progress: undefined, chapter: '正在更新出场统计' })
        const people = await db.table<Character>('characters').toArray()
        const places = await db.table<LocationAsset>('locations').toArray()
        const personCounter = createFrequencyCounter(people, true), placeCounter = createFrequencyCounter(places, false)
        for (const chapter of chapters) {
          controller.signal.throwIfAborted()
          const text = await db.table<{ text: string }>('chapterTexts').get(chapter.chapterIndex)
          if (text) { personCounter.add({ chapterIndex: chapter.chapterIndex, text: text.text }); placeCounter.add({ chapterIndex: chapter.chapterIndex, text: text.text }) }
          await new Promise<void>(resolve => setTimeout(resolve, 0))
        }
        await transact(db, 'rw', [db.tables], async (db) => {
          await checkLease(db)
          for (const [table, before, after] of [['characters', people, personCounter.result()], ['locations', places, placeCounter.result()]] as const) {
            const changed = after.filter((row, index) => JSON.stringify(row) !== JSON.stringify(before[index])).map(row => ({ ...row, revision: row.revision + 1 }))
            if (changed.length) await db.table(table).bulkPut(changed)
          }
        })
      }
      await transact(db, 'rw', [db.table('pipelineRuns'), db.table('extractionReceipts'), db.table('compileProgress')], async (db) => {
        await checkLease(db)
        const complete = await saveProgress('running', db)
        const current = await db.table<Progress>('compileProgress').get('P1')
        const status = complete ? 'completed' : current?.failedChapters.length ? 'failed' : 'paused'
        const receipts = await db.table<Receipt>('extractionReceipts').toArray()
        const scopeDone = activeScope ? scopeComplete(receipts, chapters, activeScope) : false
        let runStatus = status
        if (current) {
          const next: Progress = { ...current, status }
          if (activeScope && scopeDone && !options.lane) delete next.reExtract
          if (options.lane && next.extractionJobs?.[options.lane]) {
            const job = next.extractionJobs[options.lane]!
            job.status = scopeComplete(receipts, chapters, options.job!) ? 'completed' : selection && options.job?.scope === 'all' ? 'paused' : 'failed'
            runStatus = job.status
            if (Object.values(next.extractionJobs).some(item => item?.status === 'running')) next.status = 'running'
          }
          await db.table('compileProgress').put(next)
        } else await db.table('compileProgress').update('P1', { status })
        await db.table('pipelineRuns').update(runId, { status: runStatus, usage, cost: usage.cost, finishedAt: new Date().toISOString() })
      })
    } catch (error) {
      const cause = heartbeatError ?? error
      const cancelled = controller.signal.aborted && !heartbeatError
      const paused = options.lane && pausedLanes.has(pauseKey)
      const message = paused ? '提取已暂停，已保存的成果保留。' : cancelled ? '提取已取消，已保存的成果保留。' : cause instanceof Error ? cause.message : '提取中断，已保存的成果保留。'
      update({ error: message })
      if (acquired) await transact(db, 'rw', [db.table('pipelineRuns'), db.table('extractionReceipts'), db.table('compileProgress')], async (db) => {
        if ((await db.table<Lease>('pipelineRuns').get(leaseId))?.owner !== owner) return
        if (options.lane && (await db.table<Progress>('compileProgress').get('P1'))?.extractionJobs?.[options.lane]?.runId !== runId) return
        const status = paused ? 'paused' : cancelled ? 'cancelled' : 'paused'
        await saveProgress(status, db)
        const run = await db.table<Run>('pipelineRuns').get(runId)
        const tasks = (run?.tasks ?? []).map(task => task.status === 'running' ? { ...task, status: cancelled && !paused ? 'cancelled' : 'partial', updatedAt: new Date().toISOString(), lastError: { code: cancelled ? 'cancelled' : 'interrupted', message } } : task)
        await db.table('pipelineRuns').update(runId, { status, tasks, usage, cost: usage.cost, finishedAt: new Date().toISOString() })
      }).catch(() => update({ error: `${message}；进度保存失败，请检查本地存储。` }))
    } finally {
      clearInterval(heartbeat)
      executionWatch?.unsubscribe()
      if (acquired) await transact(db, 'rw', [db.table('pipelineRuns')], async (db) => {
        if ((await db.table<Lease>('pipelineRuns').get(leaseId))?.owner === owner) await db.table('pipelineRuns').delete(leaseId)
        if (domainLease && (await db.table<Lease>('pipelineRuns').get(`lease:${domainLease}`))?.owner === owner) await db.table('pipelineRuns').delete(`lease:${domainLease}`)
      }).catch(() => update({ error: '任务已结束，执行锁等待到期释放。' }))
      activeControllers.delete(executionKey); pausedLanes.delete(pauseKey); update({ running: false, progress: undefined })
    }
  }
  async function start(bookId: string, selection?: Selection) {
    await withExtractionLock(workspace.scope.settingsName, bookId, () => execute(bookId, selection), () => { set(bookId, { error: '本书已有处理任务，请等待其结束。' }) })
  }
  async function reExtractPreview(bookId: string, request: ReExtractRequest): Promise<ReExtractPreview> {
    if (!await workspace.settings.books.get(bookId)) throw new Error('书籍已删除。')
    const db = workspace.openBook(bookId)
    const chapters = await db.chapters.orderBy('order').toArray()
    const blockers: string[] = []
    if (!chapters.length) blockers.push('本书没有章节，请先导入章节。')
    if (request.scope === 'chapter' && !chapters.some(chapter => chapter.chapterIndex === request.chapterIndex)) blockers.push('目标章节不存在。')
    const receipts = await db.table<Receipt>('extractionReceipts').toArray()
    if (!receipts.some(row => row.substep === request.step && (request.scope === 'all' || row.chapterIndex === request.chapterIndex))) blockers.push('该范围还没有成功凭证，请使用普通提取。')
    const progress = await db.table<Progress>('compileProgress').get('P1')
    if (progress?.reExtract) blockers.push('已有待继续的重提任务，请先继续完成。')
    const leases = await db.table<Lease>('pipelineRuns').where('recordType').equals('lease').toArray()
    if (leases.some(activeLease)) blockers.push('本书已有处理任务，请等待其结束。')
    const configured = await models.settings.read()
    if (!configured.configured || !configured.config.extractionModel) blockers.push('请先在设置中保存提取模型和密钥。')
    const scope: ReExtractScope = { ...request, startedAt: new Date().toISOString() }
    blockers.push(...await reExtractTextErrors(db, chapters, scope))
    const counts = request.scope === 'chapter' && !chapters.some(chapter => chapter.chapterIndex === request.chapterIndex)
      ? { characters: 0, locations: 0, relations: 0, nodes: 0, eventLines: 0 }
      : await transact(db, 'r', [db.tables], (db) => previewReExtractData(db, scope, chapters))
    return { counts, blockers }
  }
  async function reExtract(bookId: string, request: ReExtractRequest) {
    const preview = await reExtractPreview(bookId, request)
    if (preview.blockers.length) throw new Error(preview.blockers.join('；'))
    const scope: ReExtractScope = { ...request, startedAt: new Date().toISOString() }
    await withExtractionLock(workspace.scope.settingsName, bookId, () => execute(bookId, undefined, { reExtract: scope, clear: true }), () => { set(bookId, { error: '本书已有处理任务，请等待其结束。' }) })
  }
  async function continueReExtract(bookId: string) {
    const db = workspace.openBook(bookId)
    const progress = await db.table<Progress>('compileProgress').get('P1')
    if (!progress?.reExtract) throw new Error('没有待继续的重提任务。')
    await withExtractionLock(workspace.scope.settingsName, bookId, () => execute(bookId, undefined, { reExtract: progress.reExtract }), () => { set(bookId, { error: '本书已有处理任务，请等待其结束。' }) })
  }
  async function cancelReExtract(bookId: string) {
    const db = workspace.openBook(bookId)
    const leases = await db.table<Lease>('pipelineRuns').where('recordType').equals('lease').toArray()
    if (leases.some(activeLease)) throw new Error('提取任务正在运行，请先取消或等待结束。')
    const progress = await db.table<Progress>('compileProgress').get('P1')
    if (!progress?.reExtract) throw new Error('没有待继续的重提任务。')
    const chapters = await db.chapters.orderBy('order').toArray()
    const receipts = await db.table<Receipt>('extractionReceipts').toArray()
    const { allCovered, completedSteps: _completedSteps, ...counts } = coverage(chapters, receipts, progress.failedChapters)
    const next: Progress = { ...progress, ...counts, status: allCovered ? 'completed' : 'paused' }
    delete next.reExtract
    await db.table('compileProgress').put(next)
  }
  async function previewLane(bookId: string, step: Substep): Promise<ReExtractPreview> {
    const db = workspace.openBook(bookId)
    const chapters = await db.chapters.orderBy('order').toArray()
    const scope: ReExtractScope = { step, scope: 'all', startedAt: new Date().toISOString() }
    const blockers = await reExtractTextErrors(db, chapters, scope)
    if (!chapters.length) blockers.push('本书没有章节。')
    const configured = await models.settings.read()
    if (!configured.configured || !configured.config.extractionModel) blockers.push('请先配置提取模型和密钥。')
    const leases = await db.table<Lease>('pipelineRuns').where('recordType').equals('lease').toArray()
    if (leases.some(row => activeLease(row) && (!row.extractionStep || row.extractionStep === step))) blockers.push('该类资产已有处理任务，请先暂停或取消。')
    return { blockers, counts: await transact(db, 'r', [db.tables], (db) => previewReExtractData(db, scope, chapters)) }
  }
  async function startLane(bookId: string, step: Substep, options: { replace?: boolean; chapterIndex?: string; resume?: boolean; group?: 'together' | 'single' } = {}) {
    const key = `${bookId}:${step}`
    if (lanePromises.has(key) || controllers.has(bookId)) return
    const version = cancelVersions.get(bookId) ?? 0
    const db = workspace.openBook(bookId)
    const previous = await db.table<Progress>('compileProgress').get('P1')
    if ((cancelVersions.get(bookId) ?? 0) !== version) return
    const legacy = previous?.reExtract?.step === step ? previous.reExtract : undefined
    const saved = previous?.extractionJobs?.[step] ?? (legacy ? { ...legacy, mode: 'replace' as const, group: 'single' as const, status: 'paused' as const, runId: previous?.runId } : undefined)
    const retained = options.chapterIndex && saved?.scope === 'all' && saved.group === 'single' ? saved : undefined
    const job: ExtractionJob = retained ? { ...retained, status: 'running' } : options.resume && saved ? { ...saved, status: 'running' } : { step, scope: options.chapterIndex ? 'chapter' : 'all', ...(options.chapterIndex ? { chapterIndex: options.chapterIndex } : {}), mode: options.replace ? 'replace' : 'extract', group: options.group ?? 'single', status: 'running', startedAt: new Date().toISOString() }
    const scope: ReExtractScope | undefined = options.chapterIndex ? options.replace ? { step, scope: 'chapter', chapterIndex: options.chapterIndex, startedAt: job.startedAt } : undefined : job.mode === 'replace' ? job : undefined
    const promise = withExtractionLock(workspace.scope.settingsName, bookId, () => execute(bookId, options.chapterIndex ? { chapterIndex: options.chapterIndex, step } : undefined, { lane: step, job, reExtract: scope, clear: !!options.replace && !options.resume }), () => { set(bookId, { error: '该类提取正在其他标签页运行。' }) }, step)
    lanePromises.set(key, promise)
    try { await promise } finally { if (lanePromises.get(key) === promise) lanePromises.delete(key) }
  }
  async function startTogether(bookId: string) {
    const version = cancelVersions.get(bookId) ?? 0
    const saved = await workspace.openBook(bookId).table<Progress>('compileProgress').get('P1')
    if ((cancelVersions.get(bookId) ?? 0) !== version) return
    if (saved?.reExtract || Object.values(saved?.extractionJobs ?? {}).some(job => job?.group === 'single' && job.scope === 'all')) throw new Error('请先取消独立提取任务，再一起提取。')
    await Promise.all(substeps.map(step => startLane(bookId, step, { group: 'together', resume: saved?.extractionJobs?.[step]?.group === 'together' })))
  }
  function pauseLane(bookId: string, step: Substep) {
    const controller = laneControllers.get(bookId)?.get(step)
    if (!controller) return
    pausedLanes.add(`${bookId}:${step}`)
    controller.abort()
  }
  function pauseTogether(bookId: string) { for (const step of substeps) pauseLane(bookId, step) }
  async function cancelAll(bookId: string) {
    cancelVersions.set(bookId, (cancelVersions.get(bookId) ?? 0) + 1)
    controllers.get(bookId)?.abort()
    for (const controller of laneControllers.get(bookId)?.values() ?? []) controller.abort()
    const db = workspace.openBook(bookId)
    await transact(db, 'rw', [db.table('pipelineRuns'), db.table('compileProgress'), db.table('extractionReceipts'), db.chapters], async (db) => {
      const leases = await db.table<Lease>('pipelineRuns').where('recordType').equals('lease').toArray()
      const extraction = leases.filter(lease => extractionLeaseIds.includes(lease.id))
      for (const lease of extraction) {
        await db.table('pipelineRuns').delete(lease.id)
        for (const domain of leases.filter(row => ['lease:world', 'lease:narrative'].includes(row.id) && row.owner === lease.owner && row.runId === lease.runId)) await db.table('pipelineRuns').delete(domain.id)
      }
      for (const runId of new Set(extraction.map(lease => lease.runId).filter((id): id is string => !!id))) {
        const run = await db.table<Run>('pipelineRuns').get(runId)
        if (run?.stage === 'P1' && ['running', 'paused', 'cancelling'].includes(run.status)) await db.table('pipelineRuns').update(runId, { status: 'cancelled', finishedAt: new Date().toISOString() })
      }
      const previous = await db.table<Progress>('compileProgress').get('P1')
      if (!previous) return
      const receipts = await db.table<Receipt>('extractionReceipts').toArray()
      const chapters = await db.chapters.orderBy('order').toArray()
      const { allCovered, completedSteps: _completedSteps, ...counts } = coverage(chapters, receipts, previous.failedChapters)
      const stepStates = Object.fromEntries(Object.entries(previous.stepStates ?? {}).map(([key, state]) => [key, state.status === 'running' ? { status: 'cancelled' } : state]))
      const next = { ...previous, ...counts, stepStates, status: allCovered ? 'completed' : 'paused', updatedAt: new Date().toISOString() }
      delete next.extractionJobs; delete next.reExtract
      await db.table('compileProgress').put(next)
    })
    await Promise.all(substeps.map(step => lanePromises.get(`${bookId}:${step}`)))
  }
  async function extractChapter(bookId: string, chapterIndex: string, step: Substep) {
    const receipt = await workspace.openBook(bookId).table('extractionReceipts').get(`${chapterIndex}:${step}`)
    await startLane(bookId, step, { chapterIndex, replace: !!receipt })
  }
  async function recoverLanes(bookId: string, progress?: Progress) {
    const db = workspace.openBook(bookId)
    for (const step of substeps) {
      if (laneControllers.get(bookId)?.has(step)) continue
      const leaseId = `lease:extraction:${step}`
      const lease = await db.table<Lease>('pipelineRuns').get(leaseId)
      const job = progress?.extractionJobs?.[step]
      if (lease && activeLease(lease) && job || !lease && job?.status !== 'running') continue
      await withExtractionLock(workspace.scope.settingsName, bookId, async () => {
        await transact(db, 'rw', [db.table('pipelineRuns'), db.table('compileProgress')], async (db) => {
          const current = await db.table<Progress>('compileProgress').get('P1')
          const currentLease = await db.table<Lease>('pipelineRuns').get(leaseId)
          if (currentLease && activeLease(currentLease) && current?.extractionJobs?.[step]) return
          if (current?.extractionJobs) {
            const currentJob = current.extractionJobs[step]
            if (currentJob?.status === 'running') currentJob.status = 'paused'
            const status = Object.values(current.extractionJobs).some(item => item?.status === 'running') ? 'running' : current.status === 'completed' ? 'completed' : 'paused'
            await db.table('compileProgress').put({ ...current, status })
          }
          if (currentLease) {
            await db.table('pipelineRuns').delete(leaseId)
            const domainId = `lease:${step === 'worldAssets' ? 'world' : 'narrative'}`
            const domain = await db.table<Lease>('pipelineRuns').get(domainId)
            if (domain?.owner === currentLease.owner && domain?.runId === currentLease.runId) await db.table('pipelineRuns').delete(domainId)
          }
        })
      }, () => undefined, step)
    }
  }
  async function recover(bookId: string) {
    if (controllers.has(bookId)) return
    const target = workspace.openBook(bookId)
    const saved = await target.table<Progress>('compileProgress').get('P1')
    if (saved && !saved.stepStates && saved.runId) {
      await transact(target, 'rw', [target.table('pipelineRuns'), target.table('compileProgress')], async (target) => {
        const current = await target.table<Progress>('compileProgress').get('P1')
        if (!current?.runId || current.stepStates) return
        const run = await target.table<Run>('pipelineRuns').get(current.runId)
        const stepStates = Object.fromEntries((run?.tasks ?? []).map(task => [`${task.input.chapterIndex}:${task.phase}`, { status: task.status, ...(task.lastError ? { message: task.lastError.message } : {}) }]))
        await target.table('compileProgress').put({ ...current, stepStates, ...(run?.usage ? { usage: run.usage } : {}) })
      })
    }
    await recoverLanes(bookId, saved)
    if (saved?.extractionJobs) return
    const needed = await transact(target, 'r', [target.chapters, target.table('pipelineRuns'), target.table('extractionReceipts'), target.table('compileProgress')], async (target) => {
      const previous = await target.table<Progress>('compileProgress').get('P1')
      if (!previous || previous.status === 'idle') return false
      const lease = await target.table<Lease>('pipelineRuns').get('lease:extraction')
      if (lease && activeLease(lease) && ['running', 'cancelling'].includes(previous.status)) return false
      if (!lease && !['running', 'cancelling', 'completed'].includes(previous.status)) return false
      if (!lease && previous.status === 'completed' && coverage(await target.chapters.toArray(), await target.table<Receipt>('extractionReceipts').toArray()).allCovered) return false
      return true
    })
    if (!needed) return
    await withExtractionLock(workspace.scope.settingsName, bookId, async () => {
      const db = workspace.openBook(bookId)
      await transact(db, 'rw', [db.tables], async (db) => {
        const previous = await db.table<Progress>('compileProgress').get('P1')
        if (!previous) return
        const lease = await db.table<Lease>('pipelineRuns').get('lease:extraction')
        if (lease && activeLease(lease) && ['running', 'cancelling'].includes(previous.status)) return
        const receipts = await checkReceiptSources(db, bookId)
        const chapters = await db.chapters.orderBy('order').toArray()
        const { allCovered, completedSteps: _completedSteps, ...counts } = coverage(chapters, receipts, previous.failedChapters)
        const status = allCovered ? 'completed' : ['running', 'cancelling', 'completed'].includes(previous.status) ? 'paused' : previous.status
        const next = { ...previous, ...counts, status }
        if (JSON.stringify(next) !== JSON.stringify(previous)) await db.table('compileProgress').put(next)
        if (lease) {
          await db.table('pipelineRuns').delete(lease.id)
          for (const id of ['lease:world', 'lease:narrative']) {
            const domain = await db.table<Lease>('pipelineRuns').get(id)
            if (domain?.owner === lease.owner && domain?.runId === lease.runId) await db.table('pipelineRuns').delete(id)
          }
        }
        const run = previous.runId ? await db.table<Run>('pipelineRuns').get(previous.runId) : undefined
        if (run && (run.status === 'running' || run.status === 'completed' && !allCovered)) await db.table('pipelineRuns').update(run.id, { status: allCovered ? 'completed' : 'paused', tasks: (run.tasks ?? []).map(task => task.status === 'running' ? { ...task, status: 'partial', updatedAt: new Date().toISOString(), lastError: { code: 'interrupted', message: '任务中断，可继续处理尚未完成的步骤。' } } : task) })
      })
    }, () => undefined)
  }
  return { startTogether, startLane, pauseLane, pauseTogether, cancelAll, extractChapter, previewLane, laneState: (bookId: string, step: Substep) => laneStates.get(bookId)?.[step], start, retry: (bookId: string, chapterIndex: string, step: Substep) => start(bookId, { chapterIndex, step }), reExtractPreview, reExtract, continueReExtract, cancelReExtract, recover, cancel: (bookId: string) => controllers.get(bookId)?.abort(), state: (bookId: string) => states.get(bookId),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async progress(bookId: string) {
      const db = workspace.openBook(bookId)
      return transact(db, 'r', [db.chapters, db.table('extractionReceipts'), db.table('compileProgress'), db.table('pipelineRuns')], async (db) => {
        const saved = await db.table<Progress>('compileProgress').get('P1')
        const progress: Progress = saved ?? { bookId, stage: 'P1', status: 'idle', totalChapters: 0, completedChapters: [], failedChapters: [], updatedAt: new Date().toISOString(), stepStates: {} }
        const run = !progress.stepStates && progress.runId ? await db.table<Run>('pipelineRuns').get(progress.runId) : undefined
        const chapters = await db.chapters.orderBy('order').toArray()
        const receipts = await db.table<Receipt>('extractionReceipts').toArray()
        const keys = new Set(receipts.map(row => row.key))
        const leases = await db.table<Lease>('pipelineRuns').where('recordType').equals('lease').toArray()
        const extractionLeases = leases.filter(row => row.id.startsWith('lease:extraction'))
        const legacyLease = extractionLeases.find(row => row.id === 'lease:extraction')
        const stored = progress.stepStates ?? Object.fromEntries((run?.tasks ?? []).map(task => [`${task.input.chapterIndex}:${task.phase}`, { status: task.status, message: task.lastError?.message }]))
        const failures = Object.entries(stored).filter(([key, item]) => ['failed', 'partial'].includes(item.status) && !keys.has(key)).map(([key, item]) => ({ chapterIndex: key.slice(0, key.lastIndexOf(':')), step: key.slice(key.lastIndexOf(':') + 1) as Substep, message: item.message ?? '任务中断，可继续提取。' }))
        const { allCovered, ...counts } = coverage(chapters, receipts, failures.filter(item => stored[`${item.chapterIndex}:${item.step}`]?.status === 'failed').map(item => item.chapterIndex))
        const status = !saved && allCovered ? 'completed' : progress.status === 'completed' && !allCovered || progress.status === 'failed' && !counts.failedChapters.length ? 'paused' : progress.status
        const steps = Object.fromEntries(chapters.map(chapter => [chapter.chapterIndex, Object.fromEntries(substeps.map(step => {
          const key = `${chapter.chapterIndex}:${step}`, task = stored[key]
          const leased = !!legacyLease || extractionLeases.some(row => row.extractionStep === step)
          const state: ExtractionStepStatus = keys.has(key) ? 'completed' : task?.status === 'running' && leased ? 'running' : task?.status === 'failed' ? 'failed' : task ? 'interrupted' : 'pending'
          return [step, { status: state, message: task?.message }]
        }))])) as Record<string, Record<Substep, { status: ExtractionStepStatus; message?: string }>>
        const extractionJobs = { ...progress.extractionJobs }
        if (progress.reExtract && !extractionJobs[progress.reExtract.step]) extractionJobs[progress.reExtract.step] = { ...progress.reExtract, mode: 'replace', group: 'single', status: legacyLease ? 'running' : 'paused', runId: progress.runId }
        return { ...progress, ...counts, extractionJobs, status, steps, busy: extractionLeases.length > 0, externalBusy: leases.some(row => !row.extractionStep && !row.id.startsWith('lease:extraction') && activeLease(row)), canOrganize: allCovered && status === 'completed' && extractionLeases.length === 0, usage: progress.usage ?? run?.usage, failures }
      })

    },
  }
}
export type ExtractionService = ReturnType<typeof createExtractionService>
