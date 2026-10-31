import type { AgentStore, Row } from './repository'
import { hash, strings, text, type AgentProfile } from './contracts'
import { characterCandidates } from '../assets/characterLinks'
import type { Character } from '../assets/types'

export interface Scope { bookId: string; profile: AgentProfile; phase: string; runId: string; taskId: string; sessionId?: string; owner: string; probe?: boolean; workItemIds: string[]; requiredLineIds?: string[] }
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const within = (index: string, range: string[]) => !range.length || index.localeCompare(range[0], undefined, { numeric: true }) >= 0 && index.localeCompare(range[1], undefined, { numeric: true }) <= 0
export async function noteFingerprint(store: AgentStore, note: Row) {
  const nodes = await Promise.all(strings(note.nodeIds).map(id => store.get('nodes', id)))
  const lines = await Promise.all(strings(note.lineIds).map(id => store.get('eventLines', id)))
  return store.wait(hash({ nodes, lines, evidence: note.evidence }))
}
async function projectNotes(store: AgentStore, notes: Row[]): Promise<(Row & { validity: string })[]> {
  return Promise.all(notes.map(async row => ({ ...row, validity: await noteFingerprint(store, row) === row.basisFingerprint ? 'current' : 'stale' })))
}
export async function scopedRows(store: AgentStore, scope: Scope, table: string) {
  const rows = await store.rows(table)
  if (rows.some(row => row.bookId !== scope.bookId)) throw new Error('SCOPE:查询资料不属于当前书籍。')
  return rows
}
async function checkSession(store: AgentStore, scope: Scope, args: Row) {
  const id = text(args.session_id) || scope.sessionId
  if (id) { const row = await store.get('storySessions', id); if (!row || row.bookId !== scope.bookId) throw new Error('SCOPE:会话不属于当前书籍。') }
  return id
}
export async function resolveAsset(store: AgentStore, scope: Scope, table: string, id: string): Promise<Row | undefined> {
  const kind = ({ characters: 'character', locations: 'location', nodes: 'node', eventLines: 'eventLine' } as Record<string, string>)[table]
  const original = id; const seen = new Set<string>()
  for (;;) {
    if (seen.has(id)) throw new Error('CONFLICT:来源映射存在循环。')
    seen.add(id)
    const mapping = await store.get('assetLifecycle', `${kind}:${id}`)
    if (mapping && mapping.bookId !== scope.bookId) throw new Error('SCOPE:来源记录不属于当前书籍。')
    if (mapping?.state === 'deleted') return undefined
    if (mapping?.state === 'merged') { id = text(mapping.currentId); continue }
    const row = await store.get(table, id)
    if (row && row.bookId !== scope.bookId) throw new Error('SCOPE:资料不属于当前书籍。')
    return row ? { ...row, ...(id !== original ? { resolvedFrom: original } : {}) } : undefined
  }
}
function page(rows: Row[], args: Row, max: number, options: { missingIds?: string[]; cursor?: boolean } = {}) {
  const offset = Number(args.offset ?? 0); const limit = Math.min(Number(args.limit ?? 100), max)
  const data: Row[] = []
  for (const row of rows.slice(offset, offset + limit)) {
    const item = bytes(row) > 64512 ? { id: row.id, fields_omitted: ['oversized_detail'], hint: '内容较长，请分段读取。' } : row
    if (bytes(data) + bytes(item) > 64512 && data.length) break
    data.push(item)
  }
  const truncated = offset + data.length < rows.length
  return { data, totalCount: rows.length, truncated, nextOffset: truncated ? offset + data.length : null, ...(options.missingIds ? { missingIds: options.missingIds } : {}), ...(options.cursor ? { nextAfterId: truncated && data.length ? data[data.length - 1].id : null } : {}) }
}
async function references(store: AgentStore, scope: Scope, names: string[], ids: string[]) {
  const people = await scopedRows(store, scope, 'characters') as unknown as Character[]
  return [...new Set([...names, ...ids.map(id => people.find(row => row.id === id)?.name ?? id)])].map(name => {
    const candidates = characterCandidates(name, people)
    const chosen = candidates.find(row => ids.includes(row.id)) ?? (candidates.length === 1 ? candidates[0] : undefined)
    return { name, status: chosen ? 'resolved' : candidates.length > 1 ? 'ambiguous' : 'not_found', candidateIds: candidates.map(row => row.id), ...(chosen ? { characterId: chosen.id } : {}) }
  })
}
export async function readTool(store: AgentStore, scope: Scope, name: string, args: Row, maxResults = 100): Promise<Row> {
  if (name === 'read_original') {
    const chapters = (await scopedRows(store, scope, 'chapters')).sort((a, b) => Number(a.order) - Number(b.order))
    const selected = chapters.filter(row => within(text(row.chapterIndex), strings(args.chapter_range)))
    if (!selected.length) throw new Error('NOT_FOUND:章节范围不存在。')
    const texts = await scopedRows(store, scope, 'chapterTexts')
    const joined = selected.map(chapter => { const row = texts.find(row => row.chapterIndex === chapter.chapterIndex); if (!row) throw new Error('NOT_FOUND:章节原文缺失。'); return text(row.text) }).join('')
    const offset = Number(args.offset ?? 0); let result = joined.slice(offset, offset + Math.min(Number(args.maxChars ?? 8000), 20000))
    while (bytes(result) > 64000) result = result.slice(0, Math.floor(result.length * 0.9))
    const truncated = offset + result.length < joined.length
    return { text: result, totalChars: joined.length, truncated, nextOffset: truncated ? offset + result.length : null }
  }
  if (name === 'get_editor_memory') {
    const id = await checkSession(store, scope, args)
    const notes = await projectNotes(store, (await scopedRows(store, scope, 'storyEditorNotes')).filter(row => !id || row.sessionId === id))
    const memory = (await scopedRows(store, scope, 'storyEditorMemory')).find(row => row.id === id) ?? { id: id ?? 'memory', bookId: scope.bookId, ...(id ? { sessionId: id } : {}), revision: 0, workingSummary: '', dataFingerprint: '', updatedAt: '' }
    const checkpoints = (await scopedRows(store, scope, 'storyEditorCheckpoints')).filter(row => !id || row.sessionId === id)
    const currentFingerprint = await store.wait(hash(await scopedRows(store, scope, 'nodes')))
    return { memory, dataChanged: Number(memory.revision) > 0 && memory.dataFingerprint !== currentFingerprint, pendingCount: notes.filter(row => row.status === 'active').length, staleCount: notes.filter(row => row.validity === 'stale').length,
      notes: notes.filter(row => row.status === 'active').slice(0, 10).map(row => ({ id: row.id, key: row.key, kind: row.kind, status: row.status, statement: row.statement, nodeIds: row.nodeIds, lineIds: row.lineIds, validity: row.validity, truncated: false })),
      recentCheckpoints: checkpoints.slice(-5).map(row => ({ id: row.id, stage: row.stage, phase: row.phase, status: row.status, scopeCount: strings(row.scopeIds).length, updatedAt: row.updatedAt })) }
  }
  if (name === 'list_editor_sessions') {
    const sessions = await scopedRows(store, scope, 'storySessions'); const entries = await scopedRows(store, scope, 'storySessionEntries')
    return page(sessions.map(row => ({ id: row.id, title: row.title, kind: row.kind, status: row.status, ...(row.parentSessionId ? { parentSessionId: row.parentSessionId } : {}), entryCount: entries.filter(entry => entry.sessionId === row.id).length, createdAt: row.createdAt, updatedAt: row.updatedAt })), args, 50)
  }
  if (name === 'query_editor_notes' || name === 'get_editor_note_detail') {
    const sessionId = await checkSession(store, scope, args)
    let rows = await projectNotes(store, (await scopedRows(store, scope, 'storyEditorNotes')).filter(row => !sessionId || row.sessionId === sessionId))
    if (name === 'get_editor_note_detail') rows = rows.filter(row => strings(args.ids).includes(text(row.id)))
    else rows = rows.filter(row => (!args.kind || row.kind === args.kind) && (!args.key || row.key === args.key) && (!args.status || (args.status === 'stale' ? row.validity === 'stale' : row.status === args.status)) && (!args.node_id || strings(row.nodeIds).includes(text(args.node_id))) && (!args.line_id || strings(row.lineIds).includes(text(args.line_id))))
    return page(rows, args, name === 'get_editor_note_detail' ? 20 : 50)
  }
  if (name === 'query_editor_session_history') {
    const sessionId = await checkSession(store, scope, args)
    let rows = (await scopedRows(store, scope, 'storySessionEntries')).filter(row => row.sessionId === sessionId).sort((a, b) => Number(a.ordinal) - Number(b.ordinal))
    if (args.entry_id) {
      rows = rows.filter(row => row.id === args.entry_id)
      const offset = Number(args.char_offset ?? 0); const maxChars = Math.min(Number(args.maxChars ?? 12000), 20000)
      return page(rows.map(row => { const full = JSON.stringify(row); const segment = full.slice(offset, offset + maxChars); const truncated = offset + segment.length < full.length; return { id: row.id, text: segment, totalChars: full.length, charOffset: offset, truncated, nextCharOffset: truncated ? offset + segment.length : null } }), {}, 1)
    }
    if (args.mode !== 'full') rows = rows.map(row => ({ id: row.id, ordinal: row.ordinal, type: row.type, createdAt: row.createdAt, preview: JSON.stringify(row.message ?? row.summary ?? row.reason ?? '').slice(0, 300) }))
    return page(rows, args, args.mode === 'full' ? 20 : 50)
  }
  const table = name.includes('character') ? 'characters' : name.includes('location') ? 'locations' : name.includes('event_line') ? 'eventLines' : 'nodes'
  const detail = name.startsWith('get_')
  if (detail && args.include_facts && (scope.profile !== 'asset_editor' || scope.phase !== 'optimize')) throw new Error('INVALID_ARGS:事实底稿仅供世界资产整编读取。')
  if (detail) {
    const rows: Row[] = []; const missing: string[] = []
    for (const id of strings(args.ids)) {
      const found = await resolveAsset(store, scope, table, id)
      if (!found) { missing.push(id); continue }
      const row = { ...found }
      if (!args.include_facts) for (const key of ['mergeFacts', 'optimizedFactIds', 'optimizationFingerprint']) delete row[key]
      if (table === 'nodes') row.characterReferences = await references(store, scope, [...strings(row.actors), ...strings(row.targets)], [...strings(row.actorIds), ...strings(row.targetCharacterIds)])
      if (table === 'eventLines') {
        const nodes = (await scopedRows(store, scope, 'nodes')).filter(node => strings(row.nodeIds).includes(text(node.id)))
        row.characterIds = [...new Set(nodes.flatMap(node => [...strings(node.actorIds), ...strings(node.targetCharacterIds)]))]
        row.characterReferences = await references(store, scope, nodes.flatMap(node => [...strings(node.actors), ...strings(node.targets)]), strings(row.characterIds))
      }
      rows.push(row)
    }
    return page(rows, {}, maxResults, { missingIds: missing })
  }
  if (args.after_id !== undefined && args.offset !== undefined) throw new Error('INVALID_ARGS:稳定游标与页偏移请选用一种。')
  let rows = (await scopedRows(store, scope, table)).sort((a, b) => compare(text(a.id), text(b.id)))
  const nameLike = text(args.name_like).toLowerCase()
  rows = rows.filter(row => (!nameLike || [row.name, row.title, ...strings(row.aliases)].some(value => text(value).toLowerCase().includes(nameLike))) && (!args.after_id || compare(text(row.id), text(args.after_id)) > 0) && (!args.status || row.lineStatus === args.status))
  if (args.chapter_range) rows = rows.filter(row => [text(row.chapterIndex), ...strings(row.sourceChapters), ...strings(row.chapters)].some(index => within(index, strings(args.chapter_range))))
  if (args.event_line_id) rows = rows.filter(row => strings(row.eventLineIds).includes(text(args.event_line_id)))
  if (args.actor) rows = rows.filter(row => [...strings(row.actors), ...strings(row.actorIds)].includes(text(args.actor)))
  if (args.character) {
    const nodes = await scopedRows(store, scope, 'nodes')
    const relevant = new Set(nodes.filter(node => [...strings(node.actors), ...strings(node.targets), ...strings(node.actorIds), ...strings(node.targetCharacterIds)].includes(text(args.character))).map(node => text(node.id)))
    rows = rows.filter(row => strings(row.nodeIds).some(id => relevant.has(id)))
  }
  const projected = rows.map(row => table === 'characters' || table === 'locations' ? { id: row.id, name: row.name, aliases: strings(row.aliases), sourceChapters: strings(row.sourceChapters), revision: row.revision, [table === 'characters' ? 'identityHint' : 'descriptionHint']: text(table === 'characters' ? row.identity : row.description).slice(0, 160), estimatedDetailTokens: Math.ceil(JSON.stringify(row).length / 3), duplicateScore: rows.filter(other => other.name === row.name && other.id !== row.id).length } : table === 'nodes' ? { id: row.id, name: row.name, summary: row.summary, actors: row.actors, chapterIndex: row.chapterIndex } : { id: row.id, title: row.title, chapters: row.chapters, lineStatus: row.lineStatus, nodeCount: strings(row.nodeIds).length, cause: text(row.cause).slice(0, 160), result: text(row.result).slice(0, 160) })
  return page(projected, args, maxResults, { cursor: table === 'characters' || table === 'locations' })
}

export const toolBytes = bytes
export function assertScope(scope: Scope, repositoryBookId: string) { if (scope.bookId !== repositoryBookId) throw new Error('SCOPE:执行范围与书籍不一致。') }
