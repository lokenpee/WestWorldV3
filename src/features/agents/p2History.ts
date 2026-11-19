import { transact } from '../../lib/storage/transaction'
import type { createWorkspace } from '../../lib/storage/workspace'
import type { WorldRun } from '../world/types'
import type { Row } from './repository'
import { records, strings, text } from './contracts'
import { withTraceBarrier, type OrganizationStepIndexEntry } from './trace'
import { historyIndexId } from './p2HistoryIndex'

export function completedCharacters(entries: OrganizationStepIndexEntry[]) {
  const latest = new Map<string, OrganizationStepIndexEntry>()
  for (const entry of [...entries].sort((a, b) => b.runStartedAt.localeCompare(a.runStartedAt) || b.runId.localeCompare(a.runId))) {
    if (!entry.characterId || entry.status !== 'checked' || entry.outcome === 'unavailable') continue
    const key = `${entry.step}:${entry.characterId}`
    const previous = latest.get(key)
    if (!previous || previous.detailReady === false && entry.detailReady !== false) latest.set(key, entry)
  }
  return [...latest.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN', { numeric: true }))
}

export function currentCharacter(runs: WorldRun[], step?: 'profiles' | 'relations') {
  for (const run of runs) {
    const work = run.organization?.activeWork
    if (!work?.characterId || !['running', 'paused', 'failed'].includes(run.status)) continue
    const workStep = work.kind === 'profile' ? 'profiles' : work.kind === 'relations' ? 'relations' : undefined
    if (!workStep || step && step !== workStep) continue
    const item = (workStep === 'profiles' ? run.organization!.profileItems : run.organization!.relationItems).find(item => item.id === work.characterId)
    return { runId: run.id, runStartedAt: run.startedAt, runStatus: run.status, mode: run.organization?.mode ?? 'full', scope: run.scope ?? 'fullBook', step: workStep, kind: work.kind, objectKey: work.id, label: `${item?.name || work.characterId}（${work.characterId}）`, characterId: work.characterId, status: item?.status ?? 'pending', requestCount: work.requestCount, hasTrace: work.requestCount > 0 } as OrganizationStepIndexEntry
  }
}

/** 只替换已落库的新完成记录对应的旧详情；业务报告、回执、P3及续跑会话保留。 */
export async function pruneOrganizationHistory(workspace: ReturnType<typeof createWorkspace>, bookId: string, completion?: { runId: string; step: 'profiles' | 'relations'; characterId: string }) {
  const db = workspace.openBook(bookId)
  return withTraceBarrier(async () => transact(db, 'rw', [db.table('pipelineRuns'), db.table('storySessionEntries'), db.table('storySessions')], async (db) => {
    const unit = completion ? `${completion.step === 'profiles' ? 'profile' : 'relations'}:${completion.characterId}` : undefined
    const index = unit ? await db.table('pipelineRuns').get(historyIndexId(unit)) : undefined
    const indexed = index?.recordType === 'history_index' && index.bookId === bookId && index.historyIndexVersion === 1 && index.historyUnit === unit
    const source = indexed
      ? (await db.table<WorldRun>('pipelineRuns').bulkGet([...new Set([...strings(index.historyRunIds), completion!.runId])])).filter((run): run is WorldRun => !!run)
      : await db.table<WorldRun>('pipelineRuns').where('stage').equals('P2').toArray()
    const runs = source.filter(run => run.bookId === bookId && run.workflow === 'character_organization_v1' && run.organization)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
    const latest = new Map<string, WorldRun>()
    const obsolete = new Map<string, Set<string>>()
    const retained = new Map<string, Set<string>>()
    for (const run of runs) for (const [kind, items] of [['profile', run.organization!.profileItems], ['relations', run.organization!.relationItems]] as const) {
      for (const item of items ?? []) {
        const key = `${kind}:${item.id}`, replacement = latest.get(key)
        if (unit && key !== unit) continue
        if (!retained.has(key)) retained.set(key, new Set())
        retained.get(key)!.add(run.id)
        if (replacement && run.id !== replacement.id && !['running', 'paused'].includes(run.status)) {
          if (!obsolete.has(run.id)) obsolete.set(run.id, new Set())
          obsolete.get(run.id)!.add(key)
        }
        if (!replacement && item.status === 'checked' && item.outcome !== 'unavailable') latest.set(key, run)
      }
    }
    // 确认新完成记录有最终请求落库；缺日志时不得用空记录替代旧链路。
    const valid = new Set<string>()
    const replacementRows = new Map<string, Row[]>()
    for (const [key, run] of latest) {
      if (![...obsolete.values()].some(keys => keys.has(key)) || !run.sessionId) continue
      if (!replacementRows.has(run.sessionId)) replacementRows.set(run.sessionId, await db.table('storySessionEntries').where('sessionId').equals(run.sessionId).toArray())
      const requests = replacementRows.get(run.sessionId)!.filter(row => row.type === 'request_trace' && row.runId === run.id && (row.unitId ?? row.workId) === key)
      if (requests.length && requests.every(row => row.final === true && row.complete !== false)) valid.add(key)
    }
    const sessionIds = [...new Set(runs.filter(run => [...(obsolete.get(run.id) ?? [])].some(key => valid.has(key))).map(run => run.sessionId).filter((id): id is string => !!id))]
    for (const sessionId of sessionIds) {
      const session = await db.table('storySessions').get(sessionId)
      if (session?.leaseOwner && Number(session.leaseUntil) > Date.now()) continue
      const rows: Row[] = await db.table('storySessionEntries').where('sessionId').equals(sessionId).toArray()
      const sessionRuns = runs.filter(run => run.sessionId === sessionId)
      const taskUnits = new Map(sessionRuns.flatMap(run => records(run.tasks).map(task => [text(task.taskId), text((task.input as Row | undefined)?.unitId)] as const)))
      const removed = new Set(rows.filter(row => {
        const unit = text(row.unitId ?? row.workId) || taskUnits.get(text(row.taskId)) || ''
        return valid.has(unit) && obsolete.get(text(row.runId))?.has(unit) && ['request_trace', 'prompt_snapshot', 'tool_snapshot', 'message', 'work_input', 'compaction'].includes(text(row.type))
      }).map(row => text(row.id)))
      // 快照只在没有保留请求引用时删除。
      const referenced = new Set(rows.filter(row => !removed.has(text(row.id))).flatMap(row => {
        const input = row.input as Row | undefined
        return [input?.systemPromptSnapshotId, input?.businessPromptSnapshotId, input?.toolSchemaSnapshotId].filter((id): id is string => typeof id === 'string')
      }))
      for (const row of rows) if (referenced.has(text(row.snapshotId ?? row.id))) removed.delete(text(row.id))
      for (const run of sessionRuns) for (const key of obsolete.get(run.id) ?? []) if (valid.has(key)) retained.get(key)?.delete(run.id)
      if (!removed.size) continue
      const byId = new Map(rows.map(row => [text(row.id), row]))
      const survivingParent = (id: unknown) => {
        const visited = new Set<string>()
        let next = text(id)
        while (removed.has(next) && !visited.has(next)) { visited.add(next); next = text(byId.get(next)?.parentId) }
        return removed.has(next) ? null : next || null
      }
      for (const row of rows) if (!removed.has(text(row.id)) && removed.has(text(row.parentId))) await db.table('storySessionEntries').put({ ...row, parentId: survivingParent(row.parentId) })
      if (session && removed.has(text(session.leafId))) {
        const next = { ...session }, leafId = survivingParent(session.leafId)
        if (leafId) next.leafId = leafId
        else delete next.leafId
        await db.table('storySessions').put(next)
      }
      await db.table('storySessionEntries').bulkDelete([...removed])
    }
    for (const [key, runIds] of retained) {
      const now = new Date().toISOString()
      await db.table('pipelineRuns').put({ id: historyIndexId(key), bookId, recordType: 'history_index', stage: 'P2', status: 'completed', planVersion: '2.2', startedAt: now, updatedAt: now, historyIndexVersion: 1, historyUnit: key, historyRunIds: [...runIds] })
    }
  }))
}
