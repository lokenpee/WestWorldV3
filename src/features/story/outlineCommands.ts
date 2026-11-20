import { records, strings, text } from '../agents/contracts'
import type { ReadSet } from '../agents/commands'
import type { Scope } from '../agents/queries'
import type { AgentStore, Row } from '../agents/repository'
import { synchronizeOutline } from './outline'

export class OutlineError extends Error {
  readonly code: string
  readonly opIndex?: number
  constructor(code: string, message: string, opIndex?: number) {
    super(`${code}:${message}`)
    this.code = code
    this.opIndex = opIndex
  }
}
const without = (ids: string[], removed: string[]) => ids.filter(id => !removed.includes(id))
const union = (ids: string[], added: string[]) => [...new Set([...ids, ...added])]

export async function applyOutline(store: AgentStore, scope: Scope, args: Row, reads: ReadSet, timestamp: string) {
  const created = new Map<string, string>()
  const changes: Row[] = []
  const additions = new Set<string>()
  for (const [opIndex, operation] of records(args.operations).entries()) {
    const fail = (code: string, message: string): never => { throw new OutlineError(code, message, opIndex) }
    const resolve = (value: unknown) => {
      const id = text(value)
      return id.startsWith('$') ? created.get(id.slice(1)) ?? fail('INVALID_ARGS', `临时编号不存在：${id}`) : id
    }
    const get = async (table: string, ref: unknown) => {
      const id = resolve(ref)
      const row = await store.get(table, id)
      if (!row || row.bookId !== scope.bookId) return fail('SCOPE', `资料不存在或无法访问：${id}`)
      if (!additions.has(id) && !reads.records.some(read => read.table === table && read.resolvedId === id)) return fail('READ_REQUIRED', `请先读取资料：${id}`)
      return row
    }
    const title = () => text(operation.title).trim() || fail('INVALID_ARGS', '请输入名称。')
    const newId = (prefix: string) => {
      const ref = text(operation.ref)
      if (created.has(ref)) return fail('INVALID_ARGS', `临时编号重复：${ref}`)
      const id = `${prefix}-${crypto.randomUUID()}`
      created.set(ref, id); additions.add(id)
      return id
    }
    const write = async (table: 'eventLines' | 'storyEvents', before: Row | undefined, after: Row, action: string) => {
      const members = table === 'eventLines' ? 'eventIds' : 'nodeIds'
      const previous = strings(before?.[members]), next = action === 'deleted' ? [] : strings(after[members])
      if (action !== 'deleted' && before && JSON.stringify(before) === JSON.stringify(after)) return
      if (action === 'deleted') await store.remove(table, text(after.id))
      else await store.put(table, { ...after, revision: Number(before?.revision ?? 0) + 1, ...(table === 'eventLines' ? { updatedAt: timestamp } : {}) })
      const addedIds = without(next, previous), removedIds = without(previous, next)
      changes.push({ opIndex, kind: table === 'eventLines' ? 'eventLine' : 'event', id: after.id, action, ...(addedIds.length || removedIds.length ? { addedIds, removedIds } : {}) })
    }
    const lineWithEvents = (line: Row, eventIds: string[]) => ({ ...line, eventIds, ...(!Array.isArray(line.eventIds) ? { outlinePending: true } : {}) })
    const lifecycle = async (id: string, state: 'live' | 'deleted') => {
      const key = `eventLine:${id}`, before = await store.get('assetLifecycle', key)
      await store.put('assetLifecycle', { ...before, key, bookId: scope.bookId, kind: 'eventLine', originId: id, state, ...(state === 'live' ? { currentId: id } : { currentId: undefined }), revision: Number(before?.revision ?? 0) + 1, updatedAt: timestamp })
    }
    const nodeIds = strings(operation.nodeIds)
    if (['create_event', 'attach_nodes', 'detach_nodes'].includes(text(operation.op))) for (const id of nodeIds) await get('nodes', id)
    switch (operation.op) {
      case 'create_line': {
        const id = newId('L')
        await write('eventLines', undefined, { id, bookId: scope.bookId, title: title(), eventIds: [], nodeIds: [], chapters: [], lineStatus: 'open', cause: '', process: '', result: '', createdBy: 'P3', ...(operation.role ? { role: operation.role } : {}) }, 'created')
        await lifecycle(id, 'live')
        break
      }
      case 'update_line': {
        const line = await get('eventLines', operation.lineId)
        const updated: Row = { ...line, ...(operation.title !== undefined ? { title: title() } : {}), ...(operation.role ? { role: operation.role } : {}) }
        if (operation.role === null) delete updated.role
        await write('eventLines', line, updated, 'updated')
        break
      }
      case 'create_event': {
        const line = await get('eventLines', operation.lineId)
        const id = newId('E')
        await write('storyEvents', undefined, { id, bookId: scope.bookId, title: title(), nodeIds: union([], nodeIds) }, 'created')
        await write('eventLines', line, lineWithEvents(line, union(strings(line.eventIds), [id])), 'updated')
        break
      }
      case 'rename_event': {
        const event = await get('storyEvents', operation.eventId)
        await write('storyEvents', event, { ...event, title: title() }, 'updated')
        break
      }
      case 'attach_event':
      case 'detach_event': {
        const line = await get('eventLines', operation.lineId), event = await get('storyEvents', operation.eventId)
        const id = text(event.id), ids = strings(line.eventIds)
        if (operation.fromLineId !== undefined) {
          const source = await get('eventLines', operation.fromLineId)
          if (source.id === line.id || !strings(source.eventIds).includes(id)) fail('INVALID_ARGS', '来源线须包含该事件，且与目标线不同。')
          await write('eventLines', source, lineWithEvents(source, without(strings(source.eventIds), [id])), 'updated')
        }
        if (operation.op === 'attach_event') await write('eventLines', line, lineWithEvents(line, union(ids, [id])), 'updated')
        else if (ids.includes(id)) await write('eventLines', line, lineWithEvents(line, without(ids, [id])), 'updated')
        break
      }
      case 'attach_nodes':
      case 'detach_nodes': {
        const event = await get('storyEvents', operation.eventId)
        const ids = strings(event.nodeIds)
        if (operation.fromEventId !== undefined) {
          const source = await get('storyEvents', operation.fromEventId)
          if (source.id === event.id || nodeIds.some(id => !strings(source.nodeIds).includes(id))) fail('INVALID_ARGS', '来源事件须包含所给节点，且与目标事件不同。')
          await write('storyEvents', source, { ...source, nodeIds: without(strings(source.nodeIds), nodeIds) }, 'updated')
        }
        await write('storyEvents', event, { ...event, nodeIds: operation.op === 'attach_nodes' ? union(ids, nodeIds) : without(ids, nodeIds) }, 'updated')
        break
      }
      case 'delete_line': {
        const line = await get('eventLines', operation.lineId)
        if (!Array.isArray(line.eventIds) || line.outlinePending) fail('INVALID_ARGS', '请在旧线入口处理尚未切换的故事线。')
        await write('eventLines', line, line, 'deleted')
        await lifecycle(text(line.id), 'deleted')
        break
      }
      case 'delete_event': {
        const event = await get('storyEvents', operation.eventId)
        const id = text(event.id)
        const lines = (await store.rows('eventLines')).filter(line => line.bookId === scope.bookId && strings(line.eventIds).includes(id))
        const expected = strings(operation.expectedLineIds).map(resolve).sort()
        if (JSON.stringify(expected) !== JSON.stringify(lines.map(line => text(line.id)).sort())) fail('CONFLICT', `所属故事线发生变化，请重新读取事件 ${id}。`)
        for (const line of lines) await write('eventLines', line, lineWithEvents(line, without(strings(line.eventIds), [id])), 'updated')
        await write('storyEvents', event, event, 'deleted')
        break
      }
      case 'activate_legacy_line': {
        const line = await get('eventLines', operation.lineId)
        const run = await store.get('pipelineRuns', scope.runId)
        const review = (run?.storyReading as Row | undefined)?.global_review as Row | undefined
        const page = records(review?.pages).find(item => item.id === review?.currentPageId)
        if (scope.phase !== 'global_review' || page?.type !== 'line_summary' || page.lineId !== line.id || !line.outlinePending) fail('INVALID_ARGS', '仅可在该旧线的整线复核页切换。')
        const members = new Set<string>()
        for (const id of strings(line.eventIds)) for (const nodeId of strings((await store.get('storyEvents', id))?.nodeIds)) members.add(nodeId)
        const old = strings(line.nodeIds), excluded = strings(operation.excludedNodeIds)
        if (old.some(id => !members.has(id) && !excluded.includes(id)) || excluded.some(id => !old.includes(id) || members.has(id))) fail('INVALID_ARGS', '请核对每个旧成员的归属或明确将它移出原线。')
        await write('eventLines', line, { ...line, legacyNodeIds: old, outlinePending: false }, 'updated')
        break
      }
      default: fail('INVALID_ARGS', '未知的大纲操作。')
    }
  }
  if (changes.length) await synchronizeOutline(store, timestamp)
  return { changed: changes.length > 0, created: Object.fromEntries(created), changes }
}
