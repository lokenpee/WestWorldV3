import type { Row } from './repository'

export function executionStats(requests: Row[]) {
  const rows = [...new Map(requests.map(row => [String(row.requestId ?? row.id), row])).values()]
  const sum = (key: string) => {
    const values = rows.map(row => (row.usage as Row | null)?.[key])
    return values.some(value => typeof value === 'number') ? values.reduce<number>((total, value) => total + (typeof value === 'number' ? value : 0), 0) : null
  }
  return { requests: rows.length, input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), total: sum('totalTokens'), cost: sum('cost'), tools: rows.reduce((count, row) => count + (Array.isArray(row.toolCalls) ? row.toolCalls.length : 0), 0), pendingUsage: rows.some(row => !row.usage) }
}
