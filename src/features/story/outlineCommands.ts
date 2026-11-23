import { records, strings, text } from '../agents/contracts'
import type { ReadSet } from '../agents/commands'
import type { Scope } from '../agents/queries'
import type { AgentStore, Row } from '../agents/repository'
import { eventDescriptionBatch, refreshReading, type ReadingState } from './reading'
import { hasOutlineDescription, synchronizeOutline, usesOutline } from './outline'

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
  const savedReading = scope.quickStoryCheck ? ((await store.get('pipelineRuns', scope.runId))?.storyReading as Row | undefined)?.window_link as Row | undefined : undefined
  const currentIds = scope.quickStoryCheck ? new Set(strings(records(savedReading?.pages).find(page => page.id === savedReading?.currentPageId)?.ids)) : undefined
  const narrative = scope.workflow === 'narrative_v4'
  const run = !narrative && scope.phase === 'global_review' ? await store.get('pipelineRuns', scope.runId) : undefined
  const review = (run?.storyReading as Row | undefined)?.global_review as ReadingState | undefined
  const reviewPages = records(review?.pages)
  const currentPage = reviewPages.find(page => page.id === review?.currentPageId)
  const descriptionIds = currentPage?.type === 'event_summary' ? eventDescriptionBatch(review).flatMap(page => page.ids) : strings(currentPage?.ids)
  const operations = records(args.operations)
  const writingDescription = (op: Row) => op.summary !== undefined || op.coreClue !== undefined
  if (review?.independent && operations.some(writingDescription)) {
    if (!operations.every(writingDescription)) throw new OutlineError('INVALID_ARGS', '请先单独保存归属修改并核对，再填写说明。')
    const latest = await refreshReading(store, scope.runId, scope.sessionId!, scope.phase)
    const allowed = currentPage?.type === 'line_summary' ? ['line_summary'] : ['event_summary', 'line_summary']
    if (latest.pages.some(page => page.checkedFingerprint !== page.fingerprint && !allowed.includes(page.type))) {
      throw new OutlineError('INVALID_ARGS', '归属或前一步的说明仍需核对，请先翻页读取当前任务。')
    }
  }
  for (const [opIndex, operation] of operations.entries()) {
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
    const changesDescription = operation.summary !== undefined || operation.coreClue !== undefined
    if (changesDescription && !narrative && scope.phase !== 'global_review') fail('INVALID_ARGS', '概况和核心关键线索只能在全书复核阶段填写。')
    if (changesDescription && review?.independent) {
      const expected = operation.op === 'update_event' ? 'event_summary' : 'line_summary'
      const id = text(operation.eventId ?? operation.lineId)
      if (currentPage?.type !== expected || !descriptionIds.includes(id)) {
        fail('INVALID_ARGS', '请先完成全书归属及疑点核对，再填写当前说明页的概况和核心关键线索。')
      }
    }
    const withDescription = (row: Row): Row => {
      if (!changesDescription) return row
      if (narrative) {
        const updated = { ...row }
        for (const field of ['summary', 'coreClue']) {
          if (operation[field] === undefined) continue
          const description = text(operation[field]).trim()
          if (!description) fail('INVALID_ARGS', '请填写有内容的说明。可以只提交需要填写的一项。')
          updated[field] = description
        }
        return updated
      }
      const updated = { ...row, summary: text(operation.summary ?? row.summary).trim(), coreClue: text(operation.coreClue ?? row.coreClue).trim() }
      if (!hasOutlineDescription(updated)) fail('INVALID_ARGS', '概况和核心关键线索均为必填，请一并填写。')
      return updated
    }
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
    if (currentIds && nodeIds.some(id => !currentIds.has(id))) fail('INVALID_ARGS', '快速核对只能调整本页节点。')
    if (['create_event', 'attach_nodes', 'detach_nodes'].includes(text(operation.op))) for (const id of nodeIds) await get('nodes', id)
    switch (operation.op) {
      case 'create_line': {
        const id = newId('L')
        await write('eventLines', undefined, withDescription({ id, bookId: scope.bookId, title: title(), summary: '', coreClue: '', eventIds: [], nodeIds: [], chapters: [], lineStatus: 'open', cause: '', process: '', result: '', createdBy: 'P3', ...(operation.role ? { role: operation.role } : {}) }), 'created')
        await lifecycle(id, 'live')
        break
      }
      case 'update_line': {
        const line = await get('eventLines', operation.lineId)
        if (changesDescription && !narrative && !usesOutline(line)) fail('INVALID_ARGS', '此旧线尚未切换到三层大纲，请先核对归属并切换。')
        const updated = withDescription({ ...line, ...(operation.title !== undefined ? { title: title() } : {}), ...(operation.role ? { role: operation.role } : {}) })
        if (operation.role === null) delete updated.role
        await write('eventLines', line, updated, 'updated')
        break
      }
      case 'create_event': {
        const line = scope.workflow === 'narrative_v4' && operation.lineId === undefined ? undefined : await get('eventLines', operation.lineId)
        const id = newId('E')
        await write('storyEvents', undefined, withDescription({ id, bookId: scope.bookId, title: title(), nodeIds: union([], nodeIds), summary: '', coreClue: '' }), 'created')
        if (line) await write('eventLines', line, lineWithEvents(line, union(strings(line.eventIds), [id])), 'updated')
        break
      }
      case 'rename_event': {
        const event = await get('storyEvents', operation.eventId)
        await write('storyEvents', event, { ...event, title: title() }, 'updated')
        break
      }
      case 'update_event': {
        const event = await get('storyEvents', operation.eventId)
        const updated = withDescription({ ...event, ...(operation.title !== undefined ? { title: title() } : {}) })
        await write('storyEvents', event, updated, 'updated')
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
        const expected = scope.workflow === 'narrative_v4' ? lines.map(line => text(line.id)).sort() : strings(operation.expectedLineIds).map(resolve).sort()
        if (JSON.stringify(expected) !== JSON.stringify(lines.map(line => text(line.id)).sort())) fail('CONFLICT', `所属故事线发生变化，请重新读取事件 ${id}。`)
        for (const line of lines) await write('eventLines', line, lineWithEvents(line, without(strings(line.eventIds), [id])), 'updated')
        await write('storyEvents', event, event, 'deleted')
        break
      }
      case 'activate_legacy_line': {
        const line = await get('eventLines', operation.lineId)
        if (scope.phase !== 'global_review' || currentPage?.type !== (review?.independent ? 'line_structure' : 'line_summary') || currentPage.lineId !== line.id || (review?.independent ? usesOutline(line) : !line.outlinePending)) fail('INVALID_ARGS', '仅可在该旧线的整线复核页切换。')
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
  if (changes.length) await synchronizeOutline(store, timestamp, scope.workflow !== 'narrative_v4' || changes.some(change => change.kind === 'event'))
  return { changed: changes.length > 0, created: Object.fromEntries(created), changes }
}
