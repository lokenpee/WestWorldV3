import type { Plugin } from 'vite'
import { createLocalStorageServer } from './server.ts'
import { windowsCredentialProtector } from './credentials.ts'

export function localStoragePlugin(): Plugin {
  return { name: 'westworld-local-storage', configureServer(server) {
    const directory = process.env.WESTWORLD_STORAGE_DIR
    if (!directory) return
    const storage = createLocalStorageServer(directory, windowsCredentialProtector())
    server.middlewares.use('/api/storage', (req, res) => { void storage.handle(req, res) })
    server.httpServer?.once('close', () => { void storage.close() })
  } }
}
