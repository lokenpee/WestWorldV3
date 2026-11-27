import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createImportService } from '../src/lib/storage/importService'
import { checksumOf, encodeBackup, inspectBackup, type BackupManifest } from '../src/features/backup/codec'
import { emptyTables, validateBookData, type BookData, type Row } from '../src/features/backup/data'
import { createBackupService } from '../src/features/backup/service'
import { fingerprint } from '../src/features/extraction/contracts'
import { createExtractionService } from '../src/features/extraction/service'
import { createModelService } from '../src/features/models/service'
import { defaultConfig } from '../src/features/models/types'
import { agentStream } from './support/agent-protocol'

const opened: ReturnType<typeof createWorkspace>[] = [], importers: ReturnType<typeof createImportService>[] = []
const now = '2026-11-19T00:00:00.000Z'
afterEach(async () => {
  importers.splice(0).forEach(importer => importer.close())
  for (const workspace of opened.splice(0)) {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name)
  }
})
function destination() {
  const prefix = `extraction-backup-${crypto.randomUUID()}`
  const workspace = createWorkspace({ settingsName: `${prefix}-settings`, bookPrefix: `${prefix}-book-` }); opened.push(workspace)
  const importer = createImportService(workspace); importers.push(importer)
  return { workspace, service: createBackupService(workspace, importer) }
}
async function sample() {
  const book = { id: 'source', title: '提取历史样本', sourceFileName: 'sample.txt', createdAt: now }
  const data: BookData = { book, tables: emptyTables() }
  const text = '第一章 现在的正文已编辑。', historical = '第一章 当时沈青收到旧信。😀'
  data.tables.chapters.push({ bookId: book.id, chapterIndex: '1', chapterName: '第一章', order: 0, charCount: text.length })
  data.tables.chapterTexts.push({ bookId: book.id, chapterIndex: '1', text })
  const snapshotId = await fingerprint(historical)
  data.tables.extractionInputs.push({ id: snapshotId, bookId: book.id, text: historical, createdAt: now })
  data.tables.pipelineRuns.push({ id: 'p1-run', bookId: book.id, recordType: 'run', stage: 'P1', status: 'running', startedAt: now, planVersion: '2.2', taskStorage: 'separate', nextTaskOrdinal: 5, usage: { input: 3, output: 4, totalTokens: 7, cost: 0, costStatus: 'unknown' } })
  for (const [ordinal, status] of ['completed', 'failed', 'running', 'pending', 'prepared'].entries()) {
    const taskId = `task-${ordinal}`, phase = ordinal % 2 ? 'narrativeAssets' : 'worldAssets'
    data.tables.extractionTasks.push({ id: JSON.stringify(['p1-run', taskId]), bookId: book.id, runId: 'p1-run', taskId, ordinal, callId: `call-${ordinal}`, phase, status, workItemIds: [`P1:${phase}:chapter:1`], input: { chapterIndex: '1', chapterName: '第一章 旧标题', snapshotId }, inputFingerprint: `original-input-${ordinal}`, promptHash: 'original-prompt', attempt: 1, repairCount: 0, stepsUsed: 1, appliedCommitIds: [], reviewedItems: [], readSet: { records: [], queries: [] }, createdAt: now, updatedAt: now })
  }
  return data
}
async function modifyArchive(bytes: Uint8Array, edit: (files: Record<string, Uint8Array>, manifest: BackupManifest) => void) {
  const files = unzipSync(bytes), manifest = JSON.parse(strFromU8(files['manifest.json'])) as BackupManifest
  edit(files, manifest)
  manifest.checksums = Object.fromEntries(await Promise.all(Object.entries(files).filter(([name]) => name !== 'manifest.json').map(async ([name, contents]) => [name, await checksumOf(contents)])))
  files['manifest.json'] = strToU8(JSON.stringify(manifest))
  return zipSync(files)
}

it('格式12保留共享历史快照和原输入指纹，两个恢复副本分别归属新书并暂停未完成任务', async () => {
  const data = await sample(), before = structuredClone(data)
  expect(await validateBookData(data)).toEqual([])
  const exported = await encodeBackup(data)
  expect(exported.manifest.formatVersion).toBe(15)
  expect(exported.manifest.contents).toEqual(expect.arrayContaining(['extractionTasks', 'extractionInputs']))
  expect(data).toEqual(before)
  const { workspace, service } = destination()
  for (let index = 0; index < 2; index++) {
    const book = await service.importBackup(exported.bytes), db = workspace.openBook(book.id)
    const tasks = await db.table('extractionTasks').where('runId').equals('p1-run').sortBy('ordinal')
    expect(tasks.map(task => task.status)).toEqual(['completed', 'failed', 'partial', 'partial', 'partial'])
    expect(tasks.map(task => task.inputFingerprint)).toEqual(before.tables.extractionTasks.map(task => task.inputFingerprint))
    expect(tasks.every(task => task.bookId === book.id)).toBe(true)
    expect(new Set(tasks.map(task => (task.input as Row).snapshotId)).size).toBe(1)
    expect(await db.table('extractionInputs').toArray()).toEqual(before.tables.extractionInputs.map(snapshot => ({ ...snapshot, bookId: book.id })))
    expect((await db.table('pipelineRuns').get('p1-run')).usage).toEqual(before.tables.pipelineRuns[0].usage)
    expect((await db.table('chapterTexts').get('1')).text).not.toBe(before.tables.extractionInputs[0].text)
    expect((await service.inspectBackup((await service.exportBook(book.id)).bytes)).ok).toBe(true)
  }
  expect(await workspace.listBooks()).toHaveLength(2)
  expect(data).toEqual(before)
})

it('格式11缺少新表时补空，旧P1任务恢复后继续仅转存一次且保留当时的正文和标题', async () => {
  const data = await sample(), originalTask = data.tables.extractionTasks[1], historical = data.tables.extractionInputs[0].text
  const { id: _id, bookId: _bookId, runId: _runId, ...metadata } = originalTask
  const legacyTask = { ...metadata, ordinal: 0, input: { chapterIndex: '1', chapterName: '第一章 旧标题', text: historical } }
  const { taskStorage: _taskStorage, nextTaskOrdinal: _ordinal, ...run } = data.tables.pipelineRuns[0]
  data.tables.pipelineRuns = [{ ...run, status: 'paused', tasks: [legacyTask] }]
  data.tables.extractionTasks = []; data.tables.extractionInputs = []
  data.tables.compileProgress.push({ bookId: data.book.id, stage: 'P1', status: 'paused', totalChapters: 1, completedChapters: [], failedChapters: ['1'], updatedAt: now, runId: run.id, planVersion: '2.2' })
  const bytes = await modifyArchive((await encodeBackup(data)).bytes, (files, manifest) => {
    manifest.formatVersion = 11
    manifest.contents = manifest.contents.filter(name => !['extractionTasks', 'extractionInputs'].includes(name))
    delete files['data/extractionTasks.json']; delete files['data/extractionInputs.json']
  })
  const inspected = await inspectBackup(bytes)
  expect(inspected.errors).toEqual([])
  expect(inspected.data!.tables.extractionTasks).toEqual([])
  expect(inspected.data!.tables.extractionInputs).toEqual([])
  const { workspace, service } = destination(), book = await service.importBackup(bytes), db = workspace.openBook(book.id)
  expect((await db.table('pipelineRuns').get('p1-run')).tasks[0].input).toEqual(legacyTask.input)
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string)
    const value = body.tools[0].function.parameters.properties.characters ? { characters: [], locations: [] } : { nodes: [] }
    return agentStream([{ name: 'submit_result', args: value }])
  })
  const models = createModelService(workspace, { fetch: fetcher })
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://extraction-backup-fixture.invalid/v1' }, 'fixture-only')
  const extraction = createExtractionService(workspace, models)
  await extraction.start(book.id)
  expect(extraction.state(book.id)?.error).toBeUndefined()
  expect(fetcher).toHaveBeenCalledTimes(2)
  const tasks = await db.table('extractionTasks').where('runId').equals('p1-run').sortBy('ordinal')
  expect(tasks).toHaveLength(3)
  const preserved = tasks.find(task => task.taskId === originalTask.taskId)!
  expect(preserved.inputFingerprint).toBe(originalTask.inputFingerprint)
  expect((preserved.input as Row).chapterName).toBe('第一章 旧标题')
  expect((await db.table('extractionInputs').get((preserved.input as Row).snapshotId as string)).text).toBe(historical)
  expect(await db.table('extractionInputs').count()).toBe(2)
  expect(await db.table('pipelineRuns').get('p1-run')).not.toHaveProperty('tasks')
  await extraction.start(book.id)
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(await db.table('extractionTasks').where('runId').equals('p1-run').toArray()).toHaveLength(3)
})

it.each(['missing-table', 'missing-snapshot', 'wrong-run', 'embedded-run', 'wrong-book', 'wrong-task-id'] as const)('格式12的%s在预检拒绝且不发布新书', async kind => {
  const exported = await encodeBackup(await sample())
  const bytes = await modifyArchive(exported.bytes, (files, manifest) => {
    if (kind === 'missing-table') {
      delete files['data/extractionInputs.json']
      manifest.contents = manifest.contents.filter(name => name !== 'extractionInputs')
    } else if (kind === 'missing-snapshot') files['data/extractionInputs.json'] = strToU8('[]')
    else if (kind === 'wrong-run' || kind === 'embedded-run') {
      const runs = JSON.parse(strFromU8(files['data/pipelineRuns.json']))
      delete runs[0].taskStorage
      if (kind === 'wrong-run') runs[0].stage = 'P2'
      else runs[0].tasks = []
      files['data/pipelineRuns.json'] = strToU8(JSON.stringify(runs))
    } else {
      const tasks = JSON.parse(strFromU8(files['data/extractionTasks.json']))
      tasks[0][kind === 'wrong-book' ? 'bookId' : 'id'] = 'not-this-record'
      files['data/extractionTasks.json'] = strToU8(JSON.stringify(tasks))
    }
  })
  const result = await inspectBackup(bytes)
  expect(result.ok).toBe(false)
  expect(result.errors[0].path).toMatch(kind === 'missing-table' ? /manifest/ : /extractionTasks/)
  const { service, workspace } = destination()
  await expect(service.importBackup(bytes)).rejects.toThrow()
  expect(await workspace.listBooks()).toEqual([])
})
