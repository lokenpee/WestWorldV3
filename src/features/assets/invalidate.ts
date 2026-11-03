import { assetTables, type AssetKind } from './types'
import type { MergeStore, Row } from './mergeCore'

export interface AssetChange { kind: AssetKind; id: string }
interface Coverage { kind: string; id: string; status: string; invalidations: number; updatedAt: string; dependencies?: { records: { table: string; id: string; resolvedId: string | null }[] } }

/** 人工写入、提取补齐和资料修复共用的读取依赖失效规则。调用方负责事务。 */
export async function invalidateAssetProgress(store: MergeStore, changes: AssetChange[], timestamp: string, runs?: Row[]) {
  if (!changes.length) return
  const own = new Set(changes.map(change => `${change.kind}:${change.id}`))
  const dependencies = new Set(changes.map(change => `${assetTables[change.kind]}:${change.id}`))
  const affected = new Set<string>(changes.map(change => change.kind === 'character' || change.kind === 'location' ? 'P2' : 'P3'))
  for (const run of runs ?? await store.rows('pipelineRuns')) {
    if (run.recordType !== 'run' || !['P2', 'P3'].includes(String(run.stage)) || !Array.isArray(run.coverageItems)) continue
    let dirty = false
    const coverageItems = (run.coverageItems as Coverage[]).map(item => {
      const hit = own.has(`${item.kind}:${item.id}`) || item.dependencies?.records.some(record => dependencies.has(`${record.table}:${record.id}`) || dependencies.has(`${record.table}:${record.resolvedId}`))
      if (!hit || item.status === 'pending' || item.status === 'stale') return item
      dirty = true
      return { ...item, status: 'stale', invalidations: item.invalidations + 1, updatedAt: timestamp }
    })
    if (dirty) { await store.put('pipelineRuns', { ...run, coverageItems } as Row); affected.add(String(run.stage)) }
  }
  for (const stage of affected) {
    const progress = await store.get('compileProgress', stage)
    if (progress) await store.put('compileProgress', { ...progress, validity: 'stale', updatedAt: timestamp })
  }
}
