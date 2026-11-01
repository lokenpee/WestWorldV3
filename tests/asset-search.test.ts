import { expect, it } from 'vitest'
import { searchAssets } from '../src/features/assets/search'
import type { Asset, Character, EventLine, EventNode, LocationAsset } from '../src/features/assets/types'
import type { Chapter } from '../src/lib/storage/workspace'

const person = (id: string, name: string, extra: Partial<Character> = {}): Character => ({ id, bookId: 'a', name, confidence: 1, revision: 1, createdBy: 'P1', ...extra })
const chapter = (chapterIndex: string, order: number): Chapter => ({ bookId: 'a', chapterIndex, chapterName: `第${chapterIndex}章`, order, charCount: 1 })
const ids = (rows: Asset[]) => rows.map(row => row.id)

it('薛蟠本人优先于别名、名称部分匹配和正文提及，关联人物仍可找到', () => {
  const rows = [person('body', '宝钗', { identity: '薛蟠之妹' }), person('partial', '旧档薛蟠'), person('prefix', '薛蟠旧档'), person('alias', '薛文龙', { aliases: ['薛蟠'] }), person('exact', '薛蟠'), person('other', '贾珩')]
  expect(ids(searchAssets(rows, '薛蟠'))).toEqual(['exact', 'alias', 'prefix', 'partial', 'body'])
})

it('编号精确、前缀和部分匹配按优先级排序，大小写及全角输入归一化', () => {
  const rows = [person('P-body', '宝钗', { identity: '来自C1-P003的记录' }), person('C1-P003-extra', '丙'), person('C1-P003', '薛蟠')]
  expect(ids(searchAssets(rows, ' ｃ１－ｐ００３ '))).toEqual(['C1-P003', 'C1-P003-extra', 'P-body'])
})

it('别名完全匹配优先于名称包含，名称前缀优先于别名前缀', () => {
  const rows = [person('body', '宝钗', { identity: '薛蟠' }), person('alias-prefix', '薛文龙', { aliases: ['薛蟠公子'] }), person('name-prefix', '薛蟠旧档'), person('name-part', '青年薛蟠'), person('alias-exact', '呆霸王', { aliases: ['薛蟠'] })]
  expect(ids(searchAssets(rows, '薛蟠'))).toEqual(['alias-exact', 'name-prefix', 'alias-prefix', 'name-part', 'body'])
})

it('同名同级结果按章节顺序排列，清空搜索保持原名称和编号排序', () => {
  const rows = [person('C10-P001', '薛蟠', { chapterIndex: '10' }), person('C2-P001', '薛蟠', { sourceChapters: ['10', '2'] }), person('C1-P001', '薛蟠', { chapterIndex: '1' })]
  const chapters = [chapter('1', 0), chapter('2', 1), chapter('10', 2)]
  expect(ids(searchAssets(rows, '薛蟠', chapters))).toEqual(['C1-P001', 'C2-P001', 'C10-P001'])
  expect(ids(searchAssets(rows, '', chapters))).toEqual(['C1-P001', 'C10-P001', 'C2-P001'])
  expect(ids(rows)).toEqual(['C10-P001', 'C2-P001', 'C1-P001'])
})

it('地点按名称、别名和描述匹配，名称精确结果优先', () => {
  const rows = [person('body', '东院', { description: '邻近宁国府' } as Partial<LocationAsset>), { ...person('alias', '宁府'), aliases: ['宁国府'] }, person('exact', '宁国府')] as LocationAsset[]
  expect(ids(searchAssets(rows, '宁国府'))).toEqual(['exact', 'alias', 'body'])
})

it('事件节点的名称结果优先于概述提及，事件线可按起因经过结果查找', () => {
  const node = (id: string, name: string, summary: string): EventNode => ({ id, bookId: 'a', revision: 1, createdBy: 'P1', name, summary, actors: [], quote: '', chapterIndex: '1', chapterName: '第一章', order: 0, confidence: 1 })
  expect(ids(searchAssets([node('body', '宝钗探问', '谈起薛蟠案'), node('exact', '薛蟠案', '')], '薛蟠案'))).toEqual(['exact', 'body'])
  const line = (id: string, title: string, field: 'cause' | 'process' | 'result' = 'cause'): EventLine => ({ id, bookId: 'a', revision: 1, createdBy: 'P3', title, nodeIds: [], chapters: [], cause: '', process: '', result: '', [field]: '涉及薛蟠案', lineStatus: 'open', updatedAt: '' })
  const lines = [line('cause', '案情缘起'), line('process', '审讯经过', 'process'), line('result', '结案处置', 'result'), line('exact', '薛蟠案')]
  expect(searchAssets(lines, '薛蟠案')[0].id).toBe('exact')
  expect(ids(searchAssets(lines, '薛蟠案')).sort()).toEqual(['cause', 'exact', 'process', 'result'])
})

it('相同输入排序稳定，无结果和纯空白查询正确，排序不改资料', () => {
  const rows = [person('2', '薛蟠'), person('1', '宝钗', { identity: '薛蟠之妹' })]
  const before = structuredClone(rows)
  expect(searchAssets(rows, '不存在')).toEqual([])
  expect(searchAssets(rows, '　 ')).toEqual(searchAssets(rows, ''))
  expect(searchAssets(rows, '薛蟠')).toEqual(searchAssets([...rows].reverse(), '薛蟠'))
  expect(rows).toEqual(before)
})
