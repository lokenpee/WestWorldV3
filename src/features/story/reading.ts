import { hash, records, strings, text } from '../agents/contracts'
import type { AgentStore, Row } from '../agents/repository'
import { noteFingerprint } from '../agents/queries'
import { storyContent, validStoryCoverage } from './coverage'
import { storyDirectory } from './reviewDirectory'
import { storyView } from './views'
import { readingCheck, usableReadingChecks, type ReadingCheck } from './reuse'
import { buildStoryContext, selectStoryBatch } from './retrieval'
import { hasOutlineDescription, usesOutline } from './outline'
import { readingSourceFingerprint as sourceFingerprint } from './sourceFingerprint'

export interface ReadingPage extends Row { id: string; type: string; queue: string; ids: string[]; fingerprint: string; checkedFingerprint?: string; sourceFingerprints?: Record<string, string>; reason?: string; quickCheck?: boolean }
export interface ReadingState extends Row { independent?: boolean; decisions?: Record<string, { basis: string; conclusion: string }>; pages: ReadingPage[]; currentPageId: string | null; receipts: string[]; checks?: ReadingCheck[]; reusedChecks?: ReadingCheck[]; quickPages?: Record<string, { fingerprint: string; sourceFingerprints?: Record<string, string> }> }
const stateOf = (run: Row, phase: string) => ((run.storyReading as Row | undefined)?.[phase] as ReadingState | undefined)
const readingNode = (row: Row) => ({ ...storyView(row, 'node'), chapterName: row.chapterName })
const batches = (rows: Row[], outline = false) => {
  const result: Row[][] = []; let offset = 0
  while (offset < rows.length) { const batch = rows.slice(offset, offset + selectStoryBatch(rows.slice(offset, offset + 10).map(row => storyView(row, row.nodeIds ? 'eventLine' : row.statement ? 'note' : 'node', outline)), 4000).length); result.push(batch); offset += batch.length }
  return result
}
export const checked = (page: ReadingPage) => page.checkedFingerprint === page.fingerprint
const needsDescription = (type: string, row: Row, outline: boolean) => outline && (type === 'event_summary' || type === 'line_summary' && usesOutline(row))
/** 小事件共用一次阅读请求，每个事件仍单独保存完成依据。 */
export function eventDescriptionBatch(state: ReadingState | undefined): ReadingPage[] {
  if (!state?.independent) return []
  const index = state.pages.findIndex(page => page.id === state.currentPageId)
  if (state.pages[index]?.type !== 'event_summary') return []
  const result: ReadingPage[] = []
  let length = 0
  for (const page of state.pages.slice(index)) {
    if (page.type !== 'event_summary') break
    if (result.length && checked(page)) continue
    const size = Number(page.descriptionLength ?? 4000)
    if (result.length && (length + size > 4000 || result.length >= 10)) break
    result.push(page)
    length += size
  }
  return result
}
const portable = (value: unknown): unknown => Array.isArray(value) ? value.map(portable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !['bookId', 'sessionId', 'basisFingerprint'].includes(key)).map(([key, item]) => [key, portable(item)])) : value
async function pageSources(store: AgentStore, page: ReadingPage) {
  const chapters = new Set<string>()
  const addNode = async (id: string) => { const node = await store.get('nodes', id); if (node?.chapterIndex) chapters.add(text(node.chapterIndex)) }
  const addLine = async (id: string) => {
    const line = await store.get('eventLines', id)
    for (const node of strings(line?.nodeIds)) await addNode(node)
    for (const eventId of strings(line?.eventIds)) for (const node of strings((await store.get('storyEvents', eventId))?.nodeIds)) await addNode(node)
  }
  for (const id of page.ids) {
    if (page.type === 'event_summary') { const event = await store.get('storyEvents', id); for (const node of strings(event?.nodeIds)) await addNode(node) }
    else if (['line_structure', 'line_summary'].includes(page.type)) await addLine(id)
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
  const reusedChecks = await usableReadingChecks(store, saved?.reusedChecks ?? [], outline)
  const reused = (type: string, id: string) => reusedChecks.some(check => check.type === type && check.id === id)
  const nodes = await store.rows('nodes'), lines = await store.rows('eventLines')
  const events = outline ? await store.rows('storyEvents') : []
  const eventById = new Map(events.map(event => [text(event.id), event]))
  const nodeById = new Map(nodes.map(node => [text(node.id), node]))
  const previousById = new Map(saved?.pages.map(page => [page.id, page]) ?? [])
  const chapterOrder = new Map((await store.rows('chapters')).map(row => [text(row.chapterIndex), Number(row.order)]))
  nodes.sort((a, b) => (chapterOrder.get(text(a.chapterIndex)) ?? 0) - (chapterOrder.get(text(b.chapterIndex)) ?? 0) || Number(a.order ?? 0) - Number(b.order ?? 0) || text(a.id).localeCompare(text(b.id)))
  const pages: ReadingPage[] = []
  const questions = new Map(Object.entries(saved?.questions ?? {}) as [string, string][])
  const results: { question: string; key: string; conclusion: string }[] = []
  const add = async (type: string, queue: string, rows: Row[], extra: Row = {}, basis: unknown = rows.map(row => storyContent(type === 'note_page' ? 'storyEditorNotes' : 'nodes', row))) => {
    const owner = text(extra.eventId) || text(extra.lineId) || text(rows[0]?.id)
    const id = `${type}:${owner}:${Number(extra.segment ?? 0)}`
    const fingerprint = await store.wait(hash({ type, basis: portable(basis) }))
    const previous = previousById.get(id)
    const page: ReadingPage = { ...previous, ...extra, id, type, queue, ids: rows.map(row => text(row.id)), fingerprint }
    if (!extra.reviewNotes) delete page.reviewNotes
    if (rows.some(row => needsDescription(type, row, outline) && !hasOutlineDescription(row))) delete page.checkedFingerprint
    pages.push(page)
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
    const staged = saved?.independent === true
    const chapterScope = staged ? await store.wait(hash([Array.from(chapterOrder), nodes.map(row => [row.id, row.chapterIndex, row.summary, row.process, row.clues])])) : ''
    const structure = (row: Row) => ({ id: row.id, title: row.title, nodeIds: row.nodeIds, eventIds: row.eventIds })
    const linked = new Set([...lines, ...events].flatMap(item => strings(item.nodeIds)))
    for (const group of batches(nodes.filter(row => !linked.has(text(row.id)) && !reused('node_page', text(row.id))), outline)) await add('node_page', 'orphans', group, {}, staged ? [chapterScope, group.map(row => storyContent('nodes', row))] : undefined)
    lines.sort((a, b) => text(a.id).localeCompare(text(b.id)))
    if (staged) {
      const memberships = new Map<string, Row[]>()
      for (const event of events) for (const id of strings(event.nodeIds)) {
        const found = memberships.get(id) ?? []
        found.push(event)
        memberships.set(id, found)
      }
      for (const group of batches(nodes.filter(node => memberships.has(text(node.id))), true)) {
        const owners = [...new Set(group.flatMap(node => memberships.get(text(node.id)) ?? []))]
        const eventIds = owners.map(row => text(row.id))
        const parents = lines.filter(line => strings(line.eventIds).some(id => eventIds.includes(id)))
        await add('member_batch', 'event_lines', group, { eventIds }, [group.map(node => storyContent('nodes', node)), owners.map(structure), parents.map(line => [line.id, line.title, strings(line.eventIds).filter(id => eventIds.includes(id))])])
      }
    }
    const eventSegments = async (event: Row, extra: Row) => {
      const groups = batches(strings(event.nodeIds).flatMap(id => nodeById.has(id) ? [nodeById.get(id)!] : []), true)
      for (const [index, group] of groups.entries()) await add('line_segment', 'event_lines', group, { ...extra, eventId: event.id, segment: index + 1, totalSegments: groups.length },
        { nodes: group.map(node => storyContent('nodes', node)), eventId: event.id, title: event.title })
    }
    const reviewedEvents = new Set<string>()
    const addEventPages = async (event: Row, extra: Row = {}) => {
      const id = text(event.id)
      if (reviewedEvents.has(id)) return
      reviewedEvents.add(id)
      if (!staged) await eventSegments(event, extra)
      if (reused('event_summary', id)) return
      const members = strings(event.nodeIds).flatMap(id => nodeById.has(id) ? [nodeById.get(id)!] : [])
      await add('event_summary', 'event_lines', [event], { ...extra, eventId: event.id, ...(staged ? { descriptionLength: 160 + text(event.summary).length + strings(event.clues).join('、').length + members.reduce((n, row) => n + 80 + text(row.summary).length, 0) } : {}) }, { event: storyContent('storyEvents', event), nodes: members.map(node => storyContent('nodes', node)) })
    }
    for (const [lineIndex, line] of lines.entries()) {
      const members = strings(line.nodeIds).map(id => nodeById.get(id)).filter((row): row is Row => !!row)
      const extra = { lineId: line.id, lineIndex: lineIndex + 1, totalLines: lines.length }
      const lineEvents = strings(line.eventIds).flatMap(id => eventById.has(id) ? [eventById.get(id)!] : [])
      if (!outline || line.outlinePending || !Array.isArray(line.eventIds)) {
        const segments = batches(members)
        for (const [index, group] of segments.entries()) await add('line_segment', 'event_lines', group, { ...extra, segment: index + 1, totalSegments: segments.length })
      }
      for (const event of lineEvents) await addEventPages(event, extra)
    }
    for (const event of events) await addEventPages(event)
    for (const [lineIndex, line] of lines.entries()) if (!reused('line_summary', text(line.id))) {
      const members = strings(line.nodeIds).map(id => nodeById.get(id)).filter((row): row is Row => !!row)
      const lineEvents = strings(line.eventIds).flatMap(id => eventById.has(id) ? [eventById.get(id)!] : [])
      if (staged && !usesOutline(line)) await add('line_structure', 'event_lines', [line], { lineId: line.id }, [structure(line), lineEvents.map(structure), members.map(row => storyContent('nodes', row))])
      await add('line_summary', 'event_lines', [line], { lineId: line.id, lineIndex: lineIndex + 1, totalLines: lines.length }, { line: storyContent('eventLines', line), nodes: members.map(row => storyContent('nodes', row)), ...(outline ? { events: lineEvents.map(event => storyContent('storyEvents', event)) } : {}) })
    }
    const notes: Row[] = []
    const noteBases = new Map<string, string>()
    const sessionNotes = (await store.rows('storyEditorNotes')).filter(note => note.sessionId === sessionId)
    for (const note of sessionNotes) {
      const fingerprint = await noteFingerprint(store, note)
      noteBases.set(text(note.id), fingerprint)
      if (note.status === 'active' || note.basisFingerprint !== fingerprint) {
        notes.push(note)
        if (staged && !questions.has(text(note.key))) questions.set(text(note.key), text(note.statement))
      } else if (staged && questions.has(text(note.key))) {
        results.push({ key: text(note.key), question: questions.get(text(note.key))!, conclusion: text(note.statement) })
      }
    }
    notes.sort((a, b) => text(a.id).localeCompare(text(b.id)))
    if (staged) {
      const pending: Row[] = []
      for (const note of notes) {
        const noteNodes = [...strings(note.nodeIds), ...strings(note.eventIds).flatMap(id => strings(eventById.get(id)?.nodeIds)),
          ...lines.filter(line => strings(note.lineIds).includes(text(line.id))).flatMap(line => strings(line.nodeIds))]
        const chapters = [...new Set([...noteNodes.map(id => text(nodeById.get(id)?.chapterIndex)), ...records(note.evidence).map(row => text(row.chapterIndex))].filter(Boolean))]
        const sources = await Promise.all(chapters.map(id => sourceFingerprint(store, id)))
        const basis = await store.wait(hash([note.key, note.statement, note.status, noteBases.get(text(note.id)), sources, chapterScope,
          ...lines.filter(line => strings(note.lineIds).includes(text(line.id)) || strings(line.eventIds).some(id => strings(note.eventIds).includes(id))).map(structure)]))
        const decision = saved.decisions?.[text(note.key)]
        if (decision?.basis === basis) {
          results.push({ key: text(note.key), question: questions.get(text(note.key))!, conclusion: decision.conclusion })
          continue
        }
        const target = pages.find(page => page.type === 'member_batch' && strings(page.eventIds).some(id => strings(note.eventIds).includes(id)))
          ?? pages.find(page => ['node_page', 'line_segment', 'member_batch'].includes(page.type) && page.ids.some(id => strings(note.nodeIds).includes(id)))
          ?? pages.find(page => page.type === 'line_structure' && strings(note.lineIds).includes(text(page.lineId)))
        if (target) {
          target.reviewNotes = { ...(target.reviewNotes as Record<string, string>), [text(note.id)]: basis }
          delete target.checkedFingerprint
        } else pending.push({ ...note, reviewBasis: basis })
      }
      for (const group of batches(pending)) await add('note_page', 'review_notes', group, { reviewNotes: Object.fromEntries(group.map(note => [text(note.id), note.reviewBasis])) })
      if (nodes.length || lines.length || events.length || notes.length) {
        const catalog = [lines.map(structure), events.map(structure), nodes.map(row => [row.id, row.name, row.chapterIndex, row.order]), Array.from(chapterOrder)]
        const catalogInputs = await store.wait(hash([chapterScope, [...questions.entries()].sort(([a], [b]) => a.localeCompare(b))]))
        await add('directory_open', 'event_lines', [], { catalogInputs }, [catalog, catalogInputs])
        const opening = pages[pages.length - 1]
        const prior = previousById.get(opening.id)
        // 本轮初查已完成后，成员核对产生的结构修订统一留给最终目录复查。
        if (prior && checked(prior) && prior.reviewRunId === runId && prior.catalogInputs === catalogInputs) opening.checkedFingerprint = opening.fingerprint
        await add('directory_final', 'event_lines', [], {}, catalog)
      }
      const order: Record<string, number> = { directory_open: 0, note_page: 1, node_page: 2, member_batch: 3, line_segment: 3, line_structure: 4, directory_final: 5, event_summary: 6, line_summary: 7 }
      pages.sort((a, b) => order[a.type] - order[b.type] || Number(!!b.reviewNotes) - Number(!!a.reviewNotes))
    } else for (const group of batches(notes)) await add('note_page', 'review_notes', group, {}, group.map(row => ({ note: storyContent('storyEditorNotes', row), nodes: nodes.filter(node => strings(row.nodeIds).includes(text(node.id))).map(node => storyContent('nodes', node)), lines: lines.filter(line => strings(row.lineIds).includes(text(line.id))).map(line => storyContent('eventLines', line)) })))
  }
  const sources = new Map<string, string>()
  for (const page of pages) if (checked(page)) for (const [chapter, fingerprint] of Object.entries(page.sourceFingerprints ?? {})) {
    if (!sources.has(chapter)) sources.set(chapter, await sourceFingerprint(store, chapter))
    if (sources.get(chapter) !== fingerprint) { delete page.checkedFingerprint; break }
  }
  if (saved?.quickPages) for (const page of pages) {
    const old = saved.quickPages[page.id]
    page.quickCheck = old?.fingerprint === page.fingerprint
    if (!old || !page.quickCheck) continue
    for (const [chapter, fingerprint] of Object.entries(old.sourceFingerprints ?? {})) {
      if (!sources.has(chapter)) sources.set(chapter, await sourceFingerprint(store, chapter))
      if (sources.get(chapter) !== fingerprint) { page.quickCheck = false; break }
    }
  }
  const earliest = pages.find(page => !checked(page))
  const former = pages.find(page => page.id === saved?.currentPageId)
  const stages: Record<string, number> = { directory_open: 0, directory_final: 2, event_summary: 3, line_summary: 4 }
  const stage = (page: ReadingPage) => stages[page.type] ?? 1
  const returnToEarlierStep = saved?.independent && earliest && former && stage(earliest) < stage(former)
  const currentPageId = returnToEarlierStep ? earliest.id : pages.some(page => page.id === saved?.currentPageId) ? saved!.currentPageId : pages.find(page => !checked(page))?.id ?? null
  return { ...saved, ...(saved?.independent ? { questions: Object.fromEntries(questions), results } : {}), pages, currentPageId, receipts: strings(saved?.receipts), reusedChecks }
}

export async function saveReading(store: AgentStore, runId: string, phase: string, state: ReadingState) {
  const run = (await store.get('pipelineRuns', runId))!
  await store.put('pipelineRuns', { ...run, storyReading: { ...(run.storyReading as Row ?? {}), [phase]: state } })
}

export async function scheduleQuickPages(store: AgentStore, current: ReadingState, previous: ReadingState) {
  const seen = new Set(previous.pages.filter(page => checked(page) || page.quickCheck).flatMap(page => page.ids))
  for (const check of previous.reusedChecks ?? []) if (check.type === 'node_page') seen.add(check.id)
  const quickPages: NonNullable<ReadingState['quickPages']> = {}
  for (const page of current.pages) if (page.ids.every(id => seen.has(id))) {
    page.quickCheck = true
    quickPages[page.id] = { fingerprint: page.fingerprint, sourceFingerprints: await pageSources(store, page) }
  }
  current.quickPages = quickPages
}

export async function readingBrief(store: AgentStore, bookId: string, sessionId: string, phase: string, state: ReadingState, outline = false, quickStoryCheck = false): Promise<(Row & { page: Row & { type: string } }) | null> {
  const page = state.pages.find(page => page.id === state.currentPageId)
  if (!page) return null
  const kind = ['line_structure', 'line_summary'].includes(page.type) ? 'eventLine' : page.type === 'event_summary' ? 'event' : page.type === 'note_page' ? 'note' : 'node'
  const table = kind === 'eventLine' ? 'eventLines' : kind === 'event' ? 'storyEvents' : kind === 'note' ? 'storyEditorNotes' : 'nodes'
  const rows = (await Promise.all(page.ids.map(id => store.get(table, id)))).filter((row): row is Row => !!row)
  const position = { id: page.id, type: page.type, pageNumber: state.pages.indexOf(page) + 1, totalPages: state.pages.length, ids: page.ids,
    ...(page.lineId ? { lineId: page.lineId, lineIndex: page.lineIndex, totalLines: page.totalLines } : {}), ...(page.eventId ? { eventId: page.eventId } : {}), ...(page.segment ? { segment: page.segment, totalSegments: page.totalSegments } : {}) }
  if (outline && phase === 'window_link') {
    const lines = (await store.rows('eventLines')).filter(row => row.bookId === bookId)
    const events = (await store.rows('storyEvents')).filter(row => row.bookId === bookId)
    const nodeIds = new Set(page.ids)
    const visibleEvents = quickStoryCheck ? events.filter(row => strings(row.nodeIds).some(id => nodeIds.has(id))) : events
    const eventIds = new Set(visibleEvents.map(row => text(row.id)))
    const visibleLines = quickStoryCheck ? lines.filter(row => strings(row.eventIds).some(id => eventIds.has(id)) || !usesOutline(row) && strings(row.nodeIds).some(id => nodeIds.has(id))) : lines
    const members = (values: string[]) => quickStoryCheck ? values.filter(id => nodeIds.has(id)) : values
    let preview: Row[] | undefined
    if (!quickStoryCheck && page.id === state.pages[0]?.id) {
      const chapters = new Map((await store.rows('chapters')).map(row => [text(row.chapterIndex), Number(row.order)]))
      const all = (await store.rows('nodes')).sort((a, b) => (chapters.get(text(a.chapterIndex)) ?? 0) - (chapters.get(text(b.chapterIndex)) ?? 0) || Number(a.order) - Number(b.order))
      // 长书等距抽样，首末均覆盖。预览只用于识别大事；本页资料才用于提交归属。
      const count = Math.min(150, all.length)
      preview = Array.from({ length: count }, (_, i) => {
        const row = all[Math.floor(i * (all.length - 1) / Math.max(1, count - 1))]
        return { 章: row.chapterIndex, 节点: text(row.name).slice(0, 70) }
      })
    }
    return { phase, queue: page.queue, page: position, workItems: rows.map(readingNode), ...(preview ? { preview } : {}), ...(quickStoryCheck ? { quickCheck: true } : {}),
      outline: { lines: visibleLines.map(row => ({ id: row.id, title: row.title, eventIds: strings(row.eventIds), ...(usesOutline(row) ? {} : { nodeIds: members(strings(row.nodeIds)) }) })),
        events: visibleEvents.map(row => ({ id: row.id, title: row.title, nodeIds: members(strings(row.nodeIds)) })) } }
  }
  if (page.type === 'directory_open' || page.type === 'directory_final') {
    const directory = await storyDirectory(store, true)
    const noteIds = new Set(state.pages.flatMap(item => Object.keys(item.reviewNotes ?? {})))
    const notes = (await store.rows('storyEditorNotes')).filter(row => row.sessionId === sessionId && noteIds.has(text(row.id)))
    return { phase, queue: page.queue, page: position, outlineReview: true, independent: true, outline: directory,
      directoryNotes: notes.map(row => storyView(row, 'note', true)), workItems: directory.orphans }
  }
  const group = eventDescriptionBatch(state)
  if (group.length > 1) {
    const eventGroup = await Promise.all(group.map(async member => {
      const event = (await store.get('storyEvents', text(member.eventId)))!
      const nodes = await Promise.all(strings(event.nodeIds).map(id => store.get('nodes', id)))
      return { ...storyView(event, 'event', true), evidenceNodes: nodes.flatMap(row => row ? [storyView(row, 'node', true)] : []) }
    }))
    return { phase, queue: page.queue, page: position, outlineReview: true, independent: true, workItems: eventGroup, eventGroup }
  }
  const line = page.lineId ? await store.get('eventLines', text(page.lineId)) : undefined
  const event = page.eventId ? await store.get('storyEvents', text(page.eventId)) : undefined
  const members = strings((event ?? line)?.nodeIds)
  const previous = page.type === 'line_segment' ? members.indexOf(page.ids[0]) : -1
  const prior = previous > 0 ? await store.get('nodes', members[previous - 1]) : undefined
  if (outline) {
    const lineEvents = kind === 'eventLine' ? (await Promise.all(strings(line?.eventIds).map(id => store.get('storyEvents', id)))).flatMap(row => row ? [storyView(row, 'event', true)] : []) : undefined
    const eventMembers = kind === 'event' ? (await Promise.all(members.map(id => store.get('nodes', id)))).flatMap(row => row ? [storyView(row, 'node', true)] : []) : undefined
    const noteIds = Object.keys(page.reviewNotes ?? {})
    const reviewNotes = await Promise.all(noteIds.map(id => store.get('storyEditorNotes', id)))
    const currentNodes = new Set(page.ids)
    const otherEvents = state.independent && ['line_segment', 'member_batch'].includes(page.type) ? (await store.rows('storyEvents')).filter(row => row.id !== page.eventId && strings(row.nodeIds).some(id => currentNodes.has(id)))
      .map(row => ({ id: row.id, title: row.title, nodeIds: strings(row.nodeIds).filter(id => currentNodes.has(id)) })) : []
    const batchEventIds = new Set(otherEvents.map(row => text(row.id)))
    if (event) batchEventIds.add(text(event.id))
    const parentLines = state.independent && batchEventIds.size ? (await store.rows('eventLines')).filter(row => strings(row.eventIds).some(id => batchEventIds.has(id)))
      .map(row => ({ id: row.id, title: row.title, eventIds: strings(row.eventIds).filter(id => batchEventIds.has(id)) })) : []
    return { phase, queue: page.queue, page: position, outlineReview: true, independent: state.independent, parentLines, otherEvents,
      ...(page.type === 'line_structure' ? { memberEvidence: await Promise.all((lineEvents ?? []).map(async item => {
        const ids = strings(item.nodeIds)
        const endpoints = [...new Set([ids[0], ids.at(-1)].filter((id): id is string => !!id))]
        const samples = await Promise.all(endpoints.map(id => store.get('nodes', id)))
        return { eventId: item.id, members: samples.flatMap(row => row ? [storyView(row, 'node', true)] : []) }
      })) } : {}),
      reviewNotes: reviewNotes.flatMap(row => row ? [storyView(row, 'note', true)] : []),
      workItems: rows.map(row => kind === 'node' ? readingNode(row) : storyView(row, kind, true)),
      ...(line ? { line: storyView(line, 'eventLine', true) } : {}),
      ...(event ? { event: storyView({ ...event, nodeIds: undefined, memberCount: members.length }, 'event', true) } : {}),
      ...(prior ? { previousNode: storyView(prior, 'node', true) } : {}),
      ...(lineEvents ? { lineEvents } : {}), ...(eventMembers ? { eventMembers } : {}) }
  }
  const hints = await buildStoryContext(store, bookId, sessionId, rows, kind, phase === 'global_review', true)
  const memory = await store.get('storyEditorMemory', sessionId)
  return { phase, queue: page.queue, page: position,
    remainingCount: state.pages.filter(page => !checked(page)).length, workItems: hints.assigned, related: hints.related, moreRelated: hints.truncated,
    workingSummary: text(memory?.workingSummary), ...(line ? { line: storyView(line, 'eventLine', outline) } : {}), ...(event ? { event: storyView({ ...event, nodeIds: undefined, memberCount: members.length }, 'event', true) } : {}), ...(prior ? { previousNode: storyView(prior, 'node', outline) } : {}) }
}

export async function navigateStoryReading(store: AgentStore, scope: { bookId: string; runId: string; sessionId?: string; phase: string; taskId: string; quickStoryCheck?: boolean }, args: Row, callId: string) {
  const run = (await store.get('pipelineRuns', scope.runId))!
  const displayed = stateOf(run, scope.phase)
  const state = await refreshReading(store, scope.runId, scope.sessionId!, scope.phase)
  const pages = scope.quickStoryCheck ? state.pages.filter(page => page.quickCheck) : state.pages
  const receipt = `${scope.taskId}:${callId}`
  let summary = '本次翻页已处理，已返回当前阅读位置。'
  if (!state.receipts.includes(receipt)) {
    const at = pages.findIndex(page => page.id === displayed?.currentPageId)
    if ((state.independent && displayed?.currentPageId !== state.currentPageId) || (args.currentPageId && args.currentPageId !== state.currentPageId)) summary = '当前页已变化，已返回当前阅读位置。'
    else if (args.direction === 'previous') {
      state.currentPageId = pages[Math.max(0, at - 1)]?.id ?? null
      summary = '已返回上一页，离开的页未标记完成。'
    } else if (at < 0) {
      state.currentPageId = pages.find(page => !checked(page))?.id ?? state.pages.find(page => !checked(page))?.id ?? null
      summary = '原阅读页已随资料更新，已返回下一待检查页。'
    }
    else {
      const current = pages[at]
      const displayedPage = displayed?.pages.find(page => page.id === current?.id)
      const previousIds = displayedPage?.ids ?? []
      const priorNotes = displayedPage?.reviewNotes as Record<string, string> | undefined
      const newNote = Object.entries(current.reviewNotes ?? {}).some(([id, basis]) => priorNotes?.[id] !== basis)
      if (['directory_open', 'directory_final', 'member_batch'].includes(current.type) && displayedPage?.fingerprint !== current.fingerprint) summary = '归属已变化，请核对更新后的本批目录或成员。'
      else if (newNote) summary = '本页待复核事项有变化，请核对当前问题。'
      else if (current.ids.some(id => !previousIds.includes(id))) summary = '本页增加了新对象，请核对更新后的本页。'
      else {
        if (state.independent && current.type === 'line_structure') {
          const line = await store.get('eventLines', text(current.lineId))
          if (line && !usesOutline(line)) throw new Error('INVALID_ARGS:请先核对旧线成员，整理为事件后使用 activate_legacy_line 确认归属。')
        }
        const batch = new Set(eventDescriptionBatch(displayed).map(item => item.id))
        const completing = batch.size ? pages.filter(item => batch.has(item.id)) : [current]
        if (run.storyOutlineVersion === 1 && ['event_summary', 'line_summary'].includes(current.type)) {
          for (const item of completing) {
            const row = await store.get(current.type === 'event_summary' ? 'storyEvents' : 'eventLines', item.ids[0])
            if (row && needsDescription(current.type, row, true) && !hasOutlineDescription(row)) throw new Error(`INVALID_ARGS:请先保存本页的概况和核心关键线索，两项均为必填。${text(row.title)}`)
          }
        }
        if (state.independent) {
          const conclusions = records(args.noteResults)
          for (const [id, basis] of Object.entries(current.reviewNotes as Record<string, string> ?? {})) {
            const conclusion = text(conclusions.find(result => result.id === id)?.conclusion).trim()
            if (!conclusion) throw new Error('INVALID_ARGS:请用 noteResults 逐条说明本页待复核事项的判断依据和结论。')
            const note = await store.get('storyEditorNotes', id)
            if (note) (state.decisions ??= {})[text(note.key)] = { basis, conclusion }
          }
        }
        for (const item of completing) {
          item.checkedFingerprint = item.fingerprint
          if (item.type === 'directory_open') item.reviewRunId = scope.runId
          item.reason = text(args.reason) || text(args.notes) || '本页已检查。'
          item.sourceFingerprints = await pageSources(store, item)
        }
        if (!state.independent && current.type !== 'line_segment') {
          const checks = state.checks ?? [], sources = new Map<string, string>()
          for (const id of current.ids) {
            const value = await readingCheck(store, current.type, id, sources), at = checks.findIndex(check => check.id === id && check.type === current.type)
            if (at < 0) checks.push(value); else checks[at] = value
          }
          state.checks = checks
        }
        state.currentPageId = (state.independent ? pages : pages.slice(at + 1)).find(page => !checked(page))?.id ?? pages.find(page => !checked(page))?.id ?? state.pages.find(page => !checked(page))?.id ?? null
        summary = '当前页已检查，已返回下一待检查页。'
      }
    }
    state.receipts.push(receipt)
  }
  await saveReading(store, scope.runId, scope.phase, state)
  const complete = pages.every(checked)
  return { ok: true, complete, page: complete ? null : await readingBrief(store, scope.bookId, scope.sessionId!, scope.phase, state, run.storyOutlineVersion === 1, scope.quickStoryCheck), summary: complete ? scope.quickStoryCheck ? '旧页快速核对已完成。' : '本阶段各页已检查，保存的疑点和未解线索保留。' : summary }
}

export function readingProgress(state: ReadingState): { reviewCounts?: string; conclusions: Row[]; reused: number; pageNumber: number; totalPages: number; checked: number; quickTotal: number; quickChecked: number; complete: boolean; type: string | undefined; queue: string | undefined; lineId: string; eventId: string; eventTitle?: string; segment?: number; totalSegments?: number; lineIndex?: number; totalLines?: number } {
  const page = state.pages.find(page => page.id === state.currentPageId)
  const quick = state.pages.filter(item => item.quickCheck)
  const counts = (type: string, byEvent = false) => {
    const pages = state.pages.filter(item => item.type === type)
    const ids = (item: ReadingPage) => byEvent ? strings(item.eventIds) : item.ids
    const total = new Set(pages.flatMap(ids)).size
    return `${total - new Set(pages.filter(item => !checked(item)).flatMap(ids)).size}/${total}`
  }
  const directoryPages = state.pages.filter(item => item.type.startsWith('directory_'))
  const reviewCounts = state.independent ? [
    `全书目录 ${directoryPages.filter(checked).length}/${directoryPages.length}`, `散落节点 ${counts('node_page')}`,
    `事件成员 ${counts('member_batch', true)}`, `事项 ${records(state.results).length}/${Object.keys(state.questions ?? {}).length}`,
    `事件说明 ${counts('event_summary')}`, `故事线说明 ${counts('line_summary')}`,
  ].join(' · ') : undefined
  return { reviewCounts, conclusions: records(state.results), reused: state.reusedChecks?.length ?? 0, pageNumber: page ? state.pages.indexOf(page) + 1 : state.pages.length, totalPages: state.pages.length, checked: state.pages.filter(checked).length, quickTotal: quick.length, quickChecked: quick.filter(checked).length, complete: state.pages.every(checked), type: page?.type, queue: page?.queue, lineId: text(page?.lineId), eventId: text(page?.eventId), segment: page?.segment as number | undefined, totalSegments: page?.totalSegments as number | undefined, lineIndex: page?.lineIndex as number | undefined, totalLines: page?.totalLines as number | undefined }
}
