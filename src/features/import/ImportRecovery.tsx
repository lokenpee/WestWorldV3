import { useCallback, useEffect, useState } from 'react'
import type { ImportService, RecoveryReport } from '../../lib/storage/importService'
import { useLiveResult } from '../../hooks/useLiveResult'

export function ImportRecovery({ importer }: { importer: ImportService }) {
  const [result, setResult] = useState<RecoveryReport>()
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(true)
  const query = useCallback(() => importer.pendingOperationsCount(), [importer])
  const pending = useLiveResult(query)
  const pendingCount = pending.status === 'ready' ? pending.value : 0
  useEffect(() => {
    let active = true
    importer.recoverPending().then(report => { if (active) { setResult(report); setError('') } }).catch((failure: unknown) => {
      if (active) setError(failure instanceof Error ? failure.message : '导入恢复检查失败')
    }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [importer, attempt, pendingCount])
  if (!error && !pendingCount && (!result || (!result.pending && !result.errors.length && !result.cleaned && !result.recovered && !result.deleted))) return null
  return <div className="import-recovery" role="status"><span>{error || `书籍恢复：已恢复 ${result?.recovered ?? 0} 本，已清理 ${result?.cleaned ?? 0} 项，已完成删除 ${result?.deleted ?? 0} 本；${Math.max(result?.pending ?? 0, pendingCount)} 项仍在处理或等待恢复。`}{result?.errors.length ? ` ${result.errors.join('；')}` : ''}</span><button className="secondary-button" disabled={busy} onClick={() => { setBusy(true); setAttempt(value => value + 1) }}>重试书籍恢复</button></div>
}
