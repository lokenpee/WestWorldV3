import type { AssetEditRecord, Character, CharacterPairResult, CharacterRelationEdit, RelationEvidence } from './types'
import { effectivePairs, pairEndpointIds, pairFingerprint, pairFromPerspective, pairKeyOf } from './relations'
import type { MergeStore, Row } from './mergeCore'

export interface PairWriteInput {
  bookId: string
  fromId: string; toId: string
  forwardLabels: string[]; reverseLabels: string[]
  directionUnclear?: boolean
  evidence?: RelationEvidence[]
  reason: string
  expectedFingerprint?: string
  actor: 'manual' | 'agent'
  commitId: string
  tool: string
  operationKey?: string
  runId?: string
}
export interface PairWriteResult {
  changed: boolean
  pair: CharacterPairResult
  affected: { kind: 'character'; id: string; revision: number }[]
  record: AssetEditRecord
}

const cleaned = (values: string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))]

export function validatePairLabels(forward: string[], reverse: string[], state: 'active' | 'deleted' = 'active') {
  const a = cleaned(forward), b = cleaned(reverse)
  if (a.length > 20 || b.length > 20) throw new Error('INVALID_ARGS:每个方向的标签最多20项。')
  if ([...a, ...b].some(label => label.length > 100)) throw new Error('INVALID_ARGS:单项关系标签最多100字。')
  if (state === 'active' && !a.length && !b.length) throw new Error('INVALID_ARGS:有效人物对至少一个方向要有标签；双向清空请使用删除工具。')
  return { forward: a, reverse: b }
}

async function loadPair(store: MergeStore, bookId: string, fromId: string, toId: string) {
  const [from, to] = await Promise.all([store.get('characters', fromId), store.get('characters', toId)])
  if (!from || !to || from.bookId !== bookId || to.bookId !== bookId) throw new Error('NOT_FOUND:人物不存在或不属于当前书籍。')
  if (fromId === toId) throw new Error('INVALID_ARGS:人物对需要两个不同的人物编号。')
  const characters = await store.rows('characters') as unknown as Character[]
  const relations = await store.rows('characterRelations')
  const edits = await store.rows('characterRelationEdits') as unknown as CharacterRelationEdit[]
  const pairs = effectivePairs(relations as never, edits, characters)
  return { characters, relations, edits, pairs, current: pairFromPerspective(pairs, fromId, toId, characters) }
}

async function validateEvidence(store: MergeStore, bookId: string, evidence: RelationEvidence[]) {
  for (const item of evidence) {
    if (!item.chapterIndex || !item.quote.trim()) throw new Error('INVALID_ARGS:关系依据须包含章节和原文片段。')
    const chapter = await store.get('chapters', item.chapterIndex)
    if (!chapter || chapter.bookId !== bookId) throw new Error('INVALID_ARGS:关系依据章节不存在。')
    const text = await store.get('chapterTexts', item.chapterIndex)
    if (text && !String(text.text ?? '').includes(item.quote)) throw new Error('INVALID_ARGS:关系依据须逐字存在于对应章节。')
  }
}

async function appendRecord(store: MergeStore, bookId: string, actors: PairWriteInput, record: AssetEditRecord) {
  if (actors.runId) {
    const run = await store.get('pipelineRuns', actors.runId)
    if (run) {
      const report = (run.report ?? {}) as Row
      await store.put('pipelineRuns', { ...run, report: { ...report, assetEdits: [...((report.assetEdits as Row[] | undefined) ?? []), record] } })
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

async function writePair(store: MergeStore, input: PairWriteInput, state: 'active' | 'deleted'): Promise<PairWriteResult> {
  const { bookId, fromId, toId } = input
  const { characters, relations, edits, current } = await loadPair(store, bookId, fromId, toId)
  if (input.expectedFingerprint && input.expectedFingerprint !== current.fingerprint) throw new Error('CONFLICT:人物对已被更新，请重新读取后提交。')
  const labels = state === 'active' ? validatePairLabels(input.forwardLabels, input.reverseLabels) : { forward: [], reverse: [] }
  const evidence = state === 'active' ? (input.evidence ?? []) : []
  await validateEvidence(store, bookId, evidence)
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
    reason: input.reason, evidence, timestamp, actor: input.actor,
  }
  if (unchanged) {
    await appendRecord(store, bookId, input, record)
    return { changed: false, pair: current, affected: [], record }
  }
  const previous = edits.find(row => row.pairKey === pairKey)
  const edit: CharacterRelationEdit = {
    pairKey, bookId, aId, bId, state,
    aToBLabels: aToB, bToALabels: bToA, directionUnclear, evidence,
    sourceRelationIds: state === 'active' ? [...current.sourceRelationIds] : (previous?.sourceRelationIds ?? []),
    legacyRecordIds: [...new Set([...(previous?.legacyRecordIds ?? []), ...(current.legacyRecordIds ?? [])])].sort(),
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
  return { changed: true, pair, affected, record }
}

/** 人工或 AI 共用：保存一个人物对的当前关系；active 可新增、覆盖或恢复。 */
export function saveCharacterPair(store: MergeStore, input: PairWriteInput): Promise<PairWriteResult> {
  return writePair(store, input, 'active')
}

/** 删除双向整组；已删除或不存在时返回合法无变化结果。 */
export function deleteCharacterPair(store: MergeStore, input: PairWriteInput): Promise<PairWriteResult> {
  return writePair(store, input, 'deleted')
}

export { pairFingerprint }
