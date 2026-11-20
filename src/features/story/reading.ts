import { hash, records, strings, text } from '../agents/contracts'
import type { AgentStore, Row } from '../agents/repository'
import { noteFingerprint } from '../agents/queries'
import { storyContent, validStoryCoverage } from './coverage'
import { storyView } from './views'
import { readingCheck, usableReadingChecks, type ReadingCheck } from './reuse'
import { buildStoryContext, selectStoryBatch } from './retrieval'
import { readingSourceFingerprint as sourceFingerprint } from './sourceFingerprint'

export interface ReadingPage extends Row { id: string; type: string; queue: string; ids: string[]; fingerprint: string; checkedFingerprint?: string; sourceFingerprints?: Record<string, string>; reason?: string }
export interface ReadingState extends Row { pages: ReadingPage[]; currentPageId: string | null; receipts: string[]; checks?: ReadingCheck[]; reusedChecks?: ReadingCheck[] }
const stateOf = (run: Row, phase: string) => ((run.storyReading as Row | undefined)?.[phase] as ReadingState | undefined)
const batches = (rows: Row[], outline = false) => {
  const result: Row[][] = []; let offset = 0
  while (offset < rows.length) { const batch = rows.slice(offset, offset + selectStoryBatch(rows.slice(offset, offset + 10).map(row => storyView(row, row.nodeIds ? 'eventLine' : row.statement ? 'note' : 'node', outline)), 4000).length); result.push(batch); offset += batch.length }
  return result
}
const checked = (page: ReadingPage) => page.checkedFingerprint === page.fingerprint
const portable = (value: unknown): unknown => Array.isArray(value) ? value.map(portable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !['bookId', 'sessionId', 'basisFingerprint'].includes(key)).map(([key, item]) => [key, portable(item)])) : value
async function pageSources(store: AgentStore, page: ReadingPage) {
  const chapters = new Set<string>()
  const addNode = async (id: string) => { const node = await store.get('nodes', id); if (node?.chapterIndex) chapters.add(text(node.chapterIndex)) }
  const addLine = async (id: string) => { const line = await store.get('eventLines', id); for (const node of strings(line?.nodeIds)) await addNode(node) }
  for (const id of page.ids) {
    if (page.type === 'line_summary') await addLine(id)
    else if (page.type === 'note_page') {
      const note = await store.get('storyEditorNotes', id)
      for (const node of strings(note?.nodeIds)) await addNode(node)
      for (const line of strings(note?.lineIds)) await addLine(line)
      for (const item of records(note?.evidence)) if (item.chapterIndex) chapters.add(text(item.chapterIndex))
    } else await addNode(id)
  }
  return Object.fromEntries(await Promise.all([...chapters].map(async chapter => [chapter, await sourceFingerprint(store, chapter)])))
}

/** 阅读页只记录查阅进度；故事是否闭合仍由原著内容与复核结论表达。 */
export async function refreshReading(store: AgentStore, runId: string, sessionId: string, phase: string): Promise<ReadingState> {
  const run = (await store.get('pipelineRuns', runId))!
  const outline = run.storyOutlineVersion === 1
  const saved = stateOf(run, phase)
  const reusedChecks = await usableReadingChecks(store, saved?.reusedChecks ?? [])
  const reused = (type: string, id: string) => reusedChecks.some(check => check.type === type && check.id === id)
  const nodes = await store.rows('nodes'), lines = await store.rows('eventLines')
  const events = outline ? await store.rows('storyEvents') : []
  const eventById = new Map(events.map(event => [text(event.id), event]))
  const nodeById = new Map(nodes.map(node => [text(node.id), node]))
  const previousById = new Map(saved?.pages.map(page => [page.id, page]) ?? [])
  const chapterOrder = new Map((await store.rows('chapters')).map(row => [text(row.chapterIndex), Number(row.order)]))
  nodes.sort((a, b) => (chapterOrder.get(text(a.chapterIndex)) ?? 0) - (chapterOrder.get(text(b.chapterIndex)) ?? 0) || Number(a.order ?? 0) - Number(b.order ?? 0) || text(a.id).localeCompare(text(b.id)))
  const pages: ReadingPage[] = []
  const add = async (type: string, queue: string, rows: Row[], extra: Row = {}, basis: unknown = rows.map(row => storyContent(type === 'note_page' ? 'storyEditorNotes' : 'nodes', row))) => {
    const id = `${type}:${text(extra.lineId) || (text(extra.eventId) || text(rows[0]?.id))}${extra.eventId && extra.lineId ? `:${text(extra.eventId)}` : ''}:${Number(extra.segment ?? 0)}`
    const fingerprint = await store.wait(hash({ type, basis: portable(basis) }))
    const previous = previousById.get(id)
    pages.push({ ...previous, ...extra, id, type, queue, ids: rows.map(row => text(row.id)), fingerprint })
  }
  if (phase === 'window_link') {
    for (const group of batches(nodes.filter(node => !reused('node_page', text(node.id))), outline)) await add('node_page', 'window_nodes', group)
    // 旧窗口检查点中的有效逐项结果可复用；不会重新解释旧模型的语义结论。
    if (!saved && !outline) for (const page of pages) {
      let valid = true
      for (const id of page.ids) {
        const row = nodeById.get(id)!
        const candidates = records(run.coverageItems).filter(item => item.phase === 'window_link' && item.kind === 'node' && item.id === id)
        if (!(await Promise.all(candidates.map(item => validStoryCoverage(store, item, row)))).some(Boolean)) { valid = false; break }
      }
      if (valid) { page.checkedFingerprint = page.fingerprint; page.sourceFingerprints = await pageSources(store, page) }
    }
  } else {
    const linked = new Set([...lines, ...events].flatMap(item => strings(item.nodeIds)))
    for (const group of batches(nodes.filter(row => !linked.has(text(row.id)) && !reused('node_page', text(row.id))), outline)) await add('node_page', 'orphans', group)
    lines.sort((a, b) => text(a.id).localeCompare(text(b.id)))
    const eventSegments = async (event: Row, extra: Row) => {
      const groups = batches(strings(event.nodeIds).flatMap(id => nodeById.has(id) ? [nodeById.get(id)!] : []), true)
      for (const [index, group] of groups.entries()) await add('line_segment', 'event_lines', group, { ...extra, eventId: event.id, segment: index + 1, totalSegments: groups.length }, { nodes: group.map(node => storyContent('nodes', node)), eventId: event.id, title: event.title })
    }
    for (const [lineIndex, line] of lines.entries()) {
      if (reused('line_summary', text(line.id))) continue
      const members = strings(line.nodeIds).map(id => nodeById.get(id)).filter((row): row is Row => !!row)
      const extra = { lineId: line.id, lineIndex: lineIndex + 1, totalLines: lines.length }
      const lineEvents = strings(line.eventIds).flatMap(id => eventById.has(id) ? [eventById.get(id)!] : [])
      if (!outline || line.outlinePending || !Array.isArray(line.eventIds)) {
        const segments = batches(members)
        for (const [index, group] of segments.entries()) await add('line_segment', 'event_lines', group, { ...extra, segment: index + 1, totalSegments: segments.length })
      }
      for (const event of lineEvents) await eventSegments(event, extra)
      await add('line_summary', 'event_lines', [line], extra, { line: storyContent('eventLines', line), nodes: members.map(row => storyContent('nodes', row)), ...(outline ? { events: lineEvents.map(event => storyContent('storyEvents', event)) } : {}) })
    }
    const assignedEvents = new Set(lines.flatMap(line => strings(line.eventIds)))
    for (const event of events) if (!assignedEvents.has(text(event.id))) await eventSegments(event, {})
    const notes: Row[] = []
    for (const note of await store.rows('storyEditorNotes')) if (note.sessionId === sessionId && (note.status === 'active' || note.basisFingerprint !== await noteFingerprint(store, note))) notes.push(note)
    notes.sort((a, b) => text(a.id).localeCompare(text(b.id)))
    for (const group of batches(notes)) await add('note_page', 'review_notes', group, {}, group.map(row => ({ note: storyContent('storyEditorNotes', row), nodes: nodes.filter(node => strings(row.nodeIds).includes(text(node.id))).map(node => storyContent('nodes', node)), lines: lines.filter(line => strings(row.lineIds).includes(text(line.id))).map(line => storyContent('eventLines', line)) })))
  }
  const sources = new Map<string, string>()
  for (const page of pages) if (checked(page)) for (const [chapter, fingerprint] of Object.entries(page.sourceFingerprints ?? {})) {
    if (!sources.has(chapter)) sources.set(chapter, await sourceFingerprint(store, chapter))
    if (sources.get(chapter) !== fingerprint) { delete page.checkedFingerprint; break }
  }
  const currentPageId = pages.some(page => page.id === saved?.currentPageId) ? saved!.currentPageId : pages.find(page => !checked(page))?.id ?? null
  return { ...saved, pages, currentPageId, receipts: strings(saved?.receipts), reusedChecks }
}

export async function saveReading(store: AgentStore, runId: string, phase: string, state: ReadingState) {
  const run = (await store.get('pipelineRuns', runId))!
  await store.put('pipelineRuns', { ...run, storyReading: { ...(run.storyReading as Row ?? {}), [phase]: state } })
}

export async function readingBrief(store: AgentStore, bookId: string, sessionId: string, phase: string, state: ReadingState, outline = false): Promise<Row | null> {
  const page = state.pages.find(page => page.id === state.currentPageId)
  if (!page) return null
  const kind = page.type === 'line_summary' ? 'eventLine' : page.type === 'note_page' ? 'note' : 'node'
  const table = kind === 'eventLine' ? 'eventLines' : kind === 'note' ? 'storyEditorNotes' : 'nodes'
  const rows = (await Promise.all(page.ids.map(id => store.get(table, id)))).filter((row): row is Row => !!row)
  const hints = await buildStoryContext(store, bookId, sessionId, rows, kind, phase === 'global_review', true, outline)
  const memory = await store.get('storyEditorMemory', sessionId)
  const line = page.lineId ? await store.get('eventLines', text(page.lineId)) : undefined
  const event = page.eventId ? await store.get('storyEvents', text(page.eventId)) : undefined
  const members = strings((event ?? line)?.nodeIds)
  const previous = page.type === 'line_segment' ? members.indexOf(page.ids[0]) : -1
  const prior = previous > 0 ? await store.get('nodes', members[previous - 1]) : undefined
  return { phase, queue: page.queue, page: { id: page.id, type: page.type, pageNumber: state.pages.indexOf(page) + 1, totalPages: state.pages.length, ids: page.ids,
    ...(page.lineId ? { lineId: page.lineId, lineIndex: page.lineIndex, totalLines: page.totalLines } : {}), ...(page.eventId ? { eventId: page.eventId } : {}), ...(page.segment ? { segment: page.segment, totalSegments: page.totalSegments } : {}) },
    remainingCount: state.pages.filter(page => !checked(page)).length, workItems: hints.assigned, related: hints.related, moreRelated: hints.truncated,
    workingSummary: text(memory?.workingSummary), ...(line ? { line: storyView(line, 'eventLine', outline) } : {}), ...(event ? { event: storyView({ ...event, nodeIds: undefined, memberCount: members.length }, 'event', true) } : {}), ...(prior ? { previousNode: storyView(prior, 'node', outline) } : {}) }
}

export async function navigateStoryReading(store: AgentStore, scope: { bookId: string; runId: string; sessionId?: string; phase: string; taskId: string; outline?: boolean }, args: Row, callId: string) {
  const displayed = stateOf((await store.get('pipelineRuns', scope.runId))!, scope.phase)
  const state = await refreshReading(store, scope.runId, scope.sessionId!, scope.phase)
  const receipt = `${scope.taskId}:${callId}`
  let summary = '本次翻页已处理，已返回当前阅读位置。'
  if (!state.receipts.includes(receipt)) {
    const at = state.pages.findIndex(page => page.id === displayed?.currentPageId)
    if (args.currentPageId && args.currentPageId !== state.currentPageId) summary = '当前页已变化，已返回当前阅读位置。'
    else if (args.direction === 'previous') {
      state.currentPageId = state.pages[Math.max(0, at - 1)]?.id ?? null
      summary = '已返回上一页，离开的页未标记完成。'
    } else if (at < 0) summary = '原阅读页已随资料更新，已返回下一待检查页。'
    else {
      const current = state.pages[at]
      const previousIds = displayed?.pages.find(page => page.id === current?.id)?.ids ?? []
      if (current.ids.some(id => !previousIds.includes(id))) summary = '本页增加了新对象，请核对更新后的本页。'
      else {
        current.checkedFingerprint = current.fingerprint; current.reason = text(args.reason) || text(args.notes) || '本页已检查。'
        current.sourceFingerprints = await pageSources(store, current)
        if (current.type !== 'line_segment') {
          const checks = state.checks ?? [], sources = new Map<string, string>()
          for (const id of current.ids) {
            const value = await readingCheck(store, current.type, id, sources), at = checks.findIndex(check => check.id === id && check.type === current.type)
            if (at < 0) checks.push(value); else checks[at] = value
          }
          state.checks = checks
        }
        state.currentPageId = state.pages.slice(at + 1).find(page => !checked(page))?.id ?? state.pages.find(page => !checked(page))?.id ?? null
        summary = '当前页已检查，已返回下一待检查页。'
      }
    }
    state.receipts.push(receipt)
  }
  await saveReading(store, scope.runId, scope.phase, state)
  const complete = state.pages.every(checked)
  return { ok: true, complete, page: complete ? null : await readingBrief(store, scope.bookId, scope.sessionId!, scope.phase, state, scope.outline), summary: complete ? '本阶段各页已检查，保存的疑点和未解线索保留。' : summary }
}

export function readingProgress(state: ReadingState) {
  const page = state.pages.find(page => page.id === state.currentPageId)
  return { reused: state.reusedChecks?.length ?? 0, pageNumber: page ? state.pages.indexOf(page) + 1 : state.pages.length, totalPages: state.pages.length, checked: state.pages.filter(checked).length, complete: state.pages.every(checked), type: page?.type, queue: page?.queue, lineId: text(page?.lineId), segment: page?.segment as number | undefined, totalSegments: page?.totalSegments as number | undefined, lineIndex: page?.lineIndex as number | undefined, totalLines: page?.totalLines as number | undefined }
}
