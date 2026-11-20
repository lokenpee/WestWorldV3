import Dexie from 'dexie'
import type { Chapter, createWorkspace } from '../../lib/storage/workspace'
import { transact } from '../../lib/storage/transaction'
import { versionedTable } from '../local-storage/client'
import { canonical, hash, records, text } from '../agents/contracts'
import type { Row } from '../agents/repository'
import { observationTypes } from '../agents/context'
import { noteFingerprint } from '../agents/queries'
import { coverage, type Receipt } from '../extraction/recovery'
import { evidenceEntries, type StoryProgress } from './checkpoints'
import { readingProgress, refreshReading, type ReadingState } from './reading'
import type { ReadingSourceStore } from './sourceFingerprint'
import { reviewQueue } from './review'
import type { createWindowStoryService } from './service'

type Workspace = ReturnType<typeof createWorkspace>
type LegacyStatus = Awaited<ReturnType<ReturnType<typeof createWindowStoryService>['read']>>
interface Cache {
  rows: Map<string, Map<string, { version: number; value: Row }>>
  sources: Map<string, { version: number; hash: string }>
  memo?: { key: string; current: ReadingState; notes: Row[]; review: LegacyStatus['review'] }
}
const caches = new WeakMap<object, Cache>()

/** 状态读取只复用已提交记录；缓存不是完成凭证，业务执行仍重新核查。 */
export async function readReadingStatus(workspace: Workspace, bookId: string) {
  const db = workspace.openBook(bookId)
  if (!versionedTable(db, 'nodes')) return undefined
  return transact(db, 'r', [db.tables], async scoped => {
    const progress = await scoped.table<StoryProgress>('compileProgress').get('P3')
    const run = progress?.runId ? await scoped.table('pipelineRuns').get(progress.runId) : undefined
    const phase = progress?.phase === 'global_review' ? 'global_review' : 'window_link'
    if (!(run?.storyReading as Row | undefined)?.[phase] || !progress) return undefined
    const cache: Cache = caches.get(db) ?? { rows: new Map(), sources: new Map() }
    const dependencyTables = records(run.coverageItems).flatMap(item => records((item.dependencies as Row | undefined)?.records).map(read => text(read.table)))
    const tables = [...new Set(['nodes', 'eventLines', 'chapters', 'storyEditorNotes', 'chapterTexts', ...(run.storyOutlineVersion === 1 ? ['storyEvents'] : []), ...dependencyTables])]
    const versions = new Map<string, Map<string, number>>()
    let reusable = true
    for (const table of tables) {
      const source = versionedTable(scoped, table)
      if (!source) { reusable = false; continue }
      const entries = await source.versions()
      if (entries.some(entry => entry.version <= 0)) reusable = false
      versions.set(table, new Map(entries.map(entry => [entry.key, entry.version])))
    }
    const local = new Map<string, Promise<Row[]>>()
    const points = new Map<string, Promise<Map<string, Row>>>()
    const load = async (table: string): Promise<Row[]> => {
      const metadata = versions.get(table), source = versionedTable(scoped, table)
      if (!metadata || !source) return scoped.table(table).toArray()
      const previous = cache.rows.get(table)
      const next = new Map<string, { version: number; value: Row }>()
      if (!previous) {
        for (const row of await scoped.table<Row>(table).toArray()) {
          const key = text(table === 'chapters' ? row.chapterIndex : row.id)
          next.set(key, { version: metadata.get(key) ?? 0, value: row })
        }
      } else for (const [key, version] of metadata) {
        const old = version > 0 && previous.get(key)?.version === version ? previous.get(key) : undefined
        const row = old ?? await source.get(key)
        if (row) next.set(key, { version: row.version, value: row.value })
      }
      cache.rows.set(table, new Map([...next].filter(([, row]) => row.version > 0)))
      return [...next.values()].map(row => row.value)
    }
    const store: ReadingSourceStore = {
      async rows(table) {
        if (!local.has(table)) local.set(table, load(table))
        return structuredClone(await local.get(table)!)
      },
      async get(table, id) {
        if (versions.has(table) && table !== 'chapterTexts') {
          if (!points.has(table)) points.set(table, store.rows(table).then(rows => new Map(rows.map(row => [text(table === 'chapters' ? row.chapterIndex : row.id), row]))))
          return structuredClone((await points.get(table)!).get(id))
        }
        return scoped.table(table).get(id)
      },
      async put() { throw new Error('状态读取不能保存业务数据。') },
      async remove() { throw new Error('状态读取不能删除业务数据。') },
      wait: promise => Dexie.waitFor(promise),
      async chapterHash(id, missing) {
        const version = versions.get('chapterTexts')?.get(id), old = cache.sources.get(id)
        if (version && version > 0 && old?.version === version) return old.hash
        const source = await scoped.table('chapterTexts').get(id)
        const value = await store.wait(hash(source ? text(source.text) : missing === 'empty' ? '' : null))
        if (source && version && version > 0) cache.sources.set(id, { version, hash: value })
        else cache.sources.delete(id)
        return value
      },
    }
    for (const id of cache.sources.keys()) if (!versions.get('chapterTexts')?.has(id)) cache.sources.delete(id)
    const key = canonical({ runId: run.id, phase, sessionId: progress.editorSessionId, saved: run.storyReading[phase], coverage: run.coverageItems, versions: [...versions].map(([name, rows]) => [name, [...rows]]) })
    let memo = reusable && cache.memo?.key === key ? cache.memo : undefined
    if (!memo) {
      const current = await refreshReading(store, progress.runId, progress.editorSessionId, phase)
      const currentProgress = readingProgress(current)
      let notes: Row[], review: LegacyStatus['review']
      if (phase === 'global_review') {
        notes = []
        for (const note of await store.rows('storyEditorNotes')) if (note.sessionId === progress.editorSessionId) {
          const valid = note.basisFingerprint === await noteFingerprint(store, note)
          if (note.status === 'active' || !valid) notes.push({ ...note, validity: valid ? 'current' : 'stale' })
        }
        review = { total: currentProgress.totalPages, pending: currentProgress.totalPages - currentProgress.checked, conclusions: records(run.coverageItems).filter(row => row.phase === 'global_review') }
      } else {
        const queue = await reviewQueue(store, progress.runId, progress.editorSessionId)
        notes = queue.items.filter(item => item.queue === 'review_notes').map(item => item.row)
        review = { total: queue.items.length, pending: queue.pending.length, conclusions: queue.coverage }
      }
      memo = { key, current, notes, review }
      cache.memo = reusable ? memo : undefined
    }
    const current = readingProgress(memo.current)
    const line = current.lineId ? await store.get('eventLines', current.lineId) : undefined
    const chapters = await store.rows('chapters') as unknown as Chapter[]
    const covered = coverage(chapters, await scoped.table('extractionReceipts').toArray() as Receipt[]).allCovered
    const leaseIds = ['lease:narrative', 'lease:world', 'lease:extraction', 'lease:extraction:worldAssets', 'lease:extraction:narrativeAssets']
    const leases = (await scoped.table('pipelineRuns').bulkGet(leaseIds)).filter(row => row?.recordType === 'lease' && (typeof row.expiresAt !== 'number' || row.expiresAt > Date.now()))
    const leaseExpiry = leases.filter(row => typeof row!.expiresAt === 'number').reduce<number | undefined>((expiry, row) => Math.min(expiry ?? Infinity, Number(row!.expiresAt)), undefined)
    const entries = (await scoped.table<Row>('storySessionEntries').where('type').noneOf([...observationTypes]).toArray()).filter(row => row.sessionId === progress.editorSessionId).sort((a, b) => Number(a.ordinal) - Number(b.ordinal))
    const tasks = records(run.tasks)
    const value: LegacyStatus = {
      progress, windows: [], checkpoints: [], covered, locked: leases.length > 0, leaseExpiry, completed: current.checked,
      tasks: tasks.some(task => records((task.input as Row | undefined)?.workItems).length) ? evidenceEntries(tasks, await store.rows('nodes'), await store.rows('eventLines')) : evidenceEntries(tasks),
      usage: run.usage as LegacyStatus['usage'], requestLedger: records(run.requestLedger), runStatus: text(run.status), runStartedAt: text(run.startedAt), commits: records(run.appliedCommands), assetEdits: records(run.assetEdits),
      memory: await scoped.table('storyEditorMemory').get(progress.editorSessionId), notes: structuredClone(memo.notes),
      session: { id: progress.editorSessionId, entryCount: entries.length, compactions: entries.filter(row => row.type === 'compaction').length, compact: entries.findLast(row => row.type === 'compaction') }, review: structuredClone(memo.review),
    }
    caches.set(db, cache)
    return { ...value, activityTasks: tasks.filter(task => task.phase === phase).map(task => ({ taskId: task.taskId, stepsUsed: task.stepsUsed, lastError: task.lastError, status: task.status })),
      reading: { ...current, pages: memo.current.pages.map(page => ({ id: page.id, type: page.type, reason: page.reason, checked: page.checkedFingerprint === page.fingerprint })), lineTitle: text(line?.title) } }
  })
}
