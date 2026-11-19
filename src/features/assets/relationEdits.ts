import type { AssetEditRecord, Basis, Character, CharacterPairResult, CharacterRelation, CharacterRelationEdit, RelationEvidence } from './types'
import { effectivePairs, pairEndpointIds, pairFingerprint, pairFromPerspective, pairKeyOf } from './relations'
import type { MergeStore, Row } from './mergeCore'

export interface PairWriteInput {
  bookId: string
  fromId: string; toId: string
  forwardLabels: string[]; reverseLabels: string[]
  directionUnclear?: boolean
  evidence?: RelationEvidence[]
  basis?: Basis[]
  reason: string
  expectedFingerprint?: string
  actor: 'manual' | 'agent'
  commitId: string
  tool: string
  operationKey?: string
  runId?: string
  allowUnverifiedEvidence?: boolean
  evidenceStatus?: 'verified' | 'unverified' | 'partial'
}
export interface PairWriteResult {
  changed: boolean
  pair: CharacterPairResult
  affected: { kind: 'character'; id: string; revision: number }[]
  record: AssetEditRecord
}

const cleaned = (values: string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))]

/** 仅供一次提交事务使用；原始事实与核查时解析后的事实分别保留。 */
export function createPairWriteContext(store: MergeStore, characters: Character[], relations: CharacterRelation[], edits: CharacterRelationEdit[]) {
  const people = new Map(characters.map(row => [row.id, row]))
  const editByKey = new Map(edits.map(row => [row.pairKey, row]))
  const factsByKey = new Map<string, CharacterRelation[]>()
  for (const row of relations) if (row.sourceId) for (const targetId of new Set(row.targetIds)) {
    if (targetId === row.sourceId) continue
    const key = pairKeyOf(row.sourceId, targetId)
    if (!factsByKey.has(key)) factsByKey.set(key, [])
    factsByKey.get(key)!.push(row)
  }
  return {
    store, people,
    load(fromId: string, toId: string) {
      const key = pairKeyOf(fromId, toId)
      const characters = [people.get(fromId), people.get(toId)].filter((row): row is Character => !!row)
      const relations = factsByKey.get(key) ?? []
      const edit = editByKey.get(key), edits = edit ? [edit] : []
      return { characters, relations, edits, current: pairFromPerspective(effectivePairs(relations, edits, characters), fromId, toId, characters) }
    },
    update(edit: CharacterRelationEdit, characters: Character[]) {
      editByKey.set(edit.pairKey, edit)
      for (const person of characters) people.set(person.id, person)
    },
  }
}
type PairWriteContext = ReturnType<typeof createPairWriteContext>

export function validatePairLabels(forward: string[], reverse: string[], state: 'active' | 'deleted' = 'active') {
  const a = cleaned(forward), b = cleaned(reverse)
  if (state === 'active' && !a.length && !b.length) throw new Error('INVALID_ARGS:有效人物对至少一个方向要有标签；双向清空请使用删除工具。')
  return { forward: a, reverse: b }
}

async function loadPair(store: MergeStore, bookId: string, fromId: string, toId: string, context?: PairWriteContext) {
  const [from, to] = await Promise.all([store.get('characters', fromId), store.get('characters', toId)])
  if (!from || !to || from.bookId !== bookId || to.bookId !== bookId) throw new Error('NOT_FOUND:人物不存在或不属于当前书籍。')
  if (fromId === toId) throw new Error('INVALID_ARGS:人物对需要两个不同的人物编号。')
  if (context) {
    if (context.store !== store) throw new Error('人物对写入快照不属于当前事务。')
    return context.load(fromId, toId)
  }
  const characters = await store.rows('characters') as unknown as Character[]
  const relations = await store.rows('characterRelations')
  const edits = await store.rows('characterRelationEdits') as unknown as CharacterRelationEdit[]
  const pairs = effectivePairs(relations as never, edits, characters)
  return { characters, relations, edits, pairs, current: pairFromPerspective(pairs, fromId, toId, characters) }
}

export interface EvidenceProblem { index: number; chapterIndex: string; quote: string; reason: string }

export async function evidenceProblems(store: MergeStore, bookId: string, evidence: RelationEvidence[]): Promise<EvidenceProblem[]> {
  const problems: EvidenceProblem[] = []
  for (const [index, item] of evidence.entries()) {
    const chapterIndex = String(item.chapterIndex ?? ''), quote = String(item.quote ?? '')
    if (!chapterIndex || !quote.trim()) { problems.push({ index, chapterIndex, quote, reason: '缺少章节编号或原文片段' }); continue }
    const chapter = await store.get('chapters', chapterIndex)
    if (!chapter || chapter.bookId !== bookId) { problems.push({ index, chapterIndex, quote, reason: '章节不存在或不属于本书' }); continue }
    const text = await store.get('chapterTexts', chapterIndex)
    if (!text || !String(text.text ?? '').includes(quote)) problems.push({ index, chapterIndex, quote, reason: '引文未在章节原文中逐字出现' })
  }
  return problems
}

async function validateEvidence(store: MergeStore, bookId: string, evidence: RelationEvidence[]) {
  const problems = await evidenceProblems(store, bookId, evidence)
  if (problems.length) throw new Error(`INVALID_ARGS:${problems.map(problem => `第${problem.chapterIndex}章：${problem.reason}`).join('；')}`)
}

async function appendRecord(store: MergeStore, bookId: string, actors: PairWriteInput, record: AssetEditRecord) {
  if (actors.runId) {
    const run = await store.get('pipelineRuns', actors.runId)
    if (run) {
      const report = (run.report ?? {}) as Row
      const existing = (report.assetEdits as Row[] | undefined) ?? []
      await store.put('pipelineRuns', { ...run, report: { ...report, assetEdits: [...existing, { ...record, writeSeq: existing.length + 1 }] } })
      return
    }
  }
  await store.put('pipelineRuns', {
    id: `asset-edit:${actors.commitId}`, recordType: 'asset_edit', bookId,
    stage: 'asset_edit', status: 'completed', startedAt: record.timestamp, finishedAt: record.timestamp, planVersion: '2.2',
    operationKey: actors.operationKey ?? actors.commitId, payloadFingerprint: record.commitId,
    assetEdits: [record], createdAt: record.timestamp,
  })
}

function sameLabels(a: string[], b: string[]) { return JSON.stringify(a) === JSON.stringify(b) }

async function writePair(store: MergeStore, input: PairWriteInput, state: 'active' | 'deleted', context?: PairWriteContext): Promise<PairWriteResult> {
  const { bookId, fromId, toId } = input
  const { characters, relations, edits, current } = await loadPair(store, bookId, fromId, toId, context)
  if (input.expectedFingerprint && input.expectedFingerprint !== current.fingerprint) throw new Error('CONFLICT:人物对已被更新，请重新读取后提交。')
  const labels = state === 'active' ? validatePairLabels(input.forwardLabels, input.reverseLabels) : { forward: [], reverse: [] }
  const evidence = input.evidence ?? []
  const problems = state === 'active' && evidence.length ? await evidenceProblems(store, bookId, evidence) : []
  if (state === 'deleted' && !input.allowUnverifiedEvidence) await validateEvidence(store, bookId, evidence)
  const annotated = state === 'active'
    ? evidence.map((item, index) => {
      const problem = problems.find(problem => problem.index === index)
      return problem ? { ...item, verified: false, reason: problem.reason } : { ...item, verified: true }
    })
    : evidence
  const evidenceStatus = input.evidenceStatus ?? (state === 'active'
    ? (evidence.length ? (problems.length === 0 ? 'verified' : problems.length === evidence.length ? 'unverified' : 'partial') : undefined)
    : (evidence.length ? (input.allowUnverifiedEvidence ? 'unverified' : 'verified') : undefined))
  const pairKey = pairKeyOf(fromId, toId)
  const [aId, bId] = pairEndpointIds(pairKey)
  const aToB = aId === fromId ? labels.forward : labels.reverse
  const bToA = aId === fromId ? labels.reverse : labels.forward
  const directionUnclear = state === 'active' ? input.directionUnclear === true : false
  const unchanged = state === 'active'
    ? current.state === 'active' && sameLabels(aToB, current.fromId === aId ? current.forwardLabels : current.reverseLabels) && sameLabels(bToA, current.fromId === aId ? current.reverseLabels : current.forwardLabels) && current.directionUnclear === directionUnclear
    : current.state === 'deleted' || current.state === 'absent'
  const timestamp = new Date().toISOString()
  const record: AssetEditRecord = {
    commitId: input.commitId, tool: input.tool, kind: 'relation', id: pairKey,
    fieldChanges: unchanged ? [] : [
      { field: 'state', before: current.state, after: state },
      { field: 'forwardLabels', before: current.forwardLabels, after: labels.forward },
      { field: 'reverseLabels', before: current.reverseLabels, after: labels.reverse },
    ],
    reason: input.reason, evidence: annotated, ...(evidenceStatus ? { evidenceStatus } : {}), basis: input.basis ?? [], timestamp, actor: input.actor,
  }
  if (unchanged) {
    await appendRecord(store, bookId, input, record)
    return { changed: false, pair: current, affected: [], record }
  }
  const previous = edits.find(row => row.pairKey === pairKey)
  const edit: CharacterRelationEdit = {
    pairKey, bookId, aId, bId, state,
    aToBLabels: aToB, bToALabels: bToA, directionUnclear, evidence: annotated,
    sourceRelationIds: state === 'active' ? [...current.sourceRelationIds] : (previous?.sourceRelationIds ?? []),
    legacyRecordIds: [...new Set([...(previous?.legacyRecordIds ?? []), ...(current.legacyRecordIds ?? [])])].sort(),
    basis: input.basis ?? [], ...(evidenceStatus ? { evidenceStatus } : {}),
    revision: Number(previous?.revision ?? 0) + 1, updatedAt: timestamp, updatedBy: input.actor, commitId: input.commitId,
  }
  await store.put('characterRelationEdits', edit as unknown as Row)
  const affected: PairWriteResult['affected'] = []
  for (const id of [fromId, toId]) {
    const row = await store.get('characters', id) as unknown as Character
    if (!row) continue
    const next = { ...row, revision: Number(row.revision ?? 1) + 1, updatedAt: timestamp }
    await store.put('characters', next as unknown as Row)
    affected.push({ kind: 'character', id, revision: next.revision })
  }
  await appendRecord(store, bookId, input, record)
  const afterCharacters = characters.map(person => affected.find(row => row.id === person.id) ? { ...person, revision: affected.find(row => row.id === person.id)!.revision } : person)
  const afterEdits = [...edits.filter(row => row.pairKey !== pairKey), edit]
  const pair = pairFromPerspective(effectivePairs(relations as never, afterEdits, afterCharacters), fromId, toId, afterCharacters)
  context?.update(edit, afterCharacters)
  return { changed: true, pair, affected, record }
}

/** 人工或 AI 共用：保存一个人物对的当前关系；active 可新增、覆盖或恢复。 */
export function saveCharacterPair(store: MergeStore, input: PairWriteInput, context?: PairWriteContext): Promise<PairWriteResult> {
  return writePair(store, input, 'active', context)
}

/** 删除双向整组；已删除或不存在时返回合法无变化结果。 */
export function deleteCharacterPair(store: MergeStore, input: PairWriteInput, context?: PairWriteContext): Promise<PairWriteResult> {
  return writePair(store, input, 'deleted', context)
}

export { pairFingerprint }
