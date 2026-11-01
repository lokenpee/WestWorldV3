import type { createWorkspace } from '../../lib/storage/workspace'
import type { Character, LocationAsset } from '../assets/types'
import { records, text } from '../agents/contracts'
import type { WorldKind } from '../assets/merge'
import type { MechanicalQueue, ProtectionRepair, WorldRun } from './types'

export async function repairAutomaticProtection(workspace: ReturnType<typeof createWorkspace>, bookId: string, runId: string, owner: string) {
  const db = workspace.openBook(bookId)
  const snapshot = await db.transaction('r', db.table('pipelineRuns'), db.table('characters'), db.table('locations'), db.table('assetLifecycle'), async () => ({
    runs: await db.table('pipelineRuns').where('stage').anyOf(['P2', 'manual_merge']).toArray(),
    characters: await db.table<Character>('characters').toArray(), locations: await db.table<LocationAsset>('locations').toArray(),
    lifecycle: await db.table('assetLifecycle').toArray(),
  }))
  const automatic = new Map<string, { kind: WorldKind; keepId: string; name: string }>()
  for (const run of snapshot.runs) for (const item of (run.mechanicalQueue as MechanicalQueue | undefined)?.items ?? []) {
    if (item.status !== 'completed' || item.confirmation !== 'exact_name' || item.manualSelection || item.protectionVersion === 1 || !item.commitId) continue
    const firstId = [...item.request.memberIds].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0]
    if (item.request.keepId !== firstId || item.memberNames.some(name => name.trim() !== item.request.canonicalName)) continue
    automatic.set(item.commitId, { kind: item.kind, keepId: item.request.keepId, name: item.request.canonicalName })
  }
  const protectedIds = new Set<string>()
  const candidates = new Map<string, { kind: WorldKind; id: string; name: string; at: string }>()
  for (const run of snapshot.runs.filter(run => run.stage === 'manual_merge')) for (const group of records(run.report?.groups)) {
    const key = `${group.kind}:${group.keepId}`, proof = automatic.get(run.id)
    if (!proof || proof.kind !== group.kind || proof.keepId !== group.keepId || proof.name !== group.canonicalName) {
      const origin = snapshot.lifecycle.find(row => row.kind === group.kind && row.originId === group.keepId)
      protectedIds.add(`${group.kind}:${origin?.currentId ?? group.keepId}`); continue
    }
    const at = text(run.finishedAt)
    if (at && (!candidates.has(key) || candidates.get(key)!.at < at)) candidates.set(key, { kind: proof.kind, id: proof.keepId, name: proof.name, at })
  }
  const changes: { row: Character | LocationAsset; kind: WorldKind }[] = []
  for (const [kind, rows] of [['character', snapshot.characters], ['location', snapshot.locations]] as const) for (const row of rows) {
    const key = `${kind}:${row.id}`, proof = candidates.get(key)
    if (!proof || protectedIds.has(key) || row.createdBy === 'manual' || row.name !== proof.name || row.updatedAt !== proof.at || !row.manualKeep && row.nameSource !== 'manual') continue
    changes.push({ row, kind })
  }
  if (!changes.length) return []
  return db.transaction('rw', db.table('pipelineRuns'), db.table('characters'), db.table('locations'), async () => {
    const lease = await db.table('pipelineRuns').get('lease:world')
    if (lease?.owner !== owner || lease.runId !== runId || lease.expiresAt <= Date.now()) throw new Error('合并保护修复前执行权已变化。')
    const repaired: ProtectionRepair[] = []
    for (const { row, kind } of changes) {
      const table = kind === 'character' ? 'characters' : 'locations', current = await db.table(table).get(row.id)
      if (!current || current.revision !== row.revision) continue
      await db.table(table).put({ ...current, nameSource: 'automatic', manualKeep: false, revision: current.revision + 1, updatedAt: new Date().toISOString() })
      repaired.push({ kind, id: row.id, name: row.name, beforeNameSource: row.nameSource ?? 'extracted', beforeManualKeep: row.manualKeep === true, reason: '按同名自动队列与提交记录修复自动来源标记。' })
    }
    const run = (await db.table<WorldRun>('pipelineRuns').get(runId))!
    await db.table('pipelineRuns').put({ ...run, report: { ...run.report, protectionRepairs: [...(run.report.protectionRepairs ?? []), ...repaired] } })
    return repaired
  })
}
