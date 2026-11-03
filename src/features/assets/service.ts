import type { createWorkspace } from '../../lib/storage/workspace'
import { assetTables, AssetError, roleWeights, type Asset, type AssetByKind, type AssetInput, type AssetKind, type AssetSnapshot, type Character, type CharacterRelation, type EventLine, type EventNode, type Lifecycle, type LocationAsset } from './types'
import { rebuildFacts, resolveReferences, updateFrequencies } from './derive'
import { bindNodeCharacters, nodeParticipants, remapCharacterLinks, setNodeParticipants } from './characterLinks'
import { normalizeCharacterNames } from './characterNames'
import { detailTokens, fuseWorldAssets, validateMergeOptions, type ManualMergeRun, type MergeOptions, type MergePreview, type MergeRequest, type WorldKind, type MechanicalMergeContext } from './merge'
import { dexieMergeStore, mergeWorldAssets } from './mergeCore'
import { edgesFor, projectRelations, relationView, syncRelations } from './relations'
import type { WorldRun } from '../world/types'

type Workspace = ReturnType<typeof createWorkspace>
type Database = ReturnType<Workspace['openBook']>
interface Lease { id: string; bookId: string; recordType?: string; lockKey?: string; resource?: string }
const worldKinds = new Set<AssetKind>(['character', 'location'])
const listFields = new Set(['aliases', 'actors', 'targets', 'actorIds', 'targetCharacterIds', 'participantIds', 'unlinkedParticipants', 'world_delta', 'new_facts', 'started_actions', 'nodeIds'])
const allowed: Record<AssetKind, string[]> = {
  character: ['name', 'aliases', 'chapterIndex', 'manualSourceNote', 'identity', 'ageText', 'appearance', 'personality', 'background', 'speechStyleSample', 'roleWeight'],
  location: ['name', 'aliases', 'chapterIndex', 'manualSourceNote', 'description'],
  node: ['name', 'summary', 'chapterIndex', 'quote', 'process', 'actors', 'targets', 'actorIds', 'targetCharacterIds', 'participantIds', 'unlinkedParticipants', 'time_text', 'time_hint', 'world_delta', 'new_facts', 'started_actions'],
  eventLine: ['title', 'nodeIds', 'cause', 'process', 'result', 'lineStatus'],
}
const fail = (field: keyof AssetInput, message: string): never => { throw new AssetError('VALIDATION', message, field) }
const unique = (values: string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))]

function validateInput(kind: AssetKind, input: AssetInput) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AssetError('VALIDATION', '请提供有效的资产内容。')
  for (const [key, value] of Object.entries(input)) {
    if (!allowed[kind].includes(key)) throw new AssetError('VALIDATION', '包含不可编辑的字段。')
    if (listFields.has(key)) { if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new AssetError('VALIDATION', '列表内容格式不正确。') }
    else if (typeof value !== 'string') throw new AssetError('VALIDATION', '输入内容格式不正确。')
  }
  if (input.roleWeight !== undefined && !roleWeights.includes(input.roleWeight)) fail('roleWeight', '请选择有效的人物层级。')
  if (input.lineStatus !== undefined && !['open', 'closed'].includes(input.lineStatus)) fail('lineStatus', '请选择有效的事件线状态。')
}

function lockState(leases: Lease[], bookId: string) {
  const has = (domain: string) => leases.some(lease => lease.recordType === 'lease' && lease.bookId === bookId && (lease.resource === domain || lease.lockKey === domain || lease.id === `lease:${domain}` || lease.lockKey?.endsWith(`:${domain}`)))
  return { world: has('world'), narrative: has('narrative') }
}

async function writeChanged<T extends Asset>(db: Database, table: string, before: T[], after: T[]) {
  const previous = new Map(before.map(row => [row.id, row]))
  const changed: T[] = []
  for (const row of after) {
    const old = previous.get(row.id)
    if (JSON.stringify(old) !== JSON.stringify(row)) {
      const next = { ...row, revision: old ? old.revision + 1 : 1 }
      changed.push(next)
    }
    previous.delete(row.id)
  }
  if (changed.length) await db.table<T>(table).bulkPut(changed)
  if (previous.size) await db.table(table).bulkDelete([...previous.keys()])
  return changed
}

async function markDeleted(db: Database, bookId: string, kind: AssetKind, id: string, timestamp: string) {
  const mappings = await db.table<Lifecycle>('assetLifecycle').toArray()
  const targets = mappings.filter(row => row.kind === kind && (row.originId === id || row.currentId === id))
  if (!targets.some(row => row.originId === id)) targets.push({ key: `${kind}:${id}`, bookId, kind, originId: id, state: 'live', revision: 0, updatedAt: timestamp })
  for (const row of targets) {
    const next = { ...row, state: 'deleted' as const, revision: row.revision + 1, updatedAt: timestamp }
    delete next.currentId
    await db.table('assetLifecycle').put(next)
  }
}

async function synchronizeNarrative(db: Database, bookId: string, beforeNodes: EventNode[], nodes: EventNode[], beforeLines: EventLine[], lines: EventLine[], timestamp: string) {
  const chapters = await db.chapters.orderBy('order').toArray()
  const chapterOrder = new Map(chapters.map(chapter => [chapter.chapterIndex, chapter.order]))
  for (const chapter of chapters) {
    const group = nodes.filter(node => node.chapterIndex === chapter.chapterIndex).sort((a, b) => (a.offset ?? Infinity) - (b.offset ?? Infinity) || a.order - b.order || a.id.localeCompare(b.id))
    group.forEach((node, order) => { node.order = order })
  }
  const nodeById = new Map(nodes.map(node => [node.id, node]))
  const surviving: EventLine[] = []
  for (const line of lines) {
    const members = unique(line.nodeIds).map(id => nodeById.get(id)).filter((node): node is EventNode => !!node)
      .sort((a, b) => (chapterOrder.get(a.chapterIndex) ?? 0) - (chapterOrder.get(b.chapterIndex) ?? 0) || a.order - b.order || a.id.localeCompare(b.id))
    if (!members.length) { await markDeleted(db, bookId, 'eventLine', line.id, timestamp); continue }
    const updated = { ...line, nodeIds: members.map(node => node.id), chapters: [...new Set(members.map(node => node.chapterIndex))] }
    const times = members.map(node => node.timeCoord).filter((time): time is string => !!time).sort()
    if (times.length) updated.timeRange = [times[0], times[times.length - 1]]
    else delete updated.timeRange
    if (JSON.stringify(updated) !== JSON.stringify(beforeLines.find(row => row.id === line.id))) updated.updatedAt = timestamp
    surviving.push(updated)
  }
  for (const node of nodes) node.eventLineIds = surviving.filter(line => line.nodeIds.includes(node.id)).map(line => line.id).sort()
  await writeChanged(db, 'nodes', beforeNodes, nodes)
  await writeChanged(db, 'eventLines', beforeLines, surviving)
}

async function invalidateProgressBatch(db: Database, changes: { kind: AssetKind; id: string }[], timestamp: string) {
  interface Coverage { kind: string; id: string; status: string; invalidations: number; updatedAt: string; dependencies?: { records: { table: string; id: string; resolvedId: string | null }[] } }
  interface Run { id: string; recordType: string; stage?: string; coverageItems?: Coverage[] }
  const runs = await db.table<Run>('pipelineRuns').where('stage').anyOf(['P2', 'P3']).toArray()
  const own = new Set(changes.map(change => `${change.kind}:${change.id}`))
  const dependencies = new Set(changes.map(change => `${assetTables[change.kind]}:${change.id}`))
  const affected = new Set<string>(changes.map(change => worldKinds.has(change.kind) ? 'P2' : 'P3'))
  for (const run of runs.filter(row => row.recordType === 'run' && row.coverageItems)) {
    let dirty = false
    const coverageItems = run.coverageItems!.map(item => {
      const hit = own.has(`${item.kind}:${item.id}`) || item.dependencies?.records.some(record => dependencies.has(`${record.table}:${record.id}`) || dependencies.has(`${record.table}:${record.resolvedId}`))
      if (!hit || item.status === 'pending' || item.status === 'stale') return item
      dirty = true
      return { ...item, status: 'stale', invalidations: item.invalidations + 1, updatedAt: timestamp }
    })
    if (dirty) { await db.table('pipelineRuns').put({ ...run, coverageItems }); if (run.stage) affected.add(run.stage) }
  }
  for (const stage of affected) if (await db.table('compileProgress').get(stage)) await db.table('compileProgress').update(stage, { validity: 'stale', updatedAt: timestamp })
}
const invalidateProgress = (db: Database, kind: AssetKind, id: string, timestamp: string) => invalidateProgressBatch(db, [{ kind, id }], timestamp)

export function createAssetService(workspace: Workspace) {
  async function database(bookId: string) {
    if (!await workspace.settings.books.get(bookId)) throw new AssetError('NOT_FOUND', '书籍不存在，请重新选择。')
    const db = workspace.openBook(bookId); await db.open(); return db
  }

  async function mergeMembers<K extends WorldKind>(db: Database, bookId: string, kind: K, options: MergeOptions, expected?: Record<string, number>, queued?: MechanicalMergeContext): Promise<AssetByKind[K][]> {
    validateMergeOptions(kind, options)
    const leases = await db.table<Lease & { owner?: string; runId?: string; expiresAt?: number }>('pipelineRuns').where('recordType').equals('lease').toArray()
    if (queued) {
      const lease = leases.find(row => row.id === 'lease:world')
      if (lease?.owner !== queued.owner || lease.runId !== queued.runId || leases.some(row => row.lockKey === 'extraction' && (row.expiresAt === undefined || row.expiresAt > Date.now()))) throw new AssetError('ASSET_DOMAIN_LOCKED', '机械合并队列的执行权已变化。')
      const run = await db.table<WorldRun>('pipelineRuns').get(queued.runId)
      const item = run?.mechanicalQueue?.items.find(item => item.id === queued.itemId)
      if (run?.bookId !== bookId || run.phase !== 'mechanical_queue' || item?.status !== 'running' || item.kind !== kind || item.request.keepId !== options.keepId || item.request.canonicalName !== options.canonicalName || item.request.memberIds.length !== options.memberIds.length || item.request.memberIds.some(id => !options.memberIds.includes(id) || item.request.expectedRevisions[id] !== expected?.[id])) throw new AssetError('ASSET_DOMAIN_LOCKED', '本组不属于当前已确认的机械合并队列。')
      if ((queued.automatic ?? false) !== (item.confirmation === 'exact_name' && !item.manualSelection)) throw new AssetError('ASSET_DOMAIN_LOCKED', '机械合并的确认来源已变化。')
      await db.table('pipelineRuns').update('lease:world', { expiresAt: Date.now() + 30000 })
    } else if (lockState(leases, bookId).world) throw new AssetError('ASSET_DOMAIN_LOCKED', '世界资产正在处理，请等待任务结束后合并。')
    if (expected && (Object.keys(expected).length !== options.memberIds.length || options.memberIds.some(id => !Number.isSafeInteger(expected[id]) || expected[id] < 1))) throw new AssetError('VALIDATION', '合并预览的修订信息不完整，请重新预览。')
    const rows = await db.table<AssetByKind[K]>(assetTables[kind]).bulkGet(options.memberIds)
    if (rows.some(row => !row || row.bookId !== bookId || (expected && row.revision !== expected[row.id]))) throw new AssetError('CONFLICT', '所选资料已变化或删除，请刷新合并预览。')
    const lifecycle = await db.table<Lifecycle>('assetLifecycle').bulkGet(options.memberIds.map(id => `${kind}:${id}`))
    if (lifecycle.some(row => row && (row.state === 'deleted' || row.currentId !== row.originId))) throw new AssetError('CONFLICT', '所选条目的来源映射已变化，请重新选择当前条目。')
    return rows as AssetByKind[K][]
  }

  async function previewMerge<K extends WorldKind>(bookId: string, kind: K, options: MergeOptions): Promise<MergePreview<K>> {
    const db = await database(bookId)
    return db.transaction('r', db.tables, async () => {
      const members = await mergeMembers(db, bookId, kind, options)
      const request: MergeRequest = { memberIds: [...options.memberIds], keepId: options.keepId, canonicalName: options.canonicalName.trim(), expectedRevisions: Object.fromEntries(members.map(row => [row.id, row.revision])) }
      return { kind, members, request, ...fuseWorldAssets(kind, members, request.keepId, request.canonicalName) }
    })
  }

  async function confirmMerge<K extends WorldKind>(bookId: string, kind: K, request: MergeRequest, mode?: 'mechanical' | MechanicalMergeContext) {
    if (!request?.expectedRevisions || typeof request.expectedRevisions !== 'object' || Array.isArray(request.expectedRevisions)) throw new AssetError('VALIDATION', '请先查看合并预览。')
    const db = await database(bookId)
    return db.transaction('rw', db.tables, async () => {
      const queued = typeof mode === 'object' ? mode : undefined
      const members = await mergeMembers(db, bookId, kind, request, request.expectedRevisions, queued)
      const timestamp = new Date().toISOString()
      const beforeCounts = { characters: await db.table('characters').count(), locations: await db.table('locations').count() }
      const texts = queued ? undefined : await db.table<{ chapterIndex: string; text: string }>('chapterTexts').toArray()
      const automatic = queued?.automatic === true
      const merged = await mergeWorldAssets(dexieMergeStore(db), {
        bookId, kind, memberIds: request.memberIds, keepId: request.keepId, canonicalName: request.canonicalName, timestamp,
        nameSource: automatic && !members.some(row => row.nameSource === 'manual') ? 'automatic' : 'manual',
        manualKeep: automatic ? members.some(row => row.manualKeep === true) : true,
        expectedRevisions: request.expectedRevisions,
        ...(texts ? { frequencyTexts: texts } : {}),
      })
      const invalidations: { kind: AssetKind; id: string }[] = [...request.memberIds.map(id => ({ kind, id })), ...merged.changedNodeIds.map(id => ({ kind: 'node' as const, id })), ...merged.changedCharacterIds.map(id => ({ kind: 'character' as const, id }))]
      await invalidateProgressBatch(db, invalidations, timestamp)
      const table = db.table<AssetByKind[K]>(assetTables[kind])
      const saved = (await table.get(request.keepId))!
      const run: ManualMergeRun = {
        id: crypto.randomUUID(), recordType: 'run', bookId, stage: 'manual_merge', status: 'completed', startedAt: timestamp, finishedAt: timestamp, planVersion: '2.2',
        report: { beforeCounts, afterCounts: { characters: await db.table('characters').count(), locations: await db.table('locations').count() },
          groups: [{ method: 'manual', kind, memberIds: members.map(row => row.id), memberNames: members.map(row => row.name), keepId: saved.id, canonicalName: saved.name, aliases: saved.aliases ?? [], sourceChapters: saved.sourceChapters ?? [], conflicts: merged.conflicts, beforeTokens: members.reduce((sum, row) => sum + detailTokens(row), 0), afterTokens: detailTokens(saved) }],
          optimizedIds: [], skipped: [], failed: [], conflicted: [], status: 'completed', cost: 0, usage: { input: 0, output: 0, totalTokens: 0, cost: 0 }, externalChanges: [] },
      }
      await db.table('pipelineRuns').add({ ...run, contractRevision: '2026-10-24', tasks: [], commandIntents: [], coverageItems: [], appliedCommands: [], nextTaskOrdinal: 0, reconciliationPass: 0, noProgressTasks: 0 })
      let reportId: string | undefined
      if (queued) {
        const queueRun = (await db.table<WorldRun>('pipelineRuns').get(queued.runId))!
        const queue = queueRun.mechanicalQueue!
        await db.table('pipelineRuns').put({ ...queueRun, mechanicalQueue: { ...queue, statisticsPending: true, items: queue.items.map(item => item.id === queued.itemId ? { ...item, status: 'completed', commitId: run.id } : item) }, report: { ...queueRun.report, afterCounts: run.report.afterCounts, groups: [...queueRun.report.groups, ...run.report.groups.map(group => ({ ...group, method: 'mechanical' as const }))] } })
        reportId = queueRun.id
      }
      if (mode === 'mechanical') {
        const chapters = await db.chapters.toArray(); const receipts = await db.table('extractionReceipts').toArray()
        if (!chapters.length || chapters.some(chapter => ['worldAssets', 'narrativeAssets'].some(step => !receipts.some(receipt => receipt.key === `${chapter.chapterIndex}:${step}`)))) throw new AssetError('VALIDATION', '请先完成全书逐章提取。')
        reportId = crypto.randomUUID()
        await db.table('pipelineRuns').add({ ...run, id: reportId, stage: 'P2', phase: 'mechanical', report: { ...run.report, groups: run.report.groups.map(group => ({ ...group, method: 'mechanical' })) } })
      }
      return { asset: saved, run, reportId }
    })
  }

  async function build(db: Database, bookId: string, kind: AssetKind, input: AssetInput, old?: Asset): Promise<Asset> {
    const id = old?.id ?? `U-${crypto.randomUUID()}`
    const base = { id, bookId, revision: old?.revision ?? 1, createdBy: old?.createdBy ?? 'manual' as const }
    if (kind === 'character' || kind === 'location') {
      const previous = old as Character | LocationAsset | undefined
      const name = (input.name ?? previous?.name ?? '').trim() || fail('name', '名称不能为空。')
      const chapterIndex = previous?.chapterIndex ?? input.chapterIndex?.trim()
      if (previous && input.chapterIndex !== undefined && input.chapterIndex !== (previous.chapterIndex ?? '')) fail('chapterIndex', '来源章节保持首次记录。')
      const chapter = chapterIndex ? await db.chapters.get(chapterIndex) : undefined
      if (chapterIndex && (!chapter || chapter.bookId !== bookId)) fail('chapterIndex', '请选择本书的有效章节。')
      const manualSourceNote = (input.manualSourceNote ?? previous?.manualSourceNote ?? '').trim()
      if (!chapter && !previous?.sourceChapters?.length && !manualSourceNote) fail('manualSourceNote', '没有来源章节时，请填写来源说明。')
      const nameSource = previous ? (input.name !== undefined && name !== previous.name ? 'manual' : previous.nameSource ?? 'extracted') : 'manual'
      const row: Character | LocationAsset = { ...previous, ...base, name, confidence: previous?.confidence ?? 0.5, aliases: unique(input.aliases ?? previous?.aliases ?? []).filter(alias => alias !== name), updatedAt: new Date().toISOString(), nameSource, manualKeep: previous?.manualKeep ?? false, sourceChapters: previous?.sourceChapters ?? (chapterIndex ? [chapterIndex] : []), manualSourceNote }
      if (chapter) { row.chapterIndex = chapter.chapterIndex; row.chapterName = chapter.chapterName }
      const facts: Record<string, string> = {}
      const textFields = kind === 'character' ? ['identity', 'appearance', 'personality', 'background', 'speechStyleSample'] as const : ['description'] as const
      for (const field of textFields) if (input[field] !== undefined) {
        const value = input[field]!
        if (field !== 'speechStyleSample' && value !== (previous as unknown as Record<string, unknown> | undefined)?.[field]) facts[field] = value
        Object.assign(row, { [field]: value })
      }
      if (kind === 'character') {
        const character = row as Character
        Object.assign(character, normalizeCharacterNames(character))
        if (character.identity !== (previous as Character | undefined)?.identity && character.identity !== undefined) facts.identity = character.identity
        if (input.ageText !== undefined) character.profile = { ...(previous as Character | undefined)?.profile, ageText: input.ageText }
        if (input.roleWeight !== undefined) { character.roleWeight = input.roleWeight; character.roleWeightSource = 'manual' }
      }
      if (row.mergeFacts && Object.keys(facts).length) {
        row.mergeFacts = rebuildFacts(row.mergeFacts, facts, row.sourceChapters ?? [])
        row.optimizedFactIds = (row.optimizedFactIds ?? []).filter(factId => row.mergeFacts!.some(fact => fact.id === factId))
        delete row.optimizationFingerprint
      }
      const previousAliases = previous ? (kind === 'character' ? normalizeCharacterNames(previous).aliases : previous.aliases) ?? [] : []
      const aliasesChanged = input.aliases !== undefined && (!previous || JSON.stringify([...(row.aliases ?? [])].sort()) !== JSON.stringify([...previousAliases].sort()))
      row.verifiedAliases = (aliasesChanged ? row.aliases ?? [] : row.verifiedAliases ?? []).filter(alias => (row.aliases ?? []).includes(alias) && alias !== row.name)
      return row
    }
    if (kind === 'node') {
      const previous = old as EventNode | undefined
      const chapterIndex = input.chapterIndex ?? previous?.chapterIndex ?? ''
      const chapter = await db.chapters.get(chapterIndex)
      if (!chapter || chapter.bookId !== bookId) fail('chapterIndex', '请选择本书的有效章节。')
      const source = await db.table<{ text: string; bookId: string }>('chapterTexts').get(chapterIndex)
      if (!source) throw new AssetError('SOURCE_MISSING', '所选章节正文缺失，无法校验引文。', 'quote')
      if (source.bookId !== bookId) fail('quote', '引文来源不属于当前书籍。')
      const characters = await db.table<Character>('characters').toArray()
      const bound = previous && previous.actorIds === undefined ? bindNodeCharacters(previous, characters) : previous
      const name = (input.name ?? bound?.name ?? '').trim() || fail('name', '节点名称不能为空。')
      const summary = (input.summary ?? bound?.summary ?? '').trim() || fail('summary', '概述不能为空。')
      const quote = input.quote ?? bound?.quote ?? ''
      const matched = !!quote.trim() && source.text.includes(quote)
      const row: EventNode = { ...bound, ...base, name, summary, quote, quoteStatus: !quote.trim() ? 'empty' : matched ? 'matched' : 'unmatched', chapterIndex, chapterName: chapter!.chapterName, order: bound?.order ?? await db.table<EventNode>('nodes').where('chapterIndex').equals(chapterIndex).count(), confidence: bound?.confidence ?? 0.5, actors: unique(input.actors ?? bound?.actors ?? []), eventLineIds: bound?.eventLineIds ?? [] }
      if (matched) row.offset = source.text.indexOf(quote)
      else delete row.offset
      for (const field of ['process', 'time_text', 'time_hint'] as const) if (input[field] !== undefined) row[field] = input[field]
      for (const field of ['targets', 'world_delta', 'new_facts', 'started_actions'] as const) if (input[field] !== undefined) row[field] = unique(input[field]!)
      if (input.participantIds !== undefined || input.unlinkedParticipants !== undefined) {
        const participants = nodeParticipants(row, characters)
        return setNodeParticipants(row, characters, input.participantIds ?? participants.ids, input.unlinkedParticipants ?? participants.names)
      }
      if (input.actors === undefined && input.targets === undefined && bound?.actorIds !== undefined) return remapCharacterLinks([row], characters, characters)[0]
      return bindNodeCharacters(row, characters, { actorIds: input.actorIds, targetCharacterIds: input.targetCharacterIds })
    }
    const previous = old as EventLine | undefined
    const title = (input.title ?? previous?.title ?? '').trim() || fail('title', '事件线标题不能为空。')
    const nodeIds = unique(input.nodeIds ?? previous?.nodeIds ?? [])
    if (!nodeIds.length) fail('nodeIds', '请至少选择一个事件节点。')
    const nodes = await db.table<EventNode>('nodes').bulkGet(nodeIds)
    if (nodes.some(node => !node || node.bookId !== bookId)) fail('nodeIds', '所选节点已删除或不属于本书，请重新选择。')
    return { ...previous, ...base, title, nodeIds, chapters: previous?.chapters ?? [], cause: input.cause ?? previous?.cause ?? '', process: input.process ?? previous?.process ?? '', result: input.result ?? previous?.result ?? '', lineStatus: input.lineStatus ?? previous?.lineStatus ?? 'open', updatedAt: new Date().toISOString() }
  }

  async function mutate<K extends AssetKind>(bookId: string, kind: K, input: AssetInput | null, id?: string, expectedRevision?: number): Promise<AssetByKind[K] | undefined> {
    if (input) validateInput(kind, input)
    const db = await database(bookId)
    const timestamp = new Date().toISOString()
    return db.transaction('rw', db.tables, async () => {
      const leases = await db.table<Lease>('pipelineRuns').toArray()
      const locks = lockState(leases, bookId)
      if (locks[worldKinds.has(kind) ? 'world' : 'narrative']) throw new AssetError('ASSET_DOMAIN_LOCKED', '该类资料正在由处理任务更新，请等待任务结束后编辑。')
      const table = db.table<Asset>(assetTables[kind])
      const old = id ? await table.get(id) : undefined
      if (id && (!old || old.bookId !== bookId)) throw new AssetError('NOT_FOUND', '此条目已删除或不存在。')
      if (old && (!Number.isSafeInteger(expectedRevision) || old.revision !== expectedRevision)) throw new AssetError('CONFLICT', '此条目已被更新，请重新载入后保存。')
      const row = input ? await build(db, bookId, kind, input, old) : undefined
      if (row && !old && (await table.get(row.id) || await db.table('assetLifecycle').get(`${kind}:${row.id}`))) throw new AssetError('CONFLICT', '资产编号已被使用，请重试新增。')
      const targetId = row?.id ?? id!
      if (worldKinds.has(kind)) {
        const before = await table.toArray() as (Character | LocationAsset)[]
        const after = before.filter(item => item.id !== targetId)
        if (row) after.push(row as Character | LocationAsset)
        const texts = await db.table<{ chapterIndex: string; text: string }>('chapterTexts').toArray()
        await writeChanged(db, assetTables[kind], before, updateFrequencies(after, texts, kind === 'character'))
        if (kind === 'character') {
          const beforeNodes = await db.table<EventNode>('nodes').toArray()
          const afterCharacters = await db.table<Character>('characters').toArray()
          const changedNodes = await writeChanged(db, 'nodes', beforeNodes, remapCharacterLinks(beforeNodes, before as Character[], afterCharacters))
          for (const node of changedNodes) await invalidateProgress(db, 'node', node.id, timestamp)
        }
      } else {
        const beforeNodes = await db.table<EventNode>('nodes').toArray()
        const beforeLines = await db.table<EventLine>('eventLines').toArray()
        const nodes = structuredClone(beforeNodes).filter(item => kind !== 'node' || item.id !== targetId)
        const lines = structuredClone(beforeLines).filter(item => kind !== 'eventLine' || item.id !== targetId)
        if (row && kind === 'node') nodes.push(row as EventNode)
        if (row && kind === 'eventLine') lines.push(row as EventLine)
        await synchronizeNarrative(db, bookId, beforeNodes, nodes, beforeLines, lines, timestamp)
      }
      if (!row) await markDeleted(db, bookId, kind, targetId, timestamp)
      else if (!old) await db.table('assetLifecycle').add({ key: `${kind}:${row.id}`, bookId, kind, originId: row.id, currentId: row.id, state: 'live', revision: 1, updatedAt: timestamp } satisfies Lifecycle)
      if (kind === 'character') {
        const currentRelations = await db.table<CharacterRelation>('characterRelations').toArray()
        const currentCharacters = await db.table<Character>('characters').toArray()
        const currentLifecycle = await db.table<Lifecycle>('assetLifecycle').toArray()
        const synced = syncRelations(currentRelations, currentCharacters, currentLifecycle, timestamp)
        if (synced.changed.length) await db.table('characterRelations').bulkPut(synced.changed)
        const endpoints = new Set(synced.changed.flatMap(relation => [relation.sourceId, ...relation.targetIds]).filter((id): id is string => !!id))
        for (const id of endpoints) await invalidateProgress(db, 'character', id, timestamp)
      }
      await invalidateProgress(db, kind, targetId, timestamp)
      return row ? await table.get(row.id) as AssetByKind[K] : undefined
    })
  }

  return {
    async read(bookId: string): Promise<AssetSnapshot> {
      const db = await database(bookId)
      return db.transaction('r', db.tables, async () => {
        const [storedCharacters, locations, storedNodes, eventLines, lifecycle, leases, relationRows] = await Promise.all([
          db.table<Character>('characters').toArray(), db.table<LocationAsset>('locations').toArray(), db.table<EventNode>('nodes').toArray(), db.table<EventLine>('eventLines').toArray(), db.table<Lifecycle>('assetLifecycle').toArray(), db.table<Lease>('pipelineRuns').where('recordType').equals('lease').toArray(), db.table<CharacterRelation>('characterRelations').toArray(),
        ])
        const characters = storedCharacters.map(normalizeCharacterNames)
        const relations = relationRows
        const view = relationView(relations, characters)
        const relationEdges = Object.fromEntries(characters.map(person => [person.id, edgesFor(view.edges, person.id)]))
        const projected = characters.map(person => ({ ...person, relations: projectRelations(view.edges, relations, view.unresolved, person.id, characters).relations }))
        const nodes = storedNodes.map(node => node.actorIds === undefined ? bindNodeCharacters(node, characters) : node)
        const references = resolveReferences(nodes, characters)
        const lineCharacterIds = Object.fromEntries(eventLines.map(line => [line.id, [...new Set(line.nodeIds.flatMap(id => references[id]?.actorIds ?? []))]]))
        const manualMerges = (await db.table<ManualMergeRun>('pipelineRuns').where('stage').equals('manual_merge').toArray()).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
        return { characters: projected, locations, nodes, eventLines, lifecycle, locks: lockState(leases, bookId), references, lineCharacterIds, relations, relationEdges, unresolvedRelations: view.unresolved, manualMerges }
      })
    },
    async create<K extends AssetKind>(bookId: string, kind: K, input: AssetInput) { validateInput(kind, input); return (await mutate(bookId, kind, input))! },
    async update<K extends AssetKind>(bookId: string, kind: K, id: string, expectedRevision: number, input: AssetInput) { validateInput(kind, input); return (await mutate(bookId, kind, input, id, expectedRevision))! },
    async remove(bookId: string, kind: AssetKind, id: string, expectedRevision: number) { await mutate(bookId, kind, null, id, expectedRevision) },
    previewMerge, confirmMerge,
  }
}
export type AssetService = ReturnType<typeof createAssetService>
