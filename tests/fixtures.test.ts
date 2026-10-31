import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Value } from 'typebox/value'

const seed = JSON.parse(readFileSync(new URL('./fixtures/C-固定资产.json', import.meta.url), 'utf8'))
const schema = JSON.parse(readFileSync(new URL('../docs/v2/resources/v2.2/storage.schema.json', import.meta.url), 'utf8'))
const a = readFileSync(new URL('./fixtures/A-三章短篇.txt', import.meta.url), 'utf8')

describe('人工验收样本的输入完整性', () => {
  it.each([
    ['characters', 'StoredCharacter'], ['locations', 'StoredLocation'], ['nodes', 'StoredNode'],
    ['eventLines', 'StoredEventLine'], ['chapters', 'Chapter'], ['chapterTexts', 'ChapterText'],
  ])('%s 符合完整目标存储 Schema', (table, definition) => {
    for (const row of seed.tables[table]) {
      const errors = [...Value.Errors({ ...schema, $ref: `#/$defs/${definition}` }, row)]
      expect(errors).toEqual([])
    }
  })

  it('序文、章节文本完整，所有节点引文真实存在，双向线成员一致', () => {
    const texts = seed.tables.chapterTexts as { chapterIndex: string; text: string }[]
    const chapters = seed.tables.chapters as { chapterIndex: string; charCount: number }[]
    const nodes = seed.tables.nodes as { id: string; chapterIndex: string; quote: string; eventLineIds: string[] }[]
    const lines = seed.tables.eventLines as { id: string; nodeIds: string[] }[]
    expect(texts.map(row => row.text).join('')).toBe(a)
    expect(texts[0].chapterIndex).toBe('0')
    for (const chapter of chapters) expect(texts.find(row => row.chapterIndex === chapter.chapterIndex)?.text.length).toBe(chapter.charCount)
    for (const node of nodes) {
      expect(texts.find(row => row.chapterIndex === node.chapterIndex)?.text).toContain(node.quote)
      expect(lines.filter(line => line.nodeIds.includes(node.id)).map(line => line.id).sort()).toEqual([...node.eventLineIds].sort())
    }
    expect(nodes.filter(node => node.eventLineIds.length === 0).map(node => node.id)).toEqual(['C2-N002'])
    for (const line of lines) for (const id of line.nodeIds) expect(nodes.some(node => node.id === id)).toBe(true)
  })

  it('GBK 和长章样本确实覆盖编码与长度边界', () => {
    const bytes = readFileSync(new URL('./fixtures/B-GBK.txt', import.meta.url))
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toThrow()
    expect(new TextDecoder('gbk').decode(bytes)).toBe('第一章 编码\n中文样本。')
    expect(readFileSync(new URL('./fixtures/B-长章.txt', import.meta.url), 'utf8').length).toBe(10008)
    expect(readFileSync(new URL('./fixtures/B-空文本.txt', import.meta.url)).length).toBe(0)
  })
})
