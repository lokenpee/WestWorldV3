import { useEffect, useState } from 'react'
import { subscribeTraceHub, traceSessions, type ExecutionChain } from './trace'
import type { Row } from './repository'

const empty = (): ExecutionChain => ({ entries: [], requests: [], snapshots: new Map() })
export type LoadP2Execution = (bookId: string, query: { runId: string; step: 'scan' | 'profiles' | 'relations'; objectKey: string }) => Promise<ExecutionChain>

export function useP2Execution(bookId: string, runId: string | undefined, step: 'scan' | 'profiles' | 'relations', objectKey: string | undefined, load: LoadP2Execution) {
  const key = `${bookId}:${runId}:${step}:${objectKey}`
  const [saved, setSaved] = useState<{ key: string; chain: ExecutionChain; error: string }>()
  const [tick, setTick] = useState(0)
  useEffect(() => subscribeTraceHub(() => setTick(value => value + 1)), [])
  useEffect(() => {
    if (!runId || !objectKey) return
    let live = true
    const timer = setTimeout(() => {
      void load(bookId, { runId, step, objectKey }).then(chain => { if (live) setSaved({ key, chain, error: '' }) }).catch(error => {
        if (live) setSaved(previous => ({ key, chain: previous?.key === key ? previous.chain : empty(), error: error instanceof Error ? error.message : '整理记录读取失败。' }))
      })
    }, saved?.key === key ? 300 : 0)
    return () => { live = false; clearTimeout(timer) }
    // saved不是刷新触发源；首次立即读，后续日志更新合并读取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, bookId, runId, step, objectKey, load, tick])
  const base = saved?.key === key ? saved.chain : empty()
  const requests = new Map(base.requests.map(row => [String(row.requestId ?? row.id), row]))
  const snapshots = new Map(base.snapshots)
  for (const session of traceSessions(bookId)) {
    if (session.identity.runId !== runId || session.identity.workId !== objectKey) continue
    const snapshot = session.snapshot()
    for (const row of snapshot.records) requests.set(String(row.requestId ?? row.id), row)
    for (const row of snapshot.snapshots) snapshots.set(String(row.snapshotId ?? row.id), row)
  }
  const ordered: Row[] = [...requests.values()].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)) || Number(a.requestOrdinal) - Number(b.requestOrdinal))
  return { chain: { ...base, requests: ordered, snapshots }, loading: !!runId && saved?.key !== key, error: saved?.key === key ? saved.error : '' }
}
