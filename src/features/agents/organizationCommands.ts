import type { AgentStore, Row } from './repository'
import { canonical, hash, records, strings, text } from './contracts'
import type { ReadSet } from './commands'
import type { Basis, Character, EventLine, EventNode, LocationAsset, RelationEvidence } from '../assets/types'
import { mergeWorldAssets } from '../assets/mergeCore'
import { applyAssetPatch } from '../assets/assetPatch'
import { pairFromPerspective, resolveLifecycleId } from '../assets/relations'
import { deleteCharacterPair, evidenceProblems, saveCharacterPair } from '../assets/relationEdits'

const relationFailureSignatures = new Map<string, { signature: string; count: number }>()
type RelationFailure = { targetId: string; code: string; message: string; recoverable: boolean; repeated: boolean; action: string }
const relationErrorSignatures = new Map<string, { signature: string; count: number; targetId: string; fingerprint: string; code: string; message: string }>()
import { readTool, type Scope } from './queries'
import { actualReviewEdits, buildProfileReview, buildRelationReview, hasProfileRead, pendingPairChecks, profileContent, profileFields, refreshReview, reviewContext } from './organizationReview'

async function organizationOf(store: AgentStore, scope: Scope) {
  const run = await store.get('pipelineRuns', scope.runId)
  if (!run || run.bookId !== scope.bookId) throw new Error('SCOPE:整理运行不属于当前书籍。')
  if (!run.organization) throw new Error('INVALID_ARGS:当前运行不是人物整理任务。')
  return { run, organization: run.organization as Row }
}

async function saveOrganization(store: AgentStore, run: Row, organization: Row) {
  await store.put('pipelineRuns', { ...run, organization: { ...organization, revision: Number(organization.revision ?? 1) + 1 } })
}

export async function hasCharacterDetailRead(store: AgentStore, scope: Scope, id: string, readSet: ReadSet) {
  if (await hasProfileRead(store, scope, id)) return true
  const ranges = new Map<string, number[][]>()
  for (const query of readSet.queries) {
    if (query.tool !== 'get_character_detail') continue
    const result = await readTool(store, scope, query.tool, query.args, 20)
    if (await store.wait(hash(result)) !== query.resultFingerprint) continue
    for (const row of records(result.data)) {
      if (row.id !== id && !strings(row.resolvedFrom).includes(id) || row.fields_omitted) continue
      if (typeof row.charOffset !== 'number' && typeof row.revision === 'number') return true
      if (typeof row.charOffset === 'number') {
        const key = `${(query.args as Row).include_facts === true}:${Number(row.totalChars)}`
        if (!ranges.has(key)) ranges.set(key, [])
        ranges.get(key)!.push([row.charOffset, row.charOffset + text(row.text).length])
      }
    }
  }
  for (const [key, parts] of ranges) {
    let end = 0
    for (const [start, stop] of parts.sort((a, b) => a[0] - b[0])) { if (start > end) break; end = Math.max(end, stop) }
    if (end >= Number(key.split(':')[1])) return true
  }
  return false
}

export async function assertBasis(store: AgentStore, scope: Scope, values: Row[], readSet: ReadSet) {
  if (!values.length) throw new Error('INVALID_ARGS:写入需要至少一条依据。')
  for (const value of values) {
    if (!text(value.summary).trim() || !value.source || typeof value.source !== 'object') throw new Error('INVALID_ARGS:依据须包含说明和来源。')
    const source = value.source as Row
    if (source.kind === 'asset') {
      const kind = text(source.assetKind) as 'character' | 'location' | 'node' | 'eventLine'
      const table = ({ character: 'characters', location: 'locations', node: 'nodes', eventLine: 'eventLines' } as Record<string, string>)[kind]
      if (!table) throw new Error('INVALID_ARGS:资产依据类型无效。')
      const mappings = await store.rows('assetLifecycle')
      const resolvedId = resolveLifecycleId(text(source.id), mappings as never, kind) ?? text(source.id)
      const row = await store.get(table, resolvedId)
      if (!row || row.bookId !== scope.bookId) throw new Error('INVALID_ARGS:资产依据不存在或不属于本书。')
      const read = kind === 'character' ? await hasCharacterDetailRead(store, scope, resolvedId, readSet) : readSet.records.some(item => item.table === table && ([text(source.id), resolvedId].includes(item.id) || [text(source.id), resolvedId].includes(text(item.resolvedId))))
      if (!read) throw new Error('INVALID_ARGS:资产依据须实际读取对应详情。')
    } else if (source.kind === 'chapter') {
      const chapter = await store.get('chapters', text(source.chapterIndex))
      if (!chapter || chapter.bookId !== scope.bookId) throw new Error('INVALID_ARGS:章节依据不存在或不属于本书。')
      const read = readSet.queries.some(query => {
        if (query.tool !== 'read_original') return false
        const args = query.args as Row
        return strings(args.chapter_indices).includes(text(source.chapterIndex))
          || (strings(args.chapter_range).length === 2 && text(source.chapterIndex) >= strings(args.chapter_range)[0] && text(source.chapterIndex) <= strings(args.chapter_range)[1])
          || strings(args.asset_ids).length > 0
      })
      if (!read) throw new Error('INVALID_ARGS:章节依据须在实际读取范围内。')
    } else if (source.kind === 'relation') {
      const read = readSet.queries.some(query => {
        const args = query.args as Row
        if (query.tool === 'get_character_relation') return text(args.fromId) === text(source.fromId) && text(args.toId) === text(source.toId)
        if (query.tool !== 'query_relation_work') return false
        const targets = strings(args.targetIds)
        return !targets.length || targets.includes(text(source.fromId)) || targets.includes(text(source.toId))
      })
      if (!read) throw new Error('INVALID_ARGS:关系依据须实际读取该人物对。')
    } else if (source.kind === 'legacy_relation') {
      const read = readSet.queries.some(query => query.tool === 'get_legacy_relation_records' && strings((query.args as Row).ids).includes(text(source.id)))
      if (!read) throw new Error('INVALID_ARGS:旧关系依据须实际读取该记录。')
    } else throw new Error('INVALID_ARGS:依据来源类型无效。')
  }
}

async function memberNames(store: AgentStore, ids: string[]) {
  const rows = await Promise.all(ids.map(id => store.get('characters', id)))
  return rows.map((row, index) => text(row?.name) || ids[index])
}

async function mergeNodes(store: AgentStore, scope: Scope, members: EventNode[], keepId: string, patch: Row, timestamp: string) {
  const keep = members.find(row => row.id === keepId)!
  const union = (field: keyof EventNode) => [...new Set(members.flatMap(row => Array.isArray(row[field]) ? row[field] as string[] : []))]
  const next: EventNode = {
    ...keep, ...patch, id: keepId, bookId: scope.bookId,
    actors: union('actors'), targets: union('targets'), actorIds: union('actorIds'), targetCharacterIds: union('targetCharacterIds'),
    eventLineIds: union('eventLineIds'), revision: keep.revision + 1, updatedAt: timestamp,
  } as EventNode
  await store.put('nodes', next as unknown as Row)
  const memberIds = members.map(row => row.id)
  const lines = (await store.rows('eventLines')) as unknown as EventLine[]
  for (const line of lines) {
    const nodeIds = [...new Set(line.nodeIds.map(id => id === keepId ? keepId : memberIds.includes(id) ? keepId : id))]
    if (canonical(nodeIds) === canonical(line.nodeIds)) continue
    await store.put('eventLines', { ...line, nodeIds, revision: line.revision + 1, updatedAt: timestamp } as unknown as Row)
  }
  for (const member of members) if (member.id !== keepId) await store.remove('nodes', member.id)
  const mappings = await store.rows('assetLifecycle')
  for (const id of memberIds) {
    const existing = mappings.find(row => row.key === `node:${id}`)
    await store.put('assetLifecycle', { ...(existing ?? { key: `node:${id}`, bookId: scope.bookId, kind: 'node', originId: id, revision: 0, updatedAt: timestamp }), currentId: keepId, state: id === keepId ? 'live' : 'merged', revision: Number(existing?.revision ?? 0) + 1, updatedAt: timestamp })
  }
  return next
}

async function mergeLines(store: AgentStore, scope: Scope, members: EventLine[], keepId: string, patch: Row, timestamp: string) {
  const keep = members.find(row => row.id === keepId)!
  const nodeIds = [...new Set(members.flatMap(row => row.nodeIds))]
  const nodes = await Promise.all(nodeIds.map(id => store.get('nodes', id))) as (EventNode | undefined)[]
  const chapters = [...new Set(nodes.filter((node): node is EventNode => !!node).map(node => node.chapterIndex))]
  const times = nodes.filter((node): node is EventNode => !!node).map(node => node.timeCoord).filter((value): value is string => !!value).sort()
  const next: EventLine = { ...keep, ...patch, id: keepId, bookId: scope.bookId, nodeIds, chapters, revision: keep.revision + 1, updatedAt: timestamp, ...(times.length ? { timeRange: [times[0], times[times.length - 1]] } : {}) } as EventLine
  if (!times.length) delete next.timeRange
  await store.put('eventLines', next as unknown as Row)
  const memberIds = members.map(row => row.id)
  for (const node of nodes) if (node) {
    const eventLineIds = [...new Set(strings(node.eventLineIds).map(id => memberIds.includes(id) ? keepId : id))].sort()
    if (canonical(eventLineIds) !== canonical(strings(node.eventLineIds))) await store.put('nodes', { ...node, eventLineIds, revision: node.revision + 1, updatedAt: timestamp } as unknown as Row)
  }
  for (const member of members) if (member.id !== keepId) await store.remove('eventLines', member.id)
  const mappings = await store.rows('assetLifecycle')
  for (const id of memberIds) {
    const existing = mappings.find(row => row.key === `eventLine:${id}`)
    await store.put('assetLifecycle', { ...(existing ?? { key: `eventLine:${id}`, bookId: scope.bookId, kind: 'eventLine', originId: id, revision: 0, updatedAt: timestamp }), currentId: keepId, state: id === keepId ? 'live' : 'merged', revision: Number(existing?.revision ?? 0) + 1, updatedAt: timestamp })
  }
  return next
}

async function mergeAssets(store: AgentStore, scope: Scope, args: Row, readSet: ReadSet, commitId: string, timestamp: string) {
  const kind = text(args.kind) as 'character' | 'location' | 'node' | 'eventLine'
  const table = ({ character: 'characters', location: 'locations', node: 'nodes', eventLine: 'eventLines' })[kind]
  if (!table) throw new Error('INVALID_ARGS:资产类型无效。')
  const memberIds = strings(args.memberIds), keepId = text(args.keepId)
  if (memberIds.length < 2 || new Set(memberIds).size !== memberIds.length || !memberIds.includes(keepId)) throw new Error('INVALID_ARGS:合并需要两个以上不同成员，且保留编号必须是成员之一。')
  const members = await Promise.all(memberIds.map(id => store.get(table, id)))
  if (members.some(row => !row || row.bookId !== scope.bookId)) throw new Error('NOT_FOUND:合并成员不存在或不属于本书。')
  const revisions = args.expectedRevisions as Row
  if (!revisions || memberIds.some(id => Number(revisions[id]) !== Number(members[memberIds.indexOf(id)]!.revision))) throw new Error('CONFLICT:合并成员版本已变化，请重新读取。')
  const basis = records(args.basis)
  await assertBasis(store, scope, basis, readSet)
  for (const id of memberIds) if (!basis.some(value => (value.source as Row)?.kind === 'asset' && text((value.source as Row).id) === id)) throw new Error('INVALID_ARGS:合并依据须覆盖每个成员。')
  const patch = (args.resultPatch ?? {}) as Row
  let asset: Row
  if (kind === 'character' || kind === 'location') {
    const keep = members.find(row => row!.id === keepId) as unknown as Character | LocationAsset
    const result = await mergeWorldAssets(store, {
      bookId: scope.bookId, kind, memberIds, keepId, canonicalName: text(patch.name) || keep.name,
      nameSource: keep.nameSource === 'manual' ? 'manual' : 'automatic', manualKeep: keep.manualKeep === true,
      expectedRevisions: Object.fromEntries(memberIds.map(id => [id, Number(revisions[id])])), commitId, actor: 'agent', timestamp,
    })
    asset = result.asset as unknown as Row
    if (Object.keys(patch).length) {
      const edit = await applyAssetPatch(store, { bookId: scope.bookId, kind, id: keepId, expectedRevision: Number(asset.revision), patch, reason: text(args.reason), evidence: [], basis: basis as unknown as Basis[], commitId, tool: 'merge_assets', actor: 'agent', timestamp })
      asset = edit.asset
    }
  } else if (kind === 'node') asset = await mergeNodes(store, scope, members as unknown as EventNode[], keepId, patch, timestamp) as unknown as Row
  else asset = await mergeLines(store, scope, members as unknown as EventLine[], keepId, patch, timestamp) as unknown as Row
  const run = await store.get('pipelineRuns', scope.runId)
  if (run) {
    const report = (run.report ?? {}) as Row
    const groups = records(report.groups)
    if (kind === 'character' || kind === 'location') groups.push({ method: 'ai_identity', kind, memberIds, memberNames: members.map(row => text(row!.name)), keepId, canonicalName: text(asset.name), aliases: strings(asset.aliases), sourceChapters: strings(asset.sourceChapters), conflicts: [], beforeTokens: 0, afterTokens: 0 })
    else await store.put('pipelineRuns', { ...run, report: { ...report, skipped: [...strings(report.skipped), `${kind === 'node' ? '事件节点' : '事件线'}合并：${memberIds.join('、')} → ${keepId}`] } })
    if (kind === 'character' || kind === 'location') await store.put('pipelineRuns', { ...(await store.get('pipelineRuns', scope.runId))!, report: { ...report, groups } })
  }
  return { changed: true, affected: [{ kind, id: keepId, revision: Number(asset.revision) }], asset: { id: keepId }, summary: '同类资产已合并。' }
}

async function submitProfileReview(store: AgentStore, scope: Scope, args: Row, commitId: string, timestamp: string) {
  const { run, organization } = await organizationOf(store, scope)
  const active = organization.activeWork as Row | null | undefined
  if (!active || active.kind !== 'profile' || !text(active.characterId)) throw new Error('INVALID_ARGS:当前没有待提交的人物资料工作项。')
  const id = text(active.characterId), item = records(organization.profileItems).find(row => row.id === id)
  if (!item) throw new Error('NOT_FOUND:人物资料工作项不存在。')
  const row = await store.get('characters', id) as unknown as Character | undefined
  if (!row || row.bookId !== scope.bookId) throw new Error('NOT_FOUND:人物不存在或不属于本书。')
  const expected = Number(active.dataVersion ?? row.revision)
  const patch = (args.patch ?? {}) as Row, reason = text(args.reason), done = args.done === true, uncertain = strings(args.uncertainFields)
  const basis = records(args.basis).length ? records(args.basis) as unknown as Basis[] : [{ summary: reason || '根据程序提供的当前人物资料整理', source: { kind: 'asset', assetKind: 'character', id } } as unknown as Basis]
  if (!done && !Object.keys(patch).length) throw new Error('INVALID_ARGS:done=false时请至少提交一项已确定的修改；没有修改可直接done=true表示无变化。')
  let changed = 0, revision = Number(row.revision), updated = row as unknown as Row
  if (Object.keys(patch).length) {
    try {
      const result = await applyAssetPatch(store, { bookId: scope.bookId, kind: 'character', id, expectedRevision: expected, patch, reason, evidence: [], basis, commitId, tool: 'submit_profile_review', actor: 'agent', timestamp })
      changed = result.changes.length
      revision = Number(result.asset.revision)
      updated = result.asset as unknown as Row
      if (changed) {
        const latest = (await store.get('pipelineRuns', scope.runId))!
        const report = (latest.report ?? {}) as Row
        await store.put('pipelineRuns', { ...latest, report: { ...report, assetEdits: [...records(report.assetEdits), result.record] } })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '资料提交失败。'
      if (/CONFLICT/.test(message)) throw new Error(`CONFLICT:人物资料版本已变化，请用query_character_profile读取最新版本后重新提交；当前版本${row.revision}。`)
      throw new Error(`INVALID_ARGS:${message}；请检查字段、编号和取值。`)
    }
  }
  const prior = actualReviewEdits(run, 'character', id).map(edit => text(edit.commitId))
  const commitIds = [...new Set([...strings(active.commitIds), ...prior, ...(changed ? [commitId] : [])])]
  const outcome = commitIds.length ? 'changed' : uncertain.length ? 'uncertain' : 'no_change'
  const description = reason || (outcome === 'changed' ? '已提交人物资料整理' : outcome === 'uncertain' ? '部分内容待确认' : '资料无需修改')
  if (done) {
    item.status = 'checked'; item.outcome = outcome; item.reason = description
    item.commitIds = commitIds; item.uncertainFields = uncertain
    item.contentFingerprint = await store.wait(hash(profileContent({ ...updated, revision } as unknown as Row)))
    delete item.lastError
    organization.activeWork = null
  } else {
    active.commitIds = commitIds
    active.dataVersion = revision
    active.draft = { patch, reason, uncertainFields: uncertain }
    item.reason = description
    item.commitIds = commitIds
    item.uncertainFields = uncertain
  }
  await saveOrganization(store, (await store.get('pipelineRuns', scope.runId))!, organization)
  return { changed: changed > 0, done, complete: done, summary: done ? '人物资料已保存并完成。' : '人物资料已保存，继续处理当前人物。', commitId, outcome }
}

type PreparedRelationChange = {
  targetId: string
  pair: ReturnType<typeof pairFromPerspective>
  action: 'set' | 'delete'
  forward: string[]
  reverse: string[]
  directionUnclear: boolean
  evidence: RelationEvidence[]
  basis: Basis[]
  reason: string
  review: boolean
  allowUnverified: boolean
  evidenceStatus?: 'verified' | 'unverified' | 'partial'
}

async function submitRelationReview(store: AgentStore, scope: Scope, args: Row, readSet: ReadSet, commitId: string) {
  const { organization } = await organizationOf(store, scope)
  const active = organization.activeWork as Row | null | undefined
  if (!active || active.kind !== 'relations' || !text(active.characterId)) throw new Error('INVALID_ARGS:当前没有待提交的人物关系工作项。')
  const id = text(active.characterId), item = records(organization.relationItems).find(row => row.id === id)
  if (!item) throw new Error('NOT_FOUND:人物关系工作项不存在。')
  const current = await store.get('characters', id) as unknown as Character | undefined
  if (!current || current.bookId !== scope.bookId) throw new Error('NOT_FOUND:人物不存在或不属于本书。')
  const context = await reviewContext(store)
  const changes = records(args.changes), uncertainPairs = records(args.uncertainPairs), done = args.done === true
  const failureKey = `${scope.runId}:${id}`
  const signature = await store.wait(hash({ changes, uncertainPairs, done }))
  const earlier = relationFailureSignatures.get(failureKey)
  if (earlier?.signature === signature) throw new Error('REPEATED_FAILURE:同一提交已失败且没有新依据或实质修正；请保留问题项待核对，继续其他工作，不要原样重试。')
  const rereadTargets = new Set<string>()
  for (const query of readSet.queries) {
    const queryArgs = query.args as Row
    if (query.tool === 'get_character_relation') { rereadTargets.add(text(queryArgs.fromId)); rereadTargets.add(text(queryArgs.toId)) }
    if (query.tool === 'get_character_detail') for (const target of strings(queryArgs.ids)) rereadTargets.add(target)
    if (query.tool === 'query_relation_work') for (const target of strings(queryArgs.targetIds)) rereadTargets.add(target)
  }
  for (const [key, record] of relationErrorSignatures) {
    if (!key.startsWith(`${failureKey}:error:`)) continue
    const currentPair = pairFromPerspective(context.pairs, id, record.targetId, context.people)
    if (rereadTargets.has(record.targetId) || currentPair.fingerprint !== record.fingerprint) relationErrorSignatures.delete(key)
  }

  const errors: string[] = []
  const failures: RelationFailure[] = []
  const prepared: PreparedRelationChange[] = []
  const seen = new Set<string>()
  const fail = (targetId: string, code: string, message: string) => {
    const fingerprint = targetId ? pairFromPerspective(context.pairs, id, targetId, context.people).fingerprint : ''
    const errorKey = `${failureKey}:error:${targetId}:${code}:${message}`
    const previous = relationErrorSignatures.get(errorKey)
    relationErrorSignatures.set(errorKey, { signature: `${code}:${message}`, count: (previous?.count ?? 0) + 1, targetId, fingerprint, code, message })
    failures.push({ targetId, code, message, recoverable: code === 'CONFLICT' || code === 'NOT_FOUND', repeated: !!previous, action: code === 'CONFLICT' ? '重新读取该人物对后重试' : code === 'NOT_FOUND' ? '刷新人物或关系目标后重试' : '修正字段后重试' })
  }
  if (!done && !changes.length && !uncertainPairs.length) errors.push('done=false时请提交部分修改或待核对人物对。')
  const basis = records(args.basis).length ? records(args.basis) as unknown as Basis[] : [{ summary: text(args.reason) || '根据程序提供的当前人物关系整理', source: { kind: 'asset', assetKind: 'character', id } } as unknown as Basis]

  for (const change of changes) {
    const targetId = text(change.targetId)
    if (!targetId) { fail('', 'INVALID_ARGS', '某条关系修改缺少targetId'); continue }
    if (targetId === id) { fail(targetId, 'INVALID_ARGS', `关系${targetId}不能指向自己`); continue }
    if (seen.has(targetId)) { fail(targetId, 'INVALID_ARGS', `同一提交重复targetId：${targetId}`); continue }
    seen.add(targetId)
    const target = await store.get('characters', targetId) as unknown as Character | undefined
    if (!target || target.bookId !== scope.bookId) { fail(targetId, 'NOT_FOUND', `关系目标不存在或不属于本书：${targetId}`); continue }
    const pair = pairFromPerspective(context.pairs, id, targetId, context.people)
    const action = text(change.action)
    if (action !== 'set' && action !== 'delete') { fail(targetId, 'INVALID_ARGS', `关系${targetId}的action无效；只能是set或delete`); continue }
    const reason = text(change.reason) || text(args.reason) || '整理人物关系'
    const evidence = records(change.evidence) as unknown as RelationEvidence[]
    const changeBasis = records(change.basis).length ? records(change.basis) as unknown as Basis[] : basis
    const forward = strings(change.forwardLabels), reverse = strings(change.reverseLabels)
    const directionUnclear = change.directionUnclear === undefined ? pair.directionUnclear : change.directionUnclear === true

    if (action === 'set') {
      if (!forward.length && !reverse.length) { fail(targetId, 'INVALID_ARGS', `关系${targetId}至少要有一个方向的标签；不确定的一向可以留空`); continue }
      const problems = evidence.length ? await evidenceProblems(store, scope.bookId, evidence) : []
      const annotatedEvidence = evidence.map((item, index) => {
        const problem = problems.find(problem => problem.index === index)
        return problem ? { ...item, verified: false, reason: problem.reason } : { ...item, verified: true }
      })
      const verifiedCount = annotatedEvidence.filter(item => item.verified).length
      const evidenceStatus: 'verified' | 'unverified' | 'partial' = evidence.length ? (verifiedCount === evidence.length ? 'verified' : verifiedCount > 0 ? 'partial' : 'unverified') : 'unverified'
      prepared.push({
        targetId, pair, action, forward, reverse, directionUnclear,
        evidence: annotatedEvidence, basis: changeBasis, reason, review: evidenceStatus !== 'verified', allowUnverified: true,
        evidenceStatus,
      })
      continue
    }

    // 删除整组关系属于高风险：必须有逐字原文，或有可追溯的冲突/识别错误依据。
    if (pair.state !== 'active') {
      prepared.push({ targetId, pair, action, forward: [], reverse: [], directionUnclear: false, evidence: [], basis: changeBasis, reason, review: false, allowUnverified: false })
      continue
    }
    const problems = evidence.length ? await evidenceProblems(store, scope.bookId, evidence) : []
    const annotatedEvidence = evidence.map((item, index) => {
      const problem = problems.find(problem => problem.index === index)
      return problem ? { ...item, verified: false, reason: problem.reason } : { ...item, verified: true }
    })
    const verifiedCount = annotatedEvidence.filter(item => item.verified).length
    const evidenceOk = verifiedCount > 0
    const conflict = records(change.basis).length ? records(change.basis) as unknown as Basis[] : records(args.basis).length ? basis : []
    let conflictOk = false, conflictError = ''
    if (!evidenceOk && conflict.length) {
      try { await assertBasis(store, scope, conflict as unknown as Row[], readSet); conflictOk = true }
      catch (error) { conflictError = `；${error instanceof Error ? error.message : '无法核对'}` }
    }
    if (!evidenceOk && !conflictOk) {
      const detail = problems.length ? `；${problems.map(problem => `第${problem.chapterIndex}章${problem.reason}`).join('；')}` : ''
      fail(targetId, 'INVALID_ARGS', `关系${targetId}删除关系需要逐字原文或可追溯的冲突/识别错误依据${conflictError || detail}`)
      continue
    }
    prepared.push({
      targetId, pair, action, forward: [], reverse: [], directionUnclear: false,
      evidence: evidenceOk ? annotatedEvidence : [], basis: conflictOk ? conflict : changeBasis,
      reason, review: false, allowUnverified: evidenceOk && problems.length > 0,
      ...(evidenceOk ? { evidenceStatus: problems.length ? 'partial' as const : 'verified' as const } : {}),
    })
  }

  const uncertainSeen = new Set<string>()
  const uncertainReasons = new Map<string, string>()
  for (const row of uncertainPairs) {
    const targetId = text(row.targetId)
    if (!targetId) { fail('', 'INVALID_ARGS', '待核对人物对缺少targetId'); continue }
    if (targetId === id) { fail(targetId, 'INVALID_ARGS', `待核对人物对不能指向自己：${targetId}`); continue }
    if (uncertainSeen.has(targetId)) continue
    uncertainSeen.add(targetId)
    uncertainReasons.set(targetId, text(row.reason))
    const target = await store.get('characters', targetId)
    if (!target || target.bookId !== scope.bookId) { fail(targetId, 'NOT_FOUND', `待核对人物对不存在或不属于本书：${targetId}`); continue }
    if (pairFromPerspective(context.pairs, id, targetId, context.people).state === 'absent') fail(targetId, 'INVALID_ARGS', `待核对人物对尚未建立：${targetId}`)
  }
  for (const row of records((active.draft as Row | null)?.uncertainPairs)) {
    const targetId = text(row.targetId)
    if (targetId && !uncertainReasons.has(targetId)) uncertainReasons.set(targetId, text(row.reason))
  }

  if (errors.length) {
    relationFailureSignatures.set(failureKey, { signature, count: 1 })
    throw new Error(`INVALID_ARGS:批量校验失败（${errors.length}项）：${errors.join('；')}`)
  }
  const appliedNow = new Set<string>()
  let acceptedChanges = 0
  const changedTargets = new Set<string>()
  let applyContext = context
  for (const change of prepared) {
    // 同一人物的 revision 会随前一条关系写入变化；每条写入前刷新指纹，避免同批合法修改互相判冲突。
    if (changedTargets.size) applyContext = await reviewContext(store)
    const livePair = pairFromPerspective(applyContext.pairs, id, change.targetId, applyContext.people)
    const knownFailure = [...relationErrorSignatures.entries()].find(([key, record]) => key.startsWith(`${failureKey}:error:${change.targetId}:`) && record.fingerprint === livePair.fingerprint && record.count >= 2)
    if (knownFailure) {
      const record = knownFailure[1]
      failures.push({ targetId: change.targetId, code: record.code, message: record.message, recoverable: record.code === 'CONFLICT' || record.code === 'NOT_FOUND', repeated: true, action: record.code === 'CONFLICT' ? '重新读取该人物对后重试' : record.code === 'NOT_FOUND' ? '刷新人物或关系目标后重试' : '修正字段后重试' })
      continue
    }
    let changed = false
    try {
      const result = change.action === 'set'
        ? await saveCharacterPair(store, {
            bookId: scope.bookId, fromId: id, toId: change.targetId, forwardLabels: change.forward, reverseLabels: change.reverse,
            directionUnclear: change.directionUnclear, evidence: change.evidence, basis: change.basis, reason: change.reason,
            allowUnverifiedEvidence: change.allowUnverified, evidenceStatus: change.evidenceStatus,
            expectedFingerprint: livePair.fingerprint, actor: 'agent', commitId, tool: 'submit_relation_review',
            operationKey: `${text(args.operationKey)}:${change.targetId}`, runId: scope.runId,
          })
        : await deleteCharacterPair(store, {
            bookId: scope.bookId, fromId: id, toId: change.targetId, forwardLabels: [], reverseLabels: [], directionUnclear: false,
            evidence: change.evidence, basis: change.basis, reason: change.reason, allowUnverifiedEvidence: false, evidenceStatus: change.evidenceStatus,
            expectedFingerprint: livePair.fingerprint, actor: 'agent', commitId, tool: 'submit_relation_review',
            operationKey: `${text(args.operationKey)}:${change.targetId}`, runId: scope.runId,
          })
      changed = result.changed
      acceptedChanges++
    } catch (error) {
      const message = error instanceof Error ? error.message : '提交失败。'
      const code = /^([A-Z_]+):/.exec(message)?.[1] ?? 'INVALID_ARGS'
      if (!['CONFLICT', 'NOT_FOUND', 'INVALID_ARGS'].includes(code)) throw error
      const errorKey = `${failureKey}:error:${change.targetId}:${code}:${message}`
      const previous = relationErrorSignatures.get(errorKey)
      relationErrorSignatures.set(errorKey, { signature: `${code}:${message}`, count: (previous?.count ?? 0) + 1, targetId: change.targetId, fingerprint: livePair.fingerprint, code, message })
      failures.push({
        targetId: change.targetId, code, message, repeated: !!previous,
        recoverable: code === 'CONFLICT' || code === 'NOT_FOUND',
        action: code === 'CONFLICT' ? '重新读取该人物对后重试' : code === 'NOT_FOUND' ? '刷新人物或关系目标后重试' : '修正字段后重试',
      })
      continue
    }
    if (changed) {
      appliedNow.add(change.targetId); changedTargets.add(change.targetId)
      for (const key of relationErrorSignatures.keys()) if (key.startsWith(`${failureKey}:error:${change.targetId}:`)) relationErrorSignatures.delete(key)
    }
  }

  const after = await reviewContext(store)
  const latestRun = (await store.get('pipelineRuns', scope.runId))!
  const changeByTarget = new Map(prepared.map(change => [change.targetId, change]))
  const relevantPairs = after.pairs.filter(row => row.fromId === id || row.toId === id)
  const editsByPair = new Map<string, Row[]>()
  for (const pair of relevantPairs) {
    const edits = actualReviewEdits(latestRun, 'relation', pair.pairKey)
    editsByPair.set(pair.pairKey, edits)
    if (edits.length) changedTargets.add(pair.fromId === id ? pair.toId : pair.fromId)
  }
  const reviewTargets = new Set(prepared.filter(change => change.review && appliedNow.has(change.targetId)).map(change => change.targetId))
  const commitIds = [...new Set([...editsByPair.values()].flat().map(edit => text(edit.commitId)).filter(Boolean))]
  const currentPairs = records(organization.pairChecks)
  const failedTargets = new Set(failures.map(failure => failure.targetId).filter(Boolean))
  const pairOutcomes = new Map<string, 'changed' | 'no_change' | 'uncertain'>()
  const nextPairChecks = new Map<string, Row>()
  for (const pair of relevantPairs) {
    const targetId = pair.fromId === id ? pair.toId : pair.fromId
    const edits = editsByPair.get(pair.pairKey) ?? []
    const latest = edits.at(-1)
    const existing = currentPairs.find(row => text(row.pairKey) === pair.pairKey)
    const explicitUncertain = uncertainReasons.get(targetId)
    const latestStatus = text(latest?.evidenceStatus)
    const retainedUncertain = !edits.length && text(existing?.outcome) === 'uncertain'
    const explicitNoChange = !edits.length && explicitUncertain === undefined && text(existing?.outcome) === 'no_change' && records(existing?.basis).length > 0
    const failure = failures.find(item => item.targetId === targetId)
    const pairOutcome = failure || explicitUncertain !== undefined || retainedUncertain
      ? 'uncertain'
      : edits.length ? 'changed' : 'no_change'
    pairOutcomes.set(pair.pairKey, pairOutcome)
    const reason = failure?.message ?? explicitUncertain
      ?? (edits.length ? text(latest?.reason) || changeByTarget.get(targetId)?.reason || '' : retainedUncertain || explicitNoChange ? text(existing?.reason) : '本次未提交修改，未逐对确认。')
    const pairCommitIds = failure ? [] : edits.length
      ? [...new Set(edits.map(edit => text(edit.commitId)).filter(Boolean))]
      : retainedUncertain || explicitNoChange ? strings(existing?.commitIds) : []
    const pairBasis = (failure ? [] : edits.length ? records(latest?.basis) : retainedUncertain || explicitNoChange ? records(existing?.basis) : []) as unknown as Basis[]
    const retainedStatus = retainedUncertain || explicitNoChange ? text(existing?.evidenceStatus) : ''
    const evidenceStatus = (latestStatus || retainedStatus) as 'verified' | 'unverified' | 'partial' | ''
    nextPairChecks.set(pair.pairKey, {
      ...(existing ?? {}), pairKey: pair.pairKey, fingerprint: pair.fingerprint,
      outcome: pairOutcome, reason, basis: pairBasis, commitIds: pairCommitIds,
      ...(evidenceStatus ? { evidenceStatus } : {}),
    })
  }
  const outcome = failures.length ? 'uncertain' : [...pairOutcomes.values()].includes('uncertain') ? 'uncertain' : [...pairOutcomes.values()].includes('changed') ? 'changed' : 'no_change'
  const description = failures.length
    ? `部分关系未提交：${failures.map(failure => `${failure.targetId || '未知目标'}（${failure.code}）`).join('、')}`
    : text(args.reason) || (outcome === 'uncertain' ? '部分关系待核对' : outcome === 'changed' ? '已提交人物关系修改' : '本次未提交修改，未逐对确认。')
  const uncertainTargets = new Set([...uncertainSeen, ...failedTargets])
  for (const pair of relevantPairs) {
    if (pairOutcomes.get(pair.pairKey) !== 'uncertain') continue
    uncertainTargets.add(pair.fromId === id ? pair.toId : pair.fromId)
  }
  const completed = done && failures.length === 0
  if (completed) {
    item.status = 'checked'; item.outcome = outcome; item.reason = description; item.commitIds = commitIds
    delete item.lastError
    organization.activeWork = null
    const pairs = records(organization.pairChecks)
    for (const [pairKey, next] of nextPairChecks) {
      const at = pairs.findIndex(row => text(row.pairKey) === pairKey)
      if (at < 0) pairs.push(next); else pairs[at] = next
    }
    organization.pairChecks = pairs
  } else {
    active.commitIds = commitIds
    active.draft = { changes, reason: text(args.reason), uncertainPairs: [...uncertainReasons].map(([targetId, reason]) => ({ targetId, reason })), failed: failures }
    item.reason = description; item.commitIds = commitIds
  }
  await saveOrganization(store, (await store.get('pipelineRuns', scope.runId))!, organization)
  const summary = completed ? '人物关系已保存并完成。' : failures.length
    ? acceptedChanges ? `人物关系已保存，${appliedNow.size}项本次写入；${failures.length}项未提交。` : `本次未提交任何修改：${failures.map(failure => `${failure.targetId || '未知目标'}：${failure.message}`).join('；')}`
    : '人物关系已保存，继续处理当前人物。'
  if (failures.length) relationFailureSignatures.set(failureKey, { signature, count: 1 })
  else relationFailureSignatures.delete(failureKey)
  return {
    ok: failures.length === 0, status: failures.length ? (acceptedChanges > 0 ? 'partial' as const : 'failed' as const) : 'succeeded' as const,
    changed: appliedNow.size > 0, done: completed, complete: completed, summary, ...(failures.length && !acceptedChanges ? {} : { commitId }), outcome,
    applied: [...appliedNow], cumulativeApplied: [...changedTargets], unverified: [...reviewTargets], uncertain: [...uncertainTargets], failed: failures,
  }
}

export async function replayOrganizationSubmit(store: AgentStore, scope: Scope, name: string, args: Row, readSet: ReadSet, commitId: string) {
  if (name === 'submit_profile_review') return submitProfileReview(store, scope, { patch: {}, done: true, reason: text(args.reason), uncertainFields: strings(args.uncertainFields) }, commitId, new Date().toISOString())
  if (name === 'submit_relation_review') return submitRelationReview(store, scope, { changes: [], uncertainPairs: [], done: true, reason: text(args.reason), basis: args.basis }, readSet, commitId)
}

export async function reconcileOrganizationAfterWrite(store: AgentStore, _scope: Scope, run: Row, name: string, args: Row, result: Row | undefined) {
  if (!run.organization || !result) return
  const organization = run.organization as Row
  const active = organization.activeWork as Row | null | undefined
  if (!active) return
  const affected = records(result.affected)
  const memberIds = strings(args.memberIds)
  const keepId = text(args.keepId)
  const activeId = text(active.characterId)
  let changed = false
  const invalidateProfile = (id: string) => {
    if (!id || id === text(active.characterId)) return
    const item = records(organization.profileItems).find(row => text(row.id) === id)
    if (item && item.status === 'checked') { item.status = 'pending'; item.outcome = null; item.reason = '受跨步骤修改影响，需要重新核对。'; item.lastError = null; changed = true }
  }
  const invalidateRelations = (ids: string[]) => {
    for (const item of records(organization.relationItems)) {
      if (!ids.includes(text(item.id))) continue
      if (text(item.id) === text(active.characterId) && active.kind === 'relations') continue
      if (item.status === 'checked') { item.status = 'pending'; item.outcome = null; item.reason = '受跨步骤修改影响，需要重新核对。'; item.lastError = null; changed = true }
    }
    for (const pair of records(organization.pairChecks)) {
      let members: string[] = []
      try { members = (JSON.parse(text(pair.pairKey)) as string[]) ?? [] } catch { members = [] }
      if (members.some(id => ids.includes(id))) { pair.outcome = null; pair.reason = '受跨步骤修改影响，需要重新核对。'; changed = true }
    }
  }
  const updateActive = async (nextId: string) => {
    const row = await store.get('characters', nextId)
    if (!row) return false
    if (nextId !== activeId) {
      active.id = `${active.kind === 'profile' ? 'profile' : 'relations'}:${nextId}`
      active.characterId = nextId; active.targetIds = [nextId]; active.targetId = nextId
      const field = active.kind === 'profile' ? 'profileItems' : active.kind === 'relations' ? 'relationItems' : null
      const items = field ? records(organization[field]) : []
      const item = items.find(row => text(row.id) === activeId)
      if (item) {
        const target = items.find(row => text(row.id) === nextId)
        if (target) {
          target.status = 'pending'; target.outcome = null; target.reason = '人物已合并到当前条目，需要重新核对。'; target.lastError = null
          organization[field!] = items.filter(row => text(row.id) !== activeId)
        } else {
          item.id = nextId; item.name = text(row.name)
        }
        changed = true
      }
    }
    active.dataVersion = Number(row.revision ?? active.dataVersion ?? 0)
    changed = true
    return true
  }
  if (activeId) {
    const direct = affected.find(row => text(row.kind) === 'character' && text(row.id) === activeId)
    if (direct) await updateActive(activeId)
    if (name === 'merge_assets' && text(args.kind) === 'character' && memberIds.includes(activeId) && keepId) await updateActive(keepId)
  }
  if (name === 'merge_assets' && text(args.kind) === 'character') {
    for (const id of [...memberIds, keepId]) { invalidateProfile(id); invalidateRelations([id]) }
  } else if (name === 'edit_character') {
    for (const row of affected) if (text(row.kind) === 'character') invalidateProfile(text(row.id))
  } else if (name === 'set_character_relation' || name === 'delete_character_relation') {
    const pairKey = text((result.pair as Row | undefined)?.pairKey)
    if (pairKey) {
      const pair = records(organization.pairChecks).find(row => text(row.pairKey) === pairKey)
      if (pair) { pair.outcome = null; pair.reason = '受跨步骤修改影响，需要重新核对。'; changed = true }
    }
  }
  if (changed) { organization.revision = Number(organization.revision ?? 1) + 1; run.organization = organization }
}

export async function applyOrganizationTool(store: AgentStore, scope: Scope, name: string, args: Row, readSet: ReadSet, commitId: string, timestamp: string) {
  if (name === 'submit_profile_review') return submitProfileReview(store, scope, args, commitId, timestamp)
  if (name === 'submit_relation_review') return submitRelationReview(store, scope, args, readSet, commitId)
  const { run, organization } = await organizationOf(store, scope)
  if (name === 'save_candidate_group') {
    const memberIds = [...new Set(strings(args.memberIds))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    if (memberIds.length < 2) throw new Error('INVALID_ARGS:疑似组至少需要两个不同人物。')
    for (const id of memberIds) {
      const row = await store.get('characters', id)
      if (!row || row.bookId !== scope.bookId) throw new Error('NOT_FOUND:疑似组成员不存在或不属于本书。')
      const read = readSet.queries.some(query => query.tool === 'query_character_catalog' || query.tool === 'get_character_detail' && strings((query.args as Row).ids).includes(id)) || readSet.records.some(item => item.table === 'characters' && item.id === id)
      if (!read) throw new Error('INVALID_ARGS:保存疑似组前须实际浏览或读取这些人物。')
    }
    const groups = records(organization.candidateGroups)
    const existing = text(args.groupId) ? groups.find(row => row.id === args.groupId) : groups.find(row => canonical(strings(row.memberIds)) === canonical(memberIds))
    if (text(args.groupId) && !existing) throw new Error('NOT_FOUND:疑似组不存在。')
    if (existing && args.expectedRevision !== undefined && Number(existing.revision) !== Number(args.expectedRevision)) throw new Error('CONFLICT:疑似组已更新，请重新读取。')
    const names = await memberNames(store, memberIds)
    const originStep = text(existing?.originStep) || text(scope.organizationStep) || text(organization.step)
    const group: Row = existing ?? { id: crypto.randomUUID(), memberIds, memberNames: names, reason: '', status: 'pending' as const, revision: 0, createdAt: timestamp, updatedAt: timestamp }
    const next: Row = { ...group, memberIds, memberNames: names, reason: text(args.reason), originStep, revision: Number(group.revision) + 1, updatedAt: timestamp }
    organization.candidateGroups = existing ? groups.map(row => row.id === group.id ? next : row) : [...groups, next]
    await saveOrganization(store, run, organization)
    return { changed: true, summary: '疑似组已保存。', groupId: next.id, revision: next.revision, reused: !!existing }
  }
  if (name === 'resolve_candidate_group') {
    const groups = records(organization.candidateGroups)
    const group = groups.find(row => row.id === text(args.groupId))
    if (!group) throw new Error('NOT_FOUND:疑似组不存在。')
    if (Number(group.revision) !== Number(args.expectedRevision)) throw new Error('CONFLICT:疑似组已更新，请重新读取。')
    const outcome = text(args.outcome)
    if (!['merged', 'not_same', 'uncertain', 'partial'].includes(outcome)) throw new Error('INVALID_ARGS:疑似组结论无效。')
    const basis = records(args.basis)
    await assertBasis(store, scope, basis, readSet)
    const commitIds = strings(args.commitIds)
    if (outcome === 'merged' || outcome === 'partial') {
      if (!commitIds.length) throw new Error('INVALID_ARGS:合并结论须引用实际合并确认。')
      const members = strings(group.memberIds)
      for (const commitId of commitIds) {
        const applied = records(run.appliedCommands).find(row => row.commitId === commitId)
        const intent = applied && records(run.commandIntents).find(row => row.operationKey === applied.operationKey)
        const payload = intent?.payload as Row | undefined
        if (!applied || intent?.toolName !== 'merge_assets' || payload?.kind !== 'character' || strings(payload.memberIds).filter(id => members.includes(id)).length < 2) throw new Error('INVALID_ARGS:提交确认必须来自本轮对该候选组成员的实际人物合并。')
      }
      const mappings = await store.rows('assetLifecycle')
      const resolved = members.map(id => resolveLifecycleId(id, mappings as never))
      const remaining = new Set(resolved).size
      if (resolved.some(id => !id) || (outcome === 'merged' ? remaining !== 1 : remaining <= 1 || remaining >= members.length)) throw new Error('CONFLICT:合并结论与当前生命周期不一致。')
    }
    const next = { ...group, status: 'resolved' as const, revision: Number(group.revision) + 1, updatedAt: timestamp }
    const names = strings(group.memberNames).length ? strings(group.memberNames) : await memberNames(store, strings(group.memberIds))
    const decisions = records(organization.candidateDecisions).filter(row => row.groupId !== group.id)
    const originStep = text(group.originStep) || text(scope.organizationStep) || text(organization.step)
    decisions.push({ groupId: group.id, memberIds: strings(group.memberIds), memberNames: names, outcome, reason: text(args.reason), basis, commitIds, createdAt: timestamp, originStep })
    organization.candidateGroups = groups.map(row => row.id === group.id ? next : row)
    organization.candidateDecisions = decisions
    await saveOrganization(store, run, organization)
    return { changed: true, summary: '疑似组结论已记录。' }
  }
  if (name === 'clear_candidate_groups') {
    if (Number(organization.revision) !== Number(args.expectedRevision)) throw new Error('CONFLICT:整理进度已更新，请重新读取。')
    const pending = records(organization.candidateGroups).filter(row => row.status !== 'resolved')
    if (pending.length) throw new Error(`INVALID_ARGS:仍有未处理疑似组：${pending.map(row => text(row.id)).join('、')}`)
    const clearedCount = records(organization.candidateGroups).length
    if (organization.step !== 'resolve') throw new Error('INVALID_ARGS:目录扫描和疑似组核实完成后才能清空并进入资料整理。')
    organization.candidateGroups = []
    await buildProfileReview(store, organization)
    await saveOrganization(store, run, organization)
    return { changed: clearedCount > 0, summary: '本轮疑似组工作集已清空。', clearedCount }
  }
  if (name === 'record_organization_progress') {
    await refreshReview(store, organization)
    if (text(args.action) === 'check_item') {
      const kind = text(args.kind), id = text(args.id)
      if (!kind || !id) throw new Error('INVALID_ARGS:请提供工作项类型和编号。')
      if (kind === 'scan_page') {
        if (organization.step !== 'scan') throw new Error('INVALID_ARGS:当前不在目录扫描步骤。')
        const pages = records(organization.scanPages)
        const page = pages.find(row => row.pageId === id)
        if (!page) throw new Error('NOT_FOUND:扫描页不存在。')
        organization.scanPages = pages.map(row => row.pageId === id ? { ...row, status: 'checked' } : row)
      } else if (kind === 'profile' || kind === 'relation_scan') {
        if (organization.step !== (kind === 'profile' ? 'profiles' : 'relations')) throw new Error('INVALID_ARGS:请按当前步骤登记人物检查。')
        const field = kind === 'profile' ? 'profileItems' : 'relationItems'
        const items = records(organization[field])
        const item = items.find(row => row.id === id)
        if (!item) throw new Error('NOT_FOUND:工作项不存在。')
        const outcome = text(args.outcome)
        if (!['changed', 'no_change', 'uncertain'].includes(outcome)) throw new Error('INVALID_ARGS:请提供本项结论。')
        if (!text(args.reason).trim()) throw new Error('INVALID_ARGS:请说明实际检查及整理结论。')
        if (!strings(item.readRefs).includes(text(item.contentFingerprint))) throw new Error(kind === 'profile' ? 'INVALID_ARGS:须完整读取该人物当前资料及事实底稿；长资料请续读完再登记。' : 'INVALID_ARGS:须完整读取该人物当前关系及关联资料再登记。')
        const context = await reviewContext(store)
        if (kind === 'relation_scan') {
          const pending = records(organization.pairChecks).filter(pair => (JSON.parse(text(pair.pairKey)) as string[]).includes(id) && !pair.outcome)
          if (pending.length) throw new Error(`INVALID_ARGS:该人物仍有未核对的人物对：${pending.slice(0, 10).map(pair => text(pair.pairKey)).join('、')}；读取具体关系后逐对登记。`)
        }
        const edits = kind === 'profile' ? actualReviewEdits(run, 'character', id) : records((run.report as Row)?.assetEdits).filter(edit => edit.kind === 'relation' && (JSON.parse(text(edit.id)) as string[]).includes(id) && records(edit.fieldChanges).length && text(edit.timestamp) >= text(organization.reviewStartedAt))
        const actual = edits.map(edit => text(edit.commitId)), proposed = strings(args.commitIds)
        if (proposed.some(commitId => !actual.includes(commitId)) || outcome === 'changed' && (!proposed.length || !actual.length)) throw new Error('INVALID_ARGS:已修改须引用该人物本次实际资料/关系修改确认，不能用合并或其他人物确认代替。')
        if (outcome === 'no_change' && actual.length) throw new Error('INVALID_ARGS:该人物本次已有实际修改，请登记changed或保留疑点的uncertain。')
        const uncertainFields = strings(args.uncertainFields)
        if (kind === 'profile' && outcome === 'uncertain' && (!uncertainFields.length || uncertainFields.some(field => !profileFields.includes(field)))) throw new Error('INVALID_ARGS:请用uncertainFields列明仍有疑点的具体资料字段；其他可确定字段仍须整理。')
        const fingerprint = kind === 'profile' ? await context.profile(id) : await context.scan(id)
        organization[field] = items.map(row => row.id === id ? { ...row, status: 'checked', outcome, reason: text(args.reason), contentFingerprint: fingerprint, commitIds: actual, uncertainFields } : row)
      } else if (kind === 'pair') {
        const pairs = records(organization.pairChecks)
        const pair = pairs.find(row => row.pairKey === id)
        if (!pair) throw new Error('NOT_FOUND:人物对工作项不存在。')
        if (organization.step !== 'relations') throw new Error('INVALID_ARGS:请在第三步登记人物对结论。')
        if (pair.outcome) return { changed: false, summary: '该人物对已核对，复用当前有效结果。' }
        if (pair.readFingerprint !== pair.fingerprint) throw new Error('INVALID_ARGS:须先读取该人物对当前关系再登记结论。')
        const outcome = text(args.outcome), basis = records(args.basis)
        if (!['changed', 'no_change', 'uncertain'].includes(outcome) || !text(args.reason).trim()) throw new Error('INVALID_ARGS:人物对须有实际结论和原因。')
        await assertBasis(store, scope, basis, readSet)
        const actual = actualReviewEdits(run, 'relation', id).map(edit => text(edit.commitId)), proposed = strings(args.commitIds)
        if (proposed.some(commit => !actual.includes(commit)) || outcome === 'changed' && (!actual.length || !proposed.length) || outcome === 'no_change' && actual.length) throw new Error('INVALID_ARGS:人物对结论与实际修改确认不符。')
        organization.pairChecks = pairs.map(row => row.pairKey === id ? { ...row, outcome, reason: text(args.reason), basis, commitIds: actual } : row)
      } else throw new Error('INVALID_ARGS:工作项类型无效。')
    } else if (text(args.action) === 'advance') {
      if (organization.step === 'scan') {
        if (records(organization.scanPages).some(row => row.status !== 'checked')) throw new Error('INVALID_ARGS:仍有未确认的目录页。')
        organization.step = 'resolve'
      } else if (organization.step === 'resolve') {
        if (records(organization.candidateGroups).length) throw new Error('INVALID_ARGS:请先处理并清空疑似组。')
        await buildProfileReview(store, organization)
      } else if (organization.step === 'profiles') {
        if (records(organization.profileItems).some(row => row.status !== 'checked')) throw new Error('INVALID_ARGS:仍有未检查的人物资料。')
        await buildRelationReview(store, organization)
      } else if (organization.step === 'relations') {
        if (records(organization.profileItems).some(row => row.status !== 'checked') || records(organization.relationItems).some(row => row.status !== 'checked') || pendingPairChecks(organization).length) throw new Error('INVALID_ARGS:仍有未完成或依据变化的资料/关系项，请重新读取进度。')
        organization.step = 'finalize'; organization.statisticsPending = true
      } else if (organization.step === 'finalize') {
        if (organization.statisticsPending) throw new Error('INVALID_ARGS:出场统计尚未完成。')
        organization.step = 'done'
      }
    } else throw new Error('INVALID_ARGS:进度动作无效。')
    await saveOrganization(store, run, organization)
    return { changed: true, summary: '整理进度已更新。', action: text(args.action), kind: text(args.kind), id: text(args.id), step: organization.step, revision: Number(organization.revision) + 1 }
  }
  if (name === 'merge_assets') return mergeAssets(store, scope, args, readSet, commitId, timestamp)
  throw new Error('INVALID_ARGS:未知的人物整理工具。')
}

export function organizationTool(name: string) {
  return ['save_candidate_group', 'resolve_candidate_group', 'clear_candidate_groups', 'record_organization_progress', 'merge_assets', 'submit_profile_review', 'submit_relation_review'].includes(name)
}
