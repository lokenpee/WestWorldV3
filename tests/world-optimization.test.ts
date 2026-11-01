import { expect, it } from 'vitest'
import type { Character, LocationAsset } from '../src/features/assets/types'
import { hash } from '../src/features/agents/contracts'
import { needsOptimization, optimizationBudget, optimizationRequest } from '../src/features/world/optimization'

const person = (extra: Partial<Character> = {}): Character => ({ id: 'P1', bookId: 'a', name: '沈青', aliases: [], confidence: 1, revision: 1, createdBy: 'P1', ...extra })
const synonyms = [
  { id: 'old', field: 'personality', text: '性情沉稳，处事果断', chapters: ['1'] },
  { id: 'new', field: 'personality', text: '为人沉稳，遇事果决', chapters: ['2'] },
  { id: 'unique', field: 'personality', text: '精于谋略', chapters: ['3'] },
]
const submit = (value: unknown) => ({ content: [{ type: 'toolCall', id: 'result', name: 'submit_result', arguments: value }] }) as never

it('同字段的短句进入语义整编，单条简短资料保持跳过', () => {
  expect(needsOptimization('character', person({ personality: synonyms.map(row => row.text).join('；') }))).toBe(true)
  expect(needsOptimization('character', person({ personality: '性情沉稳' }))).toBe(false)
  expect(needsOptimization('character', person({ personality: '性情沉稳，处事果断。为人沉稳，遇事果决。' }))).toBe(true)
  expect(needsOptimization('location', { ...person(), description: '位于镇东；在镇子东侧' } as LocationAsset)).toBe(true)
})

it('读取完整底稿，合成一项展示仍覆盖全部来源事实并保留独有信息', async () => {
  const row = person({ personality: synonyms.map(fact => fact.text).join('；'), mergeFacts: synonyms, optimizedFactIds: ['old'] })
  const request = await optimizationRequest('character', row)
  const input = request.input as { entities: { facts: { id: string; text: string }[] }[] }
  expect(input.entities[0].facts.map(fact => fact.text).sort()).toEqual(synonyms.map(fact => fact.text).sort())
  expect(request.prompt).toContain('性情沉稳，处事果断')
  expect(request.prompt).toContain('保留信息含义与来源，不要求逐字保留重复措辞')
  const value = { entities: { P1: { entity: { name: '沈青', aliases: [], personality: '性情沉稳，处事果断，精于谋略；性情沉稳，处事果断，精于谋略' }, covered_fact_ids: ['F1', 'F2', 'F3'], merge_notes: [] } } }
  expect(request.validate(submit(value)).fields).toEqual({ personality: '性情沉稳，处事果断，精于谋略' })
  expect(request.facts).toEqual(expect.arrayContaining(synonyms))
  expect(request.facts).toHaveLength(synonyms.length)
  expect(row.mergeFacts).toEqual(synonyms)
  for (const ids of [['F1', 'F2'], ['F1', 'F1', 'F3'], ['F1', 'F2', 'F4']]) {
    value.entities.P1.covered_fact_ids = ids
    expect(() => request.validate(submit(value))).toThrow()
  }
})

it('整编版本变化使旧完成指纹失效，新指纹在展示归并后保持有效', async () => {
  const row = person({ mergeFacts: synonyms, optimizedFactIds: synonyms.map(fact => fact.id), personality: '为人沉稳，遇事果决；性情沉稳，处事果断；精于谋略' })
  const old = await hash({ version: '2.2', names: ['沈青'], facts: synonyms, notes: [] })
  const request = await optimizationRequest('character', { ...row, optimizationFingerprint: old })
  expect(request.fingerprint).not.toBe(old)
  const next = await optimizationRequest('character', { ...row, personality: '性情沉稳，处事果断，精于谋略', optimizationFingerprint: request.fingerprint })
  expect(next.fingerprint).toBe(request.fingerprint)
})

it('百万上下文允许超过6000且超过45%的输入，边界由输入与输出预留共同计算', () => {
  expect(optimizationBudget({ estimatedTokens: 600000, estimatedOutputTokens: 10000 }, { contextWindow: 1000000, maxTokens: 65536 })).toEqual({ inputTokens: 600000, outputTokens: 10000, contextWindow: 1000000, fits: true })
  expect(optimizationBudget({ estimatedTokens: 999488, estimatedOutputTokens: 400 }, { contextWindow: 1000000, maxTokens: 65536 }).fits).toBe(true)
  expect(optimizationBudget({ estimatedTokens: 999489, estimatedOutputTokens: 400 }, { contextWindow: 1000000, maxTokens: 65536 }).fits).toBe(false)
  expect(optimizationBudget({ estimatedTokens: 7936, estimatedOutputTokens: 1024 }, { contextWindow: 8192, maxTokens: 256 })).toMatchObject({ fits: true, outputTokens: 256 })
})

it('长档案输入超过旧门槛仍可在真实容量内整编，超过模型容量时拒绝', async () => {
  const facts = Array.from({ length: 677 }, (_, index) => ({ id: `fact-${index}`, field: 'background', text: `第${index}项独有经历：${'原文中的人物经历。'.repeat(8)}`, chapters: [String(index + 1)] }))
  const request = await optimizationRequest('character', person({ background: facts.map(fact => fact.text).join('；'), mergeFacts: facts }))
  expect(request.estimatedTokens).toBeGreaterThan(6000)
  expect(optimizationBudget(request, { contextWindow: 1000000, maxTokens: 65536 }).fits).toBe(true)
  expect(optimizationBudget(request, { contextWindow: 8192, maxTokens: 8192 }).fits).toBe(false)
})

it('地点整编保留时间差异与冲突，空展示稿和遗漏编号均被拒绝', async () => {
  const row = { ...person(), description: '早年是两层木楼；后来改建为三层砖楼', mergeFacts: [{ id: 'a', field: 'description', text: '早年是两层木楼', chapters: ['1'] }, { id: 'b', field: 'description', text: '后来改建为三层砖楼', chapters: ['2'] }] } as LocationAsset
  const request = await optimizationRequest('location', row)
  expect(request.validate(submit({ description: '早年为两层木楼，后来改建为三层砖楼', coveredFactIds: ['F1', 'F2'], conflicts: [] })).fields).toEqual({ description: '早年为两层木楼，后来改建为三层砖楼' })
  expect(() => request.validate(submit({ description: ' ', coveredFactIds: ['F1', 'F2'] }))).toThrow()
})
