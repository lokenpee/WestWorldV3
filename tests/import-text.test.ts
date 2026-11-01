import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CHAPTER_PATTERN, decodeNovel, splitChapters, validateFiles } from '../src/features/import/text'
import { PreviewLoader } from '../src/features/import/previewLoader'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url))

describe('阶段2：文本保全和分章', () => {
  it('默认正则与冻结契约一致，序文及全部正文精确保留', () => {
    const golden = JSON.parse(readFileSync(new URL('../docs/v2/resources/golden-results.json', import.meta.url), 'utf8'))
    expect(DEFAULT_CHAPTER_PATTERN).toBe(golden.regex)
    const text = fixture('A-三章短篇.txt').toString('utf8')
    const chapters = splitChapters(text, DEFAULT_CHAPTER_PATTERN)
    expect(chapters.map(chapter => chapter.chapterIndex)).toEqual(['0', '1', '2', '3'])
    expect(chapters.map(chapter => chapter.text).join('')).toBe(text)
    expect(chapters[0].chapterName).toBe('序文')
  })

  it('UTF8优先、GBK回退、规范化BOM和换行，不trim正文', () => {
    expect(decodeNovel(new TextEncoder().encode('\uFEFF第一章 开始\r\n  正文 \r末尾\n').buffer, 'auto')).toEqual({ encoding: 'UTF-8', text: '第一章 开始\n  正文 \n末尾\n' })
    const bytes = fixture('B-GBK.txt')
    expect(decodeNovel(Uint8Array.from(bytes).buffer, 'auto')).toEqual({ encoding: 'GBK', text: '第一章 编码\n中文样本。' })
    expect(decodeNovel(Uint8Array.from(bytes).buffer, 'utf-8').encoding).toBe('UTF-8')
  })

  it('长章10000边界、小数编号、序文长块都不丢字', () => {
    const text = fixture('B-长章.txt').toString('utf8')
    const chapters = splitChapters(text, DEFAULT_CHAPTER_PATTERN)
    expect(chapters.map(chapter => [chapter.chapterIndex, chapter.charCount])).toEqual([['1.1', 10000], ['1.2', 8]])
    expect(chapters.map(chapter => chapter.text).join('')).toBe(text)
    const preamble = '序'.repeat(10001) + '\n第一章 新章\n结尾'
    expect(splitChapters(preamble, DEFAULT_CHAPTER_PATTERN).map(chapter => chapter.chapterIndex)).toEqual(['0.1', '0.2', '1'])
    expect(splitChapters('第1章\n' + '甲'.repeat(9995), DEFAULT_CHAPTER_PATTERN)).toHaveLength(1)
  })

  it('无标题4000分段；纯空白前缀并入首章；UTF16计数', () => {
    const plain = '甲'.repeat(8001)
    expect(splitChapters(plain, DEFAULT_CHAPTER_PATTERN).map(chapter => chapter.charCount)).toEqual([4000, 4000, 1])
    const whitespace = '\n \t第一章 标题\n😀'
    const chapters = splitChapters(whitespace, DEFAULT_CHAPTER_PATTERN)
    expect(chapters).toHaveLength(1)
    expect(chapters[0].text).toBe(whitespace)
    expect(chapters[0].charCount).toBe(whitespace.length)
  })

  it.each(['', '[', '/^/gm', '/(?=章)/g', '/abc/gg'])('拒绝空/无效/零宽正则 %s', pattern => {
    expect(() => splitChapters('第一章 开始\n正文', pattern)).toThrow()
  })

  it('捕获组与标点边界不吞掉前章标点，支持自定义无捕获正则', () => {
    const text = '序言。第一章 开始\n正文！第二章 继续\n尾'
    expect(splitChapters(text, DEFAULT_CHAPTER_PATTERN).map(chapter => chapter.text).join('')).toBe(text)
    expect(splitChapters('序\nCHAPTER A\n一\nCHAPTER B\n二', '^CHAPTER .+$').map(chapter => chapter.chapterName)).toEqual(['序文', 'CHAPTER A', 'CHAPTER B'])
  })

  it('选择和拖放都要求单个TXT，MIME不决定合法性，全空白拒绝', () => {
    expect(() => validateFiles([{ name: '书.TXT' }])).not.toThrow()
    expect(() => validateFiles([{ name: '书.csv' }])).toThrow('TXT')
    expect(() => validateFiles([{ name: 'a.txt' }, { name: 'b.txt' }])).toThrow('一个')
    expect(() => validateFiles([])).toThrow('一个')
    expect(() => decodeNovel(new TextEncoder().encode(' \n\t').buffer, 'auto')).toThrow('空白')
  })
})

describe('阶段2：异步预览防串结果', () => {
  it('后选的文件生效，晚返回的旧文件被丢弃', async () => {
    let release!: (value: ArrayBuffer) => void
    const slow = { name: '旧.txt', size: 10, arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { release = resolve }) }
    const loader = new PreviewLoader(async (bytes, encoding, pattern) => {
      const decoded = decodeNovel(bytes, encoding)
      return { ...decoded, chapters: splitChapters(decoded.text, pattern) }
    })
    const old = loader.load([slow], 'auto', DEFAULT_CHAPTER_PATTERN)
    const latest = await loader.load([new File(['新正文'], '新.txt')], 'auto', DEFAULT_CHAPTER_PATTERN)
    release(new TextEncoder().encode('旧正文').buffer)
    expect(await old).toBeNull()
    expect(latest?.text).toBe('新正文')
  })
})
it('长章和无标题切分在字符边界结束，UTF8往返保留表情与扩展汉字', () => {
  for (const [prefix, size, symbol] of [['第一章 测试\n', 10000, '😀'], ['', 4000, '𠮷']] as const) {
    const text = prefix + '甲'.repeat(size - 1 - prefix.length) + symbol + '乙'.repeat(30)
    const chapters = splitChapters(text, DEFAULT_CHAPTER_PATTERN)
    expect(chapters.length).toBeGreaterThan(1)
    for (const chapter of chapters) expect(/[\uD800-\uDFFF]/u.test(chapter.text)).toBe(false)
    expect(chapters.map(chapter => new TextDecoder().decode(new TextEncoder().encode(chapter.text))).join('')).toBe(text)
  }
})
