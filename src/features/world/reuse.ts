import { records, strings, text } from '../agents/contracts'
import type { AgentStore, Row } from '../agents/repository'
import { reviewContext } from '../agents/organizationReview'

export type RestartMode = 'reuse' | 'all'

/** 采用最新一轮的逐项结论，旧的成功不能覆盖后来的失败或疑点。 */
export async function reuseOrganization(store: AgentStore, state: Row, step: string) {
  const runs = (await store.rows('pipelineRuns')).filter(run => run.organization).sort((a, b) => text(b.startedAt).localeCompare(text(a.startedAt)))
  const latest = (field: string, key: string) => {
    const result = new Map<string, Row>()
    for (const run of runs) {
      const organization = run.organization as Row
      for (const item of records(organization[field])) if (!result.has(text(item[key]))) result.set(text(item[key]), item)
      if (field === 'identityChecks') for (const page of records(organization.scanPages)) for (const id of strings(page.ids)) if (!result.has(id)) result.set(id, { id, fingerprint: '' })
    }
    return result
  }
  if (step === 'scan') {
    const context = await reviewContext(store), previous = latest('identityChecks', 'id')
    const pending = new Set(records(state.candidateGroups).filter(group => group.status !== 'resolved').flatMap(group => strings(group.memberIds)))
    const reusable: Row[] = []
    for (const id of strings(state.scanIds)) {
      const old = previous.get(id)
      if (old && !pending.has(id) && old.fingerprint === await context.scan(id)) reusable.push(old)
    }
    state.identityChecks = reusable
    state.reusedCount = reusable.length
    const ids = strings(state.scanIds).filter(id => !reusable.some(item => item.id === id))
    state.scanPages = Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) => ({ pageId: `scan:${index}`, ids: ids.slice(index * 100, (index + 1) * 100), nextCursor: (index + 1) * 100 < ids.length ? String(index + 1) : null, status: 'issued' }))
    return
  }
  const field = step === 'profiles' ? 'profileItems' : 'relationItems', previous = latest(field, 'id')
  const pairs = latest('pairChecks', 'pairKey')
  const good = (row: Row | undefined) => row && ['changed', 'no_change'].includes(text(row.outcome)) && !row.lastError && !strings(row.uncertainFields).length
  state[field] = records(state[field]).map(item => {
    const old = previous.get(text(item.id))
    const uncertainPair = step === 'relations' && [...pairs.values()].some(pair => strings(JSON.parse(text(pair.pairKey))).includes(text(item.id)) && !good(pair))
    return old?.status === 'checked' && good(old) && !uncertainPair && old.contentFingerprint === item.contentFingerprint ? { ...old, reused: true } : item
  })
  if (step === 'relations') state.pairChecks = records(state.pairChecks).map(pair => {
    const old = pairs.get(text(pair.pairKey))
    return good(old) && old!.fingerprint === pair.fingerprint ? old! : pair
  })
  state.reusedCount = records(state[field]).filter(item => item.reused).length
}
