import { hash, records, strings, text } from '../agents/contracts'
import type { AgentStore, Row } from '../agents/repository'

export function storyContent(table: string, value: Row | null) {
  if (!value) return null
  const { revision: _revision, updatedAt: _updatedAt, ...row } = value
  if (table === 'nodes') {
    delete row.eventLineIds; delete row.order; delete row.offset
    for (const field of ['actors', 'targets', 'actorIds', 'targetCharacterIds']) if (!strings(row[field]).length) delete row[field]
  }
  if (table === 'characters' || table === 'locations') {
    delete row.frequency
    if (!['manual', 'agent'].includes(String(row.roleWeightSource ?? ''))) { delete row.roleWeight; delete row.roleWeightSource }
  }
  if (table === 'storyEditorNotes') delete row.validity
  return row
}
export const storyFingerprint = (table: string, row: Row | null) => hash(storyContent(table, row))
export const windowFingerprint = (window: unknown, nodes: unknown[]) => hash({ window, nodes: nodes.map(row => storyContent('nodes', row as Row)) })
export const storyTable = (kind: string) => ({ node: 'nodes', eventLine: 'eventLines', note: 'storyEditorNotes' } as Record<string, string>)[kind]

export function storyDependencies(value: unknown): Row {
  const reads = value as Row | undefined
  const details: Record<string, string> = { get_node_detail: 'nodes', get_event_line_detail: 'eventLines', get_character_detail: 'characters', get_location_detail: 'locations', get_editor_note_detail: 'storyEditorNotes' }
  const ids = new Set(records(reads?.queries).flatMap(query => details[text(query.tool)] ? strings((query.args as Row)?.ids).map(id => `${details[text(query.tool)]}:${id}`) : []))
  return structuredClone({ records: records(reads?.records).filter(row => row.table === 'chapterTexts' || ids.has(`${row.table}:${row.id}`) || ids.has(`${row.table}:${row.resolvedId}`)), queries: records(reads?.queries).filter(row => details[text(row.tool)] || row.tool === 'read_original') })
}

async function matches(store: AgentStore, table: string, id: string, fingerprint: unknown) {
  const row = await store.get(table, id) ?? null
  return fingerprint === await store.wait(storyFingerprint(table, row)) || fingerprint === await store.wait(hash(row))
}
export async function validStoryCoverage(store: AgentStore, item: Row, row: Row | null) {
  if (!row || item.status !== 'checked' && !(item.taskId && ['changed', 'no_change', 'needs_review'].includes(text(item.outcome)))) return false
  const table = storyTable(text(item.kind))
  if (item.coveredFingerprint !== await store.wait(storyFingerprint(table, row)) && item.coveredFingerprint !== await store.wait(hash(row))) return false
  for (const read of records(storyDependencies(item.dependencies).records)) if (!await matches(store, text(read.table), text(read.resolvedId ?? read.id), read.factFingerprint)) return false
  return true
}

export async function saveStoryCoverage(store: AgentStore, runId: string, task: Row, reviewed: Row[]) {
  const run = (await store.get('pipelineRuns', runId))!
  const coverageItems = records(run.coverageItems)
  const dependencies = storyDependencies(task.readSet)
  for (const read of records(dependencies.records)) read.factFingerprint = await store.wait(storyFingerprint(text(read.table), await store.get(text(read.table), text(read.resolvedId ?? read.id)) ?? null))
  for (const result of reviewed) {
    const work = records((task.input as Row)?.workItems).find(item => item.workItemId === result.workItemId)
    if (!work || !storyTable(text(work.kind))) continue
    const row = await store.get(storyTable(text(work.kind)), text(work.id))
    const item = { workItemId: work.workItemId, phase: task.phase, kind: work.kind, id: work.id, status: row ? 'checked' : 'skipped', inputRevision: Number(work.revision ?? 0), inputFingerprint: text(work.factFingerprint), coveredRevision: Number(row?.revision ?? 0), coveredFingerprint: await store.wait(storyFingerprint(storyTable(text(work.kind)), row ?? null)), dependencies, taskId: task.taskId, outcome: row ? result.outcome : 'deleted', reason: text(result.reason), invalidations: 0, updatedAt: new Date().toISOString() }
    const at = coverageItems.findIndex(item => item.workItemId === work.workItemId)
    if (at < 0) coverageItems.push(item); else coverageItems[at] = item
  }
  await store.put('pipelineRuns', { ...run, coverageItems })
}

export async function recoverStoryCoverage(store: AgentStore, runId: string) {
  const run = (await store.get('pipelineRuns', runId))!
  for (const task of records(run.tasks)) {
    if (!['window_link', 'global_review'].includes(text(task.phase))) continue
    const reviewed: Row[] = []
    for (const result of records(task.reviewedItems)) {
      if (records(run.coverageItems).some(item => item.workItemId === result.workItemId)) continue
      if (result.outcome === 'changed' ? !strings(task.appliedCommitIds).length : !['completed', 'partial'].includes(text(task.status))) continue
      const work = records((task.input as Row)?.workItems).find(item => item.workItemId === result.workItemId)
      if (!work) continue
      const read = records((task.readSet as Row)?.records).find(item => item.table === storyTable(text(work.kind)) && (item.resolvedId ?? item.id) === work.id)
      if (!read || !await matches(store, text(read.table), text(work.id), read.factFingerprint)) continue
      let current = true
      for (const dependency of records(storyDependencies(task.readSet).records)) if (!await matches(store, text(dependency.table), text(dependency.resolvedId ?? dependency.id), dependency.factFingerprint)) { current = false; break }
      if (current) reviewed.push(result)
    }
    if (reviewed.length) await saveStoryCoverage(store, runId, task, reviewed)
  }
}

export async function rebaseStoryCoverage(store: AgentStore, runId: string, before: Map<string, Row>) {
  const run = (await store.get('pipelineRuns', runId))!
  const cache = new Map<string, { old: string; oldRaw: string; current: string }>()
  const changed = async (table: string, id: string) => {
    const key = `${table}:${id}`, previous = before.get(key)
    if (!previous) return undefined
    if (!cache.has(key)) cache.set(key, { old: await store.wait(storyFingerprint(table, previous)), oldRaw: await store.wait(hash(previous)), current: await store.wait(storyFingerprint(table, await store.get(table, id) ?? null)) })
    return cache.get(key)!
  }
  for (const item of records(run.coverageItems)) {
    if (!['window_link', 'global_review'].includes(text(item.phase)) || item.status !== 'checked') continue
    const own = await changed(storyTable(text(item.kind)), text(item.id))
    if (own && [own.old, own.oldRaw].includes(text(item.coveredFingerprint))) item.coveredFingerprint = own.current
    item.dependencies = storyDependencies(item.dependencies)
    for (const dependency of records((item.dependencies as Row).records)) {
      const value = await changed(text(dependency.table), text(dependency.resolvedId ?? dependency.id))
      if (value && [value.old, value.oldRaw].includes(text(dependency.factFingerprint))) dependency.factFingerprint = value.current
    }
  }
  await store.put('pipelineRuns', run)
}
