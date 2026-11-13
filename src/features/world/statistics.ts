import type { createWorkspace } from '../../lib/storage/workspace'
import { createFrequencyCounter } from '../assets/derive'
import type { Character, LocationAsset } from '../assets/types'
import { createBookAgentRepository, type AgentRepository, type AgentStore } from '../agents/repository'
import { renewOrganizationLease } from '../agents/organizationLease'
import { createLeaseHeartbeat } from './leaseHeartbeat'

export async function prepareStatistics(repo: AgentRepository, signal: AbortSignal) {
  const snapshot = await repo.transaction(false, async store => ({
    people: await store.rows('characters') as unknown as Character[],
    places: await store.rows('locations') as unknown as LocationAsset[],
    texts: await store.rows('chapterTexts') as unknown as { chapterIndex: string; text: string }[],
  }))
  const people = createFrequencyCounter(snapshot.people, true), places = createFrequencyCounter(snapshot.places, false)
  let yieldedAt = performance.now()
  for (const row of snapshot.texts) {
    signal.throwIfAborted()
    people.add(row); places.add(row)
    if (performance.now() - yieldedAt > 8) { await new Promise(resolve => setTimeout(resolve, 0)); yieldedAt = performance.now() }
  }
  signal.throwIfAborted()
  const measured = people.result()
  const updates = [...measured.map((row, index) => ({ table: 'characters', row, before: snapshot.people[index] })), ...places.result().map((row, index) => ({ table: 'locations', row, before: snapshot.places[index] }))]
    .filter(({ row, before }) => JSON.stringify(row) !== JSON.stringify(before))
  return { snapshot, updates, summary: { total: snapshot.people.length, changed: measured.filter((row, index) => row.roleWeight !== snapshot.people[index].roleWeight).length, manual: snapshot.people.filter(row => row.roleWeightSource === 'manual').length } }
}

export async function saveStatistics(store: AgentStore, plan: Awaited<ReturnType<typeof prepareStatistics>>, timestamp: string) {
  // 分位依赖全部人物，不能只校验本次有变化的行。
  for (const [table, before] of [['characters', plan.snapshot.people], ['locations', plan.snapshot.places]] as const) {
    const current = await store.rows(table), revisions = new Map(before.map(row => [row.id, row.revision]))
    if (current.length !== before.length || current.some(row => !revisions.has(String(row.id)) || revisions.get(String(row.id)) !== row.revision)) throw new Error('CONFLICT:分层期间资料已变化，请重试。')
  }
  for (const { table, row, before } of plan.updates) {
    await store.put(table, { ...before, frequency: row.frequency, ...(table === 'characters' ? { roleWeight: (row as Character).roleWeight, roleWeightSource: (row as Character).roleWeightSource } : {}), revision: before.revision + 1, updatedAt: timestamp })
  }
}

/** 本地分层只持有书籍写锁，不读取或接管任何Agent会话。 */
export async function updateCharacterTiers(workspace: ReturnType<typeof createWorkspace>, bookId: string, controller: AbortController) {
  if (!await workspace.settings.books.get(bookId)) throw new Error('书籍不存在。')
  const db = workspace.openBook(bookId), repo = createBookAgentRepository(workspace, bookId)
  const scope = { bookId, owner: crypto.randomUUID(), runId: crypto.randomUUID() }
  const guard = { lockKey: 'world', owner: scope.owner, runId: scope.runId }
  let acquired = false, heartbeat: ReturnType<typeof createLeaseHeartbeat> | undefined
  try {
    await db.transaction('rw', db.table('pipelineRuns'), async () => {
      const leases = await db.table('pipelineRuns').toArray()
      if (leases.some(row => row.recordType === 'lease' && ['world', 'narrative', 'extraction', 'extraction:worldAssets', 'extraction:narrativeAssets'].includes(row.lockKey) && (typeof row.expiresAt !== 'number' || row.expiresAt > Date.now()))) throw new Error('本书已有处理任务，请等待完成后再进行人物自动分层。')
      controller.signal.throwIfAborted()
      await db.table('pipelineRuns').put({ id: 'lease:world', recordType: 'lease', bookId, lockKey: 'world', owner: scope.owner, runId: scope.runId, expiresAt: Date.now() + 30000 })
    })
    acquired = true
    heartbeat = createLeaseHeartbeat(() => repo.transaction(true, store => renewOrganizationLease(store, scope), guard), error => controller.abort(error))
    const plan = await prepareStatistics(repo, controller.signal)
    await repo.transaction(true, async store => {
      controller.signal.throwIfAborted()
      await renewOrganizationLease(store, scope)
      await saveStatistics(store, plan, new Date().toISOString())
      controller.signal.throwIfAborted()
    }, guard)
    return plan.summary
  } finally {
    heartbeat?.close()
    if (acquired) await db.transaction('rw', db.table('pipelineRuns'), async () => {
      const lease = await db.table('pipelineRuns').get('lease:world')
      if (lease?.owner === scope.owner && lease.runId === scope.runId) await db.table('pipelineRuns').delete('lease:world')
    })
  }
}
