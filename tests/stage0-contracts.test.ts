import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../docs/v2/resources/v2.2/', import.meta.url)
const pipeline = JSON.parse(readFileSync(new URL('pipeline-contract.json', root), 'utf8'))
const runtime = JSON.parse(readFileSync(new URL('ai-runtime-contract.json', root), 'utf8'))
const operations = JSON.parse(readFileSync(new URL('operation-catalog.json', root), 'utf8'))

describe('阶段 0：跨文档契约回归（不代表业务已实现）', () => {
  it.each([
    ['idle', true, true], ['P1', true, true], ['P2', false, true],
    ['P3', true, false], ['P2+P3', false, false],
  ])('%s 的人工编辑矩阵', (state, world, narrative) => {
    expect(pipeline.taskIsolation.manualEditPolicy.matrix[state]).toEqual({ world, narrative })
  })

  it('人工锁按书和资产域生效，取消请求不直接释放锁', () => {
    expect(pipeline.taskIsolation.manualCrudDuringTasks).toBeUndefined()
    expect(pipeline.taskIsolation.manualEditPolicy).toMatchObject({
      scope: 'bookId', enforceIn: ['ui', 'command-transaction'],
      release: 'after-inflight-settled-and-owner-lease-released',
      errorCode: 'ASSET_DOMAIN_LOCKED',
    })
    expect(pipeline.stages.P2.canRunWith).toEqual(['P3'])
    expect(pipeline.stages.P3.checkpointDependencies).toContain('actual-read-set')
  })

  it.each([
    ['OP-15', 'world'], ['OP-16', 'world'], ['OP-17', 'narrative'],
    ['OP-18', 'narrative'], ['OP-19', 'world'], ['OP-20', 'narrative'],
    ['OP-21', 'world'], ['OP-23', 'world'], ['OP-24', 'narrative'],
    ['OP-25', 'narrative'], ['OP-61', 'asset-kind'],
  ])('%s 的修改入口必须校验域锁', (id, domain) => {
    const operation = operations.operations.find((item: { id: string }) => item.id === id)
    expect(operation.manualWriteGuard).toEqual({ domain, policy: 'pipeline-contract.json#/taskIsolation/manualEditPolicy' })
    expect(operation.guard).toContain('域锁')
  })

  it('direct 的网络重发和修正共用三次上限，章节不再叠加重试', () => {
    expect(runtime.requestBudget).toMatchObject({
      direct: { maxProviderRequests: 3, maxRepairs: 1, repairsConsumeBudget: true },
      retryableKinds: ['network', 'server', 'rate_limit'],
      chapterRetryWrapper: false,
      agent: { maxRequestsPerTurn: 3, maxProviderRequests: 6, timeoutMs: 180000 },
    })
    expect(pipeline.stages.P1.requestBudgetRef).toBe('ai-runtime-contract.json#/requestBudget')
  })

  it('主要规格不再包含已撤销的无限域编辑和分离计费重试条款', () => {
    const docs = ['01-PRD.md', '02-架构与技术规格.md', '05-Spec-AI与会话.md', '06-界面与交互规格.md', '09-操作与自动触发契约.md']
    for (const doc of docs) {
      const text = readFileSync(new URL(`../../${doc}`, root), 'utf8')
      expect(text).not.toContain('无统一任务级禁用')
      expect(text).not.toContain('| rate_limit | 5 |')
      expect(text).not.toContain('与网络失败计数分离')
      expect(text).not.toContain('仅本地saving禁用')
      expect(text).toContain('ASSET_DOMAIN_LOCKED')
    }
  })

  it('恢复测试必须先停稳释放锁再人工改同域，不能借测试绕过新守卫', () => {
    const recovery = JSON.parse(readFileSync(new URL('acceptance/recovery-cases.json', root), 'utf8'))
    const conflict = recovery.cases.find((item: { id: string }) => item.id === 'GAP-REC-03')
    expect(conflict.steps.map((step: { operation: string }) => step.operation)).toEqual([
      'prepareCommand', 'pauseAndRelease', 'manualUpdate', 'resumeRun', 'executePrepared',
    ])
    const coverage = recovery.cases.find((item: { id: string }) => item.id === 'GAP-REC-04')
    expect(coverage.seed.tables.pipelineRuns.every((record: { recordType: string; status: string }) => record.recordType === 'run' && record.status === 'paused')).toBe(true)
  })
})
