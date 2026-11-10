import { useEffect, useMemo, useRef } from 'react'
import type { WorldRun } from './types'

const time = (value: string) => new Date(value).toLocaleString('zh-CN')
const number = (value: number | null | undefined) => value === null || value === undefined ? '未知' : String(value)
const purpose = (value: string) => ({ work: '工作请求', retry: '失败/重试', compaction: '压缩', compaction_repair: '压缩修正', repair: '修正' } as Record<string, string>)[value] ?? value
const status = (value: string) => ({ succeeded: '成功', failed: '失败', cancelled: '取消' } as Record<string, string>)[value] ?? value

export function WorldUsageDialog({ run, onClose }: { run: WorldRun; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close() }, [])
  const entries = useMemo(() => [...(run.requestLedger ?? [])].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0)), [run])
  const total = useMemo(() => entries.reduce((sum, row) => ({
    input: sum.input + (row.input ?? 0), cacheRead: sum.cacheRead + (row.cacheRead ?? 0), output: sum.output + (row.output ?? 0),
    knownCost: sum.knownCost + (row.cost ?? 0), missing: sum.missing + (row.usageStatus === 'missing' ? 1 : 0), unknownCost: sum.unknownCost + (row.costStatus === 'unknown' ? 1 : 0),
  }), { input: 0, cacheRead: 0, output: 0, knownCost: 0, missing: 0, unknownCost: 0 }), [entries])
  const groups = useMemo(() => {
    const map = new Map<string, typeof entries>()
    for (const entry of entries) { const key = entry.workId ?? entry.characterId ?? '未关联人物'; if (!map.has(key)) map.set(key, []); map.get(key)!.push(entry) }
    return [...map.entries()]
  }, [entries])
  return <dialog ref={ref} className="merge-dialog" aria-labelledby="world-usage-title" onCancel={event => event.preventDefault()}><header className="merge-dialog-heading"><h2 id="world-usage-title">请求与用量</h2><button className="text-button" onClick={onClose}>关闭</button></header><div className="merge-dialog-body">
    <p>本轮 {entries.length} 次实际请求 · 输入 {total.input}（缓存读 {total.cacheRead}）· 输出 {total.output} · 已知费用 {total.knownCost.toFixed(6)} 美元 · 用量缺失 {total.missing} 次 · 费用未知 {total.unknownCost} 次</p>
    {!entries.length && <p className="field-help">当前报告没有逐请求账本；旧轮累计用量见报告顶部，历史明细可能不完整。</p>}
    {groups.map(([workId, rows]) => <section key={workId} aria-label={`请求 ${workId}`}>
      <h3>{workId}</h3>
      <p>请求 {rows.length} 次 · 输入 {rows.reduce((sum, row) => sum + (row.input ?? 0), 0)} · 输出 {rows.reduce((sum, row) => sum + (row.output ?? 0), 0)}</p>
      {rows.map(row => <details key={row.attemptId}><summary>{time(row.startedAt)} · {purpose(row.purpose)} · {status(row.status)}{row.errorCode ? ` · ${row.errorCode}` : ''}</summary>
        <p>人物/工作：{row.characterId ?? row.workId ?? '未关联'} · 上下文：{row.contextId ?? '未记录'}</p>
        <p>执行：{row.executionId ?? '旧记录未记录'} · 请求：{row.requestId ?? '旧记录未记录'}</p>
        <p>估算输入 {number(row.estimatedInput)} · 输出预留 {number(row.outputReserve)} · 实际输入 {number(row.input)} · 缓存读 {number(row.cacheRead)} · 缓存写 {number(row.cacheWrite)} · 输出 {number(row.output)} · 总token {number(row.totalTokens)}</p>
        <p>用量状态：{row.usageStatus === 'reported' ? '供应商已报告' : row.usageStatus === 'partial' ? '部分报告' : '缺失'} · 费用：{row.cost === null ? '未知' : `${row.cost.toFixed(6)} ${row.currency ?? ''}`} · 计价：{row.costStatus === 'estimated' ? '估算' : '未知'}</p>
        {row.modelSnapshot && <p>模型：{row.modelSnapshot}</p>}
      </details>)}
    </section>)}
  </div></dialog>
}
