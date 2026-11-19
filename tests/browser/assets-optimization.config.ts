import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.', testMatch: /(?:assets|asset-search|character-workbench|network|relation-foundation|asset-paging)\.spec\.ts$/, workers: 1,
  use: { baseURL: 'http://127.0.0.1:5195', headless: true, viewport: { width: 1440, height: 1000 }, channel: process.platform === 'win32' ? 'msedge' : 'chromium' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5195 --strictPort', url: 'http://127.0.0.1:5195', reuseExistingServer: false, env: { WESTWORLD_STORAGE_DIR: '' } },
})
