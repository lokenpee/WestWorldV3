import type { Chapter, createWorkspace } from '../../lib/storage/workspace'
import { substeps, type Substep } from './types'

export type ExtractionDatabase = ReturnType<ReturnType<typeof createWorkspace>['openBook']>
export interface Receipt { key: string; bookId: string; chapterIndex: string; substep: Substep; originIds: string[]; inputFingerprint: string }
export interface Lease { id: string; recordType: string; owner?: string; runId?: string; expiresAt?: number }
export interface ReExtractScope { step: Substep; scope: 'all' | 'chapter'; chapterIndex?: string; startedAt: string }
export interface Progress { bookId: string; stage: string; status: string; totalChapters: number; completedChapters: string[]; failedChapters: string[]; partialChapters?: Record<string, Substep[]>; updatedAt: string; runId?: string; reExtract?: ReExtractScope }
export interface SavedUsage { input: number; output: number; totalTokens: number; cost: number; costStatus: 'estimated' | 'unknown' }
export interface StoredTask {
  taskId: string; ordinal: number; callId: string; phase: Substep; status: string; workItemIds: string[]
  input: { chapterIndex: string; chapterName: string; text: string }; inputFingerprint: string; promptHash: string
  attempt: number; repairCount: number; stepsUsed: number; appliedCommitIds: string[]; reviewedItems: { workItemId: string; outcome: string; reason: string }[]
  readSet: { records: never[]; queries: never[] }; createdAt: string; updatedAt: string; lastError?: { code: string; message: string }
}
export interface Run { id: string; recordType: string; bookId: string; stage: string; status: string; usage?: SavedUsage; tasks?: StoredTask[]; finishedAt?: string }
export function coverage(chapters: Chapter[], receipts: Receipt[], failed: string[] = []) {
  const keys = new Set(receipts.map(row => row.key))
  const missing = (chapter: Chapter) => substeps.filter(step => !keys.has(`${chapter.chapterIndex}:${step}`))
  const completedChapters = chapters.filter(chapter => !missing(chapter).length).map(chapter => chapter.chapterIndex)
  return {
    totalChapters: chapters.length, completedChapters,
    failedChapters: [...new Set(failed)].filter(id => chapters.some(chapter => chapter.chapterIndex === id) && !completedChapters.includes(id)),
    partialChapters: Object.fromEntries(chapters.filter(chapter => missing(chapter).length === 1).map(chapter => [chapter.chapterIndex, missing(chapter)])),
    completedSteps: chapters.length * 2 - chapters.reduce((sum, chapter) => sum + missing(chapter).length, 0),
    allCovered: chapters.length > 0 && completedChapters.length === chapters.length,
  }
}

export async function checkReceiptSources(db: ExtractionDatabase, bookId: string) {
  const receipts = await db.table<Receipt>('extractionReceipts').toArray()
  const chapters = new Set((await db.chapters.toArray()).map(row => row.chapterIndex))
  interface Mapping { key: string; bookId: string; kind: string; originId: string; currentId?: string; state: string }
  const mappings = await db.table<Mapping>('assetLifecycle').toArray()
  const byKey = new Map(mappings.map(row => [row.key, row]))
  const tables: Record<string, string> = { character: 'characters', location: 'locations', node: 'nodes' }
  const currentIds = new Map<string, Set<string>>()
  for (const [kind, table] of Object.entries(tables)) currentIds.set(kind, new Set((await db.table<{ id: string }>(table).toArray()).map(row => row.id)))
  for (const receipt of receipts) {
    if (receipt.bookId !== bookId || !chapters.has(receipt.chapterIndex) || !substeps.includes(receipt.substep) || receipt.key !== `${receipt.chapterIndex}:${receipt.substep}` || !receipt.inputFingerprint || !Array.isArray(receipt.originIds) || receipt.originIds.some(id => typeof id !== 'string' || !id)) throw new Error('提取成功凭证不完整，请检查本书资料或从备份恢复。')
    for (const id of receipt.originIds) {
      const kinds = receipt.substep === 'worldAssets' ? ['character', 'location'] : ['node']
      let mapping = kinds.map(kind => byKey.get(`${kind}:${id}`)).find(Boolean)
      const visited = new Set<string>()
      for (;;) {
        if (!mapping || mapping.bookId !== bookId || visited.has(mapping.key)) throw new Error(`第${receipt.chapterIndex}章的提取来源记录不完整，请检查本书资料或从备份恢复。`)
        visited.add(mapping.key)
        if (mapping.state === 'deleted') break
        if (mapping.state === 'live' && mapping.currentId === mapping.originId && currentIds.get(mapping.kind)?.has(mapping.currentId)) break
        if (mapping.state !== 'merged' || !mapping.currentId) throw new Error(`第${receipt.chapterIndex}章的提取资料与来源记录不一致，请检查本书资料。`)
        const targetId = mapping.currentId; const kind = mapping.kind
        mapping = byKey.get(`${kind}:${targetId}`)
      }
    }
  }
  return receipts
}

export async function withExtractionLock<T>(namespace: string, bookId: string, work: () => Promise<T>, busy: () => T): Promise<T> {
  const locks = globalThis.navigator?.locks
  if (!locks) return work()
  return locks.request(`westworld-extraction:${namespace}:${bookId}`, { mode: 'exclusive', ifAvailable: true }, lock => lock ? work() : busy())
}
