import type { Book } from '../../lib/storage/workspace'
import { bindNodeCharacters } from '../assets/characterLinks'
import { migrateCharacterRelations, migrateNodeBindings } from '../assets/migrate'
import { resolveLifecycleId } from '../assets/relations'
import type { Character, CharacterRelation, EventNode, Lifecycle } from '../assets/types'
import { hasClearedEndpoints, repairRelationBindings } from '../assets/repair'

export const tableSchemas = {
  chapters: 'Chapter', chapterTexts: 'ChapterText', characters: 'StoredCharacter', locations: 'StoredLocation', nodes: 'StoredNode', eventLines: 'StoredEventLine', characterRelations: 'StoredRelation', characterRelationEdits: 'CharacterRelationEdit', compileProgress: 'CompileProgress', storyEditorMemory: 'StoryEditorMemory', storyEditorNotes: 'StoryEditorNote', storyEditorCheckpoints: 'StoryEditorCheckpoint', storySessions: 'StorySession', storySessionEntries: 'StorySessionEntry', extractionReceipts: 'ExtractionReceipt', assetLifecycle: 'AssetLifecycle', pipelineRuns: 'PipelineRun',
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
    const key = name === 'chapters' || name === 'chapterTexts' ? 'chapterIndex' : name === 'compileProgress' ? 'stage' : name === 'characterRelationEdits' ? 'pairKey' : name === 'extractionReceipts' || name === 'assetLifecycle' ? 'key' : 'id'
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
  for (const [index, relation] of tables.characterRelations.entries()) {
    const path = `characterRelations[${index}]`
    const origin = String(relation.originCharacterId)
    if (!characters.has(origin) && !lifecycle.has(`character:${origin}`)) fail(path, '原始来源人物不存在。')
    for (const id of strings(relation.targetIds)) if (!characters.has(id)) fail(`${path}/targetIds`, `目标人物不存在：${id}`)
    const resolved = resolveLifecycleId(origin, tables.assetLifecycle as unknown as Lifecycle[])
    if ((relation.sourceId ?? null) !== (resolved && characters.has(resolved) ? resolved : null)) fail(`${path}/sourceId`, '当前来源与原始来源的生命周期映射不一致。')
    for (const evidence of rows(relation.evidence)) if (typeof evidence.chapterIndex === 'string' && evidence.chapterIndex && !hasChapter(evidence.chapterIndex)) fail(`${path}/evidence`, '关系依据章节不存在。')
  }
  for (const [index, edit] of tables.characterRelationEdits.entries()) {
    const path = `characterRelationEdits[${index}]`
    let endpoints: string[] = []
    try { const value = JSON.parse(String(edit.pairKey)); if (Array.isArray(value) && value.length === 2) endpoints = value.map(String) } catch { /* 由下方统一报键格式错误 */ }
    if (endpoints.length !== 2 || endpoints[0] === endpoints[1] || [...endpoints].sort()[0] !== endpoints[0] || edit.pairKey !== JSON.stringify(endpoints)) fail(`${path}/pairKey`, '人物对键格式或排序不符。')
    if (endpoints[0] !== edit.aId || endpoints[1] !== edit.bId) fail(`${path}`, '人物对键与端点编号不一致。')
    for (const id of endpoints) if (!characters.has(id) && !lifecycle.has(`character:${id}`)) fail(`${path}`, `人物对端点既不存在也没有生命周期记录：${id}`)
    const forward = strings(edit.aToBLabels), reverse = strings(edit.bToALabels)
    if (edit.state !== 'active' && edit.state !== 'deleted') fail(`${path}/state`, '关系编辑状态无效。')
    if (edit.state === 'active' && !forward.length && !reverse.length) fail(`${path}`, '有效关系至少一个方向要有标签。')
    if (edit.state === 'deleted' && (forward.length || reverse.length)) fail(`${path}`, '已删除关系不能保留标签。')
    if (forward.length > 20 || reverse.length > 20 || [...forward, ...reverse].some(label => !label.trim() || label.length > 100)) fail(`${path}`, '关系标签数量或长度不符。')
    for (const evidence of rows(edit.evidence)) if (!hasChapter(evidence.chapterIndex)) fail(`${path}/evidence`, '关系编辑依据章节不存在。')
    if (!Number.isSafeInteger(edit.revision) || Number(edit.revision) < 1) fail(`${path}/revision`, '关系编辑修订号无效。')
    if (!['manual', 'agent'].includes(String(edit.updatedBy)) || !String(edit.commitId ?? '').trim()) fail(`${path}`, '关系编辑来源或确认号缺失。')
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
  let currentMechanicalQueues = 0
  const runIds = new Set(tables.pipelineRuns.map(row => row.id))
  for (const run of tables.pipelineRuns) if (run.mechanicalQueue) {
    const queue = run.mechanicalQueue as Row, items = rows(queue.items)
    if (run.stage !== 'P2' || run.phase !== 'mechanical_queue') fail(`pipelineRuns/${run.id}`, '机械合并队列的阶段或类型不符。')
    if (queue.current) currentMechanicalQueues++
    const ids = new Set<string>(), members = new Set<string>()
    for (const item of items) {
      const request = item.request as Row, selected = strings(request.memberIds), proofs = item.approvalFingerprints as Row, revisions = request.expectedRevisions as Row
      if (ids.has(String(item.id)) || !selected.includes(String(request.keepId)) || selected.length !== strings(item.memberNames).length || Object.keys(proofs).length !== selected.length || Object.keys(revisions).length !== selected.length || selected.some(id => !proofs[id] || !revisions[id])) fail(`pipelineRuns/${run.id}/mechanicalQueue`, '已确认组的成员、保留条目或确认依据不完整。')
      ids.add(String(item.id))
      if (item.status === 'completed' && !runIds.has(item.commitId)) fail(`pipelineRuns/${run.id}/mechanicalQueue`, '机械合并的提交记录不存在。')
      if (item.status !== 'completed') for (const id of selected) { const key = `${item.kind}:${id}`; if (members.has(key)) fail(`pipelineRuns/${run.id}/mechanicalQueue`, '待合并组包含重复成员。'); members.add(key) }
    }
  }
  if (currentMechanicalQueues > 1) fail('pipelineRuns/mechanicalQueue', '本书存在多个当前机械合并队列。')
  if (p1 && (p1.totalChapters !== chapters.size || [...strings(p1.completedChapters), ...strings(p1.failedChapters)].some(id => !chapters.has(id)))) fail('compileProgress/P1', '提取进度的章节数量或范围不符。')
  return errors
}

export function pauseBookData(data: BookData): BookData {
  const result = structuredClone(data)
  result.tables.pipelineRuns = result.tables.pipelineRuns.filter(row => row.recordType === 'run' || row.recordType === 'asset_edit')
  for (const name of ['storySessions', 'compileProgress', 'pipelineRuns'] as const) for (const row of result.tables[name]) {
    delete row.leaseOwner; delete row.leaseUntil; delete row.owner; delete row.expiresAt; delete row.lockKey
    if (row.status === 'running' || row.status === 'cancelling') row.status = 'paused'
    for (const task of rows(row.tasks)) if (['pending', 'running', 'prepared'].includes(task.status as string)) task.status = 'partial'
    for (const intent of rows(row.commandIntents)) if (intent.state === 'prepared') intent.state = 'abandoned'
    for (const item of rows((row.mechanicalQueue as Row | undefined)?.items)) if (item.status === 'running') item.status = 'pending'
  }
  return result
}

/** 先拒绝非法资料，仅放行能由原始编号证明的已知端点清空缺陷，再共用书库修复规则。 */
export async function repairValidatedBookData(data: BookData): Promise<BackupError[]> {
  const errors = await validateBookData(data)
  const unexpected = errors.filter(error => {
    const match = /^characterRelations\[(\d+)\]\/sourceId$/.exec(error.path)
    if (error.code !== 'REFERENCE' || !match) return true
    const relation = data.tables.characterRelations[Number(match[1])] as unknown as CharacterRelation
    return !hasClearedEndpoints(relation, data.tables.characters as unknown as Character[], data.tables.assetLifecycle as unknown as Lifecycle[])
  })
  if (unexpected.length) return errors
  const key = (table: string) => table === 'compileProgress' ? 'stage' : table === 'assetLifecycle' ? 'key' : 'id'
  await repairRelationBindings({
    rows: async table => data.tables[table as TableName],
    get: async (table, id) => data.tables[table as TableName].find(row => row[key(table)] === id),
    put: async (table, row) => {
      const values = data.tables[table as TableName], index = values.findIndex(prior => prior[key(table)] === row[key(table)])
      if (index < 0) values.push(row); else values[index] = row
    },
    remove: async (table, id) => { data.tables[table as TableName] = data.tables[table as TableName].filter(row => row[key(table)] !== id) },
  }, data.book.id)
  return validateBookData(data)
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
    return bindNodeCharacters({ ...row, legacyActorIds: actorIds, legacyTargetCharacterIds: targetIds } as unknown as EventNode, characters) as unknown as Row
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

/** 格式4、5读入后的关系结构转换；格式6本身已包含关系表和绑定来源。 */
export function migrateRelationsData(data: BookData): BookData {
  const characters = data.tables.characters as unknown as Character[]
  const lifecycle = data.tables.assetLifecycle as unknown as Lifecycle[]
  const timestamp = new Date().toISOString()
  const relations = migrateCharacterRelations(characters.map(person => ({ ...person, relations: Array.isArray(person.relations) ? person.relations : [] })), lifecycle, timestamp)
  const existing = new Set(data.tables.characterRelations.map(row => row.id))
  data.tables.characterRelations.push(...relations.filter(row => !existing.has(row.id)) as unknown as Row[])
  for (const person of characters) delete person.relations
  const before = data.tables.nodes
  data.tables.nodes = migrateNodeBindings(before as unknown as EventNode[], characters).map((node, index) => JSON.stringify(node) === JSON.stringify(before[index]) ? before[index] : { ...node, revision: Number(before[index].revision ?? 1) + 1 })
  return data
}
