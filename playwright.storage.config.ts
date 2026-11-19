import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: './tests/browser', testMatch: 'storage.spec.ts', workers: 1, timeout: 120000,
  use: { baseURL: 'http://127.0.0.1:5189', headless: true, channel: process.platform === 'win32' ? 'msedge' : 'chromium' },
})
