import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  testMatch: 'pi.spec.ts',
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:4178',
    headless: true,
    // PLAYWRIGHT_CHANNEL=chromium uses Playwright's installed Chromium on CI.
    channel: process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chromium'),
  },
  webServer: {
    command: 'npm run build:probe && npx vite preview --config tests/browser/vite.config.ts --host 127.0.0.1 --port 4178 --strictPort',
    url: 'http://127.0.0.1:4178',
    reuseExistingServer: false,
  },
})
