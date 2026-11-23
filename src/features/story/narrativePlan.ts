import { NarrativeToolError } from './narrativeErrors'
import { partLabel } from './narrativeLabels'
import { formatNarrativeInput, includesNarrativeDirectory } from './narrativeInput'
import { canonical, strings, text } from '../agents/contracts'
import type { AgentStore, Row } from '../agents/repository'

export const narrativeDefaults = {
  nodeBatchSize: 20,
  eventGroupSize: 20,
  eventReviewInterval: 10,
  lineReviewInterval: 10,
  segmentSize: 20,
  outlineThreshold: 2000,
  keepRecentRounds: 2,
}
export type NarrativeConfig = typeof narrativeDefaults
export type Layer = 'event' | 'line'
export type Mode =
  'node_batch' | 'event_cycle' | 'event_review' | 'event_group' | 'line_cycle' | 'line_review'
export type Part = 'batch' | 'structure' | 'doubts' | 'unassigned' | 'descriptions'
export type ReviewProgress = { 环节: string; 已核: number; 待核: number }[]
export interface NarrativeTask {
  id: string
  mode: Mode
  part: Part
  ids: string[]
  prompt: string
  basis: Record<string, string>
  singletonSources?: Record<string, string[]>
  reviewProgress?: ReviewProgress
}
interface Review {
  final: boolean
  coverage: Record<string, string>
}
export interface NarrativePlan {
  config: NarrativeConfig
  layer: Layer
  complete: boolean
  reuseAssigned?: boolean
  active?: NarrativeTask
  nodes: Record<string, string>
  events: Record<string, string>
  retained: Record<string, string>
  batches: { event: number; line: number }
  periodTasks?: string[]
  reviews?: { layer: Layer; final: boolean; batchIds: string[]; counts: Record<string, number> }[]
  period: string[]
  affected: string[]
  review?: Review
}
export function newNarrativePlan(config: NarrativeConfig = narrativeDefaults): NarrativePlan {
  for (const key of Object.keys(narrativeDefaults) as (keyof NarrativeConfig)[])
    if (!Number.isSafeInteger(config[key]) || config[key] < 1)
      throw new Error('P3 运行参数 ' + key + ' 须为正整数。')
  return {
    config: { ...config },
    layer: 'event',
    complete: false,
    nodes: {},
    events: {},
    retained: {},
    batches: { event: 0, line: 0 },
    period: [],
    affected: [],
  }
}
export async function narrativeAssets(store: AgentStore, sessionId: string) {
  const [chapters, nodes, events, lines, notes] = await Promise.all(
    ['chapters', 'nodes', 'storyEvents', 'eventLines', 'storyEditorNotes'].map((table) => store.rows(table))
  )
  const order = new Map(chapters.map((row) => [row.chapterIndex, Number(row.order)]))
  nodes.sort(
    (a, b) =>
      (order.get(a.chapterIndex) ?? Infinity) - (order.get(b.chapterIndex) ?? Infinity) ||
      Number(a.order) - Number(b.order) ||
      text(a.id).localeCompare(text(b.id))
  )
  const positions = new Map(nodes.map((row, index) => [text(row.id), index]))
  const first = (ids: string[], index: Map<string, number>) =>
    ids.reduce((value, id) => Math.min(value, index.get(id) ?? Infinity), Infinity)
  events.sort(
    (a, b) =>
      first(strings(a.nodeIds), positions) - first(strings(b.nodeIds), positions) ||
      text(a.id).localeCompare(text(b.id))
  )
  const eventPositions = new Map(events.map((row, i) => [text(row.id), i]))
  lines.sort(
    (a, b) =>
      first(strings(a.eventIds), eventPositions) - first(strings(b.eventIds), eventPositions) ||
      text(a.id).localeCompare(text(b.id))
  )
  return { nodes, events, lines, notes: notes.filter((row) => row.sessionId === sessionId) }
}
export type NarrativeAssets = Awaited<ReturnType<typeof narrativeAssets>>
export const idsOf = (rows: Row[]) => rows.map((row) => text(row.id))
export const nodeBrief = (r: Row) => ({
  id: r.id,
  name: r.name,
  summary: r.summary,
  actors: r.actors,
  actorIds: r.actorIds,
  targetCharacterIds: r.targetCharacterIds,
  targets: r.targets,
  locations: r.locationNames,
  chapter: r.chapterIndex,
  order: r.order,
})
export function visibleNodes(
  plan: NarrativePlan,
  task: Pick<NarrativeTask, 'mode' | 'ids'>,
  assets: NarrativeAssets
) {
  return plan.layer === 'line' || task.mode === 'event_review'
    ? new Set(idsOf(assets.nodes))
    : new Set([...Object.keys(plan.nodes), ...(task.mode === 'node_batch' ? task.ids : [])])
}
export function catalog(plan: NarrativePlan, assets: NarrativeAssets, visible: Set<string>, expand = true) {
  const events = assets.events.map((row) => ({
    id: row.id,
    title: row.title,
    nodeIds: strings(row.nodeIds).filter((id) => visible.has(id)),
  }))
  const lines =
    plan.layer === 'line'
      ? assets.lines.map((row) => ({ id: row.id, title: row.title, eventIds: strings(row.eventIds) }))
      : undefined
  const titles = events.map(({ id, title }) => ({ id, title }))
  if (!expand)
    return { events: titles, ...(lines ? { lines: lines.map(({ id, title }) => ({ id, title })) } : {}) }
  const nodes = assets.nodes.filter((n) => visible.has(text(n.id))).map((n) => ({ id: n.id, name: n.name }))
  if (lines) {
    const assigned = new Set(lines.flatMap((line) => line.eventIds))
    return {
      lines,
      events,
      nodes,
      unassignedEventIds: titles.map((e) => text(e.id)).filter((id) => !assigned.has(id)),
    }
  }
  const members = new Set(events.flatMap((e) => e.nodeIds))
  const unassignedNodeIds = nodes.map((n) => text(n.id)).filter((id) => !members.has(id))
  return {
    events,
    unassignedNodeIds,
    nodes,
  }
}
function targets(plan: NarrativePlan, a: NarrativeAssets) {
  const eventLayer = plan.layer === 'event'
  return {
    items: eventLayer ? a.nodes : a.events,
    parents: eventLayer ? a.events : a.lines,
    key: eventLayer ? 'nodeIds' : 'eventIds',
    coverage: eventLayer ? plan.nodes : plan.events,
  }
}
export function assignment(plan: NarrativePlan, a: NarrativeAssets, row: Row) {
  const { parents, key } = targets(plan, a)
  const id = text(row.id),
    eventLayer = plan.layer === 'event'
  const belongs = parents.filter((p) => strings(p[key]).includes(id)).map((p) => text(p.id))
  const doubts = a.notes.filter(
    (n) =>
      n.status === 'active' &&
      n.category === (eventLayer ? 'NODE_ASSIGNMENT' : 'EVENT_ASSIGNMENT') &&
      strings(n[eventLayer ? 'nodeIds' : 'eventIds']).includes(id)
  )
  const retained = eventLayer && plan.retained[id]
  const basis = canonical([
    eventLayer
      ? [nodeBrief(row), row.process, row.clues, row.new_facts, row.actorIds, row.targetCharacterIds]
      : [row.title, row.nodeIds, row.summary, row.coreClue],
    belongs,
    idsOf(doubts),
    retained || '',
  ])
  return {
    valid: !!(belongs.length || doubts.length || retained),
    basis,
    belongs,
    hasOpenDoubt: doubts.length > 0,
  }
}
function singleMemberParents(plan: NarrativePlan, a: NarrativeAssets, id: string) {
  const { parents, key } = targets(plan, a)
  return parents.filter(parent => {
    const members = strings(parent[key])
    return members.length === 1 && members[0] === id
  })
}

function reviewRows(plan: NarrativePlan, a: NarrativeAssets, part: Part) {
  const { parents, items, key, coverage } = targets(plan, a),
    all = plan.review!.final
  const period = new Set(plan.period),
    affected = new Set(plan.affected)
  switch (part) {
    case 'structure':
      return parents.filter(
        (p) => all || affected.has(text(p.id)) || strings(p[key]).some((id) => period.has(id))
      )
    case 'doubts':
      return a.notes.filter((n) => n.status === 'active')
    case 'unassigned': {
      const members = new Set(parents.flatMap((p) => strings(p[key])))
      const singles = new Set(parents.flatMap(parent => {
        const ids = strings(parent[key])
        if (ids.length !== 1) return []
        const [id] = ids
        return all || period.has(id) || (affected.has(text(parent.id)) && Object.hasOwn(coverage, id)) ? [id] : []
      }))
      return items.filter(row => {
        const id = text(row.id)
        return singles.has(id) || ((all || period.has(id)) && !members.has(id))
      })
    }
    case 'descriptions':
      return all ? parents : []
    default:
      return []
  }
}
export function reviewBasis(plan: NarrativePlan, a: NarrativeAssets, part: Part, row: Row) {
  if (part === 'unassigned') {
    const basis = assignment(plan, a, row).basis
    const singles = singleMemberParents(plan, a, text(row.id)).map(parent => [parent.id, parent.title])
    return singles.length ? canonical([basis, singles]) : basis
  }
  if (part === 'structure')
    return canonical([row.title, row[plan.layer === 'event' ? 'nodeIds' : 'eventIds']])
  return canonical([
    row.title,
    row.summary,
    row.coreClue,
    row.nodeIds,
    row.eventIds,
    row.lineIds,
    row.statement,
    row.status,
    row.revision,
  ])
}
const reviewParts = ['structure', 'doubts', 'unassigned', 'descriptions'] as const

function reviewStatus(plan: NarrativePlan, a: NarrativeAssets, part: (typeof reviewParts)[number]) {
  const covered = plan.review!.coverage
  const pending = reviewRows(plan, a, part).filter(
    (row) => !Object.hasOwn(covered, part + ':' + row.id) || covered[part + ':' + row.id] !== reviewBasis(plan, a, part, row)
  )
  const recorded = Object.keys(covered).filter((key) => key.startsWith(part + ':')).length
  const stale = pending.filter((row) => Object.hasOwn(covered, part + ':' + row.id)).length
  return { pending, progress: { 环节: partLabel(plan.layer === 'event', part), 已核: recorded - stale, 待核: pending.length } }
}

export function refreshNarrativeTaskInput(plan: NarrativePlan, a: NarrativeAssets, task: NarrativeTask) {
  const { items, parents } = targets(plan, a)
  const records =
    task.part === 'doubts' ? a.notes : task.part === 'batch' || task.part === 'unassigned' ? items : parents
  const byId = new Map(records.map((row) => [row.id, row]))
  const rows = task.ids.map((id) => byId.get(id) ?? { id, absent: true })
  const reviewProgress =
    task.part === 'batch'
      ? undefined
      : reviewParts
          .filter((part) => part !== 'descriptions' || plan.review!.final)
          .map((part) => reviewStatus(plan, a, part).progress)
  if (reviewProgress) task.reviewProgress = reviewProgress
  if (task.part === 'unassigned') {
    task.singletonSources ??= Object.fromEntries(task.ids.map(id => [id, idsOf(singleMemberParents(plan, a, id))]))
  }
  task.prompt = taskInput(plan, a, task, rows, reviewProgress)
}

function taskDirectory(plan: NarrativePlan, a: NarrativeAssets, task: NarrativeTask, visible: Set<string>) {
  if (!includesNarrativeDirectory(task.part)) return undefined
  const catalogData = catalog(plan, a, visible)
  const { lines, events, nodes } = catalogData
  const directory = task.part !== 'batch' ? { lines, events, nodes } : catalogData
  if (!lines || JSON.stringify(directory).length <= plan.config.outlineThreshold) return directory

  const related = new Set(a.lines.flatMap((line) => strings(line.eventIds)))
  if (task.part === 'batch' || task.part === 'unassigned') task.ids.forEach((id) => related.add(id))
  return {
    lines,
    events: events.filter((event) => related.has(text(event.id))).map(({ id, title }) => ({ id, title })),
  }
}

function taskInput(
  plan: NarrativePlan,
  a: NarrativeAssets,
  task: NarrativeTask,
  rows: Row[],
  reviewProgress?: ReviewProgress
) {
  const visible = visibleNodes(plan, task, a)
  const doubtBrief = (row: Row) => ({
    id: row.id,
    category: row.category,
    statement: row.statement,
    status: row.status,
    nodeIds: strings(row.nodeIds).filter((id) => visible.has(id)),
    eventIds: strings(row.eventIds),
    ...(plan.layer === 'line' ? { lineIds: strings(row.lineIds) } : {}),
  })
  const overview = rows.map((row) => {
    if (row.absent) return { id: row.id, status: '当前已移出本段范围，以已保存结果确认' }
    if (task.part === 'doubts') return doubtBrief(row)
    if (task.mode === 'node_batch') return nodeBrief(row)
    if (task.part === 'unassigned') {
      const eventLayer = plan.layer === 'event'
      const { parents, key } = targets(plan, a)
      const current = parents.filter(parent => strings(parent[key]).includes(text(row.id)))
      const singles = singleMemberParents(plan, a, text(row.id))
      const parentRows = current.map(parent => ({
        id: parent.id, title: parent.title, [eventLayer ? '单节点事件' : '单事件故事线']: singles.includes(parent),
      }))
      return {
        ...(eventLayer ? nodeBrief(row) : { id: row.id, title: row.title, summary: row.summary, coreClue: row.coreClue }),
        入选原因: singles.length ? (eventLayer ? '所在事件仅含此节点' : '所在故事线仅含此事件') : current.length ? '已调整归属' : (eventLayer ? '未归属' : '未归线'),
        [eventLayer ? '当前事件' : '当前故事线']: parentRows,
      }
    }
    if (task.mode === 'event_group')
      return { id: row.id, title: row.title, summary: row.summary, coreClue: row.coreClue }
    return {
      id: row.id,
      title: row.title,
      members:
        plan.layer === 'event' ? strings(row.nodeIds).filter((id) => visible.has(id)) : strings(row.eventIds),
      ...(task.part === 'descriptions' ? { summary: row.summary, coreClue: row.coreClue } : {}),
    }
  })
  const eventIds = new Set<string>()
  const nodeIds = new Set<string>()
  if (task.part === 'structure' || task.part === 'descriptions') {
    for (const id of rows.flatMap((row) => strings(row[plan.layer === 'event' ? 'nodeIds' : 'eventIds'])))
      (plan.layer === 'event' ? nodeIds : eventIds).add(id)
  }
  const short = (value: unknown, limit: number) => {
    const content = text(value)
    return content.length > limit ? content.slice(0, limit) + '…' : content
  }
  const events = a.events
    .filter((row) => eventIds.has(text(row.id)))
    .map((row) => ({
      id: row.id,
      title: row.title,
      summary: strings(row.nodeIds).every((id) => visible.has(id)) ? short(row.summary, 220) : undefined,
      coreClue: strings(row.nodeIds).every((id) => visible.has(id)) ? short(row.coreClue, 160) : undefined,
    }))
  const nodes = a.nodes
    .filter((row) => nodeIds.has(text(row.id)) && visible.has(text(row.id)))
    .map((row) => ({
      id: row.id,
      name: row.name,
      chapter: row.chapterIndex,
      order: row.order,
      locations: row.locationNames,
      summary: short(row.summary, 160),
    }))
  const evidence =
    nodes.length || events.length
      ? {
          ...(nodes.length ? { nodes } : {}),
          ...(events.length ? { events } : {}),
        }
      : undefined
  return formatNarrativeInput({
    mode: task.mode,
    part: task.part,
    reviewProgress,
    targets: overview,
    evidence,
    ...(task.part === 'structure' && task.mode.endsWith('_cycle') ? { periodIds: plan.period } : {}),
    outline: taskDirectory(plan, a, task, visible),
    ...(task.part === 'batch'
      ? { config: plan.config, openDoubts: a.notes.filter((n) => n.status === 'active').map(doubtBrief) }
      : {}),
  })
}
function pendingAssignments(plan: NarrativePlan, a: NarrativeAssets, reuseExisting = false) {
  const { items, coverage } = targets(plan, a)
  return items.filter((row) => {
    const id = text(row.id)
    const state = assignment(plan, a, row)
    if (
      plan.reuseAssigned &&
      !plan.review &&
      state.belongs.length &&
      (reuseExisting || Object.hasOwn(coverage, id))
    )
      coverage[id] = state.basis
    return coverage[id] !== state.basis
  })
}

export function scheduleNarrative(plan: NarrativePlan, a: NarrativeAssets): NarrativeTask | undefined {
  if (plan.active || plan.complete) return plan.active
  const { items, coverage } = targets(plan, a),
    eventLayer = plan.layer === 'event',
    cfg = plan.config
  const pending = plan.review ? [] : pendingAssignments(plan, a, plan.batches[plan.layer] === 0)
  if (!pending.length && !plan.review) plan.review = { final: true, coverage: {} }
  let mode: Mode = eventLayer ? 'node_batch' : 'event_group',
    part: Part = 'batch'
  let rows = pending.slice(0, eventLayer ? cfg.nodeBatchSize : cfg.eventGroupSize)
  let reviewProgress: ReviewProgress | undefined
  if (plan.review) {
    mode = eventLayer
      ? plan.review.final
        ? 'event_review'
        : 'event_cycle'
      : plan.review.final
        ? 'line_review'
        : 'line_cycle'
    rows = []
    reviewProgress = []
    for (const group of reviewParts) {
      if (group === 'descriptions' && !plan.review.final) continue
      const { pending, progress } = reviewStatus(plan, a, group)
      reviewProgress.push(progress)
      if (!rows.length && pending.length) {
        rows = pending.slice(0, cfg.segmentSize)
        part = group
      }
    }
    if (!rows.length) {
      const final = plan.review.final
      // 对已确认的节点或事件，采用本次结构与孤立项复核后的实际归属。
      for (const row of pendingAssignments(plan, a)) {
        const id = text(row.id)
        if (!Object.hasOwn(coverage, id)) continue
        const state = assignment(plan, a, row)
        const reviewed =
          final ||
          state.belongs.some((parent) => Object.hasOwn(plan.review!.coverage, 'structure:' + parent)) ||
          Object.hasOwn(plan.review.coverage, 'unassigned:' + id)
        if (reviewed && state.valid) coverage[id] = state.basis
      }
      const remaining = items.some((row) => coverage[text(row.id)] !== assignment(plan, a, row).basis)
      const checked = Object.keys(plan.review.coverage)
      const parts = final
        ? ['structure', 'doubts', 'unassigned', 'descriptions']
        : ['structure', 'doubts', 'unassigned']
      ;(plan.reviews ??= []).push({
        layer: plan.layer,
        final,
        batchIds: plan.periodTasks ?? [],
        counts: Object.fromEntries(
          parts.map((part) => [part, checked.filter((key) => key.startsWith(part + ':')).length])
        ),
      })
      plan.periodTasks = []
      delete plan.review
      plan.period = []
      plan.affected = []
      if (final && !remaining) {
        if (!eventLayer) {
          plan.complete = true
          return undefined
        }
        plan.layer = 'line'
      }
      return scheduleNarrative(plan, a)
    }
  }
  const task: NarrativeTask = {
    id: crypto.randomUUID(),
    mode,
    part,
    ids: idsOf(rows),
    prompt: '',
    basis: Object.fromEntries(
      rows.map((r) => [
        text(r.id),
        part === 'batch' ? assignment(plan, a, r).basis : reviewBasis(plan, a, part, r),
      ])
    ),
  }
  if (reviewProgress) task.reviewProgress = reviewProgress
  if (task.part === 'unassigned') {
    task.singletonSources ??= Object.fromEntries(task.ids.map(id => [id, idsOf(singleMemberParents(plan, a, id))]))
  }
  task.prompt = taskInput(plan, a, task, rows, reviewProgress)
  plan.active = task
  return task
}
export function confirmNarrative(plan: NarrativePlan, a: NarrativeAssets, args: Row) {
  const t = plan.active!
  const { items, coverage } = targets(plan, a)
  let reviewResults: { target_id: string; outcome: string }[] | undefined
  if (t.part === 'batch') {
    const ids = plan.layer === 'line' ? [...new Set([...t.ids, ...strings(args.handled_event_ids)])] : t.ids
    for (const r of (args.retained_unassigned_nodes ?? []) as Row[]) {
      if (plan.layer !== 'event' || !t.ids.includes(text(r.node_id)) || !text(r.note).trim())
        throw new NarrativeToolError('INVALID_RETENTION', '独立保留须属于本批并写明依据。', {
          fields: ['retained_unassigned_nodes'],
          objectIds: [text(r.node_id)].filter(Boolean),
        })
      plan.retained[text(r.node_id)] = text(r.note)
    }
    const rowsById = new Map(items.map((row) => [text(row.id), row]))
    const unknown = ids.filter((id) => !rowsById.has(id))
    if (unknown.length)
      throw new NarrativeToolError('UNKNOWN_OBJECT', '对象不存在 ' + unknown.join('、'), {
        objectIds: unknown,
      })
    const states = ids.map((id) => ({ id, state: assignment(plan, a, rowsById.get(id)!) }))
    const unassigned = states.filter(({ state }) => !state.valid).map(({ id }) => id)
    if (unassigned.length)
      throw new NarrativeToolError('ASSIGNMENT_REQUIRED', '尚缺有效归属或对应结论 ' + unassigned.join('、'), {
        objectIds: unassigned,
        hint:
          plan.layer === 'event'
            ? '先保存节点归属，或登记归属疑点，或在确认时填写独立保留理由。'
            : '先保存事件归线，或登记关联该事件的 EVENT_ASSIGNMENT 疑点。',
      })
    for (const { id, state } of states) coverage[id] = state.basis
    ;(plan.periodTasks ??= []).push(t.id)
    plan.period = [...new Set([...plan.period, ...ids])]
    const count = ++plan.batches[plan.layer]
    const end = pendingAssignments(plan, a).length === 0
    if (
      end ||
      count % (plan.layer === 'event' ? plan.config.eventReviewInterval : plan.config.lineReviewInterval) ===
        0
    )
      plan.review = { final: end, coverage: {} }
  } else {
    const currentRows = reviewRows(plan, a, t.part).filter((r) => t.ids.includes(text(r.id)))
    if (t.part === 'descriptions') {
      const incomplete = currentRows.find((row) => !text(row.summary).trim() || !text(row.coreClue).trim())
      if (incomplete)
        throw new NarrativeToolError('DESCRIPTION_REQUIRED', '须补全概况和核心关键线索 ' + incomplete.id, {
          objectIds: [text(incomplete.id)],
          fields: ['summary', 'coreClue'].filter((field) => !text(incomplete[field]).trim()),
          hint: '先提交对应对象缺少的说明，再确认当前段。',
        })
    }
    const { part } = t
    const rows = part === 'doubts' ? a.notes : part === 'unassigned' ? items : targets(plan, a).parents
    const byId = new Map(rows.map(row => [text(row.id), row]))
    reviewResults = t.ids.map(id => {
      const row = byId.get(id)
      let outcome: string
      if (part === 'doubts') outcome = row?.status === 'active' ? 'retained_open' : 'resolved'
      else if (!row) outcome = 'repaired'
      else if (part === 'unassigned') {
        const { belongs, hasOpenDoubt } = assignment(plan, a, row)
        const eventLayer = plan.layer === 'event'
        const { parents, key } = targets(plan, a)
        const emptied = t.singletonSources?.[id]?.find(source =>
          parents.some(parent => parent.id === source && !strings(parent[key]).length))
        if (emptied) throw new NarrativeToolError(eventLayer ? 'EMPTY_SOURCE_EVENT' : 'EMPTY_SOURCE_LINE', '请处理移空的来源' + (eventLayer ? '事件' : '故事线') + '：' + emptied, { objectIds: [emptied] })
        if (hasOpenDoubt && (!belongs.length || singleMemberParents(plan, a, id).length)) outcome = 'retained_open'
        else if (!belongs.length) outcome = eventLayer ? 'independent' : 'unassigned'
        else if (singleMemberParents(plan, a, id).length && reviewBasis(plan, a, part, row) === t.basis[id]) outcome = 'no_change'
        else outcome = 'repaired'
      } else outcome = reviewBasis(plan, a, part, row) === t.basis[id] ? 'no_change' : 'repaired'
      return { target_id: id, outcome }
    })
    if (part === 'unassigned' && plan.layer === 'event') {
      for (const { target_id, outcome } of reviewResults) {
        if (outcome === 'independent') plan.retained[target_id] ||= '复核后独立保留'
        else delete plan.retained[target_id]
      }
    }
    const currentIds = new Set(idsOf(currentRows))
    for (const id of t.ids)
      if (!currentIds.has(id)) plan.review!.coverage[t.part + ':' + id] = '已移出本环节范围'
    for (const row of currentRows) {
      const id = text(row.id)
      plan.review!.coverage[t.part + ':' + id] = reviewBasis(plan, a, t.part, row)
      if (t.part === 'unassigned') coverage[id] = assignment(plan, a, row).basis
    }
  }
  delete plan.active
  return reviewResults
}
