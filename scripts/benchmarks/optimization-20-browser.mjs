import { createServer } from 'vite'
import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const ref = process.argv[3]
const old = ref ? execFileSync('git', ['show', `${ref}:src/features/world/candidates.ts`], { encoding: 'utf8' }) : undefined
const server = await createServer({ configFile: false, plugins: [{ name: 'candidate-baseline', enforce: 'pre', load(id) {
  if (old && id.split('?')[0].replaceAll('\\', '/').endsWith('/src/features/world/candidates.ts')) return old
} }], server: { host: '127.0.0.1', port: 5196, strictPort: true } })
await server.listen()
let browser
try {
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chromium', headless: true })
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:5196/tests/browser/')
  const result = await page.evaluate(async baseline => {
    const algorithm = await import('/src/features/world/candidates.ts')
    const scanner = baseline ? undefined : await import('/src/features/world/candidateScanner.ts')
    const all = Array.from({ length: 600 }, (_, i) => ({ id: `P${String(i).padStart(4, '0')}`, name: `人物${String(i).padStart(4, '0')}`, aliases: [`别名${String(i).padStart(4, '0')}`, `异称${String(i).padStart(4, '0')}`] }))
    const samples = []
    for (const size of [100, 300, 600]) {
      const runs = []
      let groups
      for (let repeat = 0; repeat < 3; repeat++) {
        const gaps = []; let last = performance.now()
        const timer = setInterval(() => { const now = performance.now(); gaps.push(now - last); last = now }, 8)
        await new Promise(resolve => setTimeout(resolve, 20))
        const began = performance.now()
        const characters = all.slice(0, size)
        groups = scanner ? await scanner.scanCandidateRows('benchmark', { characters, locations: [] }, new AbortController().signal) : algorithm.findCandidates('character', characters)
        const elapsed = performance.now() - began
        await new Promise(resolve => setTimeout(resolve, 20)); clearInterval(timer)
        runs.push({ elapsedMs: +elapsed.toFixed(2), maxTimerGapMs: +Math.max(...gaps).toFixed(2) })
      }
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(groups))))].map(x => x.toString(16).padStart(2, '0')).join('')
      samples.push({ size, groups: groups.length, digest, runs, medianElapsedMs: runs.map(x => x.elapsedMs).sort((a,b)=>a-b)[1], medianMaxTimerGapMs: runs.map(x=>x.maxTimerGapMs).sort((a,b)=>a-b)[1] })
    }
    return { samples, mainThreadScansPerRun: baseline ? 1 : 0, browser: navigator.userAgent }
  }, !!ref)
  const output = { optimization: 20, ref: ref ?? 'working-tree', ...result }
  writeFileSync(process.argv[2], JSON.stringify(output, null, 2) + '\n')
  console.log(JSON.stringify(output, null, 2))
} finally { await browser?.close(); await server.close() }
