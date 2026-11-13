import { records, strings, text } from './contracts'
import type { AgentStore, Row } from './repository'
import { readTool, type Scope } from './queries'

export const limitsOriginalRead = (scope: Scope) => scope.phase === 'character_organization' && (scope.workKind === 'profile' || scope.workKind === 'relations')

/** 调用者使用写事务：原文读取和已读标记一起生效，恢复或并行调用不会多读一次。 */
export async function readOrganizationOriginal(store: AgentStore, scope: Scope, args: Row, maxResults?: number) {
  const run = (await store.get('pipelineRuns', scope.runId))!
  const organization = run.organization as Row
  const unitId = scope.unitId || `${scope.workKind}:${text((organization.activeWork as Row | undefined)?.characterId)}`
  const used = strings(organization.originalReadUnits)
  const historical = records(run.tasks).some(task => text((task.input as Row | undefined)?.unitId) === unitId
    && records((task.readSet as Row | undefined)?.queries).some(query => query.tool === 'read_original'))
  if (used.includes(unitId) || historical) return {
    text: '', segments: [], chapters: [], totalChars: 0, truncated: false, nextCursor: null, nextOffset: null,
    readLimitReached: true, message: '当前人物在本步骤的原文查阅次数已经耗尽，请直接整理输出结论；无法确认的内容保留或登记待核对。',
  }
  const value = await readTool(store, scope, 'read_original', args, maxResults)
  await store.put('pipelineRuns', { ...run, organization: { ...organization, originalReadUnits: [...used, unitId] } })
  return value
}
