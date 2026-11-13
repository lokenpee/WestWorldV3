import type { createWorkspace } from '../../lib/storage/workspace'
import { records, strings, text } from '../agents/contracts'
import type { Row } from '../agents/repository'
import { resolveLifecycleId } from '../assets/relations'
import type { Candidate } from './candidates'
import { inheritedCandidates } from './identityCandidates'

type Workspace = ReturnType<typeof createWorkspace>
const key = (candidate: Candidate) => `${candidate.kind}:${candidate.memberIds.slice().sort().join('|')}`

export function combineCandidates(code: Candidate[], ai: Candidate[]) {
  const dismissed = new Set(ai.filter(row => row.dismissed).map(key))
  const combined = new Map(code.filter(row => !dismissed.has(key(row))).map(row => [key(row), row]))
  for (const row of ai) if (!row.dismissed && !dismissed.has(key(row))) {
    const prior = combined.get(key(row))
    combined.set(key(row), prior ? { ...row, reason: `代码发现：${prior.reason}\nAI判断：${row.reason}` } : row)
  }
  return [...combined.values()]
}

export async function readIdentityCandidates(workspace: Workspace, bookId: string): Promise<Candidate[]> {
  const db = workspace.openBook(bookId)
  const runs = (await db.table('pipelineRuns').where('stage').equals('P2').toArray()).filter(row => row.organization).sort((a, b) => text(b.startedAt).localeCompare(text(a.startedAt)))
  const mappings = await db.table('assetLifecycle').toArray(), people = await db.table('characters').toArray()
  return inheritedCandidates(runs).flatMap(group => {
    const memberIds = [...new Set(strings(group.memberIds).map(id => resolveLifecycleId(id, mappings as never)).filter((id): id is string => !!id && people.some(row => row.id === id)))]
    const run = runs.find(row => records((row.organization as Row).candidateGroups).some(item => item.id === group.id))
    return memberIds.length < 2 || !run ? [] : [{ id: `ai:${group.id}`, kind: 'character' as const, memberIds, reason: text(group.reason), ai: { runId: text(run.id), groupId: text(group.id) }, dismissed: group.status === 'resolved' }]
  })
}

export async function dismissIdentityCandidate(workspace: Workspace, bookId: string, candidate: Candidate) {
  if (!candidate.ai) return
  const db = workspace.openBook(bookId)
  await db.transaction('rw', db.table('pipelineRuns'), async () => {
    const runs = await db.table('pipelineRuns').toArray()
    if (runs.some(row => row.recordType === 'lease' && Number(row.expiresAt ?? 0) > Date.now())) throw new Error('本书正在处理，请结束后再确认候选。')
    const run = runs.find(row => row.id === candidate.ai!.runId)
    if (!run?.organization) throw new Error('候选记录不存在，请刷新列表。')
    const organization = run.organization as Row
    const groups = records(organization.candidateGroups), group = groups.find(row => row.id === candidate.ai!.groupId)
    if (!group) throw new Error('候选已更新，请重新打开。')
    group.status = 'resolved'; group.revision = Number(group.revision) + 1; group.updatedAt = new Date().toISOString()
    organization.candidateGroups = groups
    organization.candidateDecisions = [...records(organization.candidateDecisions).filter(row => row.groupId !== group.id), { groupId: group.id, memberIds: group.memberIds, memberNames: group.memberNames ?? [], outcome: 'not_same', reason: '用户确认不是同一人。', basis: [], commitIds: [], createdAt: group.updatedAt, originStep: 'scan' }]
    await db.table('pipelineRuns').put({ ...run, organization })
  })
}
