import { hash, records, strings, text } from '../agents/contracts'
import type { AgentStore, Row } from '../agents/repository'
import { storyContent } from './coverage'

export interface ReadingCheck extends Row { id: string; type: string; fingerprint: string }
const portable = (value: unknown): unknown => Array.isArray(value) ? value.map(portable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !['bookId', 'sessionId', 'basisFingerprint'].includes(key)).map(([key, value]) => [key, portable(value)])) : value
export async function readingCheck(store: AgentStore, type: string, id: string, sources = new Map<string, string>()): Promise<ReadingCheck> {
  const table = type === 'line_summary' ? 'eventLines' : type === 'note_page' ? 'storyEditorNotes' : 'nodes'
  const row = await store.get(table, id)
  const nodes = table === 'eventLines' ? (await Promise.all(strings(row?.nodeIds).map(id => store.get('nodes', id)))).filter((item): item is Row => !!item) : table === 'nodes' && row ? [row] : []
  const source: [string, string][] = []
  for (const chapter of new Set(nodes.map(node => text(node.chapterIndex)))) {
    if (!sources.has(chapter)) sources.set(chapter, await store.wait(hash(text((await store.get('chapterTexts', chapter))?.text))))
    source.push([chapter, sources.get(chapter)!])
  }
  return { type, id, fingerprint: await store.wait(hash(portable({ row: storyContent(table, row ?? null), nodes: nodes.map(node => storyContent('nodes', node)), source }))) }
}

export async function usableReadingChecks(store: AgentStore, checks: ReadingCheck[]) {
  const notes = (await store.rows('storyEditorNotes')).filter(note => note.status === 'active')
  const lines = await store.rows('eventLines')
  const sources = new Map<string, string>()
  const result: ReadingCheck[] = []
  for (const check of checks) {
    if (check.type === 'note_page') continue
    const row = await store.get(check.type === 'line_summary' ? 'eventLines' : 'nodes', check.id)
    if (!row) continue
    const members = check.type === 'line_summary' ? strings(row.nodeIds) : [check.id]
    const affectedLines = check.type === 'line_summary' ? [check.id] : lines.filter(line => strings(line.nodeIds).includes(check.id)).map(line => text(line.id))
    if (notes.some(note => strings(note.nodeIds).some(id => members.includes(id)) || strings(note.lineIds).some(id => affectedLines.includes(id)))) continue
    if ((await readingCheck(store, check.type, check.id, sources)).fingerprint === check.fingerprint) result.push(check)
  }
  return result
}

export async function inheritedReadingChecks(store: AgentStore, phase: string, refresh?: (runId: string) => Promise<Row>) {
  const latest = new Map<string, ReadingCheck>()
  const runs = (await store.rows('pipelineRuns')).filter(run => run.stage === 'P3').sort((a, b) => text(b.startedAt).localeCompare(text(a.startedAt)))
  for (const run of runs) {
    const saved = (run.storyReading as Row | undefined)?.[phase] as Row | undefined
    const state = saved && refresh ? await refresh(text(run.id)) : saved
    // 后来的未完成记录优先于旧成功，避免错误复用。
    for (const page of records(state?.pages)) for (const id of strings(page.ids)) {
      if (page.type === 'line_segment') continue
      const key = `${page.type}:${id}`
      if (!latest.has(key)) latest.set(key, (records(state?.checks).find(check => check.id === id && check.type === page.type) as ReadingCheck | undefined)
        ?? (page.checkedFingerprint === page.fingerprint ? await readingCheck(store, text(page.type), id) : { id, type: text(page.type), fingerprint: '' }))
    }
    for (const check of [...records(state?.checks), ...records(state?.reusedChecks)] as ReadingCheck[]) if (!latest.has(`${check.type}:${check.id}`)) latest.set(`${check.type}:${check.id}`, check)
  }
  return usableReadingChecks(store, [...latest.values()])
}
