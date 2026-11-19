import { afterEach, expect, it, vi } from 'vitest'
import { unzipSync } from 'fflate'
import { checksumOf, encodeBackup, restoredTables } from '../src/features/backup/codec'
import { emptyTables, type BookData, type BookTables } from '../src/features/backup/data'
import { encodeBackupInWorker, prepareBackup, prepareMigration, restorePreparedBackup, type PreparedBackup } from '../src/features/backup/preparation'

vi.mock('fflate', async importOriginal => {
  const original = await importOriginal<typeof import('fflate')>()
  return { ...original, unzipSync: vi.fn(original.unzipSync) }
})

const handles: { dispose(): void }[] = []
afterEach(() => { handles.splice(0).forEach(handle => handle.dispose()); vi.clearAllMocks() })

function sample(): BookData {
  const book = { id: 'source-book', title: '准备结果样本', sourceFileName: 'sample.txt', createdAt: '2026-11-19T00:00:00.000Z' }
  const tables = emptyTables(), text = '第一章 书信\n沈青带来一封信。😀\n'
  tables.chapters.push({ bookId: book.id, chapterIndex: '1', chapterName: '第一章 书信', order: 0, charCount: text.length })
  tables.chapterTexts.push({ bookId: book.id, chapterIndex: '1', text })
  return { book, tables }
}

it('预检仅向界面提供摘要，确认恢复只解压一次，界面改动不污染原始资料', async () => {
  const data = sample(), backup = await encodeBackup(data), bytes = backup.bytes.slice(), stages: string[] = []
  const prepared = await prepareBackup(bytes, message => stages.push(message)); handles.push(prepared)
  expect(prepared.inspection.ok).toBe(true)
  expect(prepared.inspection).not.toHaveProperty('data')
  prepared.inspection.manifest!.book.title = '界面副本'
  const result = await restorePreparedBackup(prepared, async (book, read) => {
    expect(book.title).toBe(data.book.title)
    expect(await read('restored')).toEqual(await restoredTables(data, 'restored'))
    return { ...book, id: 'restored' }
  })
  expect(result.id).toBe('restored')
  expect(unzipSync).toHaveBeenCalledTimes(1)
  expect(bytes).toEqual(backup.bytes)
  expect(stages).toContain('正在解压备份…')
  expect(stages).toContain('正在换算整理进度…')
  await expect(restorePreparedBackup(prepared, vi.fn())).rejects.toThrow('已失效')
})

it('恢复失败可复用准备结果重试，每次重写编号都从原始资料开始', async () => {
  const data = sample(), prepared = await prepareBackup((await encodeBackup(data)).bytes); handles.push(prepared)
  let failedTables: BookTables | undefined
  await expect(restorePreparedBackup(prepared, async (_book, read) => {
    failedTables = await read('failed-copy')
    failedTables.chapterTexts[0].text = '失败恢复期间的外部改动'
    throw new Error('模拟写入失败')
  })).rejects.toThrow('模拟写入失败')
  await restorePreparedBackup(prepared, async (book, read) => {
    const tables = await read('retry-copy')
    expect(tables).toEqual(await restoredTables(data, 'retry-copy'))
    expect(tables).not.toBe(failedTables)
    return { ...book, id: 'retry-copy' }
  })
  expect(unzipSync).toHaveBeenCalledTimes(1)
})

it('释放或伪造的句柄不能恢复，损坏文件不能复用之前的有效结果', async () => {
  const good = await prepareBackup((await encodeBackup(sample())).bytes); handles.push(good)
  good.dispose()
  const restore = vi.fn()
  await expect(restorePreparedBackup(good, restore)).rejects.toThrow('已失效')
  const forged: PreparedBackup = { inspection: { ok: true, errors: [] }, dispose() {} }
  await expect(restorePreparedBackup(forged, restore)).rejects.toThrow('已失效')
  const bad = await prepareBackup(new TextEncoder().encode('broken zip')); handles.push(bad)
  expect(bad.inspection.ok).toBe(false)
  await expect(restorePreparedBackup(bad, restore)).rejects.toThrow()
  expect(restore).not.toHaveBeenCalled()
})

it('恢复进行时拒绝重复确认，界面释放句柄不打断已经交给导入器的操作', async () => {
  const prepared = await prepareBackup((await encodeBackup(sample())).bytes); handles.push(prepared)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const result = restorePreparedBackup(prepared, async (book, read) => {
    await gate
    expect((await read('restoring-copy')).chapterTexts[0].bookId).toBe('restoring-copy')
    return { ...book, id: 'restoring-copy' }
  })
  await expect(restorePreparedBackup(prepared, vi.fn())).rejects.toThrow('正在恢复')
  prepared.dispose()
  release()
  expect((await result).id).toBe('restoring-copy')
  await expect(restorePreparedBackup(prepared, vi.fn())).rejects.toThrow('已失效')
})

it('迁移摘要仍取转换前资料，尚未确认迁移时不编码或解压', async () => {
  const data = sample(), original = structuredClone(data)
  const preparation = await prepareMigration(data, 8); handles.push(preparation)
  expect(preparation.digest).toBe(await checksumOf(new TextEncoder().encode(JSON.stringify(original))))
  expect(unzipSync).not.toHaveBeenCalled()
  data.tables.chapterTexts[0].text = '调用者随后改动'
  const normalized = await preparation.normalize()
  expect(normalized).toEqual(original)
  expect(unzipSync).toHaveBeenCalledTimes(1)
})

it('导出准备在独立资料副本上执行，结果保持现有备份格式', async () => {
  const data = sample(), original = structuredClone(data)
  const pending = encodeBackupInWorker(data)
  data.book.title = '调用者随后改名'
  const backup = await pending
  expect(backup.manifest.book.title).toBe(original.book.title)
  const prepared = await prepareBackup(backup.bytes); handles.push(prepared)
  expect(prepared.inspection.ok).toBe(true)
  expect(prepared.inspection.stats?.chapters).toBe(1)
})
