import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { writeFileSync } from 'node:fs'
import { afterEach, expect, test, vi } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createAssetService } from '../src/features/assets/service'
import { createModelService } from '../src/features/models/service'
import { defaultConfig } from '../src/features/models/types'
import { createWorldService } from '../src/features/world/service'
import { agentTextStream } from './support/agent-protocol'
import { organizationResponse } from './support/organization-streams'

const opened: ReturnType<typeof createWorkspace>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const workspace of opened.splice(0)) {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name)
  }
})

async function pausedFixture(targeted: boolean) {
  const prefix = `opt08-${crypto.randomUUID()}`
  const workspace = createWorkspace({ settingsName: prefix, bookPrefix: `${prefix}-book-` }); opened.push(workspace)
  const now = new Date().toISOString(), db = workspace.openBook('a')
  await workspace.settings.books.put({ id: 'a', title: '继续启动恢复样本', sourceFileName: 'fixture.txt', createdAt: now })
  await db.chapters.put({ bookId: 'a', chapterIndex: '1', chapterName: '第一章', order: 0, charCount: 5 })
  await db.table('chapterTexts').put({ bookId: 'a', chapterIndex: '1', text: '沈青送信。' })
  await db.table('characters').put({ id: 'P1', bookId: 'a', name: '沈青', aliases: [], identity: '送信人', confidence: 1, revision: 1, createdBy: 'P1', chapterIndex: '1', chapterName: '第一章' })
  await db.table('extractionReceipts').bulkPut(['worldAssets', 'narrativeAssets'].map(substep => ({ key: `1:${substep}`, bookId: 'a', chapterIndex: '1', substep, inputFingerprint: 'fixture', originIds: [], committedAt: now, runId: 'fixture-extraction' })))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let requests = 0
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (++requests === 1) { await gate; return agentTextStream('当前人物尚待整理。') }
    const response = organizationResponse(JSON.parse(String(init?.body)))
    if (!response) throw new Error('固定响应未识别人物整理请求')
    return response
  })
  const models = createModelService(workspace, { fetch: fetcher, wait: async (_ms, signal) => signal.throwIfAborted() })
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://opt08-fixture.invalid/v1', aggregationContextWindow: 65536 }, 'fixture-only')
  const service = createWorldService(workspace, models, createAssetService(workspace), { assetReview: false })
  const runId = targeted ? await service.startCharacterOrganization('a', 'P1', 'profile') : await service.startOrganizationStep('a', 'scan')
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1), { timeout: 5000 })
  await service.pauseOrganization('a'); release()
  await vi.waitFor(() => expect(service.state('a')?.running).toBe(false), { timeout: 10000 })
  const run = await db.table('pipelineRuns').get(runId)
  expect(run.status).toBe('paused')
  expect(await db.table('pipelineRuns').get('lease:world')).toBeUndefined()
  expect(service.state('a')?.error).toBeUndefined()
  return { db, service, fetcher, runId, sessionId: String(run.sessionId), resume: () => targeted ? service.continueCharacterOrganization('a', 'P1') : service.continueOrganization('a') }
}

test('opt08：继续启动冲突或保存失败后的原始错误、暂停记录及重试结果', async () => {
  const measurements = []
  for (const scenario of ['lease-conflict', 'run-save-failure', 'session-save-failure'] as const) {
    const targeted = scenario === 'session-save-failure'
    const { db, service, fetcher, runId, sessionId, resume } = await pausedFixture(targeted)
    const originalRun = await db.table('pipelineRuns').get(runId)
    const originalSession = await db.table('storySessions').get(sessionId)
    const originalEntries = await db.table('storySessionEntries').toArray()
    const originalAssets = await db.table('characters').toArray()
    const originalProgress = await db.table('compileProgress').get('P2')
    const conflict = { id: 'lease:narrative', bookId: 'a', recordType: 'lease', lockKey: 'narrative', runId: 'other-run', owner: 'other-owner', expiresAt: Date.now() + 60000 }
    const expectedError = scenario === 'lease-conflict' ? '本书已有处理任务。' : scenario === 'run-save-failure' ? '模拟本机运行记录保存失败' : '模拟本机会话执行权保存失败'
    const failSave = (_changes: unknown, key: unknown) => {
      if (key === (scenario === 'run-save-failure' ? runId : sessionId)) throw new Error(expectedError)
    }
    if (scenario === 'lease-conflict') await db.table('pipelineRuns').put(conflict)
    else db.table(scenario === 'run-save-failure' ? 'pipelineRuns' : 'storySessions').hook('updating', failSave)

    const initialRequests = fetcher.mock.calls.length
    let firstError = ''
    try { await resume() } catch (error) { firstError = error instanceof Error ? error.message : String(error) }
    expect(firstError).toBe(expectedError)
    expect(fetcher).toHaveBeenCalledTimes(initialRequests)
    expect(await db.table('characters').toArray()).toEqual(originalAssets)
    expect(await db.table('storySessionEntries').toArray()).toEqual(originalEntries)
    expect((await db.table('pipelineRuns').get(runId)).tasks).toEqual(originalRun.tasks)
    expect(await db.table('storySessions').get(sessionId)).toEqual(originalSession)
    if (scenario === 'lease-conflict') {
      expect(await db.table('pipelineRuns').get(conflict.id)).toEqual(conflict)
      await db.table('pipelineRuns').delete(conflict.id)
    } else db.table(scenario === 'run-save-failure' ? 'pipelineRuns' : 'storySessions').hook('updating').unsubscribe(failSave)

    const failedRun = await db.table('pipelineRuns').get(runId)
    const failedProgress = await db.table('compileProgress').get('P2')
    const failedState = { ...service.state('a') }
    const startupLease = await db.table('pipelineRuns').get('lease:world')
    let retryError = '', retryRunId = ''
    try { retryRunId = await resume() } catch (error) { retryError = error instanceof Error ? error.message : String(error) }
    if (!retryError) await vi.waitFor(() => expect(service.state('a')?.running).toBe(false), { timeout: 10000 })
    const finalRun = await db.table('pipelineRuns').get(runId)
    const result = {
      scenario, entryPoint: targeted ? 'continueCharacterOrganization' : 'continueOrganization',
      firstError, errorReturnedToCaller: firstError === expectedError, stateError: failedState.error ?? null,
      originalErrorInState: failedState.error === expectedError,
      failedRunStatus: failedRun.status, pauseRecordPreserved: JSON.stringify(failedRun) === JSON.stringify(originalRun),
      progressPreserved: JSON.stringify(failedProgress) === JSON.stringify(originalProgress),
      sessionPreserved: true, tasksPreserved: true, assetsPreserved: true, traceEntriesPreserved: true,
      startupLeaseRemaining: !!startupLease, retryError: retryError || null,
      retrySucceeded: retryRunId === runId && finalRun.status === 'completed', finalRunStatus: finalRun.status,
      modelCallsDuringFailedStartup: 0, modelCallsAfterRetry: fetcher.mock.calls.length - initialRequests,
    }
    measurements.push(result)
    if (process.env.WW_OPT08_EXPECT === 'before') {
      expect(result.retrySucceeded).toBe(false)
      expect(result.modelCallsAfterRetry).toBe(0)
      expect(result.originalErrorInState).toBe(false)
      expect(result.failedRunStatus).toBe(scenario === 'session-save-failure' ? 'running' : 'paused')
    } else {
      expect(result).toMatchObject({ retrySucceeded: true, originalErrorInState: true, failedRunStatus: 'paused', pauseRecordPreserved: true, progressPreserved: true, startupLeaseRemaining: false })
      expect(result.modelCallsAfterRetry).toBeGreaterThan(0)
    }
  }
  const result = {
    fixture: '临时 IndexedDB 工作区、固定模型响应；真实暂停后继续，无付费调用',
    scenarios: measurements.length,
    conflictRetriesSucceeded: measurements.filter(row => row.scenario === 'lease-conflict' && row.retrySucceeded).length,
    storageRetriesSucceeded: measurements.filter(row => row.scenario !== 'lease-conflict' && row.retrySucceeded).length,
    originalErrorsReturned: measurements.filter(row => row.errorReturnedToCaller).length,
    originalErrorsInState: measurements.filter(row => row.originalErrorInState).length,
    pauseRecordsPreserved: measurements.filter(row => row.pauseRecordPreserved).length,
    measurements,
  }
  if (process.env.WW_OPT08_RESULT) writeFileSync(process.env.WW_OPT08_RESULT, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
}, 60000)

function holdNextTransaction(db: Awaited<ReturnType<typeof pausedFixture>>['db'], lateFailure = false) {
  const original = db.transaction.bind(db) as (...args: unknown[]) => Promise<unknown>
  let release!: () => void, held = false, first = true
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(db, 'transaction').mockImplementation(((...args: unknown[]) => {
    if (!first) return original(...args)
    first = false; held = true
    return gate.then(() => {
      if (lateFailure) throw new Error('模拟旧启动晚到错误')
      return original(...args)
    })
  }) as typeof db.transaction)
  return { release: () => release(), ready: () => vi.waitFor(() => expect(held).toBe(true), { timeout: 5000 }) }
}

test.each(['cancel', 'new-run'] as const)('继续启动中取消，%s时旧启动不发模型也不覆盖新执行器', async mode => {
  const { db, service, fetcher, runId, resume } = await pausedFixture(false)
  const hold = holdNextTransaction(db, mode === 'new-run')
  const continuing = resume().then(() => '', error => error instanceof Error ? error.message : String(error))
  await hold.ready()
  await service.cancelOrganization('a')
  expect((await db.table('pipelineRuns').get(runId)).status).toBe('cancelled')
  if (mode === 'cancel') {
    hold.release()
    expect(await continuing).toMatch(/取消|aborted/i)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(service.state('a')).toMatchObject({ running: false, paused: false, phase: '已取消' })
    expect(await db.table('pipelineRuns').get('lease:world')).toBeUndefined()
    return
  }

  let releaseNext!: () => void
  const nextGate = new Promise<void>(resolve => { releaseNext = resolve })
  fetcher.mockImplementationOnce(async () => { await nextGate; return agentTextStream('新一轮当前人物尚待整理。') })
  const nextRunId = await service.startOrganizationStep('a', 'scan')
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2), { timeout: 5000 })
  const nextState = { ...service.state('a') }, nextLease = await db.table('pipelineRuns').get('lease:world')
  expect(nextLease.runId).toBe(nextRunId)
  hold.release()
  expect(await continuing).toBe('模拟旧启动晚到错误')
  expect(service.state('a')).toEqual(nextState)
  expect(await db.table('pipelineRuns').get('lease:world')).toEqual(nextLease)
  await service.pauseOrganization('a')
  releaseNext()
  await vi.waitFor(() => expect(service.state('a')?.running).toBe(false), { timeout: 10000 })
  expect((await db.table('pipelineRuns').get(nextRunId)).status).toBe('paused')
  await service.continueOrganization('a')
  await vi.waitFor(() => expect(service.state('a')?.running).toBe(false), { timeout: 10000 })
  expect((await db.table('pipelineRuns').get(nextRunId)).status).toBe('completed')
})

test('同一页面同时继续只取得一个执行器', async () => {
  const { db, service, fetcher, runId, resume } = await pausedFixture(false)
  const results = await Promise.allSettled([resume(), resume()])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  await vi.waitFor(() => expect(service.state('a')?.running).toBe(false), { timeout: 10000 })
  expect((await db.table('pipelineRuns').get(runId)).status).toBe('completed')
  expect(fetcher).toHaveBeenCalledTimes(2)
})

test('启动事务开始前同一运行被另一窗口取得，拒绝接管并保留其租约', async () => {
  const { db, service, fetcher, runId, resume } = await pausedFixture(false)
  const hold = holdNextTransaction(db)
  const continuing = resume().then(() => '', error => error instanceof Error ? error.message : String(error))
  await hold.ready()
  const otherLease = { id: 'lease:world', bookId: 'a', recordType: 'lease', lockKey: 'world', runId, owner: 'other-window', expiresAt: Date.now() + 60000 }
  await db.table('pipelineRuns').put(otherLease)
  hold.release()
  expect(await continuing).toBe('本书已有处理任务。')
  expect(await db.table('pipelineRuns').get('lease:world')).toEqual(otherLease)
  expect((await db.table('pipelineRuns').get(runId)).status).toBe('paused')
  expect(fetcher).toHaveBeenCalledTimes(1)
  await db.table('pipelineRuns').delete('lease:world')
  await resume()
  await vi.waitFor(() => expect(service.state('a')?.running).toBe(false), { timeout: 10000 })
  expect((await db.table('pipelineRuns').get(runId)).status).toBe('completed')
})
