import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { createLocalStorageServer } from '../src/features/local-storage/server'
import type { StorageCall } from '../src/features/local-storage/client'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createModelService } from '../src/features/models/service'
import { createExtractionService } from '../src/features/extraction/service'
import { defaultConfig } from '../src/features/models/types'
import { agentStream } from './support/agent-protocol'

test('opt04：固定24任务通过真实存储适配器计量写入体积', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'westworld-opt04-'))
  const store = createLocalStorageServer(directory, { protect: text => Buffer.from(text).toString('base64'), unprotect: text => Buffer.from(text, 'base64').toString() })
  let collecting = false
  const writes: { table: string; bytes: number; runBytes: number }[] = []
  const call: StorageCall = async body => {
    const serialized = JSON.stringify(body)
    if (collecting && ['put', 'add', 'bulk'].includes(String(body.action))) {
      const value = body.value as Record<string, unknown> | undefined
      writes.push({ table: String(body.table), bytes: Buffer.byteLength(serialized), runBytes: body.table === 'pipelineRuns' && value?.recordType === 'run' && value?.stage === 'P1' ? Buffer.byteLength(JSON.stringify(value)) : 0 })
    }
    return JSON.parse(JSON.stringify(await store.execute(JSON.parse(serialized)) ?? null))
  }
  const workspace = createWorkspace({ settingsName: 'test', bookPrefix: 'test-' }, call)
  try {
    const now = new Date().toISOString(), bookId = 'sample', count = 12, db = workspace.openBook(bookId)
    await workspace.settings.books.put({ id: bookId, title: 'P1量化样本', sourceFileName: 'sample.txt', createdAt: now })
    const chapters = Array.from({ length: count }, (_, i) => ({ bookId, chapterIndex: String(i + 1), chapterName: `第${i + 1}章`, order: i, charCount: 10000 }))
    await db.chapters.bulkPut(chapters)
    await db.table('chapterTexts').bulkPut(chapters.map(chapter => ({ bookId, chapterIndex: chapter.chapterIndex, text: chapter.chapterIndex.padEnd(10000, '甲') })))
    await db.table('compileProgress').put({ bookId, stage: 'P1', status: 'idle', totalChapters: count, completedChapters: [], failedChapters: [], updatedAt: now })
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(init?.body as string)
      return agentStream([{ name: 'submit_result', args: body.tools[0].function.parameters.properties.characters ? { characters: [], locations: [] } : { nodes: [] } }])
    })
    const models = createModelService(workspace, { fetch: fetcher, wait: async (_ms, signal) => signal.throwIfAborted() })
    await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://opt04-fixture.invalid/v1', extractionModel: 'test' }, 'fixture-only')
    const service = createExtractionService(workspace, models)
    collecting = true
    const start = performance.now()
    await service.start(bookId)
    const elapsedMs = performance.now() - start
    collecting = false
    expect(service.state(bookId)?.error).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(count * 2)
    expect(await db.table('extractionReceipts').count()).toBe(count * 2)
    const runs = (await db.table('pipelineRuns').toArray()).filter(row => row.recordType === 'run' && row.stage === 'P1')
    const historyTables = new Set(['pipelineRuns', 'extractionTasks', 'extractionInputs'])
    const result = { chapters: count, completedTasks: count * 2, maxRunRowBytes: Math.max(...writes.map(x => x.runBytes)), maxWriteRequestBytes: Math.max(...writes.map(x => x.bytes)),
      taskHistoryWriteBytes: writes.filter(x => historyTables.has(x.table)).reduce((sum, x) => sum + x.bytes, 0), storedRunBytes: runs.reduce((sum, x) => sum + Buffer.byteLength(JSON.stringify(x)), 0), elapsedMs: +elapsedMs.toFixed(2), receipts: await db.table('extractionReceipts').count() }
    if (process.env.WW_OPT04_RESULT) writeFileSync(process.env.WW_OPT04_RESULT, JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify(result))
  } finally {
    workspace.close(); await store.close(); rmSync(directory, { recursive: true, force: true })
  }
}, 60000)

test('opt04：3000条旧任务转换后每次写请求低于大小上限', async () => {
  const { migrateExtractionRun } = await import('../src/features/extraction/taskStore')
  const { transact } = await import('../src/lib/storage/transaction')
  const directory = mkdtempSync(join(tmpdir(), 'westworld-opt04-scale-'))
  const store = createLocalStorageServer(directory, { protect: text => Buffer.from(text).toString('base64'), unprotect: text => Buffer.from(text, 'base64').toString() })
  let maxWriteRequestBytes = 0
  const call: StorageCall = async body => {
    if (['put', 'add', 'bulk'].includes(String(body.action))) maxWriteRequestBytes = Math.max(maxWriteRequestBytes, Buffer.byteLength(JSON.stringify(body)))
    return await store.execute(body) as never
  }
  const workspace = createWorkspace({ settingsName: 'scale', bookPrefix: 'scale-' }, call)
  try {
    const now = new Date().toISOString()
    const tasks = Array.from({ length: 3000 }, (_, ordinal) => {
      const chapterIndex = String(Math.floor(ordinal / 2) + 1)
      return { taskId: `task-${ordinal}`, ordinal, callId: ordinal % 2 ? 'PROMPT-P1-NARRATIVE' : 'PROMPT-P1-WORLD', phase: ordinal % 2 ? 'narrativeAssets' as const : 'worldAssets' as const,
        status: 'completed', workItemIds: [chapterIndex], input: { chapterIndex, chapterName: `第${chapterIndex}章`, text: chapterIndex.padEnd(10000, '甲') }, inputFingerprint: `original-${ordinal}`, promptHash: 'original-prompt',
        attempt: 1, repairCount: 0, stepsUsed: 1, appliedCommitIds: [], reviewedItems: [], readSet: { records: [] as never[], queries: [] as never[] }, createdAt: now, updatedAt: now }
    })
    const run = { id: 'legacy', recordType: 'run', bookId: 'sample', stage: 'P1', status: 'paused', tasks }
    const oldRunBytes = Buffer.byteLength(JSON.stringify(run))
    expect(oldRunBytes).toBeGreaterThan(64 * 1024 * 1024)
    // Seed an already persisted legacy record directly; measured requests are only the conversion.
    const transaction = await store.execute({ action: 'begin', scope: 'book:sample', tables: ['pipelineRuns'], write: true })
    await store.execute({ action: 'put', transaction, scope: 'book:sample', table: 'pipelineRuns', key: run.id, value: run })
    await store.execute({ action: 'commit', transaction, scope: 'book:sample' })
    const db = workspace.openBook('sample')
    const start = performance.now()
    await transact(db, 'rw', [db.table('pipelineRuns'), db.table('extractionTasks'), db.table('extractionInputs')], scoped => migrateExtractionRun(scoped, run))
    const elapsedMs = performance.now() - start
    const compact = await db.table('pipelineRuns').get(run.id)
    expect(compact).not.toHaveProperty('tasks')
    expect(compact).toMatchObject({ taskStorage: 'separate', nextTaskOrdinal: 3000 })
    expect(await db.table('extractionTasks').count()).toBe(3000)
    expect(await db.table('extractionInputs').count()).toBe(1500)
    expect(maxWriteRequestBytes).toBeLessThan(1024 * 1024)
    const result = { tasks: 3000, snapshots: 1500, oldRunBytes, compactRunBytes: Buffer.byteLength(JSON.stringify(compact)), maxWriteRequestBytes, elapsedMs: +elapsedMs.toFixed(2) }
    if (process.env.WW_OPT04_SCALE_RESULT) writeFileSync(process.env.WW_OPT04_SCALE_RESULT, JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify(result))
  } finally {
    workspace.close(); await store.close(); rmSync(directory, { recursive: true, force: true })
  }
}, 60000)
