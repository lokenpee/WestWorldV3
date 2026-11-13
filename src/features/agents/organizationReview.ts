import type { AgentStore, Row } from './repository'
import type { Scope } from './queries'
import { canonical, hash, records, strings, text } from './contracts'
import { effectivePairs, pairFromPerspective, pairKeyOf, syncRelations } from '../assets/relations'
import type { Character, CharacterRelation, CharacterRelationEdit, Lifecycle } from '../assets/types'

export const organizationReviewVersion = 2
export const profileFields = ['name', 'aliases', 'identity', 'age', 'ageText', 'gender', 'appearance', 'personality', 'background', 'speechStyleSample', 'roleWeight']

export function profileContent(row: Row) {
  return {
    name: row.name, aliases: row.aliases ?? [], identity: row.identity ?? '', profile: row.profile ?? {},
    appearance: row.appearance ?? '', personality: row.personality ?? '', background: row.background ?? '',
    speechStyleSample: row.speechStyleSample ?? '', mergeFacts: row.mergeFacts ?? [], sourceChapters: row.sourceChapters ?? [],
    ...(row.roleWeightSource === 'manual' || row.roleWeightSource === 'agent' ? { roleWeight: row.roleWeight } : {}),
  }
}

export async function reviewContext(store: AgentStore) {
  const people = await store.rows('characters') as unknown as Character[]
  const byId = new Map(people.map(row => [row.id, row]))
  const raw = await store.rows('characterRelations') as unknown as CharacterRelation[]
  const lifecycle = await store.rows('assetLifecycle') as unknown as Lifecycle[]
  const relations = syncRelations(raw, people, lifecycle).relations
  const pairs = effectivePairs(relations, await store.rows('characterRelationEdits') as unknown as CharacterRelationEdit[], people)
  const pairByKey = new Map(pairs.map(pair => [pair.pairKey, pair]))
  const pairsByPerson = new Map<string, typeof pairs>()
  for (const pair of pairs) for (const id of [pair.fromId, pair.toId]) {
    if (!pairsByPerson.has(id)) pairsByPerson.set(id, [])
    pairsByPerson.get(id)!.push(pair)
  }
  const unresolvedByPerson = new Map<string, typeof relations>()
  for (const relation of relations) {
    const ids = relation.sourceId && !relation.targetIds.length ? [relation.sourceId] : !relation.sourceId ? relation.targetIds : []
    for (const id of new Set(ids)) {
      if (!unresolvedByPerson.has(id)) unresolvedByPerson.set(id, [])
      unresolvedByPerson.get(id)!.push(relation)
    }
  }
  const profileCache = new Map<string, Promise<string>>(), pairCache = new Map<string, Promise<string>>()
  const profile = (id: string) => {
    if (!profileCache.has(id)) profileCache.set(id, store.wait(hash(profileContent((byId.get(id) ?? {}) as unknown as Row))))
    return profileCache.get(id)!
  }
  const pair = (key: string) => {
    if (!pairCache.has(key)) pairCache.set(key, (async () => {
      const [a, b] = JSON.parse(key) as [string, string]
      const current = pairFromPerspective(pairByKey.has(key) ? [pairByKey.get(key)!] : [], a, b, people)
      const { fingerprint: _fp, endpointRevisions: _revisions, editRevision: _edit, ...content } = current
      return store.wait(hash({ ...content, endpoints: [await profile(a), await profile(b)] }))
    })())
    return pairCache.get(key)!
  }
  const scan = async (id: string) => store.wait(hash({
    profile: await profile(id),
    pairs: await Promise.all((pairsByPerson.get(id) ?? []).map(async row => [row.pairKey, await pair(row.pairKey)])),
    unresolved: (unresolvedByPerson.get(id) ?? [])
      .map(row => ({ id: row.id, sourceName: row.sourceName, targetName: row.targetName, forwardLabel: row.forwardLabel, reverseLabel: row.reverseLabel, direction: row.direction, evidence: row.evidence })),
  }))
  return { people, byId, pairs, profile, pair, scan }
}
type ReviewContext = Awaited<ReturnType<typeof reviewContext>>

const newItem = (row: Character, fingerprint: string) => ({ id: row.id, name: row.name, status: 'pending', outcome: null, reason: '', contentFingerprint: fingerprint, readRefs: [], commitIds: [] })
export async function buildProfileReview(store: AgentStore, organization: Row) {
  const people = await store.rows('characters') as unknown as Character[]
  organization.profileItems = await Promise.all(people.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })).map(async row => newItem(row, await store.wait(hash(profileContent(row as unknown as Row))))))
  organization.relationItems = []; organization.pairChecks = []
  organization.reviewVersion = organizationReviewVersion
  organization.reviewStartedAt = new Date().toISOString()
  organization.statisticsPending = false
  organization.step = 'profiles'
}

async function synchronizePairs(context: ReviewContext, organization: Row) {
  const targetId = text(organization.targetCharacterId)
  const scoped = organization.mode && organization.mode !== 'full' && targetId
    ? context.pairs.filter(row => row.fromId === targetId || row.toId === targetId)
    : context.pairs
  const scopedKeys = new Set(scoped.map(row => row.pairKey))
  const allPrevious = records(organization.pairChecks)
  const previous = allPrevious.filter(row => scopedKeys.has(text(row.pairKey)))
  const retained = organization.mode && organization.mode !== 'full' ? allPrevious.filter(row => !scopedKeys.has(text(row.pairKey))) : []
  const keys = new Set([...scopedKeys, ...previous.map(row => text(row.pairKey))])
  const previousByKey = new Map(previous.map(row => [text(row.pairKey), row]))
  const next: Row[] = []
  for (const key of keys) {
    const ids = JSON.parse(key) as string[]
    if (ids.length !== 2 || ids.some(id => !context.byId.has(id))) continue
    const fingerprint = await context.pair(key), old = previousByKey.get(key)
    next.push(old?.fingerprint === fingerprint ? old : { pairKey: key, fingerprint, outcome: null, reason: '', basis: [], commitIds: [] })
  }
  organization.pairChecks = [...retained, ...next]
}

export async function buildRelationReview(store: AgentStore, organization: Row) {
  const context = await reviewContext(store)
  await synchronizePairs(context, organization)
  const old = records(organization.relationItems)
  organization.relationItems = await Promise.all(context.people.map(async row => {
    const fingerprint = await context.scan(row.id), item = old.find(item => item.id === row.id)
    return item?.contentFingerprint === fingerprint ? item : newItem(row, fingerprint)
  }))
  organization.step = 'relations'
}

export async function refreshReview(store: AgentStore, organization: Row, context?: ReviewContext) {
  if (Number(organization.reviewVersion) !== organizationReviewVersion || ['scan', 'resolve'].includes(text(organization.step))) return
  const current = context ?? await reviewContext(store)
  for (const field of ['profileItems', 'relationItems']) for (const item of records(organization[field])) {
    const id = text(item.id)
    if (!current.byId.has(id)) { Object.assign(item, { status: 'checked', outcome: 'unavailable', reason: '人物已删除或合并，不再重复处理。', readRefs: [], commitIds: [] }); continue }
    const fingerprint = field === 'profileItems' ? await current.profile(id) : await current.scan(id)
    if (item.contentFingerprint !== fingerprint) Object.assign(item, { status: 'pending', outcome: null, reason: '', contentFingerprint: fingerprint, readRefs: [], commitIds: [], uncertainFields: [] })
  }
  if (records(organization.relationItems).length) await synchronizePairs(current, organization)
  if (['relations', 'finalize', 'done'].includes(text(organization.step)) && records(organization.profileItems).some(item => item.status === 'pending')) organization.step = 'profiles'
  else if (['finalize', 'done'].includes(text(organization.step)) && (records(organization.relationItems).some(item => item.status === 'pending') || pendingPairChecks(organization).length)) organization.step = 'relations'
}

export function pendingPairChecks(organization: Row) {
  const targetId = text(organization.targetCharacterId)
  const scoped = organization.mode && organization.mode !== 'full' && targetId
    ? records(organization.pairChecks).filter(pair => {
      try { return (JSON.parse(text(pair.pairKey)) as string[]).includes(targetId) } catch { return false }
    })
    : records(organization.pairChecks)
  return scoped.filter(pair => !pair.outcome)
}

function noteRead(item: Row, fingerprint: string, fragment?: Row) {
  if (!fragment) { item.readRefs = [fingerprint]; return true }
  const start = Number(fragment.charOffset), end = start + text(fragment.text).length, total = Number(fragment.totalChars)
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(total) || end > total) return false
  const refs = strings(item.readRefs).filter(ref => ref.startsWith(`${fingerprint}:`))
  refs.push(`${fingerprint}:${start}:${end}:${total}`)
  const ranges = refs.map(ref => ref.split(':').slice(1).map(Number)).filter(range => range[2] === total).sort((a, b) => a[0] - b[0])
  let covered = 0
  for (const [from, to] of ranges) { if (from > covered) break; covered = Math.max(covered, to) }
  item.readRefs = covered >= total ? [fingerprint] : [...new Set(refs)]
  return covered >= total
}

// 只登记真正返回给模型的完整资料；目录、遗漏字段及不连续片段不能充当已读。
export async function noteOrganizationRead(store: AgentStore, scope: Scope, name: string, args: Row, value: Row): Promise<Set<string>> {
  const complete = new Set<string>()
  if (scope.phase !== 'character_organization' || !['get_character_detail', 'get_character_relation', 'get_organization_progress'].includes(name)) return complete
  const run = await store.get('pipelineRuns', scope.runId)
  if (!run?.organization) return complete
  const organization = structuredClone(run.organization) as Row
  const before = canonical(organization), context = await reviewContext(store)
  await refreshReview(store, organization, context)
  if (name === 'get_character_detail') for (const row of records(value.data)) {
    const id = text(row.id)
    if (!context.byId.has(id) || row.fields_omitted) continue
    const fragment = typeof row.charOffset === 'number' ? row : undefined
    if (!fragment) complete.add(id)
    if (organization.step === 'profiles' && args.include_facts === true) {
      const item = records(organization.profileItems).find(item => item.id === id)
      if (item && noteRead(item, await context.profile(id), fragment)) complete.add(id)
    }
  }
  if (name === 'get_character_relation' && organization.step === 'relations' && typeof (value.data as Row)?.pairKey === 'string') {
    const data = value.data as Row, key = text(data.pairKey), fingerprint = await context.pair(key)
    const pairs = records(organization.pairChecks), item = pairs.find(row => row.pairKey === key)
    if (item) item.readFingerprint = fingerprint
    else pairs.push({ pairKey: key, fingerprint, readFingerprint: fingerprint, outcome: null, reason: '', basis: [], commitIds: [] })
    organization.pairChecks = pairs
  }
  if (canonical(organization) !== before) await store.put('pipelineRuns', { ...run, organization })
  return complete
}

export async function hasProfileRead(store: AgentStore, scope: Scope, id: string) {
  const run = await store.get('pipelineRuns', scope.runId), organization = run?.organization as Row | undefined
  const item = records(organization?.profileItems).find(item => item.id === id)
  const row = await store.get('characters', id)
  return !!row && !!item && strings(item.readRefs).includes(await store.wait(hash(profileContent(row))))
}

export function actualReviewEdits(run: Row, kind: 'character' | 'relation', id: string) {
  const organization = run.organization as Row
  return records((run.report as Row)?.assetEdits).filter(edit => edit.kind === kind && edit.id === id && records(edit.fieldChanges).length > 0
    && (kind !== 'character' || ['edit_character', 'submit_profile_review'].includes(String(edit.tool))) && text(edit.timestamp) >= text(organization.reviewStartedAt))
}

export async function noteOrganizationWrite(store: AgentStore, scope: Scope, name: string, args: Row, changed: boolean) {
  if (scope.phase !== 'character_organization' || !changed || !['edit_character', 'set_character_relation', 'delete_character_relation'].includes(name)) return
  const run = await store.get('pipelineRuns', scope.runId)
  if (!run?.organization) return
  const organization = structuredClone(run.organization) as Row, context = await reviewContext(store)
  if (name === 'edit_character') {
    const id = text(args.id), item = records(organization.profileItems).find(item => item.id === id)
    if (item) {
      const read = strings(item.readRefs).includes(text(item.contentFingerprint)), fingerprint = await context.profile(id)
      Object.assign(item, { contentFingerprint: fingerprint, ...(read ? { readRefs: [fingerprint] } : { readRefs: [] }) })
      if (item.status === 'checked') Object.assign(item, { outcome: 'changed', reason: text(args.reason), commitIds: actualReviewEdits(run, 'character', id).map(edit => text(edit.commitId)) })
    }
  }
  const key = name === 'edit_character' ? '' : pairKeyOf(text(args.fromId), text(args.toId))
  const oldPair = records(organization.pairChecks).find(item => item.pairKey === key)
  const hadPairRead = oldPair && oldPair.readFingerprint === oldPair.fingerprint
  const affected = name === 'edit_character' ? [text(args.id)] : [text(args.fromId), text(args.toId)]
  const scanReads = new Set(records(organization.relationItems).filter(item => affected.includes(text(item.id)) && strings(item.readRefs).includes(text(item.contentFingerprint))).map(item => text(item.id)))
  await refreshReview(store, organization, context)
  const nextPair = records(organization.pairChecks).find(item => item.pairKey === key)
  if (nextPair && hadPairRead) nextPair.readFingerprint = nextPair.fingerprint
  for (const item of records(organization.relationItems)) if (scanReads.has(text(item.id))) item.readRefs = [item.contentFingerprint]
  await store.put('pipelineRuns', { ...run, organization })
}
