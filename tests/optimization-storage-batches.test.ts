import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { createLocalStorageServer } from '../src/features/local-storage/server'
import { RemoteDatabase, type StorageCall } from '../src/features/local-storage/client'

test('opt17：1000条计数及20条批量操作的协议请求量', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'westworld-opt17-'))
  const server = createLocalStorageServer(directory, { protect: value => value, unprotect: value => value })
  let collecting = false
  const calls: { action: string; requestBytes: number; responseBytes: number }[] = []
  const call: StorageCall = async body => {
    const response = await server.execute(body)
    if (collecting) calls.push({ action: String(body.action), requestBytes: Buffer.byteLength(JSON.stringify(body)), responseBytes: Buffer.byteLength(JSON.stringify(response ?? null)) })
    return response as never
  }
  const db = new RemoteDatabase(call, 'book:a', 'a'), table = db.table('characters')
  try {
    await table.bulkPut(Array.from({ length: 1000 }, (_, i) => ({ id: `P${i}`, name: `人物${i}`, roleWeight: i % 2 ? 'major' : 'minor' })))
    const measurements: Record<string, unknown>[] = []
    const measure = async <T>(name: string, work: () => Promise<T>) => {
      calls.length = 0; collecting = true
      const result = await work(); collecting = false
      measurements.push({ name, requests: calls.length, returnedBytes: calls.reduce((sum, call) => sum + call.responseBytes, 0), sentBytes: calls.reduce((sum, call) => sum + call.requestBytes, 0) })
      return result
    }
    expect(await measure('count', () => table.count())).toBe(1000)
    expect(await measure('filteredCount', () => table.where('roleWeight').equals('major').offset(100).limit(200).count())).toBe(200)
    const keys = Array.from({ length: 20 }, (_, i) => `P${i}`)
    expect((await measure('bulkGet', () => table.bulkGet(keys))).map(row => row?.id)).toEqual(keys)
    expect(await measure('bulkUpdate', () => table.bulkUpdate(keys.map(key => ({ key, changes: { name: '已修改' } }))))).toBe(20)
    expect((await table.get('P3'))?.name).toBe('已修改')
    await measure('bulkDelete', () => table.bulkDelete(keys))
    expect(await table.count()).toBe(980)
    const result = { optimization: 17, sample: { storedRows: 1000, batchSize: 20 }, measurements }
    if (process.env.WW_OPT17_RESULT) writeFileSync(process.env.WW_OPT17_RESULT, JSON.stringify(result, null, 2) + '\n')
  } finally {
    await server.close()
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('westworld-opt17-')) throw new Error('临时目录归属不符')
    rmSync(directory, { recursive: true, force: true })
  }
})
