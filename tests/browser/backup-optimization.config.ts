import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.', testMatch: 'backup.spec.ts', workers: 1, timeout: 60000,
  use: { baseURL: 'http://127.0.0.1:5193', headless: true, channel: process.platform === 'win32' ? 'msedge' : 'chromium' },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5193 --strictPort',
    url: 'http://127.0.0.1:5193', reuseExistingServer: false,
    env: { WESTWORLD_STORAGE_DIR: '' },
  },
})
