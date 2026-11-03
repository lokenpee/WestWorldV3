import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  workers: 4,
  use: {
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chromium'),
    viewport: { width: 1440, height: 1000 },
  },
  projects: [
    { name: 'development', grepInvert: /@performance/, testMatch: ['workspace.spec.ts', 'import.spec.ts', 'assets.spec.ts', 'asset-search.spec.ts', 'character-workbench.spec.ts', 'character-network.spec.ts', 'relation-foundation.spec.ts', 'merge.spec.ts', 'backup.spec.ts', 'models.spec.ts', 'model-acceptance.spec.ts', 'extraction.spec.ts', 'agents.spec.ts', 'world.spec.ts', 'mechanical-queue.spec.ts', 'story.spec.ts', 'network.spec.ts', 'backup-transfer.spec.ts'], use: { baseURL: 'http://127.0.0.1:4179' } },
    { name: 'production', grepInvert: /@performance/, testMatch: ['workspace.production.spec.ts', 'models.spec.ts', 'extraction.spec.ts', 'agents.spec.ts', 'world.spec.ts', 'mechanical-queue.spec.ts', 'story.spec.ts', 'network.spec.ts', 'character-network.spec.ts', 'relation-foundation.spec.ts', 'backup-transfer.spec.ts', 'asset-search.spec.ts'], use: { baseURL: 'http://127.0.0.1:4180' } },
    // 帧率测量在功能回归之后单独运行，避免同时打开的测试浏览器争用渲染资源。
    { name: 'performance', dependencies: ['development', 'production'], workers: 1, grep: /@performance/, testMatch: 'character-network.spec.ts', use: { baseURL: 'http://127.0.0.1:4180' } },
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
