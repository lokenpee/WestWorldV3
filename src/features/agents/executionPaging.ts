import type { createWorkspace } from '../../lib/storage/workspace'
import type { ExecutionChain } from './trace'
import type { Row } from './repository'
import type { ExecutionEvent } from './executionChain'
import type { ExecutionGroup, ExecutionPageResult, ExecutionQuery } from './executionPagingTypes'

type Workspace = ReturnType<typeof createWorkspace>
const caches = new WeakMap<Workspace, Map<string, { refresh: (earlier?: boolean) => Promise<ExecutionChain | undefined> }>>()
const idOf = (row: Row) => String(row.requestId ?? row.id)

/** 每个选择保留已读页；正文仅在展开时读取，不进入页缓存。 */
export function readPagedExecution(workspace: Workspace, bookId: string, query: ExecutionQuery, runStatus: string) {
  let cache = caches.get(workspace)
  if (!cache) { cache = new Map(); caches.set(workspace, cache) }
  const key = JSON.stringify([bookId, query])
  let selection = cache.get(key)
  if (!selection) {
    let page: ExecutionPageResult | undefined
    const groups = new Map<string, ExecutionGroup>()
    let queue: Promise<unknown> = Promise.resolve()
    const call = <T>(action: string, options: unknown) => workspace.disk!<T>({ action, scope: `book:${bookId}`, options })
    const loadEvent = async (event: ExecutionEvent) => (await call<{ event: ExecutionEvent }>('executionBody', { ...query, requestId: event.entry.requestId, eventKey: event.key })).event
    const loadRequest = async (request: Row) => {
      const result = await call<{ request: Row; snapshots: Row[] }>('executionBody', { ...query, requestId: idOf(request) })
      return { request: result.request, snapshots: new Map(result.snapshots.map(row => [String(row.snapshotId ?? row.id), row])) }
    }
    const refresh = (earlier = false): Promise<ExecutionChain | undefined> => {
      const work = queue.catch(() => {}).then(async () => {
        const previous = page
        const result = await call<ExecutionPageResult>('executionPage', { ...query, ...(earlier && page?.nextBefore ? { before: page.nextBefore } : page ? { since: page.version } : {}) })
        if (result.legacy) { page = undefined; groups.clear(); return undefined }
        const valid = new Set(result.validRequestIds)
        const removed = previous?.validRequestIds.some(id => !valid.has(id)) || !!previous && result.version < previous.version
        // 清理会改变相邻请求的上下文去重；从最近页重新建立阅读顺序。
        const next = removed ? await call<ExecutionPageResult>('executionPage', query) : result
        if (removed) groups.clear()
        for (const group of next.groups) groups.set(idOf(group.request), group)
        page = previous && !earlier && !removed ? { ...next, hasEarlier: previous.hasEarlier, nextBefore: previous.nextBefore } : next
        const ordered = [...groups.values()].sort((a, b) => String(a.request.startedAt).localeCompare(String(b.request.startedAt)) || idOf(a.request).localeCompare(idOf(b.request)))
        return { entries: [], requests: ordered.map(group => group.request), snapshots: new Map<string, Row>(), runStatus,
          summary: page.summary, paging: { events: ordered.flatMap(group => group.events), hasEarlier: page.hasEarlier, loadEvent, loadRequest,
            loadEarlier: async () => (await refresh(true))! } }
      })
      queue = work
      return work
    }
    selection = { refresh }; cache.set(key, selection)
    if (cache.size > 8) cache.delete(cache.keys().next().value!)
  }
  return selection.refresh().then(chain => chain ? { ...chain, runStatus } : chain)
}
