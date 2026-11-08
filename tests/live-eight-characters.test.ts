import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { afterEach, it } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createImportService } from '../src/lib/storage/importService'
import { createBackupService } from '../src/features/backup/service'
import { createAssetService } from '../src/features/assets/service'
import { createModelService } from '../src/features/models/service'
import { createWorldService } from '../src/features/world/service'
import { defaultConfig } from '../src/features/models/types'
import { emptyReport } from '../src/features/world/types'
import type { Character } from '../src/features/assets/types'

const names = ['贾政', '牛继宗', '裘良', '宝珠', '瑞珠', '贾代儒', '贾瑞', '贾蔷']
const opened: ReturnType<typeof createWorkspace>[] = []
const key = (() => {
  if (process.env.WESTWORLD_TEST_API_KEY) return process.env.WESTWORLD_TEST_API_KEY
  try {
    const file = readFileSync('.env.local', 'utf8')
    return file.split(/\r?\n/).find(line => line.startsWith('WESTWORLD_TEST_API_KEY='))?.slice('WESTWORLD_TEST_API_KEY='.length) ?? ''
  } catch { return '' }
})()
afterEach(async () => { for (const workspace of opened.splice(0)) { workspace.close(); for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name) } })

const phrases = (value: unknown) => String(value ?? '').split(/[；;]/).map(text => text.trim()).filter(Boolean)

it.skipIf(!key)('真实8人：使用修改前值重建未优化样本，逐人处理并记录请求用量', async () => {
  const backupPath = process.env.WESTWORLD_EIGHT_BACKUP ?? '红楼之挽天-三河帮-2026-11-05T15-00-00-001Z-289280b5.wwv2'
  const id = crypto.randomUUID(), workspace = createWorkspace({ settingsName: `live-eight-${id}`, bookPrefix: `live-eight-${id}-` }); opened.push(workspace)
  const importer = createImportService(workspace)
  try {
    const bytes = new Uint8Array(readFileSync(backupPath))
    const book = await createBackupService(workspace, importer).importBackup(bytes)
    const db = workspace.openBook(book.id)
    const people = await db.table<Character>('characters').toArray()
    const targets = names.map(name => people.find(row => row.name === name)).filter((row): row is Character => !!row)
    if (targets.length !== names.length) throw new Error(`样本缺少人物：${names.filter(name => !people.some(row => row.name === name)).join('、')}`)
    const targetIds = new Set(targets.map(row => row.id))
    const runs = await db.table<Record<string, unknown>>('pipelineRuns').toArray()
    const edits = runs.flatMap(run => ((run.report as Record<string, unknown> | undefined)?.assetEdits as Record<string, unknown>[] | undefined) ?? [])
      .filter(edit => edit.kind === 'character' && targetIds.has(String(edit.id)))
    const rebuilt: Record<string, unknown>[] = []
    for (const edit of edits) {
      const row = await db.table<Character>('characters').get(String(edit.id))
      if (!row) continue
      const before: Record<string, unknown> = {}
      for (const change of (edit.fieldChanges as Record<string, unknown>[] | undefined) ?? []) {
        if (!String(change.field).startsWith('profile.')) before[String(change.field)] = change.before
      }
      const editedFields = new Set(Object.keys(before))
      const keptFacts = ((row.mergeFacts ?? []) as { field: string; text: string; id: string; chapters: string[] }[]).filter(fact => !editedFields.has(fact.field))
      const facts = [...keptFacts, ...[...editedFields].flatMap(field => phrases(before[field]).map(text => ({ id: crypto.randomUUID(), field, text, chapters: row.sourceChapters ?? (row.chapterIndex ? [row.chapterIndex] : []) })))]
      await db.table('characters').put({ ...row, ...before, mergeFacts: facts, optimizedFactIds: [], updatedAt: new Date().toISOString() })
      rebuilt.push({ id: row.id, name: row.name, before, facts: facts.length })
    }
    const prepared = await Promise.all(targets.map(async target => ({ ...(await db.table<Character>('characters').get(target.id))! })))
    const runId = crypto.randomUUID(), sessionId = crypto.randomUUID(), now = new Date().toISOString()
    await db.table('storySessions').put({ id: sessionId, bookId: book.id, profile: 'asset_editor', kind: 'organization', title: '人物整理', status: 'active', nextOrdinal: 0, workflow: 'character_organization_v1', runId, createdAt: now, updatedAt: now })
    await db.table('pipelineRuns').put({
      id: runId, bookId: book.id, recordType: 'run', stage: 'P2', phase: 'character_organization', workflow: 'character_organization_v1', sessionId, status: 'paused', startedAt: now, planVersion: '2.2', scope: 'fullBook', tasks: [], commandIntents: [], appliedCommands: [], coverageItems: [], aiMode: 'agent', report: emptyReport({ characters: people.length, locations: await db.table('locations').count() }),
      organization: {
        version: 1, reviewVersion: 2, executionVersion: 4, step: 'profiles', revision: 1, statisticsPending: false,
        contexts: { identity: { id: 'identity', status: 'completed', pendingWorkId: null }, profiles: { id: 'profiles', status: 'active', pendingWorkId: null }, relations: { id: 'relations', status: 'pending', pendingWorkId: null } },
        activeWork: null, scanIds: [...targetIds], scanPages: [], candidateGroups: [], candidateDecisions: [],
        profileItems: prepared.map(row => ({ id: row.id, name: row.name, status: 'pending', outcome: null, reason: '', contentFingerprint: '', readRefs: [], commitIds: [] })), relationItems: [], pairChecks: [],
      },
    })
    await db.table('compileProgress').put({ bookId: book.id, stage: 'P2', status: 'paused', runId, totalChapters: await db.chapters.count(), completedChapters: [], failedChapters: [], updatedAt: now, scope: 'fullBook', planVersion: '2.2', unit: 'item', validity: 'stale' })
    const models = createModelService(workspace, { fetch: globalThis.fetch.bind(globalThis), wait: async (ms, signal) => new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); const abort = () => { clearTimeout(timer); reject(signal.reason) }; signal.addEventListener('abort', abort, { once: true }) }) })
    await models.settings.save({ ...defaultConfig, providerId: process.env.WESTWORLD_TEST_PROVIDER ?? 'deepseek', baseUrl: process.env.WESTWORLD_TEST_BASE_URL ?? defaultConfig.baseUrl, aggregationModel: process.env.WESTWORLD_TEST_MODEL ?? 'deepseek-flash' }, key)
    const service = createWorldService(workspace, models, createAssetService(workspace), { assetReview: false })
    let cancelled = false, started = false
    const finished = new Promise<void>(resolve => {
      service.subscribe(() => {
        const state = service.state(book.id)
        if (state?.running) started = true
        if (state?.running && state.processed >= names.length && !cancelled) { cancelled = true; service.cancel(book.id) }
        if (started && !state?.running) resolve()
      })
    })
    await service.startOrganization(book.id)
    await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error('8人验证超时。')), 300000))])
    const run = (await service.reports(book.id))[0]!
    const after = await Promise.all(targets.map(async target => ({ before: prepared.find(row => row.id === target.id), after: await db.table<Character>('characters').get(target.id), item: run.organization?.profileItems.find(row => row.id === target.id), edits: (run.report.assetEdits ?? []).filter(edit => edit.id === target.id) })))
    const sessionEntries = (await db.table<Record<string, unknown>>('storySessionEntries').toArray()).filter(entry => entry.sessionId === sessionId)
    const traces = sessionEntries.filter(entry => entry.type === 'request_trace' && typeof entry.requestId === 'string')
    const snapshots = sessionEntries.filter(entry => entry.type === 'prompt_snapshot' || entry.type === 'tool_snapshot')
    const turns = sessionEntries.filter(entry => entry.type === 'message' && (entry.message as Record<string, unknown> | undefined)?.role === 'assistant').map(entry => {
      const message = entry.message as { content?: { type: string; name?: string }[] }
      return { unitId: entry.unitId, tools: (message.content ?? []).filter(part => part.type === 'toolCall').map(part => part.name) }
    }).filter(turn => (turn.tools ?? []).length)
    const toolErrors = sessionEntries.filter(entry => entry.type === 'message' && (entry.message as Record<string, unknown> | undefined)?.role === 'toolResult' && (entry.message as Record<string, unknown>).isError === true).map(entry => ({ unitId: entry.unitId, toolName: (entry.message as Record<string, unknown>).toolName, text: String(((entry.message as Record<string, unknown>).content as { text?: string }[] | undefined)?.map(part => part.text ?? '').join('') ?? '').slice(0, 300) }))
    const evidence = {
      book: book.title, turns, toolErrors, model: 'deepseek-flash', source: backupPath, rebuilt,
      characters: after.map(row => ({ id: row.after?.id, name: row.after?.name, outcome: row.item?.outcome, reason: row.item?.reason, commitIds: row.item?.commitIds, before: row.before, after: row.after, edits: row.edits })),
      requests: run.requestLedger?.length ?? 0, ledger: run.requestLedger, usage: (run as typeof run & { usage?: unknown }).usage, reportUsage: run.report.usage, cost: run.report.cost, costStatus: run.report.usage.costStatus,
      traceRequests: traces.map(entry => ({ requestId: entry.requestId, executionId: entry.executionId, unitId: entry.unitId, characterId: entry.characterId, purpose: entry.purpose, status: entry.status, complete: entry.complete, final: entry.final, tools: Array.isArray(entry.toolCalls) ? entry.toolCalls.map((tool: Record<string, unknown>) => tool.name) : [] })),
      traceSnapshots: snapshots.map(entry => ({ type: entry.type, snapshotId: entry.snapshotId, length: String(entry.content ?? '').length || (Array.isArray(entry.schema) ? entry.schema.length : 0) })),
      status: run.status, error: service.state(book.id)?.error, contexts: run.organization?.contexts,
      note: '5人有旧修改，已按assetEdits的before值和拆分短语重建未优化资料；3人无旧修改。完成8个profile后主动停止。',
    }
    mkdirSync('test-results', { recursive: true })
    writeFileSync('test-results/live-eight-characters.json', JSON.stringify(evidence, null, 2))
    const unfinished = after.filter(row => row.item?.status !== 'checked')
    if (unfinished.length) throw new Error(`未完成：${unfinished.map(row => `${row.after?.name ?? row.before?.id}：${row.item?.reason ?? '无结论'}`).join('；')}`)
    if (!run.requestLedger?.length) throw new Error('没有保存请求账本。')
    if (!traces.length) throw new Error('8人没有保存请求轨迹。')
    if (traces.some(entry => !entry.executionId || !entry.requestId || !entry.input || entry.final !== true)) throw new Error('8人请求轨迹缺少执行号、输入或收尾标记。')
    if (!snapshots.length) throw new Error('8人没有保存提示词或工具快照。')
    if (sessionEntries.some(entry => ['request_trace', 'prompt_snapshot', 'tool_snapshot'].includes(String(entry.type)) && entry.parentId !== null)) throw new Error('观测条目不应挂入会话父链。')
  } finally { importer.close() }
}, 360000)
