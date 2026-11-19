import type { AgentStore, Row } from './repository'
import { records, strings, text } from './contracts'

export const historyIndexId = (unit: string) => `p2-history:${JSON.stringify(unit)}`

/** 完成状态与待清理位置同事务登记，清理失败或退出后仍可追踪。 */
export async function registerCompletedHistory(store: AgentStore, run: Row, organization: Row) {
  const previous = ((await store.get('pipelineRuns', text(run.id)))?.organization ?? {}) as Row
  for (const [field, kind] of [['profileItems', 'profile'], ['relationItems', 'relations']] as const) {
    const checked = new Set(records(previous[field]).filter(item => item.status === 'checked').map(item => text(item.id)))
    for (const item of records(organization[field])) {
      if (item.status !== 'checked' || checked.has(text(item.id))) continue
      const unit = `${kind}:${text(item.id)}`, index = await store.get('pipelineRuns', historyIndexId(unit))
      // 未建立位置时保留首次全量发现历史的路径。
      if (index?.recordType !== 'history_index' || index.bookId !== run.bookId || index.historyIndexVersion !== 1 || index.historyUnit !== unit) continue
      await store.put('pipelineRuns', { ...index, historyRunIds: [...new Set([...strings(index.historyRunIds), text(run.id)])], updatedAt: new Date().toISOString() })
    }
  }
}
