import { expect, it } from 'vitest'
import { updateFrequencies } from '../src/features/assets/derive'
import type { Character } from '../src/features/assets/types'

const person = (id: string, name: string, extra = {}): Character => ({ id, bookId: 'a', name, confidence: 1, revision: 1, createdBy: 'P1', ...extra })
it('主名与已核实的独有别名合计频次，同一原章分块只计一章，人工层级保留', () => {
  const result = updateFrequencies([person('1', '沈青', { aliases: ['老沈', '错误别名'], verifiedAliases: ['老沈'], roleWeight: '路人', roleWeightSource: 'manual' }), person('2', '张三'), person('3', '张三丰')], [{ chapterIndex: '1.1', text: '沈青遇见老沈。错误别名。张三丰遇见张三。' }, { chapterIndex: '1.2', text: '老沈走了。' }], true)
  expect(result[0]).toMatchObject({ frequency: { chapters: 1, mentions: 3, scopeChapters: 1 }, roleWeight: '路人', roleWeightSource: 'manual' })
  expect(result[1].frequency?.mentions).toBe(1); expect(result[2].frequency?.mentions).toBe(1)
})
it('多个实体共有的别名及通用称谓不计频次，歧义长称呼也不会落入短称呼', () => {
  const result = updateFrequencies([person('1', '老沈', { verifiedAliases: ['林老沈', '娘娘'] }), person('2', '沈青', { verifiedAliases: ['林老沈', '娘娘'] })], [{ chapterIndex: '1', text: '林老沈和娘娘来了。沈青见到老沈。' }], true)
  expect(result.map(row => row.frequency?.mentions)).toEqual([1, 1])
})
