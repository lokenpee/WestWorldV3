import { expect, it, vi } from 'vitest'
import { createLeaseHeartbeat, leaseFailureKind } from '../src/features/world/leaseHeartbeat'

it('快照短暂变化归为暂时失败，执行权或会话变化归为真正丢失', () => {
  expect(leaseFailureKind(new Error('CONFLICT:资料在提交前持续变化，请重新读取后继续。'))).toBe('transient')
  expect(leaseFailureKind(new Error('CONFLICT:读取范围持续变化，请稍后重新读取。'))).toBe('transient')
  expect(leaseFailureKind(new Error('CONFLICT:执行权已转移。'))).toBe('lost')
  expect(leaseFailureKind(new Error('SCOPE:会话执行权与本任务不一致。'))).toBe('lost')
})

it('正常续租成功，不触发失败', async () => {
  let calls = 0, failures = 0
  const heartbeat = createLeaseHeartbeat(async () => { calls++ }, () => { failures++ })
  await heartbeat.tick()
  heartbeat.close()
  expect(calls).toBe(1)
  expect(failures).toBe(0)
})

it('续租失败且未关闭时触发失败回调', async () => {
  let failures = 0
  const heartbeat = createLeaseHeartbeat(async () => { throw new Error('lease lost') }, () => { failures++ })
  await heartbeat.tick()
  heartbeat.close()
  expect(failures).toBe(1)
})

it('连续失败次数递增，成功后归零', async () => {
  const counts: number[] = []
  let fail = true
  const heartbeat = createLeaseHeartbeat(async () => { if (fail) throw new Error('lease lost') }, (_error, consecutive) => { counts.push(consecutive) })
  await heartbeat.tick(); await heartbeat.tick(); fail = false; await heartbeat.tick(); fail = true; await heartbeat.tick()
  heartbeat.close()
  expect(counts).toEqual([1, 2, 1])
})

it('收尾关闭时，旧续租请求晚到失败不会 abort', async () => {
  let fail: (error: Error) => void = () => undefined
  let failures = 0
  const pending = new Promise<void>((_, reject) => { fail = reject })
  const heartbeat = createLeaseHeartbeat(() => pending, () => { failures++ })
  const tick = heartbeat.tick()
  heartbeat.close()
  fail(new Error('lease deleted'))
  await tick
  expect(failures).toBe(0)
})

it('关闭后定时器不再发起续租', async () => {
  vi.useFakeTimers()
  try {
    let calls = 0
    const heartbeat = createLeaseHeartbeat(async () => { calls++ }, () => undefined, 1000)
    heartbeat.close()
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(0)
  } finally { vi.useRealTimers() }
})
