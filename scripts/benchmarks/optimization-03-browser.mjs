import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const ref = process.argv[3]
const files = ['src/features/backup/service.ts', 'src/features/backup/codec.ts']
const baseline = new Map(ref ? files.map(name => [`/${name}`, execFileSync('git', ['show', `${ref}:${name}`], { encoding: 'utf8' })]) : [])
const server = await createServer({ configFile: false, plugins: [{ name: 'backup-benchmark', enforce: 'pre', load(id) {
  return [...baseline].find(([suffix]) => id.split('?')[0].replaceAll('\\', '/').endsWith(suffix))?.[1]
}, configureServer(server) { server.middlewares.use('/benchmark.html', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html><body>备份量化</body></html>') }) } }, react()], server: { host: '127.0.0.1', port: 5192, strictPort: true } })
await server.listen()
let browser
try {
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chromium', headless: true })
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:5192/benchmark.html')
  const result = await page.evaluate(async () => {
    const { createWorkspace } = await import('/src/lib/storage/workspace.ts')
    const { createImportService } = await import('/src/lib/storage/importService.ts')
    const { createBackupService } = await import('/src/features/backup/service.ts')
    const { emptyTables } = await import('/src/features/backup/data.ts')
    const { encodeBackup } = await import('/src/features/backup/codec.ts')
    const now = '2026-11-01T00:00:00.000Z', bookId = 'large-book'
    const data = { book: { id: bookId, title: '备份量化', sourceFileName: 'benchmark.txt', createdAt: now }, tables: emptyTables() }
    for (let i = 1; i <= 200; i++) {
      const text = `第${i}章\n${'古城中，书信与旅程继续。'.repeat(600)}`
      data.tables.chapters.push({ bookId, chapterIndex: String(i), chapterName: `第${i}章`, order: i - 1, charCount: text.length })
      data.tables.chapterTexts.push({ bookId, chapterIndex: String(i), text })
    }
    data.tables.nodes = Array.from({ length: 2000 }, (_, i) => ({ id: `N${String(i).padStart(4, '0')}`, bookId, name: `节点${i}`, summary: `第${i}个事件`, process: '完整经过和人物关系。'.repeat(50), chapterIndex: String(Math.floor(i / 10) + 1), chapterName: `第${Math.floor(i / 10) + 1}章`, actors: [], quote: '', confidence: 1, createdBy: 'P1', revision: 1, order: i % 10, eventLineIds: [] }))
    data.tables.eventLines = Array.from({ length: 100 }, (_, i) => {
      const members = data.tables.nodes.slice(i * 20, Math.min(2000, i * 20 + 21))
      return { id: `L${i}`, bookId, title: `事件线${i}`, nodeIds: members.map(row => row.id), chapters: [...new Set(members.map(row => row.chapterIndex))], cause: '线索出现', process: '事件持续发展', result: '继续核对', lineStatus: 'open', createdBy: 'P3', revision: 1, updatedAt: now }
    })
    for (const line of data.tables.eventLines) for (const id of line.nodeIds) data.tables.nodes.find(row => row.id === id).eventLineIds.push(line.id)
    for (const [kind, rows] of [['node', data.tables.nodes], ['eventLine', data.tables.eventLines]]) for (const row of rows) data.tables.assetLifecycle.push({ key: `${kind}:${row.id}`, bookId, kind, originId: row.id, currentId: row.id, state: 'live', revision: 1, updatedAt: now })
    const bytes = (await encodeBackup(data)).bytes
    const workspace = createWorkspace({ settingsName: 'opt03-settings', bookPrefix: 'opt03-book-' })
    const importer = createImportService(workspace), service = createBackupService(workspace, importer)
    const samples = []
    try {
      for (let i = 0; i < 3; i++) {
        let last = performance.now(), maxGap = 0
        const timer = setInterval(() => { const time = performance.now(); maxGap = Math.max(maxGap, time - last); last = time }, 8)
        const start = performance.now()
        const prepared = service.prepareBackup ? await service.prepareBackup(bytes) : await service.inspectBackup(bytes)
        const prepareMs = performance.now() - start
        await new Promise(resolve => setTimeout(resolve, 25))
        clearInterval(timer)
        const inspection = prepared.inspection ?? prepared
        if (!inspection.ok) throw new Error(JSON.stringify(inspection.errors))
        const restoreStart = performance.now()
        const restored = service.restorePrepared ? await service.restorePrepared(prepared) : await service.importBackup(bytes)
        const restoreMs = performance.now() - restoreStart
        prepared.dispose?.()
        const db = workspace.openBook(restored.id)
        const texts = new Map((await db.table('chapterTexts').toArray()).map(x => [x.chapterIndex, x.text]))
        if (data.tables.chapterTexts.some(x => texts.get(x.chapterIndex) !== x.text) || await db.table('nodes').count() !== 2000 || await db.table('eventLines').count() !== 100) throw new Error('恢复数据不一致')
        samples.push({ prepareMs: +prepareMs.toFixed(2), prepareMaxTimerGapMs: +maxGap.toFixed(2), restoreMs: +restoreMs.toFixed(2), intact: true })
      }
      const median = key => samples.map(x => x[key]).sort((a, b) => a - b)[1]
      return { chapters: 200, nodes: 2000, lines: 100, compressedBytes: bytes.length, medianPrepareMs: median('prepareMs'), medianPrepareMaxTimerGapMs: median('prepareMaxTimerGapMs'), medianRestoreMs: median('restoreMs'), samples }
    } finally { importer.close(); workspace.close() }
  })
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally { await browser?.close(); await server.close() }
