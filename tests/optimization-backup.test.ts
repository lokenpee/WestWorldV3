import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { writeFileSync } from 'node:fs'
import { expect, test, vi } from 'vitest'
import { unzipSync } from 'fflate'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createImportService } from '../src/lib/storage/importService'
import { createBackupService } from '../src/features/backup/service'
import { DEFAULT_CHAPTER_PATTERN, splitChapters } from '../src/features/import/text'

vi.mock('fflate', async importOriginal => {
  const actual = await importOriginal<typeof import('fflate')>()
  return { ...actual, unzipSync: vi.fn(actual.unzipSync) }
})

test('opt03：相同备份的预检、确认恢复量化及完整性', async () => {
  const prefix = `opt03-${crypto.randomUUID()}`
  const workspace = createWorkspace({ settingsName: `${prefix}-settings`, bookPrefix: `${prefix}-book-` })
  const importer = createImportService(workspace)
  try {
    const text = Array.from({ length: 200 }, (_, i) => `第${i + 1}章 测试\n${'甲'.repeat(8000)}\n`).join('')
    const source = await importer.importNovel({ fileName: '量化备份.txt', text, byteLength: Buffer.byteLength(text), encoding: 'UTF-8', pattern: DEFAULT_CHAPTER_PATTERN, chapters: splitChapters(text, DEFAULT_CHAPTER_PATTERN) })
    const service = createBackupService(workspace, importer)
    const backup = await service.exportBook(source.id)
    vi.mocked(unzipSync).mockClear()
    const start = performance.now()
    const preview = await service.prepareBackup(backup.bytes)
    expect(preview.inspection.ok).toBe(true)
    const preparedAt = performance.now()
    const restored = await service.restorePrepared(preview)
    const end = performance.now()
    const chapters = (await workspace.openBook(restored.id).chapters.toArray()).sort((a, b) => a.order - b.order)
    const texts = new Map((await workspace.openBook(restored.id).table('chapterTexts').toArray()).map(x => [x.chapterIndex, x.text]))
    expect(chapters.map(x => texts.get(x.chapterIndex)).join('')).toBe(text)
    const result = { chapters: chapters.length, sourceCharacters: text.length, compressedBytes: backup.bytes.length,
      unzipCalls: vi.mocked(unzipSync).mock.calls.length, prepareMs: +(preparedAt - start).toFixed(2), restoreMs: +(end - preparedAt).toFixed(2), intact: true }
    expect(result.unzipCalls).toBe(1)
    if (process.env.WW_OPT03_RESULT) writeFileSync(process.env.WW_OPT03_RESULT, JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify(result))
  } finally {
    importer.close(); workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name.startsWith(prefix)) await Dexie.delete(name)
  }
}, 30000)
