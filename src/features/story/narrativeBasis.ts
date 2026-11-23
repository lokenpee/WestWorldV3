import { NarrativeToolError } from './narrativeErrors'
import type { Row } from '../agents/repository'
import { text } from '../agents/contracts'
import type { NarrativeAssets } from './narrativePlan'

export function narrativeVersions(a: NarrativeAssets, visible: Set<string>, eventLayer: boolean) {
  const versions: Record<string, string> = {}
  const add = (kind: string, rows: Row[]) => {
    for (const r of rows) versions[kind + ':' + r.id] = String(r.revision ?? 0)
  }
  add(
    'node',
    a.nodes.filter((r) => visible.has(text(r.id)))
  )
  add('event', a.events)
  if (!eventLayer) add('line', a.lines)
  add('doubt', a.notes)
  return versions
}
export function checkNarrativeVersions(
  ids: string[],
  seen: Record<string, string>,
  current: Record<string, string>
) {
  const changed = ids.filter((key) => seen[key] !== current[key])
  if (changed.length)
    throw new NarrativeToolError('STALE_OBJECT', '资料已变化，请重新读取后再提交：' + changed.join('、'), {
      objectIds: changed.map((key) => key.slice(key.indexOf(':') + 1)),
      hint: '用查字段或疑点查询重读这些对象，再按当前结果提交。',
    })
}
export const changeKeys = (ops: Row[]) =>
  ops.flatMap((op) =>
    [
      ['line', op.lineId],
      ['line', op.fromLineId],
      ['event', op.eventId],
      ['event', op.fromEventId],
      ...(Array.isArray(op.nodeIds) ? op.nodeIds.map((id) => ['node', id]) : []),
    ].flatMap(([kind, id]) => (typeof id === 'string' && !id.startsWith('$') ? [kind + ':' + id] : []))
  )
