import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createAssetService } from '../src/features/assets/service'
import { createModelService } from '../src/features/models/service'
import { createWorldService } from '../src/features/world/service'
import * as repositories from '../src/features/agents/repository'

const opened: ReturnType<typeof createWorkspace>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const workspace of opened.splice(0)) { await workspace.openBook('b').delete(); await workspace.settings.delete(); workspace.close() }
})
async function fixture() {
  const id = crypto.randomUUID(), workspace = createWorkspace({ settingsName: `tiers-${id}`, bookPrefix: `tiers-${id}-` }); opened.push(workspace)
  await workspace.settings.books.put({ id: 'b', title: '分层样本', sourceFileName: 'test.txt', createdAt: new Date().toISOString() })
  const db = workspace.openBook('b')
  await db.table('characters').bulkPut([
    { id: 'A', bookId: 'b', name: '甲', roleWeight: '路人', roleWeightSource: 'manual', revision: 1 },
    { id: 'B', bookId: 'b', name: '乙', revision: 1 },
    { id: 'C', bookId: 'b', name: '丙', revision: 1 },
  ])
  await db.table('locations').put({ id: 'L', bookId: 'b', name: '城门', revision: 1 })
  await db.table('chapterTexts').put({ bookId: 'b', chapterIndex: '1', text: '甲甲甲乙乙城门' })
  const fetcher = vi.fn<typeof fetch>(), models = createModelService(workspace, { fetch: fetcher })
  const service = createWorldService(workspace, models, createAssetService(workspace))
  return { workspace, db, service, fetcher }
}

it('无P2历史及模型配置也可本地分层，保留人工层级、更新地点频次，重复执行不重复写入', async () => {
  const { db, service, fetcher } = await fixture()
  expect(await service.updateOrganizationStatistics('b')).toEqual({ total: 3, changed: 2, manual: 1 })
  expect(await db.table('characters').get('A')).toMatchObject({ roleWeight: '路人', roleWeightSource: 'manual', frequency: { mentions: 3 } })
  expect(await db.table('characters').get('B')).toMatchObject({ roleWeight: 'NPC', roleWeightSource: 'frequency' })
  expect(await db.table('characters').get('C')).toMatchObject({ roleWeight: '路人' })
  expect(await db.table('locations').get('L')).toMatchObject({ frequency: { mentions: 1 } })
  const before = await db.table('characters').toArray()
  expect(await service.updateOrganizationStatistics('b')).toMatchObject({ changed: 0 })
  expect(await db.table('characters').toArray()).toEqual(before)
  expect(await db.table('pipelineRuns').toArray()).toEqual([])
  expect(fetcher).not.toHaveBeenCalled()
})

it.each(['completed', 'paused'])('有%s旧Agent会话也不接管或改写任务、队列和历史', async status => {
  const { db, service } = await fixture()
  const run = { id: 'old', bookId: 'b', stage: 'P2', workflow: 'character_organization_v1', sessionId: 'old-session', status, organization: { step: 'relations', activeWork: { characterId: 'A' } }, report: { saved: true } }
  const session = { id: 'old-session', bookId: 'b', profile: 'asset_editor', runId: 'old' }
  await db.table('pipelineRuns').put(run); await db.table('storySessions').put(session)
  await expect(service.updateOrganizationStatistics('b')).resolves.toMatchObject({ total: 3 })
  expect(await db.table('pipelineRuns').get('old')).toEqual(run)
  expect(await db.table('storySessions').get('old-session')).toEqual(session)
})

it.each(['world', 'narrative', 'extraction', 'extraction:worldAssets', 'extraction:narrativeAssets'])('已有%s执行权时拒绝，不删除他人锁也不写入', async lockKey => {
  const { db, service } = await fixture()
  const lease = { id: `lease:${lockKey}`, recordType: 'lease', bookId: 'b', lockKey, owner: 'another', runId: 'another-run', expiresAt: Date.now() + 60000 }
  await db.table('pipelineRuns').put(lease)
  await expect(service.updateOrganizationStatistics('b')).rejects.toThrow('本书已有处理任务')
  expect(await db.table('pipelineRuns').get(lease.id)).toEqual(lease)
  expect(await db.table('characters').get('A')).not.toHaveProperty('frequency')
  expect(service.state('b')?.running).toBe(false)
})

// 在真实数据库读取完成后挂起计算，重现另一个执行者/资产修改介入的边界。
function holdSnapshot() {
  const original = repositories.createBookAgentRepository
  let enter!: () => void, release!: () => void
  const ready = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(repositories, 'createBookAgentRepository').mockImplementation((...args) => {
    const base = original(...args)
    return { ...base, async transaction(write, work, lease) {
      const result = await base.transaction(write, work, lease)
      if (!write) { enter(); await gate }
      return result
    } }
  })
  return { ready, release }
}

it('分层进行中拒绝重复点击，第一次仍可完成并释放自己的锁', async () => {
  const { db, service } = await fixture(), held = holdSnapshot()
  const first = service.updateOrganizationStatistics('b'); await held.ready
  await expect(service.updateOrganizationStatistics('b')).rejects.toThrow('本书已有处理任务')
  held.release(); await first
  expect(await db.table('pipelineRuns').get('lease:world')).toBeUndefined()
})

it('保存前执行权转移时拒绝写入，保留新执行者租约', async () => {
  const { db, service } = await fixture(), held = holdSnapshot()
  const pending = service.updateOrganizationStatistics('b'); await held.ready
  const replacement = { ...(await db.table('pipelineRuns').get('lease:world')), owner: 'replacement', runId: 'replacement-run' }
  await db.table('pipelineRuns').put(replacement)
  const rejected = expect(pending).rejects.toThrow('执行权')
  held.release(); await rejected
  expect(await db.table('pipelineRuns').get('lease:world')).toEqual(replacement)
  expect(await db.table('characters').get('A')).not.toHaveProperty('frequency')
})

it('计算后人物修改则整批拒绝，不出现一部分保存，释放自身租约后可重试', async () => {
  const { db, service } = await fixture(), held = holdSnapshot()
  const pending = service.updateOrganizationStatistics('b'); await held.ready
  await db.table('characters').update('C', { revision: 2, roleWeight: '重要配角', roleWeightSource: 'manual' })
  const rejected = expect(pending).rejects.toThrow('资料已变化')
  held.release(); await rejected
  expect(await db.table('characters').get('A')).not.toHaveProperty('frequency')
  expect(await db.table('pipelineRuns').get('lease:world')).toBeUndefined()
  await expect(service.updateOrganizationStatistics('b')).resolves.toMatchObject({ manual: 2 })
})

it('没有人物返回空结果，不创建整理运行或会话', async () => {
  const { db, service } = await fixture()
  await db.table('characters').clear()
  await expect(service.updateOrganizationStatistics('b')).resolves.toEqual({ total: 0, changed: 0, manual: 0 })
  expect(await db.table('pipelineRuns').count()).toBe(0)
  expect(await db.table('storySessions').count()).toBe(0)
})
