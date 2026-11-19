import { performance } from 'node:perf_hooks'
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
const source = process.argv[3] ? stripTypeScriptTypes(execFileSync('git', ['show', `${process.argv[3]}:src/features/import/text.ts`], { encoding: 'utf8' })) : null
const { splitChapters, DEFAULT_CHAPTER_PATTERN } = await import(source ? `data:text/javascript;base64,${Buffer.from(source).toString('base64')}` : '../../src/features/import/text.ts')

const cases = []
for (const [prefix, size] of [['第一章 测试\n', 10000], ['', 4000]]) {
  for (const boundary of ['\n', '。', '。”']) {
    const before = prefix + '甲'.repeat(size - 6 - prefix.length) + boundary
    const text = before + '众人见到贾蓉走进房间。' + '乙'.repeat(60)
    cases.push({ name: `${size}/${JSON.stringify(boundary)}`, text, size, expectedEnd: before.length })
  }
  for (const length of [size + 30, 2 * size, 2 * size + 1]) {
    cases.push({ name: `${size}/fallback/${length}`, size,
      text: prefix + '甲'.repeat(size - 20 - prefix.length) + '。' + '乙'.repeat(length - size + 19) })
  }
  cases.push({ name: `${size}/future-surrogate`, size,
    text: prefix + '甲'.repeat(size - 2 - prefix.length) + '\n' + '乙'.repeat(size - 1) + '😀' + '丙'.repeat(size - 1) })
}
const results = cases.map(sample => {
  const chunks = splitChapters(sample.text, DEFAULT_CHAPTER_PATTERN)
  return { name: sample.name, length: sample.text.length, chunks: chunks.length,
    badBoundary: sample.expectedEnd !== undefined && chunks[0].text.length !== sample.expectedEnd ? 1 : 0,
    intact: chunks.map(x => x.text).join('') === sample.text,
    withinLimit: chunks.every(x => x.text.length <= sample.size),
    utf8Intact: chunks.map(x => Buffer.from(x.text).toString('utf8')).join('') === sample.text }
})
// Large deterministic input: timing is cost evidence, boundary quality is the primary metric.
const large = Array.from({ length: 500 }, (_, i) => `第${i + 1}章 测试\n` + ('甲'.repeat(9970) + '。\n') + '乙'.repeat(123)).join('\n')
for (let i = 0; i < 3; i++) splitChapters(large, DEFAULT_CHAPTER_PATTERN)
const elapsed = []
for (let i = 0; i < 15; i++) {
  const start = performance.now()
  splitChapters(large, DEFAULT_CHAPTER_PATTERN)
  elapsed.push(performance.now() - start)
}
elapsed.sort((a, b) => a - b)
const noBreaks = '甲'.repeat(4000000)
const noBreakElapsed = []
for (let i = 0; i < 15; i++) {
  const start = performance.now()
  splitChapters(noBreaks, DEFAULT_CHAPTER_PATTERN)
  noBreakElapsed.push(performance.now() - start)
}
noBreakElapsed.sort((a, b) => a - b)
const result = { sampleCount: cases.length, badBoundaries: results.reduce((sum, x) => sum + x.badBoundary, 0),
  totalChunks: results.reduce((sum, x) => sum + x.chunks, 0),
  intact: results.every(x => x.intact && x.utf8Intact && x.withinLimit),
  largeCharacters: large.length, medianMs: +elapsed[7].toFixed(3), noBreakCharacters: noBreaks.length, noBreakMedianMs: +noBreakElapsed[7].toFixed(3), cases: results }
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
