import Dexie from 'dexie'
import type { DatabaseScope } from '../../src/lib/storage/workspace'

export const bookSchemaV5 = {
  chapters: 'chapterIndex, order', chapterTexts: 'chapterIndex', characters: 'id, chapterIndex, name', locations: 'id, chapterIndex, name', nodes: 'id, chapterIndex, order', eventLines: 'id, lineStatus', compileProgress: 'stage', storyEditorMemory: 'id, sessionId', storyEditorNotes: 'id, &[sessionId+key], sessionId, kind, status, updatedAt', storyEditorCheckpoints: 'id, sessionId, stage, phase, status, updatedAt', storySessions: 'id, status, createdAt, parentSessionId', storySessionEntries: 'id, &[sessionId+ordinal], sessionId, parentId, type', extractionReceipts: 'key, chapterIndex, substep', assetLifecycle: 'key, kind, originId, currentId, state', pipelineRuns: 'id, recordType, stage, status, startedAt, &lockKey',
}

const currentRelationStore = 'id, bookId, originCharacterId, sourceId, targetName, *targetIds'
const historyRelationStore = 'id, left.characterId, right.characterId, status, kind'

export interface LegacyBookSeed {
  bookId: string
  text?: string
  characters: Record<string, unknown>[]
  lifecycle?: Record<string, unknown>[]
  relations?: Record<string, unknown>[]
  nodes?: Record<string, unknown>[]
  edits?: Record<string, unknown>[]
  pipelineRuns?: Record<string, unknown>[]
  compileProgress?: Record<string, unknown>[]
  receipts?: Record<string, unknown>[]
}

/** 按历史版本结构创建书库；edits 为空时使用没有 characterRelationEdits 的历史7表。 */
export async function createLegacyBook(scope: DatabaseScope, seed: LegacyBookSeed, version: 5 | 6 | 7 = 7, withEdits = false) {
  const name = `${scope.bookPrefix}${seed.bookId}`
  const old = new Dexie(name)
  old.version(5).stores(bookSchemaV5)
  if (version >= 6) old.version(6).stores({ characterRelations: version === 6 ? historyRelationStore : currentRelationStore })
  if (version >= 7) old.version(7).stores(withEdits ? { characterRelationEdits: 'pairKey, aId, bId, state' } : {})
  await old.open()
  const text = seed.text ?? '抱琴是元春的侍女。齐王与许绍真相识。'
  const timestamp = '2026-10-31T00:00:00.000Z'
  await old.table('chapters').put({ bookId: seed.bookId, chapterIndex: '1', chapterName: '第一章', order: 0, charCount: text.length })
  await old.table('chapterTexts').put({ bookId: seed.bookId, chapterIndex: '1', text })
  await old.table('characters').bulkPut(seed.characters)
  await old.table('assetLifecycle').bulkPut(seed.lifecycle ?? seed.characters.map(row => ({ key: `character:${row.id}`, bookId: seed.bookId, kind: 'character', originId: row.id, currentId: row.id, state: 'live', revision: 1, updatedAt: timestamp })))
  if (seed.relations) await old.table('characterRelations').bulkPut(seed.relations)
  if (seed.edits) await old.table('characterRelationEdits').bulkPut(seed.edits)
  if (seed.nodes) await old.table('nodes').bulkPut(seed.nodes)
  if (seed.pipelineRuns) await old.table('pipelineRuns').bulkPut(seed.pipelineRuns)
  await old.table('compileProgress').put(seed.compileProgress?.[0] ?? { bookId: seed.bookId, stage: 'P1', status: 'completed', totalChapters: 1, completedChapters: ['1'], failedChapters: [], updatedAt: timestamp, planVersion: '2.2' })
  for (const receipt of seed.receipts ?? [{ key: '1:worldAssets', chapterIndex: '1', substep: 'worldAssets' }, { key: '1:narrativeAssets', chapterIndex: '1', substep: 'narrativeAssets' }]) await old.table('extractionReceipts').put({ bookId: seed.bookId, inputFingerprint: 'fingerprint', originIds: [], committedAt: '2026-10-31T00:00:00.000Z', runId: 'run', ...receipt })
  old.close()
  return name
}

export function character(id: string, name: string, extra: Record<string, unknown> = {}) {
  return { id, bookId: 'legacy', name, aliases: [], revision: 1, confidence: 1, createdBy: 'P1', chapterIndex: '1', chapterName: '第一章', sourceChapters: ['1'], updatedAt: '2026-10-31T00:00:00.000Z', ...extra }
}

export function legacyRelation(id: string, left: Record<string, unknown>, right: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id, bookId: 'legacy', revision: 1, left, right, kind: 'service', leftRole: null, rightRole: null, qualifier: '', label: '', labelVariants: [], labelSource: 'original',
    status: 'active', issues: [], verification: 'legacy', evidence: [], createdAt: '2026-10-31T00:00:00.000Z', updatedAt: '2026-10-31T00:00:00.000Z', ...extra,
  }
}

export const side = (characterId: string | null, nameHint: string, binding = characterId ? 'owner' : 'unresolved') => ({ characterId, nameHint, binding })
