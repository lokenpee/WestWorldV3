import { afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalStorageServer } from '../src/features/local-storage/server'
import type { StorageCall } from '../src/features/local-storage/client'
const stores = new Map<string, ReturnType<typeof createLocalStorageServer>>()
const dirs: string[] = []
vi.mock('../src/lib/storage/workspace', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/lib/storage/workspace')>()
  return { ...actual, createWorkspace(scope = actual.MAIN_SCOPE) {
    const key = scope.settingsName
    let server = stores.get(key)
    if (!server) {
      const dir = mkdtempSync(join(tmpdir(), 'westworld-domain-disk-')); dirs.push(dir)
      server = createLocalStorageServer(dir, { protect: value => Buffer.from(value).toString('base64'), unprotect: value => Buffer.from(value, 'base64').toString() })
      stores.set(key, server)
    }
    const call: StorageCall = async body => JSON.parse(JSON.stringify(await server!.execute(JSON.parse(JSON.stringify(body))) ?? null))
    return actual.createWorkspace(scope, call)
  } }
})
afterAll(async () => {
  for (const server of stores.values()) await server.close()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
