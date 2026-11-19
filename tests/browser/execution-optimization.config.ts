import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.', testMatch: 'execution-paging.spec.ts', workers: 1,
  use: { baseURL: 'http://127.0.0.1:5194', headless: true, channel: process.platform === 'win32' ? 'msedge' : 'chromium' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5194 --strictPort', url: 'http://127.0.0.1:5194', reuseExistingServer: false, env: { WESTWORLD_STORAGE_DIR: '' } },
})
