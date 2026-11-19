import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { transact } from '../src/lib/storage/transaction'
import { createExtractionInput, extractionTaskId, interruptExtractionTasks, migrateExtractionRun, readExtractionInput, readExtractionTasks, registerExtractionTask } from '../src/features/extraction/taskStore'
import type { ExtractionDatabase, ExtractionTask, Run, StoredTask } from '../src/features/extraction/recovery'

const opened: ReturnType<typeof createWorkspace>[] = []
const timestamp = '2026-11-19T00:00:00.000Z'
const task = (taskId: string, phase: StoredTask['phase'] = 'worldAssets', ordinal = 0): StoredTask => ({ taskId, ordinal, callId: `call-${taskId}`, phase, status: 'running', workItemIds: [`P1:${phase}:chapter:1`], input: { chapterIndex: '1', chapterName: '当时的章名', text: '当时的正文。' }, inputFingerprint: `original-${taskId}`, promptHash: 'old-prompt', attempt: 2, repairCount: 1, stepsUsed: 2, appliedCommitIds: [], reviewedItems: [], readSet: { records: [], queries: [] }, createdAt: timestamp, updatedAt: timestamp })
async function setup(tasks = [task('world'), task('story', 'narrativeAssets', 1)]) {
  const id = crypto.randomUUID(), workspace = createWorkspace({ settingsName: `task-store-${id}`, bookPrefix: `task-store-${id}-book-` })
  opened.push(workspace)
  const db = workspace.openBook('a')
  const run: Run = { id: 'run', bookId: 'a', recordType: 'run', stage: 'P1', status: 'paused', tasks }
  await db.table('pipelineRuns').put(run)
  await db.table('chapterTexts').put({ bookId: 'a', chapterIndex: '1', text: '后来改过的正文。' })
  const write = <T>(work: (db: ExtractionDatabase) => Promise<T>) => transact(db, 'rw', [db.table('pipelineRuns'), db.table('extractionTasks'), db.table('extractionInputs')], work)
  return { db, run, write }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const workspace of opened.splice(0)) {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name)
  }
})

it('旧正文和章名原子迁移，两步骤共享快照，重复恢复不重复生成', async () => {
  const { db, run, write } = await setup()
  const digest = crypto.subtle.digest.bind(crypto.subtle)
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
    await new Promise(resolve => setTimeout(resolve, 15))
    return digest(algorithm, data)
  })
  const compact = await write(db => migrateExtractionRun(db, run))
  expect(compact).toMatchObject({ taskStorage: 'separate', nextTaskOrdinal: 2 })
  expect(compact).not.toHaveProperty('tasks')
  expect(await db.table('pipelineRuns').get(run.id)).toEqual(compact)
  const independent = await readExtractionTasks(db, compact)
  expect(independent.map(row => row.inputFingerprint)).toEqual(['original-world', 'original-story'])
  expect(independent[0]).toMatchObject({ id: extractionTaskId('run', 'world'), runId: 'run', bookId: 'a', attempt: 2, repairCount: 1, stepsUsed: 2 })
  expect(independent.every(row => !('text' in row.input))).toBe(true)
  expect(await db.table('extractionInputs').count()).toBe(1)
  expect(await readExtractionInput(db, independent[0])).toEqual(run.tasks![0].input)
  expect(await readExtractionInput(db, run.tasks![0])).toEqual(run.tasks![0].input)
  await write(db => migrateExtractionRun(db, compact))
  expect(await db.table('extractionTasks').count()).toBe(2)
  expect(await db.table('extractionInputs').count()).toBe(1)
})

it('旧任务转换失败回滚快照、任务和运行，重试保留原指纹', async () => {
  const { db, run, write } = await setup()
  const tasks = db.table('extractionTasks')
  let writes = 0
  const rejectSecond = () => { if (++writes === 2) throw new Error('模拟第二条任务写入失败') }
  tasks.hook('creating', rejectSecond)
  await expect(write(db => migrateExtractionRun(db, run))).rejects.toThrow('模拟第二条任务写入失败')
  expect(await db.table('pipelineRuns').get(run.id)).toEqual(run)
  expect(await tasks.count()).toBe(0)
  expect(await db.table('extractionInputs').count()).toBe(0)
  tasks.hook('creating').unsubscribe(rejectSecond)
  const compact = await write(db => migrateExtractionRun(db, run))
  expect((await readExtractionTasks(db, compact)).map(row => row.inputFingerprint)).toEqual(['original-world', 'original-story'])
})

it('缺失历史正文的旧任务明确报错，不拿当前章节补写或保存空正文', async () => {
  const invalid = { ...task('invalid'), input: { chapterIndex: '1', chapterName: '旧章名' } } as StoredTask
  const { db, run, write } = await setup([invalid])
  await expect(write(db => migrateExtractionRun(db, run))).rejects.toThrow('旧提取任务缺少当时的正文或章节信息')
  expect(await db.table('pipelineRuns').get(run.id)).toEqual(run)
  expect(await db.table('extractionTasks').count()).toBe(0)
  expect(await db.table('extractionInputs').count()).toBe(0)
})

it('登记任务后回滚不前进游标；另一运行共用正文但独立暂停', async () => {
  const { db, run, write } = await setup([])
  const first = await write(db => migrateExtractionRun(db, run)), second = { ...first, id: 'second' }
  await db.table('pipelineRuns').put(second)
  const input = await createExtractionInput('a', task('a').input.text, timestamp)
  await expect(write(async db => { await registerExtractionTask(db, first, task('a'), input); throw new Error('登记事务失败') })).rejects.toThrow('登记事务失败')
  expect(await db.table('extractionTasks').count()).toBe(0)
  expect(await db.table('extractionInputs').count()).toBe(0)
  expect((await db.table('pipelineRuns').get(first.id)).nextTaskOrdinal).toBe(0)
  await write(db => registerExtractionTask(db, first, task('a'), input))
  await write(db => registerExtractionTask(db, second, task('b', 'narrativeAssets'), input))
  expect(await db.table('extractionInputs').count()).toBe(1)
  await write(db => interruptExtractionTasks(db, first, { status: 'partial' }))
  expect((await db.table<ExtractionTask>('extractionTasks').get(extractionTaskId(first.id, 'a')))!.status).toBe('partial')
  expect((await db.table<ExtractionTask>('extractionTasks').get(extractionTaskId(second.id, 'b')))!.status).toBe('running')
})
