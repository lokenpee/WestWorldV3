import { writeFileSync } from 'node:fs'
import * as current from '../../src/features/import/text.ts'
const text = Array.from({ length: 1000 }, (_, i) => `第${i + 1}章 测试\n${'甲'.repeat(4000)}\n`).join('')
const chapters = (current.splitChapterRanges ?? current.splitChapters)(text, current.DEFAULT_CHAPTER_PATTERN)
const preview = { encoding: 'UTF-8', text, chapters }
const result = { chapters: chapters.length, sourceCharacters: text.length,
  storedTextCharacters: text.length + chapters.reduce((sum, x) => sum + (x.text?.length ?? 0), 0),
  payloadBytes: Buffer.byteLength(JSON.stringify(preview)),
  intact: chapters.map(x => x.text ?? text.slice(x.start, x.end)).join('') === text }
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
