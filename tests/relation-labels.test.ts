import { describe, expect, it } from 'vitest'
import { relationLines } from '../src/features/assets/relationLabels'
import { validatePairLabels } from '../src/features/assets/relationEdits'
import { validateExtraction } from '../src/features/extraction/contracts'

describe('关系身份标签', () => {
  it('两端姓名由代码填充且反向标签保持目标身份', () => {
    expect(relationLines('林黛玉', '宝玉', ['妹妹'], ['兄长'])).toEqual(['林黛玉--妹妹-->宝玉', '林黛玉<--兄长--宝玉'])
    expect(relationLines('宝玉', '林黛玉', ['兄长'], ['妹妹'])).toEqual(['宝玉--兄长-->林黛玉', '宝玉<--妹妹--林黛玉'])
  })
  it('缺失方向显示未知，多个身份保留', () => {
    expect(relationLines('甲', '乙', ['朋友', '同僚'], [])).toEqual(['甲--朋友、同僚-->乙', '甲<--未知--乙'])
  })
  it('保存校验保留 Agent 标签，只拒绝双向空标签', () => {
    expect(validatePairLabels(['宝二哥'], ['林妹妹'])).toEqual({ forward: ['宝二哥'], reverse: ['林妹妹'] })
    expect(validatePairLabels(['未知'], ['兄长'])).toEqual({ forward: ['未知'], reverse: ['兄长'] })
    expect(() => validatePairLabels([], [])).toThrow('至少一个方向')
  })
  it('P1 保留 Agent 原始关系标签，不静默改写', () => {
    const quote = '来人说自己是宝玉的旧识，但具体是何关系，书中没有明说。'
    const value = { characters: [{ name: '林黛玉', confidence: 1, relations: [{ target: '贾珩', relation_type: 'friendship', relation_label: '珩大爷', reverse_label: '林妹妹', direction: 'directed', quote }] }], locations: [] }
    const message = { content: [{ type: 'toolCall', name: 'submit_result', arguments: value }] } as unknown as Parameters<typeof validateExtraction>[1]
    const output = validateExtraction('worldAssets', message)
    expect(output.characters?.[0].relations).toMatchObject([{ relation_label: '珩大爷', reverse_label: '林妹妹', direction: 'directed', relation_type: 'friendship', quote }])
  })
  it('只确定一侧关系时，保留另一侧的 Agent 原值', () => {
    const value = { characters: [{ name: '沈青', confidence: 1, relations: [{ target: '顾衡', relation_type: 'acquaintance', relation_label: '旧识', reverse_label: '未知', direction: 'directed', quote: '沈青说顾衡是自己的旧识' }] }], locations: [] }
    const message = { content: [{ type: 'toolCall', name: 'submit_result', arguments: value }] } as unknown as Parameters<typeof validateExtraction>[1]
    const output = validateExtraction('worldAssets', message)
    expect(output.characters?.[0].relations).toMatchObject([{ relation_label: '旧识', reverse_label: '未知', direction: 'directed' }])
  })
})
