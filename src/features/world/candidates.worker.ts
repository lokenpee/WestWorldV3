import { findCandidates } from './candidates'
import type { ScanRequest, ScanResponse } from './candidateScanner'

self.onmessage = (event: MessageEvent<ScanRequest>) => {
  const { bookId, requestId, input } = event.data
  let response: ScanResponse
  try { response = { bookId, requestId, ok: true, candidates: [...findCandidates('character', input.characters), ...findCandidates('location', input.locations)] } }
  catch (error) { response = { bookId, requestId, ok: false, message: error instanceof Error ? error.message : '候选扫描失败。' } }
  self.postMessage(response)
}
