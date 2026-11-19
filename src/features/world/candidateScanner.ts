import { findCandidates, type Candidate, type CandidateEntity } from './candidates'

export interface CandidateInput { characters: CandidateEntity[]; locations: CandidateEntity[] }
export interface ScanRequest { bookId: string; requestId: string; input: CandidateInput }
export type ScanResponse = { bookId: string; requestId: string } & ({ ok: true; candidates: Candidate[] } | { ok: false; message: string })
export const candidateInput = (input: CandidateInput): CandidateInput => {
  const names = (rows: CandidateEntity[]) => rows.map(({ id, name, aliases }) => ({ id, name, aliases: aliases ?? [] })).sort((a, b) => a.id.localeCompare(b.id))
  return { characters: names(input.characters), locations: names(input.locations) }
}
const cancelled = () => new DOMException('候选扫描已取消，已保存的合并结果保留。', 'AbortError')

export async function scanCandidateRows(bookId: string, input: CandidateInput, signal: AbortSignal): Promise<Candidate[]> {
  if (signal.aborted) throw cancelled()
  const projected = candidateInput(input)
  if (typeof Worker === 'undefined') {
    if (typeof window !== 'undefined') throw new Error('浏览器无法启动候选扫描线程，请刷新后重试。')
    return [...findCandidates('character', projected.characters), ...findCandidates('location', projected.locations)]
  }
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID()
    let worker: Worker | undefined, settled = false
    const finish = (error?: Error, value?: Candidate[]) => {
      if (settled) return
      settled = true; signal.removeEventListener('abort', abort); worker?.terminate()
      if (error) reject(error); else resolve(value!)
    }
    const abort = () => finish(cancelled())
    try {
      worker = new Worker(new URL('./candidates.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (event: MessageEvent<ScanResponse>) => {
        const result = event.data
        if (result.bookId !== bookId || result.requestId !== requestId) return
        if (signal.aborted) { abort(); return }
        if (result.ok) finish(undefined, result.candidates); else finish(new Error(result.message))
      }
      worker.onerror = () => finish(new Error('候选扫描线程出错，请重新扫描。'))
      worker.onmessageerror = () => finish(new Error('候选扫描结果读取失败，请重新扫描。'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) { abort(); return }
      worker.postMessage({ bookId, requestId, input: projected } satisfies ScanRequest)
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
  })
}
