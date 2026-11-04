import type { AgentStore, Row } from './repository'
import { hash, strings, text, type AgentProfile } from './contracts'
import { characterCandidates } from '../assets/characterLinks'
import { edgesFor, effectivePairs, pairFromPerspective, pairView, projectRelations, relationView, syncRelations } from '../assets/relations'
import { normalizeCharacterNames } from '../assets/characterNames'
import { storyContent } from '../story/coverage'
import { searchStoryContext } from '../story/retrieval'
import type { Character, CharacterRelation, CharacterRelationEdit, Lifecycle } from '../assets/types'

export interface Scope { bookId: string; profile: AgentProfile; phase: string; runId: string; taskId: string; sessionId?: string; owner: string; probe?: boolean; workItemIds: string[]; requiredLineIds?: string[]; reviewScope?: 'all_assets' | 'relations' }
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const canonicalCursor = (value: unknown) => JSON.stringify(Array.isArray(value) ? value.map(String) : [])
const within = (index: string, range: string[]) => !range.length || index.localeCompare(range[0], undefined, { numeric: true }) >= 0 && index.localeCompare(range[1], undefined, { numeric: true }) <= 0
export async function noteFingerprint(store: AgentStore, note: Row) {
  const nodes = await Promise.all(strings(note.nodeIds).map(id => store.get('nodes', id)))
  const lines = await Promise.all(strings(note.lineIds).map(id => store.get('eventLines', id)))
  return store.wait(hash({ nodes: nodes.map(row => storyContent('nodes', row ?? null)), lines: lines.map(row => storyContent('eventLines', row ?? null)), evidence: note.evidence }))
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
    return row ? { ...row, ...(id !== original ? { resolvedFrom: [original] } : {}) } : undefined
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
function detailFragments(rows: Row[], args: Row): Row[] {
  return rows.map(row => {
    const full = JSON.stringify(row)
    if (full.length <= 6000 && args.char_offset === undefined && args.maxChars === undefined) return row
    const offset = Number(args.char_offset ?? 0)
    if (offset >= full.length) throw new Error('INVALID_ARGS:详情续读位置超出内容长度，请使用上次返回的nextCharOffset。')
    let part = full.slice(offset, offset + Math.min(Number(args.maxChars ?? 6000), 6000))
    while (bytes(part) > 28000) part = part.slice(0, Math.floor(part.length * 0.9))
    const truncated = offset + part.length < full.length
    return { id: row.id, text: part, totalChars: full.length, charOffset: offset, truncated, nextCharOffset: truncated ? offset + part.length : null }
  })
}
async function references(store: AgentStore, scope: Scope, names: string[], ids: string[]) {
  const people = await scopedRows(store, scope, 'characters') as unknown as Character[]
  return [...new Set([...names, ...ids.map(id => people.find(row => row.id === id)?.name ?? id)])].map(name => {
    const candidates = characterCandidates(name, people)
    return candidates.length
      ? { name, status: 'resolved', candidateIds: candidates, ...(candidates.length === 1 ? { characterId: candidates[0] } : {}) }
      : { name, status: 'not_found', candidateIds: [] }
  })
}
export async function readTool(store: AgentStore, scope: Scope, name: string, args: Row, maxResults = 100): Promise<Row> {
  if (name === 'search_story_context') {
    if (scope.profile !== 'story_editor') throw new Error('SCOPE:相关叙事检索仅供故事编辑使用。')
    return searchStoryContext(store, scope.bookId, scope.sessionId, { ...args, include_future: args.include_future ?? scope.phase === 'global_review' })
  }
  if (name === 'read_original') {
    const assetIds = strings(args.asset_ids), range = strings(args.chapter_range), requested = strings(args.chapter_indices)
    if (!assetIds.length && !range.length && !requested.length) throw new Error('INVALID_ARGS:请给出资产编号或章节。')
    const chapters = (await scopedRows(store, scope, 'chapters')).sort((a, b) => Number(a.order) - Number(b.order))
    let indexes: Set<string> | undefined
    if (assetIds.length) {
      indexes = new Set<string>()
      for (const id of assetIds) {
        const asset = await resolveAsset(store, scope, 'characters', id) ?? await resolveAsset(store, scope, 'locations', id) ?? await resolveAsset(store, scope, 'nodes', id)
        if (!asset) throw new Error('NOT_FOUND:资产不存在。')
        for (const index of strings(asset.sourceChapters).length ? strings(asset.sourceChapters) : [text(asset.chapterIndex)]) if (index) indexes.add(index)
      }
    }
    const chosen = chapters.filter(row => (!indexes || indexes.has(text(row.chapterIndex))) && (!requested.length || requested.includes(text(row.chapterIndex))) && within(text(row.chapterIndex), range))
    if (!chosen.length) throw new Error('NOT_FOUND:章节不存在或资产缺少来源章节。')
    const cursor = args.cursor as { chapterIndex: string; offset: number } | undefined
    let position = cursor ? chosen.findIndex(row => row.chapterIndex === cursor.chapterIndex) : 0
    if (position < 0) throw new Error('INVALID_ARGS:续读章节不在选定范围内。')
    const baseOffset = cursor ? chosen.slice(0, position).reduce((sum, row) => sum + Number(row.charCount ?? 0), 0) + cursor.offset : Number(args.offset ?? 0)
    let skip = cursor?.offset ?? Number(args.offset ?? 0)
    let remaining = Math.min(Number(args.maxChars ?? 8000), 20000), byteBudget = 28000
    const segments: { chapterIndex: string; offset: number; text: string }[] = []
    let nextCursor: { chapterIndex: string; offset: number } | null = null
    let consumed = 0
    for (; position < chosen.length; position++) {
      const chapterIndex = text(chosen[position].chapterIndex)
      const row = await store.get('chapterTexts', chapterIndex)
      if (!row) throw new Error('NOT_FOUND:章节原文缺失。')
      if (row.bookId !== scope.bookId) throw new Error('SCOPE:查询资料不属于当前书籍。')
      const original = text(row.text)
      if (skip >= original.length) { skip -= original.length; continue }
      let part = original.slice(skip, skip + remaining)
      while (bytes(part) > byteBudget && part.length) part = part.slice(0, Math.floor(part.length * 0.9))
      if (!part.length) { nextCursor = { chapterIndex, offset: skip }; break }
      segments.push({ chapterIndex, offset: skip, text: part })
      consumed += part.length; remaining -= part.length; byteBudget -= bytes(part)
      const end = skip + part.length
      if (end < original.length) { nextCursor = { chapterIndex, offset: end }; break }
      skip = 0
      if (remaining <= 0 || byteBudget < 16 || segments.length >= 20) {
        nextCursor = position + 1 < chosen.length ? { chapterIndex: text(chosen[position + 1].chapterIndex), offset: 0 } : null
        break
      }
    }
    return { text: segments.map(part => part.text).join(''), segments, chapters: segments.map(part => part.chapterIndex), totalChars: chosen.reduce((sum, row) => sum + Number(row.charCount ?? 0), 0), truncated: !!nextCursor, nextCursor, nextOffset: nextCursor ? baseOffset + consumed : null }

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
    return page(name === 'get_editor_note_detail' ? detailFragments(rows, args) : rows, args, name === 'get_editor_note_detail' ? 20 : 50)
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
  if (name === 'get_character_relation') {
    const fromId = text(args.fromId), toId = text(args.toId)
    if (!fromId || !toId || fromId === toId) throw new Error('INVALID_ARGS:请给出两个不同的人物编号。')
    const people = (await scopedRows(store, scope, 'characters')) as unknown as Character[]
    if (!people.some(person => person.id === fromId) || !people.some(person => person.id === toId)) throw new Error('NOT_FOUND:人物不存在或已删除。')
    const lifecycle = (await scopedRows(store, scope, 'assetLifecycle')) as unknown as Lifecycle[]
    const relations = (await scopedRows(store, scope, 'characterRelations')) as unknown as CharacterRelation[]
    const edits = (await scopedRows(store, scope, 'characterRelationEdits')) as unknown as CharacterRelationEdit[]
    const normalized = people.map(normalizeCharacterNames)
    const pairs = effectivePairs(syncRelations(relations, normalized, lifecycle).relations, edits, normalized)
    return { data: pairFromPerspective(pairs, fromId, toId, normalized) }
  }
  if (name === 'get_legacy_relation_records') {
    const ids = strings(args.ids)
    if (!ids.length || ids.length > 50 || new Set(ids).size !== ids.length) throw new Error('INVALID_ARGS:旧关系编号须为1–50个不重复编号。')
    const all = await scopedRows(store, scope, 'legacyRelationRecords')
    const selected = ids.map(id => all.find(row => row.id === id))
    if (selected.some(row => !row)) throw new Error(`NOT_FOUND:旧关系记录不存在：${ids.filter((_, index) => !selected[index]).join('、')}`)
    const rows = selected as Row[]
    const fingerprint = await store.wait(hash(rows))
    const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 50)
    let index = 0, offset = 0
    if (args.cursor !== undefined && args.cursor !== null) {
      if (typeof args.cursor !== 'string') throw new Error('INVALID_ARGS:续读游标格式不正确。')
      let cursor: { ids?: unknown; index?: unknown; offset?: unknown; fingerprint?: unknown }
      try { cursor = JSON.parse(args.cursor) } catch { throw new Error('INVALID_ARGS:续读游标无法解析。') }
      if (canonicalCursor(cursor.ids) !== canonicalCursor(ids) || cursor.fingerprint !== fingerprint) throw new Error('CONFLICT:续读需求或旧关系记录已变化，请重新读取。')
      if (!Number.isSafeInteger(cursor.index) || !Number.isSafeInteger(cursor.offset) || Number(cursor.index) < 0 || Number(cursor.offset) < 0) throw new Error('INVALID_ARGS:续读游标位置无效。')
      index = Number(cursor.index); offset = Number(cursor.offset)
      if (index >= rows.length) throw new Error('INVALID_ARGS:续读游标已超出记录范围。')
    }
    const data: Row[] = []
    let next: { ids: string[]; index: number; offset: number; fingerprint: string } | null = null
    const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object'
      ? `{${Object.entries(value).sort(([a], [b]) => compare(a, b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
      : JSON.stringify(value)
    while (index < rows.length) {
      const row = rows[index]
      const meta = { id: text(row.id), disposition: text(row.disposition), pairKeys: strings(row.pairKeys), issues: strings(row.issues) }
      if (offset === 0) {
        const whole = { ...meta, original: row.original, fragment: null }
        if (bytes(whole) <= 24000 && bytes({ data: [...data, whole] }) <= 60000) {
          data.push(whole); index++
          if (data.length >= limit && index < rows.length) { next = { ids, index, offset: 0, fingerprint }; break }
          continue
        }
      }
      const serialized = stable(row.original)
      if (offset >= serialized.length) { index++; offset = 0; continue }
      let size = Math.min(16000, serialized.length - offset)
      let textPart = serialized.slice(offset, offset + size)
      while (textPart.length > 1 && /[\uD800-\uDBFF]$/.test(textPart)) textPart = textPart.slice(0, -1)
      while (true) {
        const item = { ...meta, original: null, fragment: { offset, text: textPart, totalLength: serialized.length } }
        if (bytes({ data: [...data, item] }) <= 60000 || !data.length) { data.push(item); break }
        if (textPart.length <= 1) { next = { ids, index, offset, fingerprint }; break }
        textPart = textPart.slice(0, Math.max(1, Math.floor(textPart.length * 0.8)))
        while (textPart.length > 1 && /[\uD800-\uDBFF]$/.test(textPart)) textPart = textPart.slice(0, -1)
      }
      if (next) break
      const end = offset + textPart.length
      if (end < serialized.length) { next = { ids, index, offset: end, fingerprint }; break }
      index++; offset = 0
      if (data.length >= limit && index < rows.length) { next = { ids, index, offset: 0, fingerprint }; break }
    }
    return { data, nextCursor: next ? JSON.stringify(next) : null, fingerprint }
  }
  const table = name.includes('character') ? 'characters' : name.includes('location') ? 'locations' : name.includes('event_line') ? 'eventLines' : 'nodes'
  const detail = name.startsWith('get_')
  if (detail && args.include_facts && (scope.profile !== 'asset_editor' || scope.phase !== 'optimize')) throw new Error('INVALID_ARGS:事实底稿仅供世界资产整编读取。')
  if (detail) {
    let characterRelations: { people: Character[]; rows: CharacterRelation[]; view: ReturnType<typeof pairView>; unresolved: ReturnType<typeof relationView>['unresolved']; pairs: ReturnType<typeof effectivePairs> } | undefined
    if (table === 'characters') {
      const people = (await scopedRows(store, scope, 'characters')) as unknown as Character[]
      const lifecycle = (await scopedRows(store, scope, 'assetLifecycle')) as unknown as Lifecycle[]
      const rows = (await scopedRows(store, scope, 'characterRelations')) as unknown as CharacterRelation[]
      const edits = (await scopedRows(store, scope, 'characterRelationEdits')) as unknown as CharacterRelationEdit[]
      const normalized = people.map(normalizeCharacterNames)
      const synced = syncRelations(rows, normalized, lifecycle).relations
      const pairs = effectivePairs(synced, edits, normalized)
      const types = new Map(synced.map(relation => [relation.id, relation.relationType]))
      const view = pairView(pairs, normalized)
      view.edges = view.edges.map(edge => ({ ...edge, types: [...new Set(edge.relationIds.flatMap(id => types.get(id) ?? []))] }))
      characterRelations = { people: normalized, rows: synced, view, unresolved: relationView(synced, normalized).unresolved, pairs }
    }
    const rows: Row[] = []; const missing: string[] = []
    for (const id of strings(args.ids)) {
      const found = await resolveAsset(store, scope, table, id)
      if (!found) { missing.push(id); continue }
      const row: Row = table === 'characters' ? normalizeCharacterNames({ ...found, name: text(found.name), aliases: strings(found.aliases), identity: text(found.identity) }) : { ...found }
      if (!args.include_facts) for (const key of ['mergeFacts', 'optimizedFactIds', 'optimizationFingerprint']) delete row[key]
      if (characterRelations && characterRelations.people.some(person => person.id === row.id)) {
        const projection = projectRelations(characterRelations.view.edges, characterRelations.rows, characterRelations.unresolved, text(row.id), characterRelations.people)
        row.relations = projection.relations
        row.relationEdges = edgesFor(characterRelations.view.edges, text(row.id))
        row.unresolvedRelations = projection.unresolvedRelations
        row.legacyRelationIds = [...new Set(characterRelations.pairs.filter(pair => pair.fromId === row.id || pair.toId === row.id).flatMap(pair => pair.legacyRecordIds))]
      }
      if (table === 'nodes') row.characterReferences = await references(store, scope, [...strings(row.actors), ...strings(row.targets)], [...strings(row.actorIds), ...strings(row.targetCharacterIds)])
      if (table === 'eventLines') {
        const nodes = (await scopedRows(store, scope, 'nodes')).filter(node => strings(row.nodeIds).includes(text(node.id)))
        row.characterIds = [...new Set(nodes.flatMap(node => [...strings(node.actorIds), ...strings(node.targetCharacterIds)]))]
        row.characterReferences = await references(store, scope, nodes.flatMap(node => [...strings(node.actors), ...strings(node.targets)]), strings(row.characterIds))
      }
      const existing = rows.find(item => item.id === row.id)
      if (existing) existing.resolvedFrom = [...new Set([...strings(existing.resolvedFrom), ...strings(row.resolvedFrom)])]
      else rows.push(row)
    }
    return page(['get_node_detail', 'get_event_line_detail'].includes(name) ? detailFragments(rows, args) : rows, {}, maxResults, { missingIds: missing })
  }
  if (args.after_id !== undefined && args.offset !== undefined) throw new Error('INVALID_ARGS:稳定游标与页偏移请选用一种。')
  let rows = (await scopedRows(store, scope, table)).sort((a, b) => compare(text(a.id), text(b.id)))
  if (table === 'characters') rows = rows.map(row => normalizeCharacterNames({ ...row, name: text(row.name), aliases: strings(row.aliases), identity: text(row.identity) }))
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
  const projected = rows.map(row => table === 'characters' || table === 'locations' ? { id: row.id, name: row.name, aliases: strings(row.aliases), sourceChapters: strings(row.sourceChapters), revision: row.revision, [table === 'characters' ? 'identityHint' : 'descriptionHint']: text(table === 'characters' ? row.identity : row.description).slice(0, 160), estimatedDetailTokens: Math.ceil(JSON.stringify(row).length / 3), duplicateScore: Math.min(1, rows.filter(other => other.name === row.name && other.id !== row.id).length) } : table === 'nodes' ? { id: row.id, name: row.name, summary: text(row.summary).slice(0, 160), actors: strings(row.actors).slice(0, 8), chapterIndex: row.chapterIndex } : { id: row.id, title: row.title, chapters: row.chapters, lineStatus: row.lineStatus, nodeCount: strings(row.nodeIds).length, cause: text(row.cause).slice(0, 160), result: text(row.result).slice(0, 160) })
  return page(projected, args, maxResults, { cursor: table === 'characters' || table === 'locations' })
}

export const toolBytes = bytes
export function assertScope(scope: Scope, repositoryBookId: string) { if (scope.bookId !== repositoryBookId) throw new Error('SCOPE:执行范围与书籍不一致。') }
