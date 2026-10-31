import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  use: {
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chromium'),
    viewport: { width: 1440, height: 1000 },
  },
  projects: [
    { name: 'development', testMatch: ['workspace.spec.ts', 'import.spec.ts', 'assets.spec.ts', 'merge.spec.ts', 'backup.spec.ts', 'models.spec.ts', 'model-acceptance.spec.ts', 'extraction.spec.ts', 'agents.spec.ts', 'world.spec.ts', 'story.spec.ts'], use: { baseURL: 'http://127.0.0.1:4179' } },
    { name: 'production', testMatch: ['workspace.production.spec.ts', 'models.spec.ts', 'extraction.spec.ts', 'agents.spec.ts', 'world.spec.ts', 'story.spec.ts'], use: { baseURL: 'http://127.0.0.1:4180' } },
  ],
  webServer: [{
    command: 'npm run dev -- --host 127.0.0.1 --port 4179 --strictPort',
    url: 'http://127.0.0.1:4179',
    reuseExistingServer: false,
  }, {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4180 --strictPort',
    url: 'http://127.0.0.1:4180',
    reuseExistingServer: false,
  }],
})
