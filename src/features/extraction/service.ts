import type { Chapter, createWorkspace } from '../../lib/storage/workspace'
import type { ModelService } from '../models/service'
import type { CallResult, CallProgress } from '../models/types'
import { classifyError } from '../models/policy'
import { bindNodeCharacters, remapCharacterLinks } from '../assets/characterLinks'
import { dexieMergeStore } from '../assets/mergeCore'
import { invalidateAssetProgress, type AssetChange } from '../assets/invalidate'
import { extractedRelation, syncRelations, type ExtractedRelationInput } from '../assets/relations'
import { normalizeCharacterNames } from '../assets/characterNames'
import { rebuildFacts, updateFrequencies } from '../assets/derive'
import type { Character, CharacterRelation, EventNode, Lifecycle, LocationAsset } from '../assets/types'
import { stepLabels, substeps, type ExtractionData, type ExtractedRow, type Substep } from './types'
import { checkReceiptSources, coverage, withExtractionLock, type Lease, type Progress, type Receipt, type ReExtractScope, type Run, type SavedUsage, type StoredTask } from './recovery'
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
const activeLease = (row: Lease) => row.recordType === 'lease' && (row.expiresAt === undefined || Number(row.expiresAt) > Date.now())

export function createExtractionService(workspace: Workspace, models: Pick<ModelService, 'generate' | 'settings'>) {
  const states = new Map<string, ExtractionState>()
  const controllers = new Map<string, AbortController>()
  const listeners = new Set<() => void>()
  const set = (bookId: string, change: Partial<ExtractionState>) => { states.set(bookId, { ...(states.get(bookId) ?? { running: false, results: [] }), ...change }); listeners.forEach(listener => listener()) }
  async function execute(bookId: string, selection?: Selection, options: { reExtract?: ReExtractScope; clear?: boolean } = {}) {
    if (controllers.has(bookId)) return
    const controller = new AbortController(); controllers.set(bookId, controller)
    const db = workspace.openBook(bookId)
    let runId: string = crypto.randomUUID(); const owner = crypto.randomUUID()
    let acquired = false
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let heartbeatError: unknown
    let chapters: Chapter[] = []
    const initialProgress = await db.table<Progress>('compileProgress').get('P1')
    const activeScope = options.reExtract ?? (selection ? undefined : initialProgress?.reExtract)
    const domainLease = activeScope ? (activeScope.step === 'worldAssets' ? 'world' : 'narrative') : undefined
    const usage: SavedUsage = { input: 0, output: 0, totalTokens: 0, cost: 0, costStatus: 'estimated' }
    const checkLease = async () => {
      controller.signal.throwIfAborted()
      const lease = await db.table<Lease>('pipelineRuns').get('lease:extraction')
      if (lease?.owner !== owner || lease.runId !== runId) throw new ExecutionLost('提取任务已由其他执行者接管，当前任务已停止写入。')
      const progress = await db.table<Progress>('compileProgress').get('P1')
      if (progress?.runId !== runId) throw new ExecutionLost('当前书籍已有其他提取任务。')
      if (domainLease) {
        const domain = await db.table<Lease>('pipelineRuns').get(`lease:${domainLease}`)
        if (domain?.owner !== owner || domain.runId !== runId || Number(domain.expiresAt ?? 0) <= Date.now()) throw new ExecutionLost('重提目标范围的执行权已失效。')
      }
      const others = await db.table<Lease>('pipelineRuns').where('recordType').equals('lease').toArray()
      if (others.some(row => row.recordType === 'lease' && row.id !== lease.id && !(row.owner === owner && row.runId === runId) && (row.expiresAt === undefined || row.expiresAt > Date.now()))) throw new ExecutionLost('本书已有其他处理任务，当前提取已暂停。')
      await db.table('pipelineRuns').update(lease.id, { expiresAt: Date.now() + 30000 })
      if (domainLease) await db.table('pipelineRuns').update(`lease:${domainLease}`, { expiresAt: Date.now() + 30000 })
    }
    async function saveProgress(status: string) {
      const receipts = await db.table<Receipt>('extractionReceipts').toArray()
      const previous = await db.table<Progress>('compileProgress').get('P1')
      const run = await db.table<Run>('pipelineRuns').get(runId)
      const latest = new Map((run?.tasks ?? []).map(task => [`${task.input.chapterIndex}:${task.phase}`, task]))
      const failed = latest.size ? [...latest.values()].filter(task => task.status === 'failed' && !receipts.some(row => row.key === `${task.input.chapterIndex}:${task.phase}`)).map(task => task.input.chapterIndex) : previous?.failedChapters ?? []
      const { completedChapters, failedChapters, partialChapters } = coverage(chapters, receipts, failed)
      await db.table('compileProgress').put({ bookId, stage: 'P1', status, totalChapters: chapters.length, completedChapters, failedChapters, partialChapters, updatedAt: new Date().toISOString(), runId, scope: 'fullBook', planVersion: '2.2', unit: 'chapter', validity: 'current', ...(previous?.reExtract ? { reExtract: previous.reExtract } : {}) })
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
      if (selection && (!chapters.some(chapter => chapter.chapterIndex === selection.chapterIndex) || !substeps.includes(selection.step))) throw new Error('补提取的章节或步骤不存在。')
      await db.transaction('r', db.tables, () => checkReceiptSources(db, bookId))
      await db.transaction('rw', db.table('pipelineRuns'), db.table('compileProgress'), async () => {
        const leases = await db.table<Lease>('pipelineRuns').where('recordType').equals('lease').toArray()
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
        if (domainLease) await db.table('pipelineRuns').put({ id: `lease:${domainLease}`, recordType: 'lease', bookId, lockKey: domainLease, owner, runId, expiresAt: Date.now() + 30000 })
        await db.table('compileProgress').update('P1', { runId })
      }); acquired = true
      heartbeat = setInterval(() => { void db.transaction('rw', db.table('pipelineRuns'), async () => {
        const lease = await db.table<Lease>('pipelineRuns').get('lease:extraction')
        if (lease?.owner !== owner || lease.runId !== runId) throw new ExecutionLost('提取任务已由其他执行者接管。')
        await db.table('pipelineRuns').update(lease.id, { expiresAt: Date.now() + 30000 })
        if (domainLease) {
          const domain = await db.table<Lease>('pipelineRuns').get(`lease:${domainLease}`)
          if (domain?.owner !== owner || domain.runId !== runId) throw new ExecutionLost('重提目标范围的执行权已失效。')
          await db.table('pipelineRuns').update(`lease:${domainLease}`, { expiresAt: Date.now() + 30000 })
        }
      }).catch(error => { if (error instanceof ExecutionLost) { heartbeatError = error; controller.abort() } }) }, 8000)
      if (options.clear && activeScope) {
        await db.transaction('rw', db.tables, async () => {
          await checkLease()
          await clearReExtractData(db, activeScope, chapters, new Date().toISOString())
          const previous = await db.table<Progress>('compileProgress').get('P1')
          if (previous) await db.table('compileProgress').put({ ...previous, reExtract: activeScope, status: 'running', updatedAt: new Date().toISOString() })
          await saveProgress('running')
        })
      }
      await db.transaction('rw', db.table('pipelineRuns'), db.table('extractionReceipts'), db.table('compileProgress'), () => saveProgress('running'))
      for (const chapter of chapters) for (const step of substeps) {
        if (selection && (chapter.chapterIndex !== selection.chapterIndex || step !== selection.step)) continue
        if (!selection && activeScope && (step !== activeScope.step || activeScope.scope === 'chapter' && chapter.chapterIndex !== activeScope.chapterIndex)) continue
        controller.signal.throwIfAborted()
        await db.transaction('rw', db.table('pipelineRuns'), db.table('compileProgress'), checkLease)
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
        const failedResult = (error: unknown): CallResult => ({ ok: false, mode: 'direct', text: '', elapsedMs: 0, attempts: [], usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, costStatus: 'unknown' }, error: classifyError(error) })
        const result: CallResult & { value?: ExtractionData } = !text ? failedResult('本章原文缺失。') : await models.generate<ExtractionData>({ role: 'extraction', signal: controller.signal, maxRequests: 3, repairAttempts: 2,
          context: { systemPrompt: promptOf(step), messages: [{ role: 'user', content: `章节标识：${chapter.chapterIndex}\n章节名：${chapter.chapterName}\n\n--- 正文开始 ---\n${text}\n--- 正文结束 ---`, timestamp: Date.now() }], tools: [{ name: 'submit_result', description: '提交本章提取结果', parameters: schemaOf(step), constrainedSampling: { type: 'json_schema', strict: 'prefer' } }] },
          validate: message => validateExtraction(step, message, text), repairPrompt: '请按字段要求修正并调用唯一的 submit_result 提交本章结果；其他工具未执行。',
          beforeRequest: () => db.transaction('rw', db.table('pipelineRuns'), db.table('compileProgress'), checkLease),
          onProgress: progress => set(bookId, { progress }),
        }).catch(error => { if (error instanceof ExecutionLost || controller.signal.aborted) throw error; return failedResult(error) })
        usage.input += result.usage.input; usage.output += result.usage.output; usage.totalTokens += result.usage.totalTokens; usage.cost += result.usage.cost ?? 0
        if (result.usage.costStatus === 'unknown') usage.costStatus = 'unknown'
        controller.signal.throwIfAborted()
        const entry: StepResult = { chapterIndex: chapter.chapterIndex, step, ok: result.ok, message: result.ok ? `${stepLabels[step]}已保存` : result.error?.message ?? '提取失败', attempts: result.attempts.length, tokens: result.usage.totalTokens, cost: result.usage.cost, elapsedMs: result.elapsedMs }
        const finishTask = async () => {
          const run = (await db.table<Run>('pipelineRuns').get(runId))!
          const tasks = (run.tasks ?? []).map(task => task.taskId === taskId ? { ...task, status: entry.ok ? 'completed' : 'failed', attempt: entry.attempts, repairCount: Math.max(0, ...result.attempts.map(attempt => attempt.turn - 1)), stepsUsed: entry.attempts, updatedAt: new Date().toISOString(), ...(entry.ok ? {} : { lastError: { code: result.error?.kind ?? 'validation', message: entry.message } }) } : task)
          await db.table('pipelineRuns').update(runId, { tasks, usage, cost: usage.cost })
        }
        if (result.ok && result.value) {
          try {
          await db.transaction('rw', db.tables, async () => {
            await checkLease()
            if (await db.table('extractionReceipts').get(key)) return
            const currentText = await db.table<{ text: string }>('chapterTexts').get(chapter.chapterIndex)
            if (currentText?.text !== text) throw new Error('本章原文已变化，请重新提取。')
            const originIds: string[] = []
            const beforeCharacters = await db.table<Character>('characters').toArray()
            const pendingRelations: { person: Character; input: ExtractedRelationInput }[] = []
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
                  Object.assign(row, bindNodeCharacters(row as unknown as EventNode, await db.table<Character>('characters').toArray()))
                } else {
                  Object.assign(row, { sourceChapters: [chapter.chapterIndex], nameSource: 'extracted' })
                  if (kind === 'character') {
                    row.aliases = source.aliases_mentioned ?? []; delete row.aliases_mentioned
                    Object.assign(row, normalizeCharacterNames(row as unknown as Character))
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
              const known = new Set(existing.map(row => row.id))
              const fresh = created.filter(row => !known.has(row.id))
              if (fresh.length) await db.table('characterRelations').bulkPut(fresh)
              const synced = syncRelations([...existing, ...fresh], people, mappings, timestamp)
              if (synced.changed.length) await db.table('characterRelations').bulkPut(synced.changed)
              const nodes = await db.table<EventNode>('nodes').toArray()
              const changedNodes = remapCharacterLinks(nodes, beforeCharacters, people).filter((node, i) => node !== nodes[i])
              for (const node of changedNodes) await db.table('nodes').put({ ...node, revision: node.revision + 1 })
              const changes: AssetChange[] = changedNodes.map(node => ({ kind: 'node', id: node.id }))
              for (const relation of [...fresh, ...synced.changed]) {
                const before = existing.find(row => row.id === relation.id)
                for (const id of [before?.sourceId, ...(before?.targetIds ?? []), relation.sourceId, ...relation.targetIds]) if (id) changes.push({ kind: 'character', id })
              }
              for (const person of people) if (!beforeCharacters.some(row => row.id === person.id)) changes.push({ kind: 'character', id: person.id })
              await invalidateAssetProgress(dexieMergeStore(db), changes, timestamp)
            }
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
          } catch (error) {
            if (error instanceof ExecutionLost || controller.signal.aborted || !/^(ConstraintError|DataError|ValidationError)$/.test((error as Error)?.name ?? '')) throw error
            entry.ok = false
            entry.message = error instanceof Error ? error.message : '本章结果保存校验失败。'
          }
        }
        set(bookId, { results: [...states.get(bookId)!.results, entry] })
        await db.transaction('rw', db.table('pipelineRuns'), db.table('extractionReceipts'), db.table('compileProgress'), async () => {
          await checkLease()
          await finishTask()
          await saveProgress('running')
        })
      }
      await db.transaction('rw', db.table('pipelineRuns'), db.table('extractionReceipts'), db.table('compileProgress'), async () => {
        await checkLease()
        const complete = await saveProgress('running')
        const current = await db.table<Progress>('compileProgress').get('P1')
        const status = complete ? 'completed' : current?.failedChapters.length ? 'failed' : 'paused'
        const receipts = await db.table<Receipt>('extractionReceipts').toArray()
        const scopeDone = activeScope ? scopeComplete(receipts, chapters, activeScope) : false
        if (current) {
          const next: Progress = { ...current, status }
          if (activeScope && scopeDone) delete next.reExtract
          await db.table('compileProgress').put(next)
        } else await db.table('compileProgress').update('P1', { status })
        await db.table('pipelineRuns').update(runId, { status, usage, cost: usage.cost, finishedAt: new Date().toISOString() })
      })
    } catch (error) {
      const cause = heartbeatError ?? error
      const cancelled = controller.signal.aborted && !heartbeatError
      const message = cancelled ? '提取已取消，已保存的成果保留。' : cause instanceof Error ? cause.message : '提取中断，已保存的成果保留。'
      set(bookId, { error: message })
      if (acquired) await db.transaction('rw', db.table('pipelineRuns'), db.table('extractionReceipts'), db.table('compileProgress'), async () => {
        if ((await db.table<Lease>('pipelineRuns').get('lease:extraction'))?.owner !== owner) return
        const status = cancelled ? 'cancelled' : 'paused'
        await saveProgress(status)
        const run = await db.table<Run>('pipelineRuns').get(runId)
        const tasks = (run?.tasks ?? []).map(task => task.status === 'running' ? { ...task, status: cancelled ? 'cancelled' : 'partial', updatedAt: new Date().toISOString(), lastError: { code: cancelled ? 'cancelled' : 'interrupted', message } } : task)
        await db.table('pipelineRuns').update(runId, { status, tasks, usage, cost: usage.cost, finishedAt: new Date().toISOString() })
      }).catch(() => set(bookId, { error: `${message}；进度保存失败，请检查本地存储。` }))
    } finally {
      clearInterval(heartbeat)
      if (acquired) await db.transaction('rw', db.table('pipelineRuns'), async () => {
        if ((await db.table<Lease>('pipelineRuns').get('lease:extraction'))?.owner === owner) await db.table('pipelineRuns').delete('lease:extraction')
        if (domainLease && (await db.table<Lease>('pipelineRuns').get(`lease:${domainLease}`))?.owner === owner) await db.table('pipelineRuns').delete(`lease:${domainLease}`)
      }).catch(() => set(bookId, { error: '任务已结束，执行锁等待到期释放。' }))
      controllers.delete(bookId); set(bookId, { running: false, progress: undefined })
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
    const counts = request.scope === 'chapter' && !chapters.some(chapter => chapter.chapterIndex === request.chapterIndex)
      ? { characters: 0, locations: 0, relations: 0, nodes: 0, eventLines: 0 }
      : await db.transaction('r', db.tables, () => previewReExtractData(db, scope, chapters))
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
  return { start, retry: (bookId: string, chapterIndex: string, step: Substep) => start(bookId, { chapterIndex, step }), reExtractPreview, reExtract, continueReExtract, recover, cancel: (bookId: string) => controllers.get(bookId)?.abort(), state: (bookId: string) => states.get(bookId),
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
        const status = progress.status === 'completed' && !allCovered || progress.status === 'failed' && !counts.failedChapters.length ? 'paused' : progress.status
        const failures = [...new Map((run?.tasks ?? []).filter(task => task.status === 'failed' || task.status === 'partial').filter(task => !receipts.some(receipt => receipt.key === `${task.input.chapterIndex}:${task.phase}`)).map(task => [`${task.input.chapterIndex}:${task.phase}`, { chapterIndex: task.input.chapterIndex, step: task.phase, message: task.lastError?.message ?? '任务中断，可继续提取。' }])).values()]
        const latest = new Map((run?.tasks ?? []).map(task => [`${task.input.chapterIndex}:${task.phase}`, task]))
        const steps = Object.fromEntries(chapters.map(chapter => [chapter.chapterIndex, Object.fromEntries(substeps.map(step => {
          const key = `${chapter.chapterIndex}:${step}`, task = latest.get(key)
          const state: ExtractionStepStatus = receipts.some(row => row.key === key) ? 'completed' : task?.status === 'running' && !!lease ? 'running' : task?.status === 'failed' ? 'failed' : task ? 'interrupted' : 'pending'
          return [step, { status: state, message: task?.lastError?.message }]
        }))])) as Record<string, Record<Substep, { status: ExtractionStepStatus; message?: string }>>
        return { ...progress, ...counts, status, steps, busy: !!lease, canOrganize: allCovered && status === 'completed' && !lease, usage: run?.usage, failures }

      })
    },
  }
}
export type ExtractionService = ReturnType<typeof createExtractionService>
