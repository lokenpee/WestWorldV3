import { describe, expect, it } from 'vitest'
import { relationLines, relationRoleLabel } from '../src/features/assets/relationLabels'
import { validatePairLabels } from '../src/features/assets/relationEdits'
import { validateExtraction, promptOf } from '../src/features/extraction/contracts'

describe('关系身份标签', () => {
  it('两端姓名由代码填充且反向标签保持目标身份', () => {
    expect(relationLines('林黛玉', '宝玉', ['妹妹'], ['兄长'])).toEqual(['林黛玉--妹妹-->宝玉', '林黛玉<--兄长--宝玉'])
    expect(relationLines('宝玉', '林黛玉', ['兄长'], ['妹妹'])).toEqual(['宝玉--兄长-->林黛玉', '宝玉<--妹妹--林黛玉'])
  })
  it.each(['宝二哥', '林妹妹', '珩大爷', '打趣', '被打趣', '未知方向待核对'])('旧标签%s显示未知', label => {
    expect(relationRoleLabel(label)).toBe('未知')
  })
  it.each(['妹妹', '兄长', '表妹', '堂兄', '妻子', '朋友', '老师', '学生', '族长'])('保留身份标签%s', label => {
    expect(relationRoleLabel(label)).toBe(label)
  })
  it('缺失方向显示未知，多个身份保留', () => {
    expect(relationLines('甲', '乙', ['朋友', '同僚'], [])).toEqual(['甲--朋友、同僚-->乙', '甲<--未知--乙'])
  })
  it('人工和AI共用保存校验，称呼返回修正提示而未知可保存', () => {
    expect(() => validatePairLabels(['宝二哥'], ['林妹妹'])).toThrow('关系身份')
    expect(validatePairLabels(['未知'], ['兄长'])).toEqual({ forward: ['未知'], reverse: ['兄长'] })
  })
  it('P1明显称呼降为未知但保留本章线索，不丢整章', () => {
    const quote = '黛玉凝了凝罥烟眉，清眸中却是不由浮现起那青衫少年的身影。'
    const value = { characters: [{ name: '林黛玉', confidence: 1, relations: [{ target: '贾珩', relation_type: 'friendship', relation_label: '珩大爷', reverse_label: '林妹妹', direction: 'directed', quote }] }], locations: [] }
    const message = { content: [{ type: 'toolCall', name: 'submit_result', arguments: value }] } as unknown as Parameters<typeof validateExtraction>[1]
    const output = validateExtraction('worldAssets', message)
    expect(output.characters?.[0].relations).toMatchObject([{ relation_label: '未知', reverse_label: '未知', direction: 'unspecified', relation_type: 'unknown', quote }])
    expect(promptOf('worldAssets')).toContain('不能据此认定兄妹、恋人')
  })
})
