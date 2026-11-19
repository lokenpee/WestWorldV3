import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

// Serve committed import files in memory to compare the same UI sample without checkout changes.
const ref = process.argv[3]
const files = ['text.ts', 'ImportPanel.tsx', 'preview.worker.ts', 'previewLoader.ts', 'parseInWorker.ts'].map(name => `src/features/import/${name}`).concat('src/lib/storage/importService.ts')
const baseline = new Map(ref ? files.map(name => [`/${name}`, execFileSync('git', ['show', `${ref}:${name}`], { encoding: 'utf8' })]) : [])
const server = await createServer({ configFile: false, plugins: [{ name: 'import-baseline', enforce: 'pre', load(id) {
  return [...baseline].find(([suffix]) => id.split('?')[0].replaceAll('\\', '/').endsWith(suffix))?.[1]
} }, react()], server: { host: '127.0.0.1', port: 5191, strictPort: true } })
await server.listen()
let browser
try {
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chromium', headless: true })
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } })
  await page.goto('http://127.0.0.1:5191/?acceptance=stage2')
  const text = Array.from({ length: 1000 }, (_, i) => `第${i + 1}章 测试\n${'甲'.repeat(4000)}\n`).join('')
  const elapsed = []
  let rows
  for (let i = 0; i < 5; i++) {
    const start = performance.now()
    await page.getByLabel('小说TXT文件').setInputFiles({ name: '量化样本.txt', mimeType: 'text/plain', buffer: Buffer.from(text) })
    await page.getByRole('region', { name: '分章预览' }).waitFor()
    rows = await page.locator('.preview-table-wrap tbody tr').count()
    elapsed.push(performance.now() - start)
  }
  elapsed.sort((a, b) => a - b)
  if (!ref) {
    for (let i = 1; i < 10; i++) await page.getByRole('button', { name: '下一页预览' }).click()
  }
  await page.getByRole('button', { name: '预览 第1000章 测试', exact: true }).click()
  const lastText = await page.getByRole('dialog').locator('pre').textContent()
  if (lastText !== `第1000章 测试\n${'甲'.repeat(4000)}\n`) throw new Error('末章正文不一致')
  await page.getByRole('button', { name: '关闭原文' }).click()
  await page.getByRole('button', { name: '按 UTF-8 重读' }).click()
  await page.getByRole('button', { name: '预览 第1章 测试', exact: true }).waitFor()
  const result = { ref: ref ?? 'working-tree', chapters: 1000, firstPageRows: rows, medianPreviewMs: +elapsed[2].toFixed(2), lastChapterIntact: true, rereadReturnsFirstPage: true,
    fits375px: await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth) }
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally { await browser?.close(); await server.close() }
