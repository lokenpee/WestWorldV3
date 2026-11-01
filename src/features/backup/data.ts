import type { Book } from '../../lib/storage/workspace'
import { bindNodeCharacters } from '../assets/characterLinks'
import type { Character, EventNode } from '../assets/types'

export const tableSchemas = {
  chapters: 'Chapter', chapterTexts: 'ChapterText', characters: 'StoredCharacter', locations: 'StoredLocation', nodes: 'StoredNode', eventLines: 'StoredEventLine', compileProgress: 'CompileProgress', storyEditorMemory: 'StoryEditorMemory', storyEditorNotes: 'StoryEditorNote', storyEditorCheckpoints: 'StoryEditorCheckpoint', storySessions: 'StorySession', storySessionEntries: 'StorySessionEntry', extractionReceipts: 'ExtractionReceipt', assetLifecycle: 'AssetLifecycle', pipelineRuns: 'PipelineRun',
} as const
export type TableName = keyof typeof tableSchemas
export type Row = Record<string, unknown>
export type BookTables = Record<TableName, Row[]>
export interface BookData { book: Book; tables: BookTables }
export interface BackupError { code: string; path: string; message: string }
export const tableNames = Object.keys(tableSchemas) as TableName[]
async function loadValidation() {
  const [{ Value }, { default: schemaText }] = await Promise.all([import('typebox/value'), import('../../../docs/v2/resources/v2.2/storage.schema.json?raw')])
  return { Value, schema: JSON.parse(schemaText) }
}
let validation: ReturnType<typeof loadValidation> | undefined
export const emptyTables = (): BookTables => Object.fromEntries(tableNames.map(name => [name, [] as Row[]])) as BookTables
export const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
export const rows = (value: unknown): Row[] => Array.isArray(value) ? value as Row[] : []
export const chapterFileName = (index: string) => `chapters/${index.split('.').map(part => part.padStart(4, '0')).join('.')}.txt`

export async function validateBookData(data: BookData): Promise<BackupError[]> {
  const { Value, schema } = await (validation ??= loadValidation())
  const errors: BackupError[] = []
  const fail = (path: string, message: string, code = 'REFERENCE') => errors.push({ code, path, message })
  for (const [name, values] of [['book', [data.book]], ...tableNames.map(name => [name, data.tables[name]])] as [string, unknown[]][]) {
    if (!Array.isArray(values)) { fail(name, '数据须为列表。', 'SCHEMA'); continue }
    const ref = name === 'book' ? 'Book' : tableSchemas[name as TableName]
    for (const [index, row] of values.entries()) {
      for (const error of [...Value.Errors({ ...schema, $ref: `#/$defs/${ref}` }, row)].slice(0, 5)) fail(`${name}[${index}]${error.instancePath}`, `数据结构不符：${error.message}`, 'SCHEMA')
    }
  }
  if (errors.length) return errors
  const { book, tables } = data
  if (!book.id.trim() || !book.title.trim()) fail('book', '书籍编号和名称须有内容。', 'SCHEMA')
  for (const name of tableNames) {
    const key = name === 'chapters' || name === 'chapterTexts' ? 'chapterIndex' : name === 'compileProgress' ? 'stage' : name === 'extractionReceipts' || name === 'assetLifecycle' ? 'key' : 'id'
    const keys = new Set<unknown>()
    for (const [index, row] of tables[name].entries()) {
      if (row.bookId !== book.id) fail(`${name}[${index}].bookId`, '记录归属与书籍编号不一致。')
      if (typeof row[key] !== 'string' || !(row[key] as string).trim() || keys.has(row[key])) fail(`${name}[${index}].${key}`, '编号为空或重复。', 'DUPLICATE')
      keys.add(row[key])
    }
  }
  const chapters = new Map(tables.chapters.map(row => [row.chapterIndex, row]))
  const texts = new Map(tables.chapterTexts.map(row => [row.chapterIndex, row]))
  if (!chapters.size || chapters.size !== texts.size) fail('chapters', '章节与正文数量须相同且至少有一章。')
  const orders = new Set(tables.chapters.map(row => row.order))
  for (const [index, chapter] of tables.chapters.entries()) {
    const text = texts.get(chapter.chapterIndex)?.text
    if (typeof text === 'string' && /[\uD800-\uDFFF]/u.test(text)) fail(`chapterTexts/${chapter.chapterIndex}`, '章节正文含不完整字符，请核对原文后重新导入。', 'SCHEMA')
    if (!/^\d+(?:\.\d+)*$/.test(chapter.chapterIndex as string) || !orders.has(index) || typeof text !== 'string' || !text.length || text.length > 10000 || text.length !== chapter.charCount) fail(`chapters[${index}]`, '章节顺序、编号或正文字符数不符。')
  }
  const hasChapter = (value: unknown) => chapters.has(value) || [...chapters.keys()].some(key => (key as string).startsWith(`${value}.`))
  for (const name of ['characters', 'locations', 'nodes'] as const) for (const row of tables[name]) {
    if (row.chapterIndex !== undefined && !hasChapter(row.chapterIndex)) fail(`${name}/${row.id}`, '来源章节不存在。')
    for (const chapter of strings(row.sourceChapters)) if (!hasChapter(chapter)) fail(`${name}/${row.id}`, '来源章集合包含不存在的章节。')
  }
  const characters = new Set(tables.characters.map(row => row.id))
  const nodes = new Map(tables.nodes.map(row => [row.id, row]))
  const lines = new Map(tables.eventLines.map(row => [row.id, row]))
  for (const node of tables.nodes) {
    for (const id of [...strings(node.actorIds), ...strings(node.targetCharacterIds)]) if (!characters.has(id)) fail(`nodes/${node.id}`, `人物关联不存在：${id}`)
    for (const id of strings(node.eventLineIds)) if (!strings(lines.get(id)?.nodeIds).includes(node.id as string)) fail(`nodes/${node.id}`, `事件线反向关联不符：${id}`)
  }
  for (const line of tables.eventLines) {
    if (!strings(line.nodeIds).length) fail(`eventLines/${line.id}`, '事件线须包含节点。')
    for (const id of strings(line.nodeIds)) if (!nodes.has(id) || !strings(nodes.get(id)?.eventLineIds).includes(line.id as string)) fail(`eventLines/${line.id}`, `成员节点不存在或反向关联不符：${id}`)
    for (const chapter of strings(line.chapters)) if (!hasChapter(chapter)) fail(`eventLines/${line.id}`, `事件线章节不存在：${chapter}`)
  }
  for (const receipt of tables.extractionReceipts) if (!chapters.has(receipt.chapterIndex) || receipt.key !== `${receipt.chapterIndex}:${receipt.substep}`) fail(`extractionReceipts/${receipt.key}`, '凭证章节、子步骤或编号不符。')
  const kinds: Record<string, TableName> = { character: 'characters', location: 'locations', node: 'nodes', eventLine: 'eventLines' }
  const lifecycle = new Map(tables.assetLifecycle.map(row => [row.key, row]))
  for (const mapping of tables.assetLifecycle) {
    if (mapping.key !== `${mapping.kind}:${mapping.originId}`) fail(`assetLifecycle/${mapping.key}`, '来源映射编号不符。')
    const visited = new Set<unknown>()
    let current: Row | undefined = mapping
    while (current && current.state !== 'deleted') {
      if (visited.has(current.key)) { fail(`assetLifecycle/${mapping.key}`, '来源映射存在循环。'); break }
      visited.add(current.key)
      const id = current.currentId ?? current.originId
      const next = lifecycle.get(`${mapping.kind}:${id}`)
      if (next && next !== current && next.state !== 'live') { current = next; continue }
      if (tables[kinds[mapping.kind as string]].some(row => row.id === id)) break
      current = next
      if (!current) fail(`assetLifecycle/${mapping.key}`, '来源映射目标不存在。')
    }
  }
  const sessions = new Map(tables.storySessions.map(row => [row.id, row]))
  const entries = new Map(tables.storySessionEntries.map(row => [row.id, row]))
  for (const session of tables.storySessions) {
    const ordinals = new Set<unknown>()
    const members = tables.storySessionEntries.filter(row => row.sessionId === session.id)
    for (const entry of members) { if (ordinals.has(entry.ordinal)) fail(`storySessions/${session.id}`, '会话条目顺序重复。'); ordinals.add(entry.ordinal) }
    if (session.nextOrdinal !== members.reduce((max, row) => Math.max(max, Number(row.ordinal) + 1), 0)) fail(`storySessions/${session.id}`, '下一条目序号不符。')
    if (session.leafId && entries.get(session.leafId)?.sessionId !== session.id) fail(`storySessions/${session.id}`, '当前会话末端不存在。')
    const visited = new Set<unknown>([session.id])
    let parent = session.parentSessionId
    while (parent) { if (visited.has(parent) || !sessions.has(parent)) { fail(`storySessions/${session.id}`, '父会话不存在或形成循环。'); break }; visited.add(parent); parent = sessions.get(parent)?.parentSessionId }
  }
  for (const entry of tables.storySessionEntries) if (!sessions.has(entry.sessionId) || (entry.parentId !== null && (entries.get(entry.parentId)?.sessionId !== entry.sessionId || Number(entries.get(entry.parentId)?.ordinal) >= Number(entry.ordinal)))) fail(`storySessionEntries/${entry.id}`, '会话归属或父条目链不符。')
  for (const name of ['storyEditorMemory', 'storyEditorNotes', 'storyEditorCheckpoints', 'compileProgress'] as const) for (const row of tables[name]) if ((row.sessionId !== undefined && !sessions.has(row.sessionId)) || (row.editorSessionId !== undefined && !sessions.has(row.editorSessionId))) fail(`${name}/${row.id ?? row.stage}`, '引用的会话不存在。')
  const p1 = tables.compileProgress.find(row => row.stage === 'P1')
  if (p1 && (p1.totalChapters !== chapters.size || [...strings(p1.completedChapters), ...strings(p1.failedChapters)].some(id => !chapters.has(id)))) fail('compileProgress/P1', '提取进度的章节数量或范围不符。')
  return errors
}

export function pauseBookData(data: BookData): BookData {
  const result = structuredClone(data)
  result.tables.pipelineRuns = result.tables.pipelineRuns.filter(row => row.recordType === 'run')
  for (const name of ['storySessions', 'compileProgress', 'pipelineRuns'] as const) for (const row of result.tables[name]) {
    delete row.leaseOwner; delete row.leaseUntil; delete row.owner; delete row.expiresAt; delete row.lockKey
    if (row.status === 'running' || row.status === 'cancelling') row.status = 'paused'
    for (const task of rows(row.tasks)) if (['pending', 'running', 'prepared'].includes(task.status as string)) task.status = 'partial'
    for (const intent of rows(row.commandIntents)) if (intent.state === 'prepared') intent.state = 'abandoned'
  }
  return result
}

export function migrateLegacy(data: BookData, legacy: Record<string, unknown>): BookData {
  for (const [target, old] of [['characters', 'characterSnapshots'], ['locations', 'locationSnapshots']] as const) {
    if (Object.hasOwn(legacy, old)) {
      if (!Array.isArray(legacy[old])) throw new Error(`data/${old}.json 须为列表。`)
      data.tables[target] = rows(legacy[old])
    }
    for (const row of data.tables[target]) {
      row.revision ??= 1; row.createdBy ??= 'P1'
      if (row.speech_style_sample !== undefined) { row.speechStyleSample = row.speech_style_sample; delete row.speech_style_sample }
    }
  }
  data.tables.nodes = data.tables.nodes.map(row => {
    row.revision ??= 1
    const characters = data.tables.characters as unknown as Character[]
    const actorIds = strings(row.actorIds).filter(id => characters.some(person => person.id === id))
    const targetIds = strings(row.targetCharacterIds).filter(id => characters.some(person => person.id === id))
    return bindNodeCharacters(row as unknown as EventNode, characters, actorIds, targetIds) as unknown as Row
  })
  for (const line of data.tables.eventLines) { line.revision ??= 1; line.createdBy ??= 'P3'; delete line.characterIds }
  const timestamp = new Date().toISOString()
  for (const [kind, name] of Object.entries({ character: 'characters', location: 'locations', node: 'nodes', eventLine: 'eventLines' })) for (const row of data.tables[name as TableName]) data.tables.assetLifecycle.push({ key: `${kind}:${row.id}`, bookId: data.book.id, kind, originId: row.id, currentId: row.id, state: 'live', revision: 1, updatedAt: timestamp })
  for (const progress of data.tables.compileProgress) {
    if (progress.stage === 'P1') { progress.completedChapters = []; progress.status = 'idle' }
    else progress.validity = 'stale'
    progress.planVersion = '2.2'
  }
  return pauseBookData(data)
}
