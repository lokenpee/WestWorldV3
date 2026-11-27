import { records, strings, text } from '../agents/contracts'
import type { Row } from '../agents/repository'
import type { NarrativeAssets, NarrativeTask, NarrativePlan } from './narrativePlan'

type Named = { id: string; title: string }
export type Outcome = { parent: Named; items: Named[] }[]
const named = (r: Row): Named => ({ id: text(r.id), title: text(r.title ?? r.name ?? r.statement) })
function group(rows: { item: Named; parents: Named[] }[]): Outcome {
  const groups = new Map<string, Outcome[number]>()
  for (const { item, parents } of rows)
    for (const parent of parents) {
      if (!groups.has(parent.id)) groups.set(parent.id, { parent, items: [] })
      groups.get(parent.id)!.items.push(item)
    }
  return [...groups.values()]
}
export function confirmedOutcome(task: NarrativeTask, plan: NarrativePlan, a: NarrativeAssets, args: Row) {
  const event = plan.layer === 'event'
  const selected = new Set([...task.ids, ...strings(args.handled_event_ids)])
  const items = event ? a.nodes : a.events
  const parents = event ? a.events : a.lines
  return group(
    items
      .filter((r) => selected.has(text(r.id)))
      .map((r) => {
        const item = named(r)
        const belongs = parents
          .filter((p) => strings(p[event ? 'nodeIds' : 'eventIds']).includes(item.id))
          .map(named)
        if (!belongs.length) {
          const doubts = a.notes.filter(
            (n) => n.status === 'active' && strings(n[event ? 'nodeIds' : 'eventIds']).includes(item.id)
          )
          const note = plan.retained[item.id]
          belongs.push({ id: '', title: '未归属' })
          item.title += ' · ' + [note, ...doubts.map((n) => text(n.statement))].filter(Boolean).join('；')
        }
        return { item, parents: belongs }
      })
  )
}

// 旧运行仅展示当时写入回执中可证明的成员变化，避免把之后的复核当成本批成果。
export function receiptOutcome(receipts: Row[], task: NarrativeTask) {
  const event = task.mode === 'node_batch'
  const material = JSON.parse(task.prompt)
  const targets = records(material.targets ?? material.本批节点资料 ?? material.本组事件资料)
  const outline = material.outline ?? material.事件与可见节点目录 ?? material.故事线与事件目录 ?? {}
  const names = new Map(
    [...targets, ...records(outline.events), ...records(outline.lines)].map((r) => [text(r.id), named(r)])
  )
  const groups: Outcome = []
  for (const receipt of receipts) {
    const ops = records((receipt.arguments as Row)?.operations)
    for (const change of records((receipt.result as Row)?.changes)) {
      if (change.kind !== (event ? 'event' : 'eventLine')) continue
      const id = text(change.id),
        op = ops[Number(change.opIndex)]
      if (op?.title) names.set(id, { id, title: text(op.title) })
      const items = ['addedIds', 'removedIds'].flatMap((key) =>
        strings(change[key]).map((member) => ({
          id: member,
          title: (key === 'addedIds' ? '归入 · ' : '移出 · ') + (names.get(member)?.title ?? ''),
        }))
      )
      if (items.length) groups.push({ parent: names.get(id) ?? { id, title: '' }, items })
    }
  }
  return groups
}

type ReviewChange = { label: string; value?: string }
type ReviewRow = Named & { context: string; changes: ReviewChange[]; outcome: string; note: string }
type ReviewNames = (ids: string[], kind: 'node' | 'event' | 'line' | 'doubt') => Promise<Named[]>

export async function reviewReceiptOutcome(
  task: NarrativeTask,
  material: Row,
  targets: Row[],
  receipts: Row[],
  confirm: Row | undefined,
  loadNames: ReviewNames
) {
  const directory = (material.事件与可见节点目录 ?? material.故事线与事件目录 ?? material.outline) as Row | undefined
  const names = new Map(
    [...records(directory?.nodes), ...records(directory?.events), ...records(directory?.lines), ...targets]
      .map(named).filter(({ title }) => title).map(({ id, title }) => [id, title])
  )
  const decisions = new Map(records(confirm?.reviewResults ?? (confirm?.arguments as Row | undefined)?.review_results)
    .map((decision) => [text(decision.target_id), decision]))
  const changes = new Map<string, Map<string, ReviewChange>>()
  const members = new Map<string, Map<string, 'added' | 'removed'>>()
  const parents = new Set<string>()
  const doubts = new Set<string>()
  const descriptions = new Set<string>()
  const save = (id: string, key: string, label: string, value?: string) => {
    const entry = changes.get(id) ?? new Map()
    entry.set(key, { label, ...(value ? { value } : {}) })
    changes.set(id, entry)
  }
  const markMember = (id: string, parent: string, action: 'added' | 'removed') => {
    const entry = members.get(id) ?? new Map()
    if (entry.has(parent) && entry.get(parent) !== action) entry.delete(parent)
    else entry.set(parent, action)
    members.set(id, entry)
  }
  const eventLayer = task.mode === 'event_cycle' || task.mode === 'event_review'
  const parentLabel = eventLayer ? '事件' : '故事线'
  for (const receipt of receipts) {
    const args = receipt.arguments as Row | undefined
    const result = receipt.result as Row | undefined
    if (receipt.name === 'manage_doubts') {
      const id = text(result?.id)
      const action = text(result?.action)
      const label: Record<string, string> = {
        create: '登记疑点', update: '更新疑点', resolve: '已解决疑点',
        reopen: '重新打开疑点', merge: '合并疑点', delete: '删除疑点',
      }
      if (!id || !label[action]) continue
      doubts.add(id)
      if (text(args?.statement)) names.set(id, text(args?.statement))
      save(id, 'doubt', label[action], text(args?.reason))
      continue
    }
    if (receipt.name !== 'edit_events' && receipt.name !== 'edit_storylines') continue
    const operations = records(args?.operations)
    for (const change of records(result?.changes)) {
      if (change.kind !== (eventLayer ? 'event' : 'eventLine')) continue
      const id = text(change.id)
      if (!id) continue
      parents.add(id)
      for (const member of strings(change.addedIds)) markMember(member, id, 'added')
      for (const member of strings(change.removedIds)) markMember(member, id, 'removed')
      const operation = operations[Number(change.opIndex)]
      if (!operation) continue
      const reason = text(operation.reason).trim()
      if (reason) {
        const memberTargets = [...strings(change.addedIds), ...strings(change.removedIds)].filter(member => task.ids.includes(member))
        for (const target of memberTargets.length ? memberTargets : [id])
          save(target, 'reason:' + reason, '修改原因', reason)
      }
      if (change.action === 'created') save(id, 'object', '新建' + parentLabel)
      if (change.action === 'deleted') save(id, 'object', '删除' + parentLabel)
      const op = text(operation.op)
      if (['create_event', 'create_line', 'update_event', 'update_line', 'rename_event'].includes(op)) {
        const title = text(operation.title).trim()
        const previous = names.get(id)
        if (title) {
          names.set(id, title)
          if (change.action === 'updated' && previous !== title)
            save(id, 'title', previous ? '名称从「' + previous + '」改为「' + title + '」' : '保存名称', previous ? undefined : title)
        }
        for (const [field, label] of [['summary', '保存概况'], [operation.clues === undefined ? 'coreClue' : 'clues', '保存核心关键线索']] as const) {
          const value = field === 'clues' ? strings(operation.clues).join('、') : text(operation[field]).trim()
          if (!value) continue
          descriptions.add(id)
          save(id, field, label, value)
        }
        if (Object.hasOwn(operation, 'role')) save(id, 'role', operation.role === null ? '清除故事线角色' : '保存故事线角色', text(operation.role))
      }
    }
  }
  const missing = (ids: Iterable<string>) => [...ids].filter((id) => !names.has(id))
  const fetched = await Promise.all([
    loadNames(missing(parents), eventLayer ? 'event' : 'line'),
    loadNames(missing(members.keys()), eventLayer ? 'node' : 'event'),
    loadNames(missing(doubts), 'doubt'),
  ])
  for (const { id, title } of fetched.flat()) if (title && !names.has(id)) names.set(id, title)
  const title = (id: string) => names.get(id) || id
  const listed = new Set(task.ids)
  let membershipCount = 0
  for (const [memberId, byParent] of members) {
    const added: string[] = [], removed: string[] = []
    for (const [id, action] of byParent) (action === 'added' ? added : removed).push(id)
    if (!added.length && !removed.length) continue
    const involved = [...added, ...removed]
    const rowId = listed.has(memberId) ? memberId : involved.find((id) => listed.has(id)) ?? involved[0]
    const labels = (ids: string[]) => ids.map((id) => '「' + title(id) + '」').join('、')
    const action = added.length && removed.length
      ? '从' + labels(removed) + '移到' + labels(added)
      : added.length ? '归入' + labels(added) : '移出' + labels(removed)
    save(rowId, 'member:' + memberId, '「' + title(memberId) + '」' + action)
    membershipCount++
  }
  const candidateContext = new Map(targets.filter(row => row.入选原因).map(row => {
    const parents = records(row.当前事件 ?? row.当前故事线).map(parent => text(parent.title ?? parent.id))
    return [text(row.id), [text(row.入选原因), ...parents].join(' · ')]
  }))
  const rows: ReviewRow[] = [...new Set([...changes.keys(), ...task.ids])].map((id) => ({
    id,
    title: title(id),
    context: candidateContext.get(id) ?? '',
    changes: [...(changes.get(id)?.values() ?? [])],
    outcome: confirm?.reviewResults && changes.has(id) && decisions.get(id)?.outcome === 'no_change'
      ? 'repaired' : text(decisions.get(id)?.outcome),
    note: text(decisions.get(id)?.note),
  }))
  return { rows, confirmed: Boolean(confirm), membershipCount, descriptionCount: descriptions.size, targetCount: task.ids.length }
}
