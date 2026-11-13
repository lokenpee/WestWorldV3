import type { AgentStore, Row } from '../agents/repository'
import { canonical, records, strings, text } from '../agents/contracts'
import type { ReadSet } from '../agents/commands'
import { resolveLifecycleId } from '../assets/relations'
import { reviewContext } from '../agents/organizationReview'

export async function identityPage(store: AgentStore, organization: Row, requestedId = text(organization.identityPageId)) {
  const pages = records(organization.scanPages)
  const page = requestedId ? pages.find(row => row.pageId === requestedId) : pages.find(row => row.status !== 'checked')
  if (!page) return null
  organization.identityPageId = page.pageId
  organization.seenIdentityPageIds = [...new Set([...strings(organization.seenIdentityPageIds), text(page.pageId)])]
  const people = await store.rows('characters'), mappings = await store.rows('assetLifecycle')
  const ids = [...new Set(strings(page.ids).map(id => resolveLifecycleId(id, mappings as never)).filter((id): id is string => !!id))]
  return { pageId: page.pageId, pageNumber: pages.indexOf(page) + 1, totalPages: pages.length, people: ids.map(id => people.find(row => row.id === id)).filter((row): row is Row => !!row).map(row => ({ id: row.id, name: row.name, aliases: row.aliases ?? [], identity: row.identity ?? '' })) }
}

export async function navigateIdentityPages(store: AgentStore, organization: Row, args: Row) {
  const pages = records(organization.scanPages)
  const index = pages.findIndex(page => page.pageId === organization.identityPageId)
  if (index < 0 || args.currentPageId !== organization.identityPageId) throw new Error('CONFLICT:请使用当前阅读页编号翻页。')
  if (!['next', 'previous'].includes(text(args.direction))) throw new Error('INVALID_ARGS:请选择下一页或上一页。')
  if (args.direction === 'previous') {
    const page = await identityPage(store, organization, text(pages[Math.max(0, index - 1)].pageId))
    return { changed: index > 0, complete: false, page, summary: index ? '已返回上一页；离开的页未标记完成。' : '已经是第一页。' }
  }
  pages[index].status = 'checked'; delete pages[index].lastError
  const context = await reviewContext(store), checks = records(organization.identityChecks)
  for (const id of strings(pages[index].ids)) {
    const at = checks.findIndex(item => item.id === id), item = { id, fingerprint: await context.scan(id) }
    if (at < 0) checks.push(item); else checks[at] = item
  }
  organization.identityChecks = checks
  organization.scanPages = pages
  const next = pages[index + 1] ?? pages.find(page => page.status !== 'checked')
  const page = next ? await identityPage(store, organization, text(next.pageId)) : null
  return { changed: true, complete: !page, page, summary: page ? `当前页已完成，现为第${page.pageNumber}/${page.totalPages}页。` : '全部目录已处理完毕，疑似组等待用户核对。' }
}

export async function saveIdentityGroups(store: AgentStore, organization: Row, args: Row, reads: ReadSet, timestamp: string) {
  const pages = records(organization.scanPages)
  const people = await store.rows('characters'), mappings = await store.rows('assetLifecycle')
  const seen = new Set([...strings(organization.seenIdentityPageIds), text(organization.identityPageId)])
  const visible = new Set(pages.filter(row => row.status === 'checked' || seen.has(text(row.pageId))).flatMap(row => strings(row.ids)).map(id => resolveLifecycleId(id, mappings as never)))
  for (const read of reads.records) if (read.table === 'characters') visible.add(read.resolvedId ?? read.id)
  let groups = records(organization.candidateGroups)
  const saved: Row[] = []
  for (const proposed of records(args.groups)) {
    const memberIds = [...new Set(strings(proposed.memberIds).map(id => resolveLifecycleId(id, mappings as never) ?? ''))].sort()
    const combine = strings(proposed.groupIds)
    const prior = text(proposed.groupId) ? groups.find(row => row.id === proposed.groupId) : groups.find(row => canonical(strings(row.memberIds).slice().sort()) === canonical(memberIds))
    if (proposed.groupId && !prior || combine.some(id => !groups.some(row => row.id === id))) throw new Error('NOT_FOUND:待更新的疑似组不存在，请刷新候选。')
    if (prior?.status === 'resolved' || combine.some(id => groups.some(row => row.id === id && row.status === 'resolved'))) {
      saved.push({ id: prior?.id, ignored: true, reason: '保留人工已处理结论。' }); continue
    }
    if (memberIds.some(id => !id || !visible.has(id) || !people.some(row => row.id === id))) throw new Error('INVALID_ARGS:疑似组成员须是已提供或已查阅且仍存在的人物。')
    if (memberIds.length < 2) {
      if (!prior || combine.length) throw new Error('INVALID_ARGS:新建或合并疑似组至少需要两人；撤销已有组请指定groupId。')
      groups = groups.filter(row => row.id !== prior.id)
      saved.push({ id: prior.id, removed: true, reason: text(proposed.reason) }); continue
    }
    const combinedMembers = groups.filter(row => combine.includes(text(row.id))).flatMap(row => strings(row.memberIds))
    if (combinedMembers.some(id => !memberIds.includes(resolveLifecycleId(id, mappings as never) ?? ''))) throw new Error('INVALID_ARGS:候选合组应包含被合组的成员；存在反证时分别保留。')
    const group: Row = { ...prior, id: prior?.id ?? crypto.randomUUID(), memberIds, memberNames: memberIds.map(id => text(people.find(row => row.id === id)?.name)), reason: text(proposed.reason), status: 'pending', revision: Number(prior?.revision ?? 0) + 1, originStep: 'scan', createdAt: prior?.createdAt ?? timestamp, updatedAt: timestamp }
    groups = groups.filter(row => row.id !== group.id && !combine.includes(text(row.id)))
    groups.push(group); saved.push(group)
  }
  organization.candidateGroups = groups
  return { changed: saved.some(row => !row.ignored), complete: false, summary: '疑似组已保存，仍停留在当前页。看完后可主动翻页。', groups: saved }
}

export function inheritedCandidates(runs: Row[]) {
  const groups = new Map<string, Row>()
  // 最新扫描维护完整候选集；不复活已在新轮合组删除的旧候选。
  const latest = runs.filter(row => Number((row.organization as Row | undefined)?.executionVersion) >= 5 && ((row.organization as Row).runStep === 'scan' || records((row.organization as Row).scanPages).length)).sort((a, b) => text(b.startedAt).localeCompare(text(a.startedAt)))[0]
  if (latest) {
    for (const group of records((latest.organization as Row).candidateGroups)) groups.set(text(group.id), structuredClone(group))
    for (const run of runs.filter(row => row.id !== latest.id && text(row.startedAt) > text(latest.startedAt)).sort((a, b) => text(a.startedAt).localeCompare(text(b.startedAt)))) for (const group of records((run.organization as Row | undefined)?.candidateGroups)) groups.set(text(group.id), structuredClone(group))
  }
  else for (const run of runs.slice().sort((a, b) => text(a.startedAt).localeCompare(text(b.startedAt)))) for (const group of records((run.organization as Row | undefined)?.candidateGroups)) groups.set(text(group.id), structuredClone(group))
  return [...groups.values()]
}
