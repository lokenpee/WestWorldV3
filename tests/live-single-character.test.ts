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

const opened: ReturnType<typeof createWorkspace>[] = []
const key = (() => {
  if (process.env.WESTWORLD_TEST_API_KEY) return process.env.WESTWORLD_TEST_API_KEY
  try {
    const file = readFileSync('.env.local', 'utf8')
    return file.split(/\r?\n/).find(line => line.startsWith('WESTWORLD_TEST_API_KEY='))?.slice('WESTWORLD_TEST_API_KEY='.length) ?? ''
  } catch { return '' }
})()
afterEach(async () => { for (const workspace of opened.splice(0)) { workspace.close(); for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name) } })

it.skipIf(!key)('真实单人：贾政资料整理只产生一个人物工作项并记录请求用量', async () => {
  const backupPath = process.env.WESTWORLD_SINGLE_BACKUP ?? '红楼之挽天-三河帮-2026-11-05T15-00-00-001Z-289280b5.wwv2'
  const id = crypto.randomUUID(), workspace = createWorkspace({ settingsName: `live-single-${id}`, bookPrefix: `live-single-${id}-` }); opened.push(workspace)
  const importer = createImportService(workspace)
  try {
    const bytes = new Uint8Array(readFileSync(backupPath))
    const book = await createBackupService(workspace, importer).importBackup(bytes)
    const db = workspace.openBook(book.id)
    const people = await db.table<Character>('characters').toArray()
    const target = people.find(row => row.name === '贾政')
    if (!target) throw new Error('样本中未找到贾政。')
    const before = JSON.parse(JSON.stringify(target))
    const runId = crypto.randomUUID(), sessionId = crypto.randomUUID(), now = new Date().toISOString()
    await db.table('storySessions').put({ id: sessionId, bookId: book.id, profile: 'asset_editor', kind: 'organization', title: '人物整理', status: 'active', nextOrdinal: 0, workflow: 'character_organization_v1', runId, createdAt: now, updatedAt: now })
    await db.table('pipelineRuns').put({
      id: runId, bookId: book.id, recordType: 'run', stage: 'P2', phase: 'character_organization', workflow: 'character_organization_v1', sessionId, status: 'paused', startedAt: now, planVersion: '2.2', scope: 'fullBook', tasks: [], commandIntents: [], appliedCommands: [], coverageItems: [], aiMode: 'agent', report: emptyReport({ characters: people.length, locations: await db.table('locations').count() }),
      organization: {
        version: 1, reviewVersion: 2, executionVersion: 4, step: 'profiles', revision: 1, statisticsPending: false,
        contexts: { identity: { id: 'identity', status: 'completed', pendingWorkId: null }, profiles: { id: 'profiles', status: 'active', pendingWorkId: null }, relations: { id: 'relations', status: 'pending', pendingWorkId: null } },
        activeWork: null, scanIds: [target.id], scanPages: [{ pageId: 'scan:0', ids: [target.id], nextCursor: null, status: 'checked' }], candidateGroups: [], candidateDecisions: [],
        profileItems: [{ id: target.id, name: target.name, status: 'pending', outcome: null, reason: '', contentFingerprint: '', readRefs: [], commitIds: [] }], relationItems: [], pairChecks: [],
      },
    })
    await db.table('compileProgress').put({ bookId: book.id, stage: 'P2', status: 'paused', runId, totalChapters: await db.chapters.count(), completedChapters: [], failedChapters: [], updatedAt: now, scope: 'fullBook', planVersion: '2.2', unit: 'item', validity: 'stale' })
    const models = createModelService(workspace, { fetch: globalThis.fetch.bind(globalThis), wait: async (ms, signal) => new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); const abort = () => { clearTimeout(timer); reject(signal.reason) }; signal.addEventListener('abort', abort, { once: true }) }) })
    await models.settings.save({ ...defaultConfig, providerId: process.env.WESTWORLD_TEST_PROVIDER ?? 'deepseek', baseUrl: process.env.WESTWORLD_TEST_BASE_URL ?? defaultConfig.baseUrl, aggregationModel: process.env.WESTWORLD_TEST_MODEL ?? 'deepseek-flash' }, key)
    const service = createWorldService(workspace, models, createAssetService(workspace), { assetReview: false })
    let cancelled = false, started = false, checking = false
    const finished = new Promise<void>(resolve => {
      service.subscribe(() => {
        const state = service.state(book.id)
        if (state?.running) started = true
        if (state?.running && !cancelled && !checking) {
          checking = true
          void db.table('pipelineRuns').get(runId).then(run => {
            const item = (run?.organization as { profileItems?: { id: string; status: string }[] } | undefined)?.profileItems?.find(row => row.id === target.id)
            if (item?.status === 'checked' && !cancelled) { cancelled = true; service.cancel(book.id) }
          }).finally(() => { checking = false })
        }
        if (started && !state?.running) resolve()
      })
    })
    await service.startOrganization(book.id)
    await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error('单人验证超时。')), 240000))])
    const run = (await service.reports(book.id))[0]!
    const after = await db.table<Character>('characters').get(target.id)
    const item = run.organization?.profileItems.find(row => row.id === target.id)
    const entries = await db.table('storySessionEntries').toArray()
    const msgs = entries.filter(row => row.type === 'message')
    const traces = entries.filter(row => row.type === 'request_trace' && typeof row.requestId === 'string')
    const snapshots = entries.filter(row => row.type === 'prompt_snapshot' || row.type === 'tool_snapshot')
    const contentText = (value: unknown) => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => typeof part === 'object' && part && 'text' in part ? String((part as { text?: unknown }).text ?? '') : '').join('') : ''
    const traceBodies = traces.map(row => {
      const input = row.input && typeof row.input === 'object' ? row.input as Record<string, unknown> : {}
      return { roles: Array.isArray(input.messages) ? (input.messages as Record<string, unknown>[]).map(message => String(message.role ?? '')) : [], users: Array.isArray(input.messages) ? (input.messages as Record<string, unknown>[]).filter(message => message.role === 'user').map(message => contentText(message.content)) : [], systems: Array.isArray(input.messages) ? (input.messages as Record<string, unknown>[]).filter(message => message.role === 'system').map(message => contentText(message.content)) : [] }
    })
    const toolSnapshots = snapshots.filter(row => row.type === 'tool_snapshot')
    const toolNames = toolSnapshots.flatMap(row => Array.isArray(row.schema) ? (row.schema as Record<string, unknown>[]).map(tool => String(tool.name)) : [])
    const toolSchemaBytes = toolSnapshots.reduce((sum, row) => sum + new TextEncoder().encode(JSON.stringify(row.schema ?? [])).length, 0)
    const systemText = traceBodies.map(body => body.systems.join('\n')).join('\n')
    const evidence = {
      book: book.title, character: { id: target.id, name: target.name, before, after },
      outcome: item?.outcome, reason: item?.reason, commitIds: item?.commitIds,
      requests: run.requestLedger?.length ?? 0, ledger: run.requestLedger, usage: (run as typeof run & { usage?: unknown }).usage,
      reportUsage: run.report.usage, cost: run.report.cost, status: run.status, error: service.state(book.id)?.error,
      messageEntries: msgs.length, contexts: run.organization?.contexts,
      traceRequests: traces.map(row => ({ requestId: row.requestId, executionId: row.executionId, purpose: row.purpose, status: row.status, complete: row.complete, final: row.final, model: row.model, text: String(row.text ?? '').slice(0, 120), toolCalls: Array.isArray(row.toolCalls) ? row.toolCalls.map((tool: Record<string, unknown>) => tool.name) : [], usage: row.usage })),
      traceSnapshots: snapshots.map(row => ({ type: row.type, snapshotId: row.snapshotId, length: String(row.content ?? '').length || (Array.isArray(row.schema) ? row.schema.length : 0), toolNames: row.type === 'tool_snapshot' && Array.isArray(row.schema) ? (row.schema as Record<string, unknown>[]).map(tool => String(tool.name)) : undefined })), traceBodies,
      toolNames, toolSchemaBytes, systemLength: systemText.length, businessLength: snapshots.filter(row => row.type === 'prompt_snapshot' && String(row.snapshotId).includes(':business:')).reduce((sum, row) => sum + String(row.content ?? '').length, 0),
      note: '单人验证在第一个 profile 工作项完成后主动取消，只用于质量与请求构成检查。',
    }
    mkdirSync('test-results', { recursive: true })
    writeFileSync('test-results/live-single-character.json', JSON.stringify(evidence, null, 2))
    if (!item || item.status !== 'checked') throw new Error(`单人未完成：${service.state(book.id)?.error ?? item?.reason ?? '无结论'}`)
    if (!run.requestLedger?.length) throw new Error('没有保存请求账本。')
    if (run.requestLedger.some(row => !row.attemptId)) throw new Error('请求账本缺少attemptId。')
    if (!traces.length) throw new Error('没有保存运行详情请求记录。')
    if (traces.some(row => !row.executionId || !row.input || !row.requestId || row.final !== true)) throw new Error('运行详情请求记录缺少执行号、输入或收尾标记。')
    if (!snapshots.length) throw new Error('没有保存提示词或工具快照。')
    if (!toolNames.length) throw new Error('工具快照没有记录实际工具名。')
    for (const name of ['submit_result', 'submit_relation_review', 'record_organization_progress']) if (toolNames.includes(name)) throw new Error(`资料工作项仍提供其他步骤工具：${name}`)
    for (const name of ['submit_profile_review', 'merge_assets', 'edit_character', 'set_character_relation', 'delete_character_relation']) if (!toolNames.includes(name)) throw new Error(`资料工作项缺少跨步骤工具：${name}`)
    if (systemText.includes('submit_relation_review')) throw new Error('资料工作项系统提示词仍要求提交人物关系。')
    if (!systemText.includes('# 第二步：优化人物资料')) throw new Error('系统提示词缺少第二步工作项规则。')
    if (systemText.includes('# 第一步：目录页') || systemText.includes('# 第三步：整理人物关系')) throw new Error('系统提示词混入其他步骤规则。')
    for (const body of traceBodies) {
      const tasks = body.users.filter(value => value.trim().startsWith('{') && value.includes('"workItems"'))
      if (tasks.length !== new Set(tasks).size) throw new Error('最终请求重复注入人物任务。')
      const system = body.systems.join('\n')
      if (system.includes('100000') || system.includes('最后一次只能调用submit_result')) throw new Error('系统提示词仍含旧P2预算或submit_result规则。')
    }
    if (entries.some(row => ['request_trace', 'prompt_snapshot', 'tool_snapshot'].includes(String(row.type)) && row.parentId !== null)) throw new Error('观测条目不应挂入会话父链。')
  } finally { importer.close() }
}, 300000)
