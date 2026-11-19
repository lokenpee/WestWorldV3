import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { createLocalStorageServer } from '../src/features/local-storage/server'
import { RemoteDatabase, credentialPresent, type StorageCall } from '../src/features/local-storage/client'
import type { CredentialProtector } from '../src/features/local-storage/contracts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
function fixture(protector: CredentialProtector) {
  const directory = mkdtempSync(join(tmpdir(), 'westworld-credentials-'))
  let server = createLocalStorageServer(directory, protector)
  const call: StorageCall = async body => await server.execute(body) as never
  const settings = new RemoteDatabase(call, 'settings', 'settings'), book = new RemoteDatabase(call, 'book:a', 'a')
  cleanups.push(async () => {
    await server.close()
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('westworld-credentials-')) throw new Error('临时目录归属不符')
    rmSync(directory, { recursive: true, force: true })
  })
  return { settings, book, directory, call, restart: async () => { await server.close(); server = createLocalStorageServer(directory, protector) } }
}
const encode = (value: string) => `cipher:${Buffer.from(value).toString('base64')}`
const decode = (value: string) => Buffer.from(value.slice('cipher:'.length), 'base64').toString()
const syncForbidden = () => { throw new Error('runtime must use async protection') }

test('延迟加解密不阻塞另一书，提交前磁盘仍是旧值，磁盘与恢复副本没有明文', async () => {
  let finishEncrypt: (() => void) | undefined, finishDecrypt: (() => void) | undefined
  const { settings, book, call, directory } = fixture({ protect: syncForbidden, unprotect: syncForbidden,
    protectAsync: value => new Promise(resolve => { finishEncrypt = () => resolve(encode(value)) }),
    unprotectAsync: value => new Promise(resolve => { finishDecrypt = () => resolve(decode(value)) }),
  })
  const secret = 'FAKE-ONLY-ASYNC-KEY', pending = settings.table('credentials').put({ providerId: 'test', type: 'api_key', key: secret })
  await vi.waitFor(() => expect(finishEncrypt).toBeDefined())
  await book.table('characters').put({ id: 'A', name: '其他书照常保存' })
  expect(await credentialPresent(settings, 'test')).toBe(false)
  finishEncrypt!(); await pending
  const loaded = settings.table('credentials').get('test')
  await vi.waitFor(() => expect(finishDecrypt).toBeDefined())
  expect((await book.table('characters').get('A'))?.name).toBe('其他书照常保存')
  finishDecrypt!(); expect((await loaded)?.key).toBe(secret)
  await call({ action: 'backup' })
  expect(readFileSync(join(directory, 'workspace.sqlite')).includes(Buffer.from(secret))).toBe(false)
})

test('同版本并发解密合并，更新/删除/失败重试和服务重启使缓存正确失效', async () => {
  let decrypts = 0, fail = false
  const { settings, restart } = fixture({ protect: syncForbidden, unprotect: syncForbidden,
    protectAsync: async value => encode(value), unprotectAsync: async value => { decrypts++; await new Promise(resolve => setTimeout(resolve, 5)); if (fail) throw new Error('decrypt failed'); return decode(value) },
  })
  const table = settings.table('credentials')
  await table.put({ providerId: 'test', type: 'api_key', key: 'old-fake' })
  expect(await credentialPresent(settings, 'test')).toBe(true)
  expect(decrypts).toBe(0)
  expect((await Promise.all([table.get('test'), table.get('test'), table.get('test')])).map(row => row?.key)).toEqual(['old-fake', 'old-fake', 'old-fake'])
  expect(decrypts).toBe(1)
  await table.put({ providerId: 'test', type: 'api_key', key: 'new-fake' })
  expect((await table.get('test'))?.key).toBe('new-fake'); expect(decrypts).toBe(2)
  await table.delete('test'); expect(await credentialPresent(settings, 'test')).toBe(false); expect(await table.get('test')).toBeUndefined()
  await table.put({ providerId: 'test', type: 'api_key', key: 'retry-fake' }); fail = true
  await expect(table.get('test')).rejects.toThrow('decrypt failed')
  fail = false; expect((await table.get('test'))?.key).toBe('retry-fake'); expect(decrypts).toBe(4)
  await restart(); expect((await table.get('test'))?.key).toBe('retry-fake'); expect(decrypts).toBe(5)
})

test('加密失败整批配置回滚，事务内读取和存在性判断使用尚未提交值', async () => {
  let fail = false
  const { settings } = fixture({ protect: syncForbidden, unprotect: syncForbidden,
    protectAsync: async value => { if (fail) throw new Error('encrypt failed'); return encode(value) }, unprotectAsync: async value => decode(value),
  })
  await settings.table('credentials').put({ providerId: 'test', type: 'api_key', key: 'old' })
  fail = true
  await expect(settings.transaction('rw', settings.tables, async ({ db }) => {
    await db.table('appSettings').put({ key: 'config', value: 'must rollback' })
    await db.table('credentials').put({ providerId: 'test', type: 'api_key', key: 'new' })
    expect(await credentialPresent(db, 'test')).toBe(true)
    expect((await db.table('credentials').get('test'))?.key).toBe('new')
  })).rejects.toThrow('encrypt failed')
  expect(await settings.table('appSettings').get('config')).toBeUndefined()
  expect((await settings.table('credentials').get('test'))?.key).toBe('old')
  fail = false
  await settings.transaction('rw', settings.tables, async ({ db }) => {
    await db.table('credentials').delete('test')
    expect(await credentialPresent(db, 'test')).toBe(false)
    expect(await db.table('credentials').bulkGet(['test'])).toEqual([undefined])
  })
})

test('旧版本迟到解密不覆盖新密钥缓存', async () => {
  let finish: (() => void) | undefined, calls = 0
  const { settings } = fixture({ protect: syncForbidden, unprotect: syncForbidden,
    protectAsync: async value => encode(value), unprotectAsync: async value => {
      calls++; const plain = decode(value)
      if (plain === 'old') await new Promise<void>(resolve => { finish = resolve })
      return plain
    },
  })
  const table = settings.table('credentials')
  await table.put({ providerId: 'test', type: 'api_key', key: 'old' })
  const old = table.get('test')
  await vi.waitFor(() => expect(finish).toBeDefined())
  await table.put({ providerId: 'test', type: 'api_key', key: 'new' })
  expect((await table.get('test'))?.key).toBe('new')
  finish!(); expect((await old)?.key).toBe('old')
  expect((await table.get('test'))?.key).toBe('new')
  expect(calls).toBe(2)
})
