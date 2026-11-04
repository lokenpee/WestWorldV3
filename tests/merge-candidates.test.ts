import { describe, expect, it } from 'vitest'
import { findCandidates, findExactNameGroups } from '../src/features/world/candidates'
import type { Character, LocationAsset } from '../src/features/assets/types'

const person = (id: string, name: string, aliases: string[] = []) => ({ id, name, aliases } as Character)
const place = (id: string, name: string, aliases: string[] = []) => ({ id, name, aliases } as LocationAsset)
const groups = (rows: (Character | LocationAsset)[], kind: 'character' | 'location' = 'character') => findCandidates(kind, rows)

describe('机械合并候选识别', () => {
  it('主名与别名交叉相同进入候选', () => {
    const result = groups([person('C1', '北静王', ['北静王爷', '北静郡王']), person('C2', '水溶', ['北静王', '北静郡王'])])
    expect(result).toHaveLength(1)
    expect(result[0].memberIds).toEqual(['C1', 'C2'])
    expect(result[0].reason).toContain('主名与别名相同')
  })

  it('独有别名不稀释共同称呼', () => {
    const result = groups([person('C3', '甄妃', ['北静王妃']), person('C4', '甄雪', ['北静王妃', '甄家二小姐', '甄妃', '甄氏'])])
    expect(result).toHaveLength(1)
    expect(result[0].memberIds).toEqual(['C3', 'C4'])
    expect(result[0].reason).toContain('称呼重叠 2/2')
  })

  it('保留没有相同称呼的主名包含候选', () => {
    const result = groups([person('C5', '贾宝玉', ['宝二爷']), person('C6', '宝玉')])
    expect(result).toHaveLength(1)
    expect(result[0].reason).toContain('主名包含')
  })

  it('保留没有相同称呼的整组相似度候选', () => {
    const result = groups([person('C7', '甲', ['长安侯爷', '如意郎君', '乙']), person('C8', '乙', ['长安侯爷', '如意郎君', '甲'])])
    expect(result).toHaveLength(1)
    expect(result[0].reason).toContain('整组别名相似度')
  })

  it('多泛称不会连接三人', () => {
    const result = groups([
      person('A', '甲', ['贾家', '宁府', '东府', '西府']),
      person('B', '乙', ['贾家', '宁府', '东府', '西府']),
      person('C', '丙', ['贾家', '宁府', '东府', '西府']),
    ])
    expect(result).toEqual([])
  })

  it('重叠恰好0.8不连接，0.833连接', () => {
    const five = ['长安侯府', '如意郎君', '富贵人家', '平安客栈', '吉祥如意']
    const dummies5 = five.slice(0, 4).map((name, index) => person(`D${index}`, `丁${index}`, [name, `独有${index}甲`, `独有${index}乙`]))
    expect(groups([
      person('A', '甲'.repeat(20), five.slice(0, 4)),
      person('B', '乙'.repeat(20), five.slice(0, 4)),
      ...dummies5,
    ])).toEqual([])
    const six = [...five, '金玉满堂']
    const dummies6 = six.slice(0, 5).map((name, index) => person(`E${index}`, `戊${index}`, [name, `另有${index}甲`, `另有${index}乙`]))
    const result = groups([
      person('A', '甲'.repeat(20), six.slice(0, 5)),
      person('B', '乙'.repeat(20), six.slice(0, 5)),
      ...dummies6,
    ])
    expect(result.some(group => group.memberIds.includes('A') && group.memberIds.includes('B'))).toBe(true)
    expect(result.find(group => group.memberIds.includes('A') && group.memberIds.includes('B'))!.reason).toContain('称呼重叠 5/6')
  })

  it('共享称呼出现两次连接，出现三次不连接', () => {
    expect(groups([person('A', '甲', ['长安侯', '独有甲']), person('B', '乙', ['长安侯', '独有乙'])])).toHaveLength(1)
    expect(groups([
      person('A', '甲', ['宁国府', '独有甲', '甲别称']),
      person('B', '乙', ['宁国府', '独有乙', '乙别称']),
      person('C', '丙', ['宁国府', '独有丙', '丙别称']),
    ])).toEqual([])
  })

  it('上下文称谓不参与人物候选', () => {
    expect(groups([person('A', '甲', ['老爷']), person('B', '乙', ['老爷'])])).toEqual([])
  })

  it('地点使用相同精确规则', () => {
    const result = groups([place('L1', '长安侯府', ['长安侯旧宅']), place('L2', '长安侯旧宅', ['长安侯府'])], 'location')
    expect(result).toHaveLength(1)
    expect(result[0].memberIds).toEqual(['L1', 'L2'])
  })

  it('传递分组保留并聚合命中原因', () => {
    const result = groups([
      person('A', '北静王', ['水溶']),
      person('B', '水溶', ['北静王', '北静郡王']),
      person('C', '北静郡王', ['北静王']),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].memberIds).toEqual(['A', 'B', 'C'])
    expect(result[0].reason).toContain('主名与别名相同')
  })

  it('完整同名自动分组不受候选规则影响', () => {
    expect(findExactNameGroups('character', [person('A', '张三'), person('B', '张三')])).toHaveLength(1)
    expect(findExactNameGroups('character', [person('A', '张三'), person('B', '张三丰')])).toEqual([])
  })
})
