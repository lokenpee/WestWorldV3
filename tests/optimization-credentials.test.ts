import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { createLocalStorageServer } from '../src/features/local-storage/server'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createModelConfigStore } from '../src/features/models/config'
import { defaultConfig } from '../src/features/models/types'
import { windowsCredentialProtector } from '../src/features/local-storage/credentials'
import type { StorageCall } from '../src/features/local-storage/client'

test.skipIf(process.platform !== 'win32')('opt18：假密钥配置与加载的解密次数和服务线程等待', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'westworld-opt18-'))
  const native = windowsCredentialProtector() as ReturnType<typeof windowsCredentialProtector> & { protectAsync?: (value: string) => Promise<string>; unprotectAsync?: (value: string) => Promise<string> }
  let decrypts = 0, syncDecrypts = 0
  const protector = {
    protect: (value: string) => native.protect(value),
    unprotect: (value: string) => { decrypts++; syncDecrypts++; return native.unprotect(value) },
    protectAsync: async (value: string) => native.protectAsync ? native.protectAsync(value) : native.protect(value),
    unprotectAsync: async (value: string) => { decrypts++; return native.unprotectAsync ? native.unprotectAsync(value) : native.unprotect(value) },
  }
  const server = createLocalStorageServer(directory, protector)
  const call: StorageCall = async body => await server.execute(body) as never
  const workspace = createWorkspace({ settingsName: 'opt18', bookPrefix: 'opt18-' }, call)
  try {
    await workspace.settings.appSettings.put({ key: 'llm.config', value: defaultConfig })
    await workspace.settings.table('credentials').put({ providerId: defaultConfig.providerId, type: 'api_key', key: 'FAKE-OPT18-LOCAL-ONLY' })
    const config = createModelConfigStore(workspace), measurements = []
    for (const [name, work] of [['configured', async () => (await config.read()).configured], ['firstLoad', async () => (await config.load()).apiKey === 'FAKE-OPT18-LOCAL-ONLY'], ['warmLoad', async () => (await config.load()).apiKey === 'FAKE-OPT18-LOCAL-ONLY']] as const) {
      decrypts = 0; syncDecrypts = 0
      let last = performance.now(), maxGap = 0
      const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now }, 8)
      const start = performance.now()
      expect(await work()).toBe(true)
      const elapsed = performance.now() - start
      await new Promise(resolve => setTimeout(resolve, 16)); clearInterval(timer)
      measurements.push({ name, decrypts, syncDecrypts, elapsedMs: +elapsed.toFixed(2), maxTimerIntervalMs: +maxGap.toFixed(2) })
    }
    if (process.env.WW_OPT18_EXPECT !== 'before') {
      expect(measurements.map(row => row.decrypts)).toEqual([0, 1, 0])
      expect(measurements.map(row => row.syncDecrypts)).toEqual([0, 0, 0])
    }
    if (process.env.WW_OPT18_RESULT) writeFileSync(process.env.WW_OPT18_RESULT, JSON.stringify({ optimization: 18, fakeCredential: true, measurements }, null, 2) + '\n')
  } finally {
    workspace.close(); await server.close()
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('westworld-opt18-')) throw new Error('临时目录归属不符')
    rmSync(directory, { recursive: true, force: true })
  }
}, 20000)
