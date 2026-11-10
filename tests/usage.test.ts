import { expect, it } from 'vitest'
import { summarizeUsage, usageCost } from '../src/features/models/policy'

const attempt = (cost: Record<string, number>, extra: Record<string, unknown> = {}) => ({
  ordinal: 1, turn: 1, elapsedMs: 1,
  usage: { input: 6, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 18, cost },
  ...extra,
})

it('费用汇总优先使用 total，缺失时才使用分项，避免重复计算', () => {
  const total = { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 }
  const withTotal = attempt(total)
  expect(usageCost(withTotal.usage as never)).toBe(1)
  expect(summarizeUsage([withTotal] as never, { pricingStatus: 'estimated', pricingCurrency: 'USD' } as never)).toMatchObject({ cost: 1, costStatus: 'estimated' })

  const withoutTotal = attempt({ ...total, total: 0 })
  expect(usageCost(withoutTotal.usage as never)).toBe(1)
  expect(summarizeUsage([withoutTotal] as never, { pricingStatus: 'estimated', pricingCurrency: 'USD' } as never)).toMatchObject({ cost: 1 })
})

it('未知价格不生成费用', () => {
  const value = attempt({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 })
  expect(summarizeUsage([value] as never, { pricingStatus: 'unknown' } as never)).toMatchObject({ costStatus: 'unknown' })
  expect(summarizeUsage([value] as never, { pricingStatus: 'unknown' } as never)).not.toHaveProperty('cost')
})
