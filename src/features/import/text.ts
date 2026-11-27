export const DEFAULT_CHAPTER_PATTERN = String.raw`/(?:^|[。！？!?：:；;])([\s\u3000\uFEFF]*第\s*(?:[零一二三四五六七八九十百千万0-9]\s*)+[章回卷节部篇][^\n\r]{0,80})/gm`

export type EncodingChoice = 'auto' | 'utf-8' | 'gbk'
export interface ChapterDraft {
  chapterIndex: string
  chapterName: string
  order: number
  charCount: number
  text: string
}
export interface ChapterRange extends Omit<ChapterDraft, 'text'> { start: number; end: number }
export type PreviewChapter = ChapterDraft | ChapterRange
export interface ParsedNovel<C extends PreviewChapter = ChapterDraft> {
  encoding: 'UTF-8' | 'GBK'
  text: string
  chapters: C[]
}
export interface NovelPreview<C extends PreviewChapter = ChapterDraft> extends ParsedNovel<C> {
  fileName: string
  byteLength: number
  pattern: string
}
export type ImportPreview = NovelPreview<PreviewChapter>
export function chapterText(source: string, chapter: PreviewChapter) {
  return 'text' in chapter ? chapter.text : source.slice(chapter.start, chapter.end)
}

export function validateFiles(files: readonly { name: string }[]) {
  if (files.length !== 1) throw new Error('请一次选择一个 TXT 文件。')
  if (!/\.txt$/i.test(files[0].name)) throw new Error('仅支持 TXT 文件，请选择 .txt 小说。')
}

export function normalizeText(text: string) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

export function decodeNovel(bytes: ArrayBuffer, choice: EncodingChoice): Pick<ParsedNovel, 'encoding' | 'text'> {
  let text: string
  let encoding: 'UTF-8' | 'GBK' = 'UTF-8'
  if (choice === 'auto') {
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
    catch { text = new TextDecoder('gbk').decode(bytes); encoding = 'GBK' }
  } else {
    text = new TextDecoder(choice, { ignoreBOM: true }).decode(bytes)
    encoding = choice === 'gbk' ? 'GBK' : 'UTF-8'
  }
  text = normalizeText(text)
  if (!text.trim()) throw new Error('文件为空或只包含空白，无法导入。')
  return { encoding, text }
}

function compilePattern(input: string) {
  const value = input.trim()
  if (!value) throw new Error('分章正则不能为空，可以点击恢复默认。')
  const literal = value.match(/^\/([\s\S]*)\/([a-z]*)$/)
  try {
    const source = literal ? literal[1] : value
    const original = literal?.[2] ?? ''
    new RegExp(source, original) // Reject duplicate or invalid flags before adding defaults.
    return new RegExp(source, original + (original.includes('g') ? '' : 'g') + (original.includes('m') ? '' : 'm'))
  } catch (error) { throw new Error(`分章正则无效：${error instanceof Error ? error.message : String(error)}`) }
}

export function splitChapters(text: string, pattern: string): ChapterDraft[] {
  return splitChapterRanges(text, pattern).map(({ start, end, ...chapter }) => ({ ...chapter, text: text.slice(start, end) }))
}

export function splitChapterRanges(text: string, pattern: string): ChapterRange[] {
  const regex = compilePattern(pattern)
  const titles: { start: number; name: string }[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    if (!match[0].length) throw new Error('分章正则不能匹配零长度文本，请修改后重试。')
    const capture = match[1] ?? match[0]
    const name = capture.trim()
    if (name) titles.push({ start: match.index + Math.max(0, match[0].indexOf(capture)), name })
  }
  const chapters: ChapterRange[] = []
  function add(index: string, name: string, start: number, end: number, chunkSize = 10000) {
    const chunks = splitCharacterRanges(text, start, end, chunkSize)
    for (let part = 0; part < chunks.length; part++) {
      const chunk = chunks[part]
      chapters.push({
        chapterIndex: chunks.length > 1 ? `${index}.${part + 1}` : index,
        chapterName: chunks.length > 1 ? `${name}（第 ${part + 1} 块）` : name,
        order: chapters.length, charCount: chunk.end - chunk.start, ...chunk,
      })
    }
  }
  if (!titles.length) {
    for (const chunk of splitCharacterRanges(text, 0, text.length, 4000)) {
      const index = String(chapters.length + 1)
      chapters.push({ chapterIndex: index, chapterName: `第 ${index} 段`, order: chapters.length, charCount: chunk.end - chunk.start, ...chunk })
    }
  } else {
    const prefix = text.slice(0, titles[0].start)
    const hasPreamble = prefix.trim().length > 0
    if (hasPreamble) add('0', '序文', 0, titles[0].start)
    titles.forEach((title, index) => {
      const start = index === 0 && !hasPreamble ? 0 : title.start
      add(String(index + 1), title.name, start, titles[index + 1]?.start ?? text.length)
    })
  }
  return chapters
}

function splitCharacterRanges(text: string, from: number, limit: number, size: number) {
  const chunks: { start: number; end: number }[] = []
  // Backward capacity includes every future surrogate boundary, not just raw lengths.
  const minimumStarts = [limit]
  while (minimumStarts.at(-1)! > from) {
    const end = minimumStarts.at(-1)!
    let start = Math.max(from, end - size)
    if (start > from && /[\uD800-\uDBFF]/.test(text[start - 1]) && /[\uDC00-\uDFFF]/.test(text[start])) start++
    minimumStarts.push(start)
  }
  for (let offset = from; offset < limit;) {
    const minimumEnd = minimumStarts[Math.max(0, minimumStarts.length - chunks.length - 2)]
    const end = findChunkBoundary(text, offset, size, minimumEnd, limit)
    chunks.push({ start: offset, end }); offset = end
  }
  return chunks
}

function findChunkBoundary(text: string, offset: number, size: number, minimumEnd: number, limit: number) {
  let end = Math.min(offset + size, limit)
  if (end === limit) return end
  if (/[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--
  // Keep the planned number of chunks: moving a boundary must not add model work.
  const minimum = Math.max(offset + 1, end - Math.min(1000, Math.floor(size / 10)), minimumEnd)
  for (let i = end - 1; i >= minimum - 1; i--) if (text[i] === '\n') return i + 1
  for (let i = end - 1; i >= minimum - 1; i--) {
    if (!'。！？!?'.includes(text[i])) continue
    let boundary = i + 1
    while (boundary < limit && '”’」』）】'.includes(text[boundary])) boundary++
    if (boundary <= end) return boundary
  }
  return end
}

export function assertPreview(preview: ImportPreview) {
  validateFiles([{ name: preview.fileName }])
  if (!preview.text.trim() || preview.text.includes('\r') || !preview.chapters.length) throw new Error('导入预览无效，请重新预览。')
  const ids = new Set<string>()
  let offset = 0
  for (const [order, chapter] of preview.chapters.entries()) {
    if (!chapter.chapterName.trim() || !chapter.chapterIndex || ids.has(chapter.chapterIndex) || chapter.order !== order || !Number.isSafeInteger(chapter.charCount) || chapter.charCount < 1) throw new Error('导入预览的章节信息不完整，请重新预览。')
    const end = offset + chapter.charCount
    if ('text' in chapter ? chapter.text.length !== chapter.charCount || chapter.text !== preview.text.slice(offset, end)
      : chapter.start !== offset || chapter.end !== end || end > preview.text.length) throw new Error('导入预览正文不一致，请重新预览。')
    offset = end
    ids.add(chapter.chapterIndex)
  }
  if (offset !== preview.text.length) throw new Error('导入预览正文不一致，请重新预览。')
}
