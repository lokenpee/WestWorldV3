import { canonical, hash, records, strings, text } from '../agents/contracts'
import type { AgentRepository, AgentStore, Row } from '../agents/repository'
import { storyContent } from '../story/coverage'

export const identityBatchSize = 3
const tables = { character: 'characters', location: 'locations' } as const
export const identityWorkId = (kind: string, id: string) => `ai_identity:fullBook:${kind}:${encodeURIComponent(id)}`

export function identityContent(row: Row | null) {
  if (!row) return null
  const { revision: _revision, updatedAt: _updatedAt, frequency: _frequency, ...content } = row
  if (!['manual', 'agent'].includes(String(row.roleWeightSource ?? ''))) { delete content.roleWeight; delete content.roleWeightSource }
  return content
}
export const coverageFingerprint = (table: string, row: Row | null) => hash(['characters', 'locations'].includes(table) ? identityContent(row) : ['nodes', 'eventLines'].includes(table) ? storyContent(table, row) : row)

// 浏览目录用于寻找候选；持久核实依据保留实际打开的详情及原文。
export function identityDependencies(value: unknown): Row {
  const reads = value as Row | undefined
  const details: Record<string, string> = { get_character_detail: 'characters', get_location_detail: 'locations', get_node_detail: 'nodes', get_event_line_detail: 'eventLines' }
  const ids = new Set(records(reads?.queries).flatMap(query => details[text(query.tool)] ? strings((query.args as Row)?.ids).map(id => `${details[text(query.tool)]}:${id}`) : []))
  return structuredClone({ records: records(reads?.records).filter(row => row.table === 'chapterTexts' || ids.has(`${row.table}:${row.id}`) || ids.has(`${row.table}:${row.resolvedId}`)), queries: records(reads?.queries).filter(query => !!details[text(query.tool)] || query.tool === 'read_original') })
}

export function clearIdentityFailures(report: Row, ids: string[]) {
  return { ...report, failed: strings(report.failed).filter(message => !ids.some(id => message.startsWith(`${id}：`))) }
}

export async function acceptIdentityMerge(store: AgentStore, runId: string, taskId: string, kind: string, memberIds: string[], keepId: string, readSet: unknown) {
  const run = await store.get('pipelineRuns', runId)
  if (!run) return
  const table = kind === 'character' ? 'characters' : 'locations'
  const kept = await store.get(table, keepId)
  if (!kept) return
  const fingerprint = await store.wait(coverageFingerprint(table, kept))
  const evidence = identityDependencies(readSet)
  evidence.records = records(evidence.records).filter(row => row.table === 'chapterTexts')
  const coverageItems = records(run.coverageItems).map(item => {
    if (item.kind === kind && memberIds.includes(text(item.id))) return {
      ...item, status: item.id === keepId ? 'checked' : 'skipped', outcome: item.id === keepId ? 'changed' : 'deleted',
      coveredFingerprint: fingerprint, coveredRevision: Number(kept.revision ?? 0), dependencies: evidence, taskId,
      reason: '身份合并已提交。', updatedAt: new Date().toISOString(),
    }
    const dependencies = identityDependencies(item.dependencies)
    dependencies.records = records(dependencies.records).map(dependency => dependency.table === table && memberIds.includes(text(dependency.resolvedId ?? dependency.id))
      ? { ...dependency, resolvedId: keepId, revision: Number(kept.revision ?? 0), factFingerprint: fingerprint } : dependency)
    return { ...item, dependencies }
  })
  await store.put('pipelineRuns', { ...run, ...(run.coverageItems ? { coverageItems } : {}), ...(run.report ? { report: clearIdentityFailures(run.report as Row, memberIds) } : {}) })
}

export async function saveIdentityQueue(repo: AgentRepository, runId: string, options: { owner?: string; signal?: AbortSignal } = {}) {
  const snapshot = await repo.transaction(false, async store => {
    const run = (await store.get('pipelineRuns', runId))!
    const characters = await store.rows('characters'), locations = await store.rows('locations')
    const data = new Map<string, Row | null>()
    for (const [table, rows] of [['characters', characters], ['locations', locations]] as const) for (const row of rows) data.set(`${table}:${row.id}`, row)
    for (const item of records(run.coverageItems)) for (const dependency of records(identityDependencies(item.dependencies).records)) {
      const table = text(dependency.table), id = text(dependency.resolvedId ?? dependency.id), key = `${table}:${id}`
      if (['characters', 'locations', 'chapterTexts', 'nodes', 'eventLines'].includes(table) && !data.has(key)) data.set(key, await store.get(table, id) ?? null)
    }
    return { run, characters, locations, data }
  })
  options.signal?.throwIfAborted()
  const { run, characters, locations, data } = snapshot
  const fingerprints = new Map(await Promise.all([...data].map(async ([key, row]) => [key, await coverageFingerprint(key.split(':')[0], row)] as const)))
  const previous = records(run.coverageItems)
  const items: Row[] = []
  for (const [kind, table] of Object.entries(tables)) for (const row of table === 'characters' ? characters : locations) {
    const fingerprint = fingerprints.get(`${table}:${row.id}`)!
    const workItemId = identityWorkId(kind, text(row.id))
    const old = previous.find(item => item.workItemId === workItemId)
    const dependencies = identityDependencies(old?.dependencies)
    const hasResult = old?.status === 'checked' || !!old?.taskId && ['changed', 'no_change', 'needs_review'].includes(text(old?.outcome))
    let current = hasResult && old?.coveredFingerprint === fingerprint
    if (current) for (const dependency of records(dependencies.records)) {
      if (!['characters', 'locations', 'chapterTexts', 'nodes', 'eventLines'].includes(text(dependency.table))) continue
      if (fingerprints.get(`${dependency.table}:${dependency.resolvedId ?? dependency.id}`) !== dependency.factFingerprint) { current = false; break }
    }
    items.push({ workItemId, phase: 'ai_identity', kind, id: row.id, status: current ? 'checked' : 'pending', inputRevision: row.revision, inputFingerprint: fingerprint, coveredRevision: old?.coveredRevision ?? 0, coveredFingerprint: old?.coveredFingerprint ?? '', dependencies, taskId: old?.taskId ?? null, outcome: old?.outcome ?? null, reason: old?.reason ?? '', invalidations: Number(old?.invalidations ?? 0) + (old?.status === 'checked' && !current ? 1 : 0), updatedAt: new Date().toISOString() })
  }
  items.sort((a, b) => text(a.kind).localeCompare(text(b.kind)) || (text(a.id) < text(b.id) ? -1 : text(a.id) > text(b.id) ? 1 : 0))
  const live = new Set(items.map(row => row.workItemId))
  const removed: Row[] = previous.filter(row => !live.has(row.workItemId)).map(row => ({ ...row, status: 'skipped', outcome: 'deleted', reason: '资料已合并或删除。' }))
  const pending = items.filter(row => row.status !== 'checked')
  const queue = { run, items, pending, coverageItems: [...items, ...removed], coverage: { total: items.length, checked: items.length - pending.length, pendingIds: pending.map(row => text(row.workItemId)) } }
  options.signal?.throwIfAborted()
  await repo.transaction(true, async store => {
    options.signal?.throwIfAborted()
    if (options.owner) {
      const lease = await store.get('pipelineRuns', 'lease:world')
      if (lease?.owner !== options.owner || lease.runId !== runId || Number(lease.expiresAt) <= Date.now()) throw new Error('队列执行权已变化，请继续AI整理。')
    }
    const current = (await store.get('pipelineRuns', runId))!
    if (canonical(current.coverageItems) !== canonical(run.coverageItems)) throw new Error('核实进度已更新，请继续AI整理。')
    const currentCharacters = await store.rows('characters'), currentLocations = await store.rows('locations')
    if (canonical(currentCharacters) !== canonical(characters) || canonical(currentLocations) !== canonical(locations)) throw new Error('资料已更新，请继续核对。')
    for (const [key, row] of data) if (!key.startsWith('characters:') && !key.startsWith('locations:') && canonical(await store.get(key.split(':')[0], key.slice(key.indexOf(':') + 1)) ?? null) !== canonical(row)) throw new Error('原文已更新，请继续核对。')
    const resolvedIds = [...items.filter(item => item.status === 'checked'), ...removed].map(item => text(item.id))
    await store.put('pipelineRuns', { ...current, coverageItems: queue.coverageItems, coverage: queue.coverage, ...(current.report ? { report: clearIdentityFailures(current.report as Row, resolvedIds) } : {}) })
  })
  return queue
}
