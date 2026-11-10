export interface LeaseHeartbeat { tick(): Promise<void>; close(): void }

export type LeaseFailureKind = 'lost' | 'transient'

/** 快照短暂变化可以等下一拍；只有执行者、运行或会话身份变化才算真正丢失执行权。 */
export function leaseFailureKind(error: unknown): LeaseFailureKind {
  const message = error instanceof Error ? error.message : String(error)
  if (/资料在提交前持续变化|读取范围持续变化|SnapshotConflict/.test(message)) return 'transient'
  if (/执行权|租约|会话|SCOPE|本书已有任务|本书已有处理任务/.test(message)) return 'lost'
  return 'transient'
}

/** 租约续期定时器；close 后即使旧续期请求失败也不能再 abort 已收尾的运行。 */
export function createLeaseHeartbeat(refresh: () => Promise<void>, fail: (error: unknown, consecutive: number) => void, intervalMs = 8000): LeaseHeartbeat {
  let closed = false
  let inFlight = false
  let failures = 0
  const tick = async () => {
    if (closed || inFlight) return
    inFlight = true
    try { await refresh(); failures = 0 }
    catch (error) { failures++; if (!closed) fail(error, failures) }
    finally { inFlight = false }
  }
  const timer = setInterval(() => { void tick() }, intervalMs)
  return { tick, close() { closed = true; clearInterval(timer) } }
}
