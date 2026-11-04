import type { Character, CharacterRelation, CharacterRelationEdit, LegacyRelationDisposition, LegacyRelationRecord, Lifecycle, RelationEvidence } from './types'
import { pairEndpointIds, pairKeyOf, resolveLifecycleId } from './relations'

const roleLabels: Record<string, string> = {
  grandfather: '祖父', grandmother: '祖母', maternalGrandfather: '外祖父', maternalGrandmother: '外祖母',
  grandson: '孙子', granddaughter: '孙女', maternalGrandson: '外孙', maternalGranddaughter: '外孙女',
  elderUncle: '伯父', youngerUncle: '叔父', paternalAunt: '姑母', maternalUncle: '舅父', maternalAunt: '姨母',
  elderUncleWife: '伯母', youngerUncleWife: '婶母', paternalAuntHusband: '姑父', maternalUncleWife: '舅母', maternalAuntHusband: '姨父',
  nephew: '侄子', niece: '侄女', maternalNephew: '外甥', maternalNiece: '外甥女',
  wifeFather: '岳父', wifeMother: '岳母', husbandFather: '公公', husbandMother: '婆婆', sonInLaw: '女婿', daughterInLaw: '儿媳',
  father: '父亲', mother: '母亲', parent: '父母一方', son: '儿子', daughter: '女儿', child: '子女',
  spouse: '配偶', elderBrother: '哥哥', elderSister: '姐姐', youngerBrother: '弟弟', youngerSister: '妹妹', sibling: '手足',
  mentor: '师父', disciple: '弟子', lord: '主人', servant: '仆从', superior: '上级', subordinate: '下级',
  colleague: '同僚', friend: '朋友', relative: '亲属',
  ally: '盟友', enemy: '敌对方', rival: '竞争对手', partner: '合作伙伴', lover: '恋人', husband: '丈夫', wife: '妻子',
}
const roleByLabel = new Map(Object.entries(roleLabels).map(([role, label]) => [label, role]))
const kindLabels: Record<string, string> = {
  parentChild: '亲子', marriage: '婚姻', siblings: '手足', mentor: '师徒', service: '主仆', authority: '上下级',
  colleague: '同僚', friend: '朋友', kinship: '亲属', other: '关系', alliance: '同盟', hostility: '敌对',
  rivalry: '竞争', cooperation: '合作', romance: '恋情',
}
const semanticIssues = new Set(['roleUnclear', 'labelConflict', 'typeUnclear', 'claimUnconfirmed', 'labelBehavior'])
const objectType = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []

export class LegacyConversionError extends Error {
  readonly path: string
  readonly recordId: string
  constructor(path: string, recordId: string, message: string) {
    super(`SCHEMA:${path}${recordId ? `（${recordId}）` : ''}：${message}`)
    this.name = 'LegacyConversionError'
    this.path = path
    this.recordId = recordId
  }
}

/** 历史 left/right 行：两端对象、历史 kind/status/evidence 齐全，且没有当前 targetName 事实字段。 */
export function isLegacyRelationRow(row: unknown): row is Record<string, unknown> {
  if (!objectType(row) || !nonEmpty(row.id)) return false
  if (!objectType(row.left) || !objectType(row.right)) return false
  if (row.targetName !== undefined || row.originCharacterId !== undefined) return false
  const left = row.left, right = row.right
  const sideValid = (side: Record<string, unknown>) => (side.characterId === null || side.characterId === undefined || typeof side.characterId === 'string')
    && typeof side.nameHint === 'string' && typeof side.binding === 'string'
  return sideValid(left) && sideValid(right)
    && nonEmpty(row.kind) && ['active', 'pending', 'excluded'].includes(String(row.status))
    && Array.isArray(row.evidence) && typeof row.label === 'string'
}

/** 当前关系事实行：沿用 CharacterRelation 的必需字段。 */
export function isCurrentRelationRow(row: unknown): row is CharacterRelation {
  if (!objectType(row) || !nonEmpty(row.id) || !nonEmpty(row.bookId)) return false
  return nonEmpty(row.originCharacterId) && nonEmpty(row.sourceName) && nonEmpty(row.targetName)
    && nonEmpty(row.relationType) && nonEmpty(row.forwardLabel) && typeof row.reverseLabel === 'string'
    && ['directed', 'bidirectional', 'unspecified'].includes(String(row.direction))
    && Array.isArray(row.evidence) && (row.sourceId === null || typeof row.sourceId === 'string')
    && Array.isArray(row.targetIds) && Number.isSafeInteger(row.revision)
}

export interface LegacyConversionInput {
  bookId: string
  relations: unknown[]
  characters: Character[]
  lifecycle: Lifecycle[]
  edits: CharacterRelationEdit[]
  chapterTexts: { chapterIndex: string; text: string }[]
  timestamp?: string
  migrationId?: string
}

export interface LegacyMigrationCounts {
  input: number; archived: number; projected: number; unresolved: number; excluded: number; conflicts: number
}
export interface LegacyRecordMapping { id: string; disposition: LegacyRelationDisposition; pairKeys: string[]; issues: string[] }
export interface LegacyMigrationReport {
  kind: 'legacy_relation_migration'; version: 1; sourceSchemas: string[]; counts: LegacyMigrationCounts
  recordMappings: LegacyRecordMapping[]; affectedIds: string[]
}
export interface LegacyConversionResult {
  relations: CharacterRelation[]
  legacyRecords: LegacyRelationRecord[]
  edits: CharacterRelationEdit[]
  report?: LegacyMigrationReport
}

interface Projection {
  row: Record<string, unknown>
  record: LegacyRelationRecord
  leftId: string | null
  rightId: string | null
  pairKey: string | null
  aToB: string[]
  bToA: string[]
  unclear: boolean
  evidence: RelationEvidence[]
  explicit: boolean
}

function roleLabel(value: unknown): { label: string; valid: boolean } | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !value.trim()) return { label: '', valid: false }
  const text = value.trim()
  const role = Object.hasOwn(roleLabels, text) ? text : roleByLabel.get(text)
  return role ? { label: roleLabels[role], valid: true } : { label: text, valid: false }
}

function originalLabel(row: Record<string, unknown>): string {
  const direct = typeof row.label === 'string' ? row.label.trim() : ''
  if (direct) return direct
  const variant = list(row.labelVariants).find(item => nonEmpty(item))
  if (variant) return String(variant).trim()
  return kindLabels[String(row.kind)] ?? '关系'
}

function evidenceFor(row: Record<string, unknown>, texts: Map<string, string>): RelationEvidence[] {
  const result: RelationEvidence[] = []
  for (const item of list(row.evidence)) {
    if (!objectType(item)) continue
    const quote = typeof item.quote === 'string' ? item.quote : ''
    if (!quote) continue
    const candidates = [
      typeof item.quoteChapterIndex === 'string' ? item.quoteChapterIndex : '',
      ...list(item.sourceChapterIndices).filter((value): value is string => typeof value === 'string'),
    ].filter(Boolean)
    const chapterIndex = candidates.find(index => texts.get(index)?.includes(quote))
    if (chapterIndex && !result.some(row => row.chapterIndex === chapterIndex && row.quote === quote)) result.push({ chapterIndex, quote })
  }
  return result
}

function project(row: Record<string, unknown>, characters: Map<string, Character>, lifecycle: Lifecycle[], texts: Map<string, string>, timestamp: string, bookId: string): Projection {
  const left = row.left as Record<string, unknown>
  const right = row.right as Record<string, unknown>
  const rawLeft = typeof left.characterId === 'string' ? left.characterId : null
  const rawRight = typeof right.characterId === 'string' ? right.characterId : null
  const leftId = rawLeft ? resolveLifecycleId(rawLeft, lifecycle) : null
  const rightId = rawRight ? resolveLifecycleId(rawRight, lifecycle) : null
  const issues = list(row.issues).filter((item): item is string => typeof item === 'string')
  const dispositionBase: LegacyRelationDisposition = row.status === 'excluded' ? 'excluded' : 'converted'
  const record: LegacyRelationRecord = {
    id: String(row.id), bookId, schema: 'legacy-left-right-v1', original: structuredClone(row),
    disposition: dispositionBase, pairKeys: [], issues, migrationVersion: 1, migratedAt: timestamp,
  }
  const unresolved = (issue: string) => {
    record.disposition = 'unresolved'
    if (!record.issues.includes(issue)) record.issues.push(issue)
  }
  const bindingBad = (side: Record<string, unknown>) => ['unresolved', 'deleted'].includes(String(side.binding))
  if (dispositionBase === 'excluded') {
    if (leftId && rightId && leftId !== rightId && characters.has(leftId) && characters.has(rightId)) record.pairKeys = [pairKeyOf(leftId, rightId)]
    const pairKey = record.pairKeys[0] ?? null
    return { row, record, leftId, rightId, pairKey, aToB: [], bToA: [], unclear: false, evidence: [], explicit: false }
  }
  if (!rawLeft || !rawRight) return unresolved(!rawLeft ? (bindingBad(left) ? 'objectDeleted' : 'objectMissing') : (bindingBad(right) ? 'objectDeleted' : 'objectMissing')), { row, record, leftId: null, rightId: null, pairKey: null, aToB: [], bToA: [], unclear: false, evidence: [], explicit: false }
  if (!leftId || !rightId || !characters.has(leftId) || !characters.has(rightId)) return unresolved(bindingBad(left) || bindingBad(right) ? 'objectDeleted' : 'objectMissing'), { row, record, leftId: null, rightId: null, pairKey: null, aToB: [], bToA: [], unclear: false, evidence: [], explicit: false }
  if (leftId === rightId) return unresolved('self_after_merge'), { row, record, leftId, rightId, pairKey: null, aToB: [], bToA: [], unclear: false, evidence: [], explicit: false }
  const pairKey = pairKeyOf(leftId, rightId)
  record.pairKeys = [pairKey]
  const leftRole = roleLabel(row.leftRole), rightRole = roleLabel(row.rightRole)
  const semantic = issues.some(issue => semanticIssues.has(issue))
  let aToB: string[] = [], bToA: string[] = [], unclear = false
  const fallback = originalLabel(row)
  if (!semantic && leftRole?.valid && rightRole?.valid) {
    aToB = [leftRole.label]; bToA = [rightRole.label]
  } else if (!semantic && leftRole?.valid && !rightRole) {
    aToB = [leftRole.label]
  } else if (!semantic && !leftRole && rightRole?.valid) {
    bToA = [rightRole.label]
  } else {
    aToB = [fallback]; bToA = [fallback]; unclear = true
    if (!record.issues.includes('directionUnclear')) record.issues.push('directionUnclear')
  }
  for (const issue of issues) if (!record.issues.includes(issue)) record.issues.push(issue)
  const [aId] = pairEndpointIds(pairKey)
  const forward = leftId === aId ? aToB : bToA
  const reverse = leftId === aId ? bToA : aToB
  return {
    row, record, leftId, rightId, pairKey, aToB: forward, bToA: reverse, unclear,
    evidence: evidenceFor(row, texts), explicit: ['manual', 'ai'].includes(String(row.verification)),
  }
}

/**
 * 历史关系的一次性转换：归档每条旧行，并按具体人物对投影当前结果。
 * 纯计算，不写存储；书库升级和备份预检共用同一规则。
 */
export function convertLegacyRelations(input: LegacyConversionInput): LegacyConversionResult {
  const timestamp = input.timestamp ?? new Date().toISOString()
  const migrationId = input.migrationId ?? `legacy-migration:${crypto.randomUUID()}`
  const characters = new Map(input.characters.map(row => [row.id, row]))
  const texts = new Map(input.chapterTexts.map(row => [row.chapterIndex, row.text]))
  const current: CharacterRelation[] = []
  const records: LegacyRelationRecord[] = []
  const projections: Projection[] = []
  let inputRows = 0
  for (const [index, row] of input.relations.entries()) {
    if (isCurrentRelationRow(row)) { current.push(structuredClone(row)); continue }
    if (!isLegacyRelationRow(row)) throw new LegacyConversionError(`characterRelations[${index}]`, objectType(row) ? String(row.id ?? '') : '', '既不是当前关系事实，也不是已知的历史 left/right 结构。')
    inputRows++
    if (records.some(record => record.id === String(row.id))) throw new LegacyConversionError(`characterRelations[${index}]`, String(row.id), '旧关系编号重复。')
    projections.push(project(row, characters, input.lifecycle, texts, timestamp, input.bookId))
  }
  if (!inputRows) return { relations: current, legacyRecords: [], edits: input.edits }

  const edits = new Map<string, CharacterRelationEdit>(input.edits.map(row => [row.pairKey, { ...row, legacyRecordIds: [...(row.legacyRecordIds ?? [])].sort() }]))
  const converted = projections.filter(item => item.record.disposition === 'converted' && item.pairKey)
  const excluded = projections.filter(item => item.record.disposition === 'excluded' && item.pairKey)
  const groups = new Map<string, Projection[]>()
  for (const item of converted) {
    if (!groups.has(item.pairKey!)) groups.set(item.pairKey!, [])
    groups.get(item.pairKey!)!.push(item)
  }
  for (const [pairKey, group] of groups) {
    const chosen = group.some(item => item.explicit) ? group.filter(item => item.explicit) : group
    const labelsA: string[] = [], labelsB: string[] = []
    const evidence: RelationEvidence[] = []
    let unclear = false
    for (const item of chosen.sort((a, b) => a.record.id.localeCompare(b.record.id))) {
      for (const label of item.aToB) if (!labelsA.includes(label)) labelsA.push(label)
      for (const label of item.bToA) if (!labelsB.includes(label)) labelsB.push(label)
      for (const row of item.evidence) if (!evidence.some(known => known.chapterIndex === row.chapterIndex && known.quote === row.quote)) evidence.push(row)
      unclear = unclear || item.unclear
    }
    const invalid = labelsA.length > 20 || labelsB.length > 20 || [...labelsA, ...labelsB].some(label => label.length > 100)
    const empty = !labelsA.length && !labelsB.length
    if (invalid || empty) {
      for (const item of group) {
        item.record.disposition = 'unresolved'
        const issue = invalid ? 'label_limit' : 'label_empty'
        if (!item.record.issues.includes(issue)) item.record.issues.push(issue)
      }
      continue
    }
    const [aId, bId] = pairEndpointIds(pairKey)
    const legacyRecordIds = group.map(item => item.record.id).sort()
    const existing = edits.get(pairKey)
    if (existing) {
      existing.legacyRecordIds = [...new Set([...(existing.legacyRecordIds ?? []), ...legacyRecordIds])].sort()
      continue
    }
    const edit: CharacterRelationEdit = {
      pairKey, bookId: input.bookId, aId, bId, state: 'active',
      aToBLabels: labelsA, bToALabels: labelsB, directionUnclear: unclear,
      evidence, sourceRelationIds: [], legacyRecordIds,
      revision: 1, updatedAt: timestamp, updatedBy: 'migration', commitId: migrationId,
    }
    edits.set(pairKey, edit)
  }
  // 只有 excluded 旧行且没有其他有效依据的具体人物对，生成删除结果。
  for (const pairKey of new Set(excluded.map(item => item.pairKey!))) {
    if (converted.some(item => item.pairKey === pairKey)) continue
    const existing = edits.get(pairKey)
    const [aId, bId] = pairEndpointIds(pairKey)
    const legacyRecordIds = excluded.filter(item => item.pairKey === pairKey).map(item => item.record.id).sort()
    if (existing) {
      existing.legacyRecordIds = [...new Set([...(existing.legacyRecordIds ?? []), ...legacyRecordIds])].sort()
      continue
    }
    if (current.some(relation => relation.sourceId && relation.targetIds.some(id => pairKeyOf(relation.sourceId!, id) === pairKey))) continue
    const edit: CharacterRelationEdit = {
      pairKey, bookId: input.bookId, aId, bId, state: 'deleted',
      aToBLabels: [], bToALabels: [], directionUnclear: false, evidence: [], sourceRelationIds: [], legacyRecordIds,
      revision: 1, updatedAt: timestamp, updatedBy: 'migration', commitId: migrationId,
    }
    edits.set(pairKey, edit)
  }
  for (const item of projections) records.push(item.record)
  const projected = projections.filter(item => item.record.disposition === 'converted').length
  const unresolved = projections.filter(item => item.record.disposition === 'unresolved').length
  const excludedCount = projections.filter(item => item.record.disposition === 'excluded').length
  const conflicts = projections.filter(item => item.record.issues.some(issue => semanticIssues.has(issue))).length
  const recordMappings = records.map(record => ({ id: record.id, disposition: record.disposition, pairKeys: [...record.pairKeys], issues: [...record.issues] }))
  const affected = new Set<string>()
  for (const item of projections) {
    if (item.leftId) affected.add(item.leftId)
    if (item.rightId) affected.add(item.rightId)
  }
  return {
    relations: current,
    legacyRecords: records,
    edits: [...edits.values()],
    report: {
      kind: 'legacy_relation_migration', version: 1, sourceSchemas: ['legacy-left-right-v1'],
      counts: { input: inputRows, archived: records.length, projected, unresolved, excluded: excludedCount, conflicts },
      recordMappings, affectedIds: [...affected].sort(),
    },
  }
}

/** 关系行是否为当前结构；供备份清单分支判断“非空且缺编辑表”的当前格式7。 */
export function hasCurrentRelationRows(relations: unknown[]): boolean {
  return relations.some(isCurrentRelationRow)
}
