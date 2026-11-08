import type { AgentRepository, AgentStore } from './repository'

interface OrganizationLeaseScope { bookId: string; runId: string; owner: string; sessionId?: string }

// 定时器可能延迟；仅仍持有原租约的执行者可在业务边界续期。
export async function renewOrganizationLease(store: AgentStore, scope: OrganizationLeaseScope) {
  const lease = await store.get('pipelineRuns', 'lease:world')
  if (!lease || lease.bookId !== scope.bookId || lease.owner !== scope.owner || lease.runId !== scope.runId || lease.lockKey !== 'world') throw new Error('CONFLICT:整理阶段执行权已失效。')
  const now = Date.now()
  for (const id of ['lease:extraction', 'lease:extraction:worldAssets', 'lease:extraction:narrativeAssets']) {
    const other = await store.get('pipelineRuns', id)
    if (other && Number(other.expiresAt ?? Infinity) > now) throw new Error('CONFLICT:本书已有提取任务，整理执行权已失效。')
  }
  const session = scope.sessionId ? await store.get('storySessions', scope.sessionId) : undefined
  if (scope.sessionId && (!session || session.bookId !== scope.bookId || session.profile !== 'asset_editor' || session.runId !== scope.runId || session.leaseOwner !== scope.owner)) throw new Error('CONFLICT:人物整理会话执行权已转移。')
  await store.put('pipelineRuns', { ...lease, expiresAt: now + 30000 })
  if (session) await store.put('storySessions', { ...session, leaseUntil: now + 30000 })
}

// 只用于新P2；写操作把续约和业务变更一起提交，读操作先续约再读快照。
export function withOrganizationLease(repo: AgentRepository, scope: OrganizationLeaseScope): AgentRepository {
  return { bookId: repo.bookId, tracePut: rows => repo.tracePut(rows), traceRows: () => repo.traceRows(), async transaction(write, work) {
    if (write) return repo.transaction(true, async store => { await renewOrganizationLease(store, scope); return work(store) })
    await repo.transaction(true, store => renewOrganizationLease(store, scope))
    return repo.transaction(false, work)
  } }
}
