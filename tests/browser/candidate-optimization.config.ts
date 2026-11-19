import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.', testMatch: 'candidate-scanner.spec.ts', workers: 1,
  use: { baseURL: 'http://127.0.0.1:5197', headless: true, viewport: { width: 1440, height: 1000 }, channel: process.platform === 'win32' ? 'msedge' : 'chromium' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5197 --strictPort', url: 'http://127.0.0.1:5197', reuseExistingServer: false, env: { WESTWORLD_STORAGE_DIR: '' } },
})
