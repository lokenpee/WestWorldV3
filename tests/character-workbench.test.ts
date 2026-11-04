import { describe, expect, it } from 'vitest'
import { searchCharacters } from '../src/features/assets/search'
import { paginateCharacterPairs } from '../src/features/assets/relations'
import type { Character, CharacterPairResult } from '../src/features/assets/types'

const person = (id: string, name: string, roleWeight: Character['roleWeight'], aliases: string[] = [], extra: Partial<Character> = {}): Character => ({ id, name, aliases, roleWeight, bookId: 'a', revision: 1, confidence: 1, createdBy: 'manual', chapterIndex: '1', ...extra })

describe('人物工作台查询', () => {
  it('空查询按层级、拼音和编号排序，缺失层级按 NPC', () => {
    const rows = [
      person('C1-P003', '王五', '路人'), person('C1-P002', '张三', 'NPC'), person('C1-P001', '李四', '主要人物'),
      person('C1-P004', '阿四', '主要人物'), person('C1-P005', '赵六', undefined), person('C1-P006', '阿四', '主要人物'),
    ]
    expect(searchCharacters(rows, '').map(row => row.id)).toEqual(['C1-P004', 'C1-P006', 'C1-P001', 'C1-P002', 'C1-P005', 'C1-P003'])
  })

  it('只匹配主名和别名，编号与身份不参与，相关度优先', () => {
    const rows = [
      person('A1', '薛文龙', 'NPC', ['薛蟠']), person('C1-P003', '薛蟠', '主要人物'), person('B1', '宝钗', '主要人物', [], { identity: '薛蟠之妹' }),
      person('D1', '薛蟠旧档', 'NPC'), person('C2-P003', '薛蟠', 'NPC'),
    ]
    expect(searchCharacters(rows, '薛蟠').map(row => row.id)).toEqual(['C1-P003', 'C2-P003', 'A1', 'D1'])
    expect(searchCharacters(rows, 'c1-p003')).toHaveLength(0)
    expect(searchCharacters(rows, '薛蟠之妹')).toHaveLength(0)
    expect(searchCharacters(rows, '薛文龙').map(row => row.id)).toEqual(['A1'])
  })

  it('人物对按对方姓名和编号稳定分页，总数与并集一致', () => {
    const people = [person('A', '张三', '主要人物'), ...Array.from({ length: 100 }, (_, index) => person(`B${index}`, `张${index}`, 'NPC'))]
    const pairs: CharacterPairResult[] = people.slice(1).map((row, index) => ({ pairKey: JSON.stringify(['A', row.id].sort()), fromId: 'A', toId: row.id, forwardLabels: ['朋友'], reverseLabels: ['朋友'], state: 'active', editRevision: 0, fingerprint: `F${index}`, evidence: [], sourceRelationIds: [], legacyRecordIds: [], directionUnclear: false, endpointRevisions: {} }))
    const collected: string[] = []
    let offset: number | null = 0
    while (offset !== null) { const page = paginateCharacterPairs(pairs, people, 'A', offset, 50); collected.push(...page.items.map(row => row.toId)); offset = page.nextOffset }
    expect(collected).toHaveLength(100)
    expect(new Set(collected).size).toBe(100)
  })
})
