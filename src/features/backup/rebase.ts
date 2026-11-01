import { hash, records, text } from '../agents/contracts'
import type { AgentStore } from '../agents/repository'
import { noteFingerprint } from '../agents/queries'
import { coverageFingerprint } from '../world/queue'
import { storyFingerprint, windowFingerprint } from '../story/coverage'
import { createStoryWindows, windowNodes } from '../story/windows'
import { checkpointId } from '../story/checkpoints'
import type { Chapter } from '../../lib/storage/workspace'
import type { EventNode } from '../assets/types'
import type { BookData, BookTables, Row, TableName } from './data'

const keyOf = (table: string, row: Row) => text(table === 'chapters' || table === 'chapterTexts' ? row.chapterIndex : table === 'assetLifecycle' || table === 'extractionReceipts' ? row.key : table === 'compileProgress' ? row.stage : row.id)
function reader(tables: BookTables): AgentStore {
  const index = new Map(Object.entries(tables).map(([table, rows]) => [table, new Map(rows.map(row => [keyOf(table, row), row]))]))
  return { rows: async table => tables[table as TableName] ?? [], get: async (table, id) => index.get(table)?.get(id), wait: promise => promise,
    put: async () => { throw new Error('恢复依据检查为只读操作。') }, remove: async () => { throw new Error('恢复依据检查为只读操作。') } }
}

// 只转换仍能与原书当前资料对应的证明；失效证明继续保持失效。
export async function rebaseRestoredProgress(original: BookData, tables: BookTables, bookId: string) {
  const oldReader = reader(original.tables), nextReader = reader(tables)
  const fingerprints = new Map<string, string>()
  const oldNodesHash = await hash(original.tables.nodes), nextNodesHash = await hash(tables.nodes)
  fingerprints.set(oldNodesHash, nextNodesHash)
  for (const memory of tables.storyEditorMemory) if (memory.dataFingerprint === oldNodesHash) memory.dataFingerprint = nextNodesHash
  for (const old of original.tables.storyEditorNotes) {
    const next = tables.storyEditorNotes.find(row => row.id === old.id)
    if (next && old.basisFingerprint === await noteFingerprint(oldReader, old)) {
      next.basisFingerprint = await noteFingerprint(nextReader, next)
      fingerprints.set(text(old.basisFingerprint), text(next.basisFingerprint))
    }
  }
  const proofTables: TableName[] = ['characters', 'locations', 'nodes', 'eventLines', 'chapterTexts', 'storyEditorMemory', 'storyEditorNotes']
  for (const table of proofTables) {
    const current = new Map(tables[table].map(row => [keyOf(table, row), row]))
    await Promise.all(original.tables[table].map(async old => {
      const next = current.get(keyOf(table, old))
      if (!next) return
      const pairs = await Promise.all([
        Promise.all([hash(old), hash(next)]),
        Promise.all([coverageFingerprint(table, old), coverageFingerprint(table, next)]),
        Promise.all([storyFingerprint(table, old), storyFingerprint(table, next)]),
      ])
      for (const [before, after] of pairs) fingerprints.set(before, after)
    }))
  }
  const oldChapters = [...original.tables.chapters].sort((a, b) => Number(a.order) - Number(b.order)) as unknown as Chapter[]
  const nextChapters = [...tables.chapters].sort((a, b) => Number(a.order) - Number(b.order)) as unknown as Chapter[]
  const windows = createStoryWindows(oldChapters)
  const oldPlan = await hash({ version: '2.2', size: 100, overlap: 20, windows, chapters: oldChapters })
  const nextPlan = await hash({ version: '2.2', size: 100, overlap: 20, windows: createStoryWindows(nextChapters), chapters: nextChapters })
  const progress = tables.compileProgress.find(row => row.stage === 'P3')
  if (progress?.planKey === oldPlan) {
    progress.planKey = nextPlan
    for (const window of windows) {
      const oldId = checkpointId(text(progress.editorSessionId), oldPlan, window)
      const checkpoint = tables.storyEditorCheckpoints.find(row => row.id === oldId)
      if (!checkpoint) continue
      checkpoint.id = checkpointId(text(progress.editorSessionId), nextPlan, window)
      const before = windowNodes(window, oldChapters, original.tables.nodes as unknown as EventNode[])
      const after = windowNodes(window, nextChapters, tables.nodes as unknown as EventNode[])
      if ([await windowFingerprint(window, before), await hash({ window, nodes: before })].includes(text(checkpoint.sourceFingerprint))) checkpoint.sourceFingerprint = await windowFingerprint(window, after)
    }
  }
  const proofKeys = new Set(['factFingerprint', 'coveredFingerprint', 'basisFingerprint', 'dataFingerprint'])
  const rebase = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(rebase); return }
    if (!value || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      if (proofKeys.has(key) && typeof item === 'string' && fingerprints.has(item)) (value as Row)[key] = fingerprints.get(item)!
      else rebase(item)
    }
  }
  for (const run of tables.pipelineRuns) {
    rebase(run)
    for (const item of records((run.mechanicalQueue as Row | undefined)?.items)) {
      const proofs = item.approvalFingerprints as Row | undefined
      if (proofs) for (const [id, before] of Object.entries(proofs)) if (typeof before === 'string' && fingerprints.has(before)) proofs[id] = fingerprints.get(before)!
    }
    for (const task of records(run.tasks)) if ((task.input as Row | undefined)?.bookId === bookId) task.inputFingerprint = await hash(task.input)
  }
}
