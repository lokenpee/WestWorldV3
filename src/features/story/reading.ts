import { hash, records, strings, text } from '../agents/contracts'
import type { AgentStore, Row } from '../agents/repository'
import { noteFingerprint } from '../agents/queries'
import { storyContent, validStoryCoverage } from './coverage'
import { buildStoryContext, selectStoryBatch, storyDigest } from './retrieval'

export interface ReadingPage extends Row { id: string; type: string; queue: string; ids: string[]; fingerprint: string; checkedFingerprint?: string; sourceFingerprints?: Record<string, string>; reason?: string }
export interface ReadingState extends Row { pages: ReadingPage[]; currentPageId: string | null; receipts: string[] }
const stateOf = (run: Row, phase: string) => ((run.storyReading as Row | undefined)?.[phase] as ReadingState | undefined)
const batches = (rows: Row[]) => {
  const result: Row[][] = []; let offset = 0
  while (offset < rows.length) { const batch = selectStoryBatch(rows.slice(offset, offset + 10), 4000); result.push(batch); offset += batch.length }
  return result
}
const checked = (page: ReadingPage) => page.checkedFingerprint === page.fingerprint
const portable = (value: unknown): unknown => Array.isArray(value) ? value.map(portable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !['bookId', 'sessionId', 'basisFingerprint'].includes(key)).map(([key, item]) => [key, portable(item)])) : value
const sourceFingerprint = async (store: AgentStore, chapter: string) => {
  const source = await store.get('chapterTexts', chapter)
  return store.wait(hash(source ? text(source.text) : null))
}
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
  const saved = stateOf(run, phase)
  const nodes = await store.rows('nodes'), lines = await store.rows('eventLines')
  const chapterOrder = new Map((await store.rows('chapters')).map(row => [text(row.chapterIndex), Number(row.order)]))
  nodes.sort((a, b) => (chapterOrder.get(text(a.chapterIndex)) ?? 0) - (chapterOrder.get(text(b.chapterIndex)) ?? 0) || Number(a.order ?? 0) - Number(b.order ?? 0) || text(a.id).localeCompare(text(b.id)))
  const pages: ReadingPage[] = []
  const add = async (type: string, queue: string, rows: Row[], extra: Row = {}, basis: unknown = rows.map(row => storyContent(type === 'note_page' ? 'storyEditorNotes' : 'nodes', row))) => {
    const id = `${type}:${text(extra.lineId) || text(rows[0]?.id)}:${Number(extra.segment ?? 0)}`
    const fingerprint = await store.wait(hash({ type, basis: portable(basis) }))
    const previous = saved?.pages.find(page => page.id === id)
    pages.push({ ...previous, ...extra, id, type, queue, ids: rows.map(row => text(row.id)), fingerprint })
  }
  if (phase === 'window_link') {
    for (const group of batches(nodes)) await add('node_page', 'window_nodes', group)
    // 旧窗口检查点中的有效逐项结果可复用；不会重新解释旧模型的语义结论。
    if (!saved) for (const page of pages) {
      let valid = true
      for (const id of page.ids) {
        const row = nodes.find(node => node.id === id)!
        const candidates = records(run.coverageItems).filter(item => item.phase === 'window_link' && item.kind === 'node' && item.id === id)
        if (!(await Promise.all(candidates.map(item => validStoryCoverage(store, item, row)))).some(Boolean)) { valid = false; break }
      }
      if (valid) { page.checkedFingerprint = page.fingerprint; page.sourceFingerprints = await pageSources(store, page) }
    }
  } else {
    const linked = new Set(lines.flatMap(line => strings(line.nodeIds)))
    for (const group of batches(nodes.filter(row => !linked.has(text(row.id))))) await add('node_page', 'orphans', group)
    lines.sort((a, b) => text(a.id).localeCompare(text(b.id)))
    for (const [lineIndex, line] of lines.entries()) {
      const members = strings(line.nodeIds).map(id => nodes.find(node => node.id === id)).filter((row): row is Row => !!row)
      const segments = batches(members)
      for (const [index, group] of segments.entries()) await add('line_segment', 'event_lines', group, { lineId: line.id, lineIndex: lineIndex + 1, totalLines: lines.length, segment: index + 1, totalSegments: segments.length })
      await add('line_summary', 'event_lines', [line], { lineId: line.id, lineIndex: lineIndex + 1, totalLines: lines.length }, { line: storyContent('eventLines', line), nodes: members.map(row => storyContent('nodes', row)) })
    }
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
  return { ...saved, pages, currentPageId, receipts: strings(saved?.receipts) }
}

export async function saveReading(store: AgentStore, runId: string, phase: string, state: ReadingState) {
  const run = (await store.get('pipelineRuns', runId))!
  await store.put('pipelineRuns', { ...run, storyReading: { ...(run.storyReading as Row ?? {}), [phase]: state } })
}

export async function readingBrief(store: AgentStore, bookId: string, sessionId: string, phase: string, state: ReadingState): Promise<Row | null> {
  const page = state.pages.find(page => page.id === state.currentPageId)
  if (!page) return null
  const kind = page.type === 'line_summary' ? 'eventLine' : page.type === 'note_page' ? 'note' : 'node'
  const table = kind === 'eventLine' ? 'eventLines' : kind === 'note' ? 'storyEditorNotes' : 'nodes'
  const rows = (await Promise.all(page.ids.map(id => store.get(table, id)))).filter((row): row is Row => !!row)
  const hints = await buildStoryContext(store, bookId, sessionId, rows, kind, phase === 'global_review')
  const memory = await store.get('storyEditorMemory', sessionId)
  const line = page.lineId ? await store.get('eventLines', text(page.lineId)) : undefined
  const previous = line && page.type === 'line_segment' ? strings(line.nodeIds).indexOf(page.ids[0]) : -1
  const prior = previous > 0 ? await store.get('nodes', strings(line?.nodeIds)[previous - 1]) : undefined
  return { phase, queue: page.queue, page: { id: page.id, type: page.type, pageNumber: state.pages.indexOf(page) + 1, totalPages: state.pages.length, ids: page.ids,
    ...(page.lineId ? { lineId: page.lineId, lineIndex: page.lineIndex, totalLines: page.totalLines, ...(page.segment ? { segment: page.segment, totalSegments: page.totalSegments } : {}) } : {}) },
    remainingCount: state.pages.filter(page => !checked(page)).length, workItems: hints.assigned, related: hints.related, moreRelated: hints.truncated,
    workingSummary: text(memory?.workingSummary), ...(line ? { line: { ...storyDigest(line, 'eventLine'), cause: text(line.cause).slice(0, 500), result: text(line.result).slice(0, 500), summaryTruncated: text(line.cause).length > 500 || text(line.result).length > 500 }, ...(prior ? { previousNode: storyDigest(prior, 'node') } : {}) } : {}) }
}

export async function navigateStoryReading(store: AgentStore, scope: { bookId: string; runId: string; sessionId?: string; phase: string; taskId: string }, args: Row, callId: string) {
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
        state.currentPageId = state.pages.slice(at + 1).find(page => !checked(page))?.id ?? state.pages.find(page => !checked(page))?.id ?? null
        summary = '当前页已检查，已返回下一待检查页。'
      }
    }
    state.receipts.push(receipt)
  }
  await saveReading(store, scope.runId, scope.phase, state)
  const complete = state.pages.every(checked)
  return { ok: true, complete, page: complete ? null : await readingBrief(store, scope.bookId, scope.sessionId!, scope.phase, state), summary: complete ? '本阶段各页已检查，保存的疑点和未解线索保留。' : summary }
}

export function readingProgress(state: ReadingState) {
  const page = state.pages.find(page => page.id === state.currentPageId)
  return { pageNumber: page ? state.pages.indexOf(page) + 1 : state.pages.length, totalPages: state.pages.length, checked: state.pages.filter(checked).length, complete: state.pages.every(checked), type: page?.type, queue: page?.queue, lineId: text(page?.lineId), segment: page?.segment as number | undefined, totalSegments: page?.totalSegments as number | undefined, lineIndex: page?.lineIndex as number | undefined, totalLines: page?.totalLines as number | undefined }
}
