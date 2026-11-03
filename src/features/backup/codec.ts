import { strFromU8, strToU8, unzipSync, zip, type Zippable } from 'fflate'
import type { Book } from '../../lib/storage/workspace'
import { chapterFileName, emptyTables, migrateLegacy, migrateRelationsData, pauseBookData, repairValidatedBookData, tableNames, type BackupError, type BookData, type Row, type TableName } from './data'

export interface BackupManifest {
  format: 'westworld-v2'; formatVersion: number; appVersion: string; exportedAt: string
  book: { id: string; title: string; chapterCount: number }; contents: string[]; excludes: string[]; checksums: Record<string, string>
}
export interface BackupInspection { ok: boolean; errors: BackupError[]; manifest?: BackupManifest; stats?: { chapters: number; characters: number; locations: number; nodes: number; eventLines: number }; data?: BookData }
export interface ExportResult { fileName: string; bytes: Uint8Array<ArrayBuffer>; manifest: BackupManifest; processing: boolean }
export const checksumOf = async (bytes: Uint8Array) => `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))).map(value => value.toString(16).padStart(2, '0')).join('')}`
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const fail = (code: string, path: string, message: string): BackupInspection => ({ ok: false, errors: [{ code, path, message }] })

export async function encodeBackup(input: BookData): Promise<ExportResult> {
  const processing = input.tables.pipelineRuns.some(row => row.recordType === 'lease' || row.status === 'running') || input.tables.compileProgress.some(row => row.status === 'running')
  const data = pauseBookData(input)
  const errors = await repairValidatedBookData(data)
  if (errors.length) throw new Error(`备份资料校验失败：${errors[0].path} ${errors[0].message}`)
  const contents = ['book', ...tableNames.filter(name => name !== 'chapterTexts')]
  const files: Record<string, Uint8Array> = { 'data/book.json': strToU8(JSON.stringify(data.book)) }
  for (const name of tableNames.filter(name => name !== 'chapterTexts')) files[`data/${name}.json`] = strToU8(JSON.stringify(data.tables[name]))
  for (const row of data.tables.chapterTexts) files[chapterFileName(row.chapterIndex as string)] = strToU8(row.text as string)
  const manifest: BackupManifest = { format: 'westworld-v2', formatVersion: 7, appVersion: '0.3.0', exportedAt: new Date().toISOString(), book: { id: data.book.id, title: data.book.title, chapterCount: data.tables.chapters.length }, contents, excludes: ['apiKey', 'appSettings', 'credentials', 'leases'], checksums: Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, bytes]) => [name, await checksumOf(bytes)]))) }
  files['manifest.json'] = strToU8(JSON.stringify(manifest))
  const bytes = await new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => zip(files as Zippable, { level: 6 }, (error, result) => error ? reject(error) : resolve(new Uint8Array(result))))
  const title = Array.from(data.book.title.replace(/[<>:"/\\|?*]/g, '_')).map(character => character.charCodeAt(0) < 32 ? '_' : character).join('').slice(0, 80)
  return { bytes, manifest, processing, fileName: `${title}-${manifest.exportedAt.replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.wwv2` }
}

export async function inspectBackup(bytes: Uint8Array): Promise<BackupInspection> {
  let path = 'manifest.json'
  try {
    if (bytes.length > 128 * 1024 * 1024) return fail('SIZE', '', '备份文件超过128MB。')
    let expanded = 0; let count = 0
    const files = unzipSync(bytes, { filter: file => {
      expanded += file.originalSize; count++
      if (expanded > 256 * 1024 * 1024 || count > 40000) throw new Error('备份展开内容超过256MB或文件数量超过40000。')
      return true
    } })
    const parse = (name: string): unknown => { path = name; if (!files[name]) throw new Error('备份中缺少文件。'); return JSON.parse(strFromU8(files[name])) }
    const value = parse(path)
    if (!object(value) || value.format !== 'westworld-v2' || !Number.isInteger(value.formatVersion) || typeof value.appVersion !== 'string' || typeof value.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.exportedAt)) || !object(value.book) || typeof value.book.id !== 'string' || typeof value.book.title !== 'string' || !Number.isInteger(value.book.chapterCount) || !Array.isArray(value.contents) || !value.contents.every(item => typeof item === 'string') || !Array.isArray(value.excludes) || !value.excludes.every(item => typeof item === 'string') || !object(value.checksums)) return fail('MANIFEST', path, '备份清单结构不完整。')
    if (![4, 5, 6, 7].includes(value.formatVersion as number)) return fail('VERSION', path, Number(value.formatVersion) > 7 ? '备份版本较新，请使用支持该版本的应用。' : '备份版本不受支持。')
    const manifest = value as unknown as BackupManifest
    for (const name of Object.keys(files)) if (name !== 'manifest.json' && !Object.hasOwn(manifest.checksums, name)) return fail('CHECKSUM', name, '文件缺少校验和。')
    for (const [name, checksum] of Object.entries(manifest.checksums)) {
      if (!/^(?:data\/[A-Za-z]+\.json|chapters\/\d+(?:\.\d+)*\.txt)$/.test(name)) return fail('PATH', name, '备份文件路径不符合格式。')
      if (!files[name]) return fail('MISSING_FILE', name, '备份中缺少文件。')
      if (typeof checksum !== 'string' || checksum !== await checksumOf(files[name])) return fail('CHECKSUM', name, '文件校验和不符。')
    }
    const bookValue = parse('data/book.json')
    if (!object(bookValue) || bookValue.id !== manifest.book.id || bookValue.title !== manifest.book.title) return fail('BOOK', path, '书籍信息与清单不符。')
    const book = bookValue as unknown as Book
    book.sourceFileName ??= ''
    const tables = emptyTables()
    const legacy: Record<string, unknown> = {}
    const expected = ['book', ...tableNames.filter(name => name !== 'chapterTexts' && (
      manifest.formatVersion < 5 ? !['extractionReceipts', 'assetLifecycle', 'pipelineRuns', 'characterRelations', 'characterRelationEdits'].includes(name)
        : manifest.formatVersion === 5 ? !['characterRelations', 'characterRelationEdits'].includes(name)
          : manifest.formatVersion === 6 ? name !== 'characterRelationEdits'
            : true))]
    if (expected.some(name => !manifest.contents.includes(name)) || new Set(manifest.contents).size !== manifest.contents.length) return fail('CONTENTS', 'manifest.json', '备份内容清单缺少必要数据或含重复项。')
    for (const name of manifest.contents) {
      if (name === 'book') continue
      const value = parse(`data/${name}.json`)
      if (!Array.isArray(value)) return fail('SCHEMA', path, '数据文件须为列表。')
      if (tableNames.includes(name as TableName) && name !== 'chapterTexts') tables[name as TableName] = value as Row[]
      else if (manifest.formatVersion === 4 && ['characterSnapshots', 'locationSnapshots'].includes(name)) legacy[name] = value
      else return fail('CONTENTS', path, '备份包含无法识别的数据表。')
    }
    const decoder = new TextDecoder('utf-8', { fatal: true })
    for (const chapter of tables.chapters) {
      if (!object(chapter) || typeof chapter.chapterIndex !== 'string' || !/^\d+(?:\.\d+)*$/.test(chapter.chapterIndex)) return fail('CHAPTER', 'data/chapters.json', '章节编号不符合格式。')
      path = chapterFileName(chapter.chapterIndex)
      if (!files[path] || !manifest.checksums[path]) return fail('MISSING_FILE', path, '章节原文缺失。')
      tables.chapterTexts.push({ bookId: book.id, chapterIndex: chapter.chapterIndex, text: decoder.decode(files[path]) })
    }
    const expectedFiles = new Set(['manifest.json', ...manifest.contents.map(name => `data/${name}.json`), ...tables.chapters.map(row => chapterFileName(row.chapterIndex as string))])
    for (const name of Object.keys(files)) if (!expectedFiles.has(name)) return fail('CONTENTS', name, '文件未登记在数据表或章节清单中。')
    let data: BookData = { book, tables }
    if (manifest.formatVersion === 4) data = migrateLegacy(data, legacy)
    if (manifest.formatVersion < 6) data = migrateRelationsData(data)
    const errors = await repairValidatedBookData(data)
    if (manifest.book.chapterCount !== tables.chapters.length) errors.push({ code: 'COUNT', path: 'manifest.json', message: '清单章数与实际章节数量不符。' })
    if (errors.length) return { ok: false, errors, manifest }
    return { ok: true, errors: [], manifest, data, stats: { chapters: tables.chapters.length, characters: data.tables.characters.length, locations: data.tables.locations.length, nodes: tables.nodes.length, eventLines: tables.eventLines.length } }
  } catch (error) { return fail('PARSE', path, error instanceof Error ? error.message : '备份文件解析失败。') }
}

export async function restoredTables(data: BookData, bookId: string) {
  const copy = pauseBookData(data)
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite)
    if (!object(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'bookId' && item === data.book.id ? bookId : rewrite(item)]))
  }
  const tables = rewrite(copy.tables) as typeof copy.tables
  tables.storySessionEntries = tables.storySessionEntries.map((row, index) => ({ ...row, ...(copy.tables.storySessionEntries[index].message ? { message: copy.tables.storySessionEntries[index].message } : {}), ...(copy.tables.storySessionEntries[index].systemMessage ? { systemMessage: copy.tables.storySessionEntries[index].systemMessage } : {}) }))
  const { rebaseRestoredProgress } = await import('./rebase')
  await rebaseRestoredProgress(copy, tables, bookId)
  return tables
}
