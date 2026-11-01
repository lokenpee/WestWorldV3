import type { AgentStore, Row } from './repository'
import type { ReadSet } from './commands'
import type { Scope } from './queries'
import { records, strings, text } from './contracts'
import { isContextualName } from '../assets/characterNames'

export async function applyAliasChecks(store: AgentStore, scope: Scope, checks: Row[], reads: ReadSet, commitId: string, evidenceCheck: (item: Row) => Promise<void>) {
  const used = new Set<string>()
  for (const check of checks) {
    const kind = text(check.kind), table = kind === 'character' ? 'characters' : 'locations', id = text(check.id)
    if (used.has(`${kind}:${id}`)) throw new Error('INVALID_ARGS:同一资产的别名校对请合并为一项。')
    used.add(`${kind}:${id}`)
    const detailTool = kind === 'character' ? 'get_character_detail' : 'get_location_detail'
    if (!reads.queries.some(query => query.tool === detailTool && strings(query.args.ids).includes(id)) || !reads.records.some(read => read.table === table && read.resolvedId === id)) throw new Error('INVALID_ARGS:别名校对前须读取当前资产详情。')
    const row = await store.get(table, id)
    if (!row || row.bookId !== scope.bookId) throw new Error('SCOPE:别名校对目标不存在或不属于当前书籍。')
    const aliases = strings(row.aliases), verified = new Set(strings(row.verifiedAliases).filter(alias => aliases.includes(alias)))
    const removals = new Set<string>(), decisions = records(check.decisions), seen = new Set<string>()
    for (const decision of decisions) {
      const alias = text(decision.alias), evidence = records(decision.evidence)
      if (seen.has(alias) || alias === row.name || !aliases.includes(alias)) throw new Error('INVALID_ARGS:别名校对须引用当前别名，不可重复或删除主名。')
      seen.add(alias)
      if (!evidence.some(item => text(item.quote).includes(alias))) throw new Error('INVALID_ARGS:别名证据须包含被校对的称呼。')
      for (const item of evidence) await evidenceCheck(item)
      if (decision.decision === 'keep') {
        if (kind === 'character' && isContextualName(alias)) throw new Error('INVALID_ARGS:通用称谓不作为全书稳定别名统计。')
        const ownNames = [text(row.name), ...strings(row.verifiedAliases)].filter(name => name !== alias)
        if (!evidence.some(item => ownNames.some(name => name && text(item.quote).includes(name)))) throw new Error('INVALID_ARGS:保留别名的证据须包含主名或此前已核实的其他称呼。')
        verified.add(alias)
      } else { removals.add(alias); verified.delete(alias) }
      if (decision.referentId) {
        const targetId = text(decision.referentId), target = await store.get(table, targetId)
        if (!target || target.bookId !== scope.bookId || targetId === id || !reads.records.some(read => read.table === table && read.resolvedId === targetId) || !evidence.some(item => text(item.quote).includes(text(target.name)))) throw new Error('INVALID_ARGS:被指向的其他实体须先读取详情，且姓名出现在证据中。')
      }
    }
    const afterAliases = aliases.filter(alias => !removals.has(alias)), verifiedAliases = [...verified].filter(alias => afterAliases.includes(alias))
    const affectedNodeIds = kind === 'character' && removals.size ? (await store.rows('nodes')).filter(node => [...strings(node.actorIds), ...strings(node.targetCharacterIds)].includes(id) && [...strings(node.actors), ...strings(node.targets), text(node.quote), text(node.process), text(node.summary)].some(value => [...removals].some(alias => value.includes(alias)))).map(node => text(node.id)) : []
    const createdAt = new Date().toISOString()
    await store.put(table, { ...row, aliases: afterAliases, verifiedAliases, revision: Number(row.revision) + 1, updatedAt: createdAt })
    const run = (await store.get('pipelineRuns', scope.runId))!
    if (run.report) {
      const report = run.report as Row
      await store.put('pipelineRuns', { ...run, report: { ...report, aliasChecks: [...records(report.aliasChecks), { id: crypto.randomUUID(), kind, assetId: id, name: row.name, beforeAliases: aliases, afterAliases, verifiedAliases, decisions, taskId: scope.taskId, commitId, createdAt, affectedNodeIds }] } })
    }
  }
}
