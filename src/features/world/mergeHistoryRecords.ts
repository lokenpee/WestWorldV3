import type { Row } from '../agents/repository'
import { records, strings, text } from '../agents/contracts'

export function mergeHistoryRecords(runs: Row[]) {
  const automatic = new Set(runs.flatMap(run => records((run.mechanicalQueue as Row | undefined)?.items).filter(item => item.confirmation === 'exact_name' && item.manualSelection !== true).map(item => text(item.commitId))))
  const result = new Map<string, Row>()
  // 队列报告和机械报告会引用同一人工合并凭证，只显示一次。
  for (const run of [...runs].sort((a, b) => Number(b.stage === 'manual_merge') - Number(a.stage === 'manual_merge'))) {
    for (const [index, group] of records((run.report as Row | undefined)?.groups).entries()) {
      const key = `${group.kind}:${strings(group.memberIds).slice().sort().join('|')}:${group.keepId}`
      if (!result.has(key)) result.set(key, { ...group, key: `${run.id}:${index}`, at: text(run.finishedAt ?? run.startedAt), automatic: automatic.has(text(run.id)), stage: run.stage })
    }
  }
  return [...result.values()].sort((a, b) => text(b.at).localeCompare(text(a.at)))
}

