import {
  formatNarrativeInput,
  narrativeSystemPrompt,
  reviewMaterialSections,
} from '../src/features/story/narrativeInput'
import { receiptOutcome } from '../src/features/story/narrativeOutcome'
import { narrativeMaterial } from './support/agent-protocol'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import {
  newNarrativePlan,
  refreshNarrativeTaskInput,
  scheduleNarrative,
  confirmNarrative,
  narrativeDefaults,
  visibleNodes,
  type NarrativeAssets,
  type Mode,
  type NarrativeTask,
} from '../src/features/story/narrativePlan'
import { validate } from '../src/features/agents/contracts'
import type { Row } from '../src/features/agents/repository'
import { toolDefinitions, narrativeTools } from '../src/features/story/narrativeTools'
import { narrativeVersions } from '../src/features/story/narrativeBasis'
import { createMemoryAgentRepository } from '../src/features/agents/repository'
import type { Scope } from '../src/features/agents/queries'
import { narrativeContext } from '../src/features/story/narrativeContext'
import type { Message } from '@earendil-works/pi-ai'

const template = readFileSync('docs/v2/resources/v2.2/prompts/active/p3-narrative-v4.md', 'utf8')

it.each(['node_batch', 'event_cycle', 'event_review', 'event_group', 'line_cycle', 'line_review'] as Mode[])(
  '%s 只给本阶段的编辑参数',
  (mode) => {
    const event = ['node_batch', 'event_cycle', 'event_review'].includes(mode)
    const example = JSON.parse(
      readFileSync('docs/v2/resources/v2.2/request-examples/PROMPT-P3-NARRATIVE-V4-' + mode + '.json', 'utf8')
    )
    const part = example.input.part as NarrativeTask['part']
    const defs = toolDefinitions({ mode, part } as NarrativeTask),
      edit = event ? 'edit_events' : 'edit_storylines'
    expect(
      Object.fromEntries(
        example.context.tools.map((t: { name: string; parameters: unknown }) => [t.name, t.parameters])
      )
    ).toEqual(defs)
    expect(narrativeMaterial(example.context.messages[1].content)).toMatchObject(example.input)
    expect(example.context.messages[0].content).toContain(narrativeSystemPrompt(template, { mode, part }))
    const instructions =
      example.context.messages[0].content +
      example.context.tools.find((t: { name: string }) => t.name === 'confirm').description
    for (const field of ['retained_unassigned_nodes', 'handled_event_ids', 'review_results']) {
      const relevant =
        field ===
        (part === 'batch' ? (event ? 'retained_unassigned_nodes' : 'handled_event_ids') : '')
      expect(instructions.includes(field)).toBe(relevant)
    }
    expect(instructions).not.toContain(event ? 'edit_storylines' : 'edit_events')
    expect(Object.keys(defs).sort()).toEqual(
      [
        edit,
        'get_detail',
        'manage_doubts',
        'confirm',
        ...(part === 'batch' || part === 'unassigned' ? ['get_outline'] : []),
      ].sort()
    )
    const update = {
      op: event ? 'update_event' : 'update_line',
      [event ? 'eventId' : 'lineId']: 'x',
      summary: '概况',
      coreClue: '线索',
    }
    expect(() => validate(defs[edit], { operations: [update] })).not.toThrow()
    const create = () =>
      validate(defs[edit], {
        operations: [
          {
            op: event ? 'create_event' : 'create_line',
            ref: 'new',
            title: '新对象',
            summary: '先写概况',
            ...(event ? { nodeIds: ['N1'] } : {}),
          },
        ],
      })
    if (part === 'descriptions') expect(create).toThrow()
    else expect(create).not.toThrow()
    if (!event)
      expect(() =>
        validate(defs[edit], { operations: [{ op: 'update_line', lineId: 's', nodeIds: ['N1'] }] })
      ).toThrow()
  }
)
it('六种模式按当前环节组装十六种指令，确认工具只暴露可用结论', () => {
  const prompts = new Set<string>()
  for (const mode of [
    'node_batch',
    'event_group',
    'event_cycle',
    'event_review',
    'line_cycle',
    'line_review',
  ] as const) {
    const cycle = mode.endsWith('_cycle')
    const final = mode.endsWith('_review')
    const event = mode === 'node_batch' || (mode.startsWith('event_') && mode !== 'event_group')
    const sections: NarrativeTask['part'][] =
      cycle || final ? ['structure', 'doubts', 'unassigned'] : ['batch']
    if (final) sections.push('descriptions')
    for (const part of sections) {
      const task = { mode, part } as NarrativeTask
      const prompt = narrativeSystemPrompt(template, task)
      prompts.add(prompt)
      expect(prompt).toContain(event ? 'A→B→A' : '发现匪情、调兵、剿匪、善后')
      expect(prompt).not.toContain(event ? 'edit_storylines' : 'edit_events')
      if (cycle) expect(prompt).toContain('本周期')
      if (final) expect(prompt).toContain('分段覆盖全书')
      const payload = JSON.parse(
        formatNarrativeInput({
          mode,
          part,
          targets: [{ id: 'test' }],
          outline: { marker: 'directory' },
          config: { marker: 'configuration' },
          openDoubts: [{ id: 'other' }],
          evidence: { nodes: [{ id: 'unrelated' }] },
          reviewProgress: [{ 环节: '检查', 已核: 0, 待核: 1 }],
        })
      )
      const directoryKey = event ? '事件与可见节点目录' : '故事线与事件目录'
      expect(Object.hasOwn(payload, directoryKey)).toBe(part === 'batch' || part === 'structure' || part === 'unassigned')
      if (part === 'doubts' || part === 'unassigned') {
        expect(Object.keys(payload)).toEqual(['任务说明', ...(part === 'unassigned' ? [directoryKey] : []), (part === 'unassigned' ? (event ? '本段未归属节点和单节点事件' : '本段未归线事件和单事件故事线') : reviewMaterialSections[part])])
      }
      const tools = toolDefinitions(task)
      const edit = tools[event ? 'edit_events' : 'edit_storylines']
      const idKey = event ? 'eventId' : 'lineId'
      const prefix = event ? 'event' : 'line'
      const write = (op: Row) => () => validate(edit, { operations: [op] })
      expect(write({ op: 'update_' + prefix, [idKey]: 'X', summary: '概况' })).not.toThrow()
      const remove = write({ op: 'delete_' + prefix, [idKey]: 'X' })
      if (part === 'descriptions') {
        expect(remove).toThrow()
        expect(write({ op: 'update_' + prefix, [idKey]: 'X', title: '新标题' })).toThrow()
      } else expect(remove).not.toThrow()
      if (part === 'batch') continue
      expect(prompt).toContain('confirm({})')
      expect(prompt).not.toContain('review_results')
      expect(tools.confirm).toMatchObject({ properties: {}, required: [] })
      expect(() => validate(tools.confirm, {})).not.toThrow()
      expect(write({ op: 'update_' + prefix, [idKey]: 'X', summary: '一句概况', reason: '压缩重复叙述' })).not.toThrow()
    }
  }
  expect(prompts.size).toBe(16)
})

it('全书故事线整段确认后带入仅关联故事线的疑点', () => {
  const a = sceneBook(1)
  a.notes.push({ id: 'D', category: 'OTHER', status: 'active', statement: '篇章结尾待查', lineIds: ['S'] })
  const plan = newNarrativePlan()
  const first = narrativeMaterial(scheduleNarrative(plan, a)!.prompt)
  expect(first.openDoubts[0]).not.toHaveProperty('lineIds')
  const lines = newNarrativePlan()
  lines.layer = 'line'
  scheduleNarrative(lines, a)
  confirmNarrative(lines, a, { handled_event_ids: ['E0'] })
  const task = scheduleNarrative(lines, a)!
  expect(task).toMatchObject({ mode: 'line_review', part: 'structure' })
  expect(narrativeMaterial(task.prompt).periodIds).toBeUndefined()
  expect(confirmNarrative(lines, a, {})).toEqual([{ target_id: 'S', outcome: 'no_change' }])
  const next = scheduleNarrative(lines, a)!
  expect(next.part).toBe('doubts')
  const material = narrativeMaterial(next.prompt)
  expect(material.targets).toContainEqual(expect.objectContaining({ id: 'D', lineIds: ['S'] }))
  expect(material.openDoubts).toEqual([])
  expect(Object.keys(JSON.parse(next.prompt))).toEqual(['任务说明', '本段待复核疑点表'])
  a.notes[0].status = 'resolved'
  expect(confirmNarrative(lines, a, {})).toEqual([{ target_id: 'D', outcome: 'resolved' }])
})

it('孤立项的归属或未决结论须有已保存的成员或关联疑点', () => {
  const a = sceneBook(1)
  const plan = newNarrativePlan()
  plan.layer = 'line'
  scheduleNarrative(plan, a)
  confirmNarrative(plan, a, { handled_event_ids: ['E0'] })
  scheduleNarrative(plan, a)
  a.lines[0].eventIds = []
  confirmNarrative(plan, a, {})
  const orphan = scheduleNarrative(plan, a)!
  expect(orphan.part).toBe('unassigned')
  a.notes.push({ id: 'D', category: 'EVENT_ASSIGNMENT', status: 'active', eventIds: ['E0'] })
  expect(confirmNarrative(plan, a, {})).toEqual([{ target_id: 'E0', outcome: 'retained_open' }])
})

it('全书复核修订产生的孤点进入当前阶段，冻结前必须逐项确认', () => {
  const a = sceneBook(2),
    plan = newNarrativePlan()
  scheduleNarrative(plan, a)
  confirmNarrative(plan, a, {})
  scheduleNarrative(plan, a)
  a.events[0].nodeIds = []
  confirmNarrative(plan, a, {})
  const orphan = scheduleNarrative(plan, a)!
  expect(orphan).toMatchObject({ mode: 'event_review', part: 'unassigned', ids: ['N0', 'N1'] })
  expect(Object.keys(JSON.parse(orphan.prompt))).toEqual(['任务说明', '事件与可见节点目录', '本段未归属节点和单节点事件'])
  expect(JSON.parse(orphan.prompt).本段未归属节点和单节点事件).toContainEqual(
    expect.objectContaining({ id: 'N0', name: '一幕', summary: '核对过的场景' })
  )
  expect(confirmNarrative(plan, a, {})).toEqual([
    {target_id:'N0', outcome:'independent'}, {target_id:'N1', outcome:'no_change'},
  ])
  scheduleNarrative(plan, a)
  confirmNarrative(plan, a, {})
  expect(scheduleNarrative(plan, a)?.mode).toBe('event_group')
  expect(plan.batches.event).toBe(1)
})
it('周期按本期和受影响事件筛选单节点；全书再检查，移动与保留必须对应实际归属', () => {
  const a = sceneBook(4)
  const plan = newNarrativePlan()
  plan.nodes = { N0: '已读', N1: '已读', N2: '已读' }
  plan.period = ['N1']
  plan.affected = ['E0', 'E3']
  plan.review = { final: false, coverage: {} }
  const finishStructure = () => {
    const task = scheduleNarrative(plan, a)!
    expect(task.part).toBe('structure')
    confirmNarrative(plan, a, {})
  }
  finishStructure()
  const cycle = scheduleNarrative(plan, a)!
  expect(cycle.ids).toEqual(['N0','N1'])
  const material = narrativeMaterial(cycle.prompt)
  expect(material.targets[0]).toMatchObject({入选原因:'所在事件仅含此节点', 当前事件:[{id:'E0', title:'事件 0'}]})
  expect(material.outline.nodes.map((n: Row) => n.id)).toEqual(['N0','N1','N2'])
  a.events[0].nodeIds = []
  a.events[2].nodeIds = ['N2','N0']
  expect(() => confirmNarrative(plan, a, {})).toThrow(/移空/)
  a.events.shift()
  expect(confirmNarrative(plan, a, {})).toContainEqual({target_id:'N0', outcome:'repaired'})
  expect(plan.retained.N1).toBeUndefined()
  plan.review = {final:true, coverage:{}}
  finishStructure()
  expect(scheduleNarrative(plan,a)).toMatchObject({part:'unassigned', ids:['N1','N3']})
})

it('恢复旧未归属分段先完成原目标，后续补查共享节点所在的单节点事件', () => {
  const a = sceneBook(3)
  a.events[0].nodeIds = []
  a.events[2].nodeIds = ['N1', 'N2']
  const plan = newNarrativePlan()
  plan.review = {final:true, coverage:{}}
  scheduleNarrative(plan,a)
  confirmNarrative(plan,a, {})
  const old = scheduleNarrative(plan,a)!
  old.ids = ['N0']
  delete old.singletonSources
  refreshNarrativeTaskInput(plan,a,old)
  expect(narrativeMaterial(old.prompt).outline.events).toHaveLength(3)
  confirmNarrative(plan,a, {})
  const next = scheduleNarrative(plan,a)!
  expect(next.ids).toEqual(['N1'])
  expect(narrativeMaterial(next.prompt).targets[0].当前事件).toHaveLength(2)
})

it('两阶段目录常带名称，复核只附当前分段的查证材料', () => {
  const a = sceneBook(40)
  const plan = newNarrativePlan({ ...narrativeDefaults, outlineThreshold: 1 })
  const batch = narrativeMaterial(scheduleNarrative(plan, a)!.prompt)
  expect(batch.outline.nodes).toHaveLength(20)
  expect(batch.outline.nodes[0]).toEqual({ id: 'N0', name: '一幕' })
  expect(batch.outline.events[0]).toEqual({ id: 'E0', title: '事件 0', nodeIds: ['N0'] })
  expect(batch.outline.events[25]).toEqual({ id: 'E25', title: '事件 25', nodeIds: [] })
  confirmNarrative(plan, a, {})
  scheduleNarrative(plan, a)
  confirmNarrative(plan, a, {})
  const structure = scheduleNarrative(plan, a)!
  expect(structure.part).toBe('structure')
  const raw = JSON.parse(structure.prompt)
  expect(raw.本段结构核对表).toHaveLength(20)
  expect(raw.本段待复核疑点表).toBeUndefined()
  expect(raw.事件与可见节点目录.nodes).toHaveLength(40)
  expect(raw.事件与可见节点目录).not.toHaveProperty('unassignedNodeIds')
  expect(raw.本段查证材料.nodes).toHaveLength(20)
  expect(raw.本段查证材料.nodes[0]).toMatchObject({ id: 'N0', name: '一幕', summary: '核对过的场景' })

  const lines = newNarrativePlan({ ...narrativeDefaults, outlineThreshold: 10000 })
  lines.layer = 'line'
  const group = narrativeMaterial(scheduleNarrative(lines, a)!.prompt)
  expect(group.outline.lines[0]).toMatchObject({ id: 'S', title: '故事线' })
  expect(group.outline.events[0]).toMatchObject({ id: 'E0', title: '事件 0', nodeIds: ['N0'] })
  expect(group.outline.nodes[0]).toMatchObject({ id: 'N0', name: '一幕' })
})

it.each(['batch', 'cycle', 'final'])('第二阶段 %s 目录超过默认阈值只发故事线和相关事件名称', (phase) => {
  const a = sceneBook(40)
  a.lines[0].eventIds = ['E35']
  const makeTask = (outlineThreshold = narrativeDefaults.outlineThreshold) => {
    const plan = newNarrativePlan({ ...narrativeDefaults, outlineThreshold, eventGroupSize: 2 })
    plan.layer = 'line'
    if (phase !== 'batch') {
      plan.review = { final: phase === 'final', coverage: {} }
      plan.period = ['E35']
    }
    return narrativeMaterial(scheduleNarrative(plan, a)!.prompt)
  }

  const full = makeTask(10000)
  const size = JSON.stringify(full.outline).length
  expect(size).toBeGreaterThan(2000)
  expect(makeTask(size).outline).toEqual(full.outline)
  expect(full.outline.nodes).toHaveLength(40)
  expect(full.outline.events[0].nodeIds).toEqual(['N0'])

  const compact = makeTask()
  expect(compact.outline).toEqual({
    lines: [{ id: 'S', title: '故事线', eventIds: ['E35'] }],
    events: [
      ...(phase === 'batch'
        ? [
            { id: 'E0', title: '事件 0' },
            { id: 'E1', title: '事件 1' },
          ]
        : []),
      { id: 'E35', title: '事件 35' },
    ],
  })
  expect(compact.targets).toEqual(full.targets)
  expect(compact.part).toBe(phase === 'batch' ? 'batch' : 'structure')
  expect(compact.mode).toBe(
    phase === 'batch' ? 'event_group' : phase === 'cycle' ? 'line_cycle' : 'line_review'
  )
})

it.each(['event', 'line'] as const)('快速整理 %s 跨原批凑满 20 个未分配项', (layer) => {
  const a = sceneBook(100)
  const assigned = (i: number) => i < 17 || (i >= 20 && i < 35)
  if (layer === 'event')
    a.events.forEach((event, i) => {
      if (!assigned(i)) event.nodeIds = []
    })
  else a.lines[0].eventIds = a.events.filter((_, i) => assigned(i)).map((event) => event.id)
  const plan = { ...newNarrativePlan(), reuseAssigned: true, layer }
  const task = scheduleNarrative(plan, a)!
  const prefix = layer === 'event' ? 'N' : 'E'
  expect(task.ids).toEqual(
    [17, 18, 19, 35, 36, 37, 38, 39, ...Array.from({ length: 12 }, (_, i) => 40 + i)].map((i) => prefix + i)
  )
  expect(Object.keys(layer === 'event' ? plan.nodes : plan.events)).toHaveLength(32)
  expect(plan.batches[layer]).toBe(0)
})

it.each(['event', 'line'] as const)('快速整理 %s 已全部分配时直接进入全书复核', (layer) => {
  const a = sceneBook(2)
  const plan = { ...newNarrativePlan(), reuseAssigned: true, layer }
  const task = scheduleNarrative(plan, a)!
  expect(task).toMatchObject({ mode: layer === 'event' ? 'event_review' : 'line_review', part: 'structure' })
  expect(task.ids).toEqual(layer === 'event' ? ['E0', 'E1'] : ['S'])
  expect(plan.batches[layer]).toBe(0)
})

it('P3 编辑工具允许一次提交 41 个操作及中文临时编号', () => {
  const task = { mode: 'node_batch', part: 'batch' } as NarrativeTask
  const rules = toolDefinitions(task)
  const operations = Array.from({ length: 41 }, (_, index) => ({
    op: 'create_event',
    ref: '事件' + index,
    title: '一幕',
    nodeIds: ['N' + index],
  }))
  expect(() => validate(rules.edit_events, { operations })).not.toThrow()
})

it.each([false, true])('故事线复查单事件线并只重开成员有变化的线（全书 %s）', final => {
  const a = sceneBook(6)
  a.lines = [
    { id: 'A', title: '来信', eventIds: ['E0'] },
    { id: 'B', title: '追信', eventIds: ['E1', 'E2'] },
    { id: 'C', title: '赴宴', eventIds: ['E3'] },
    { id: 'D', title: '独立场景', eventIds: ['E4'] },
  ]
  const plan = newNarrativePlan({ ...narrativeDefaults, outlineThreshold: 1 })
  plan.layer = 'line'
  plan.period = ['E0','E1','E3','E5']
  plan.review = { final, coverage: {} }
  const structure = scheduleNarrative(plan, a)!
  expect(structure.part).toBe('structure')
  confirmNarrative(plan, a, {})
  const review = scheduleNarrative(plan, a)!
  expect(review.part).toBe('unassigned')
  expect(review.ids).toEqual(final ? ['E0','E3','E4','E5'] : ['E0','E3','E5'])
  const material = narrativeMaterial(review.prompt)
  expect(material.targets[0]).toMatchObject({id:'E0', 当前故事线:[{id:'A', title:'来信', 单事件故事线:true}]})
  expect(material.outline.events).toContainEqual({id:'E5',title:'事件 5'})
  expect(material.outline.nodes).toBeUndefined()
  a.lines[0].eventIds = []
  a.lines[1].eventIds = ['E0','E1','E2','E5']
  expect(() => confirmNarrative(plan,a,{})).toThrow(/移空的来源故事线/)
  a.lines.shift()
  expect(confirmNarrative(plan,a,{})).toEqual(expect.arrayContaining([
    {target_id:'E0',outcome:'repaired'}, {target_id:'E3',outcome:'no_change'}, {target_id:'E5',outcome:'repaired'},
  ]))
  expect(scheduleNarrative(plan,a)).toMatchObject({part:'structure',ids:['B']})
})

it('归线确认按实际处理的组外事件去重计数，按运行参数切组', () => {
  const a = sceneBook(7),
    plan = newNarrativePlan({
      ...narrativeDefaults,
      eventGroupSize: 2,
      lineReviewInterval: 3,
      segmentSize: 1,
    })
  plan.layer = 'line'
  const t = scheduleNarrative(plan, a)!
  expect(t.ids).toEqual(['E0', 'E1'])
  confirmNarrative(plan, a, { handled_event_ids: ['E6', 'E6'] })
  expect(scheduleNarrative(plan, a)?.ids).toEqual(['E2', 'E3'])
  expect(Object.keys(plan.events)).toHaveLength(3)
  expect(plan.batches.line).toBe(1)
})
function sceneBook(size: number): NarrativeAssets {
  const nodes = Array.from({ length: size }, (_, i) => ({
    id: 'N' + i,
    bookId: 'b',
    name: '一幕',
    summary: '核对过的场景',
    order: i,
    chapterIndex: '1',
    revision: 1,
  }))
  const events = nodes.map((r, i) => ({
    id: 'E' + i,
    bookId: 'b',
    nodeIds: [r.id],
    title: '事件 ' + i,
    summary: '事件概况',
    coreClue: '核心线索',
    revision: 1,
  }))
  return {
    nodes,
    events,
    lines: [
      {
        id: 'S',
        bookId: 'b',
        title: '故事线',
        summary: '概况',
        coreClue: '核心',
        revision: 1,
        eventIds: events.map((e) => e.id),
      },
    ],
    notes: [],
  }
}
it('二十个未修改事件用空参确认，重发同一确认只推进一次', async () => {
  const a = sceneBook(20)
  const plan = newNarrativePlan()
  plan.review = { final: true, coverage: {} }
  const task = scheduleNarrative(plan, a)!
  expect(task).toMatchObject({ mode: 'event_review', part: 'structure' })
  const scope: Scope = {
    bookId: 'b', runId: 'r', sessionId: 's', owner: 'owner', taskId: task.id,
    profile: 'story_editor', phase: 'window_link', workflow: 'narrative_v4', workItemIds: [],
  }
  const expiresAt = Date.now() + 90000
  const repo = createMemoryAgentRepository('b', {
    nodes: a.nodes, storyEvents: a.events, eventLines: a.lines,
    pipelineRuns: [
      { bookId: 'b', id: 'r', narrative: plan },
      { bookId: 'b', id: task.id, observed: narrativeVersions(a, visibleNodes(plan, task, a), true) },
      { bookId: 'b', id: 'lease:narrative', owner: 'owner', runId: 'r', expiresAt },
    ],
    storySessions: [{ bookId: 'b', id: 's', leaseOwner: 'owner', leaseUntil: expiresAt }],
  })
  const tool = narrativeTools(repo, scope, task).tools.find(tool => tool.name === 'confirm')!
  expect(tool.parameters).toMatchObject({ properties: {}, required: [] })
  for (let attempt = 0; attempt < 2; attempt++)
    expect((await tool.execute('confirmation', {})).details).toMatchObject({ confirmed: true })
  const receipt = await repo.transaction(false, store => store.get('pipelineRuns', task.id + ':confirmation'))
  expect(receipt?.arguments).toEqual({})
  expect(receipt?.reviewResults).toEqual(task.ids.map(target_id => ({target_id, outcome:'no_change'})))
})

it('401 个节点与事件各触发两个周期，尾批并入全书复核', () => {
  const a = sceneBook(401),
    plan = newNarrativePlan(),
    cycles = new Set<string>()
  for (let i = 0; i < 500; i++) {
    const task = scheduleNarrative(plan, a)
    if (!task) break
    const payload = narrativeMaterial(task.prompt)
    if (task.mode.endsWith('_cycle')) {
      cycles.add(task.mode + ':' + plan.batches[plan.layer])
      if (plan.batches[plan.layer] === 20 && task.part === 'structure')
        expect(payload.periodIds[0]).toBe(plan.layer === 'event' ? 'N200' : 'E200')
    }
    confirmNarrative(plan, a, task.mode === 'event_group' ? { handled_event_ids: task.ids } : {})
  }
  expect(plan.complete).toBe(true)
  expect(plan.batches).toEqual({ event: 21, line: 21 })
  expect(cycles).toEqual(new Set(['event_cycle:10', 'event_cycle:20', 'line_cycle:10', 'line_cycle:20']))
})
it('疑点以20、20、5分段，未决状态随每段空参确认保存', () => {
  const a = sceneBook(0)
  a.notes = Array.from({ length: 45 }, (_, i) => ({ id: 'D' + i, status: 'active' }))
  const plan = newNarrativePlan(),
    counts = []
  for (let i = 0; i < 3; i++) {
    const t = scheduleNarrative(plan, a)!
    counts.push(t.ids.length)
    expect(t.reviewProgress).toContainEqual({
      环节: '处理待复核疑点',
      已核: i * 20,
      待核: 45 - i * 20,
    })
    expect(confirmNarrative(plan, a, {})).toEqual(t.ids.map(target_id => ({target_id, outcome:'retained_open'})))
  }
  expect(counts).toEqual([20, 20, 5])
})
it('首批保留旧事件及后批成员，越界整笔失败，重复确认只推进一次', async () => {
  const a = sceneBook(2)
  a.events[0].nodeIds = ['N1']
  a.events[1].nodeIds = []
  const plan = newNarrativePlan({ ...narrativeDefaults, nodeBatchSize: 1 }),
    t = scheduleNarrative(plan, a)!
  expect(t.prompt).toContain('事件 0')
  expect(t.prompt).not.toContain('N1')
  const scope: Scope = {
    bookId: 'b',
    runId: 'r',
    sessionId: 's',
    owner: 'owner',
    taskId: t.id,
    profile: 'story_editor',
    phase: 'window_link',
    workflow: 'narrative_v4',
    workItemIds: [],
  }
  const repo = createMemoryAgentRepository('b', {
    nodes: a.nodes,
    storyEvents: a.events,
    chapters: [{ bookId: 'b', chapterIndex: '1', order: 0 }],
    pipelineRuns: [
      { bookId: 'b', id: 'r', narrative: plan },
      { bookId: 'b', id: t.id, observed: narrativeVersions(a, visibleNodes(plan, t, a), true) },
      { bookId: 'b', id: 'lease:narrative', owner: 'owner', runId: 'r', expiresAt: Date.now() + 90000 },
    ],
    storySessions: [{ bookId: 'b', id: 's', leaseOwner: 'owner', leaseUntil: Date.now() + 90000 }],
  })
  const api = narrativeTools(repo, scope, t),
    call = async (n: string, id: string, args: object) =>
      api.tools.find((x) => x.name === n)!.execute(id, args)
  expect(
    (
      await call('edit_events', 'bad', {
        operations: [
          { op: 'update_event', eventId: 'E0', title: '误改' },
          { op: 'delete_event', eventId: 'E0' },
        ],
      })
    ).isError
  ).toBe(true)
  expect(await repo.transaction(false, (s) => s.get('storyEvents', 'E0'))).toMatchObject({ title: '事件 0' })
  expect(
    (await call('get_detail', 'read', { requests: [{ kind: 'node', id: 'N1', fields: ['*'] }] })).details
  ).toEqual([{ id: 'N1', values: {}, unavailable: ['*'], message: '该编号没有本任务可读取的资料。' }])
  expect(
    (
      await call('edit_events', 'one', {
        operations: [
          { op: 'update_event', eventId: 'E0', summary: '加入本批后更新概况' },
          { op: 'attach_nodes', eventId: 'E0', nodeIds: ['N0'] },
        ],
      })
    ).isError
  ).not.toBe(true)
  const read = await call('get_detail', 'alias', {
    requests: [{ kind: 'node', id: 'N0', fields: ['chapter', 'locations'] }],
  })
  expect(JSON.parse((read.content[0] as { text: string }).text)[0]).toMatchObject({
    values: { chapter: '1' },
    unavailable: ['locations'],
  })
  const badField = await call('get_detail', 'wrong-field', {
    requests: [
      { kind: 'node', id: 'N0', fields: ['text', 'name'] },
      { kind: 'node', id: 'missing', fields: ['summary'] },
    ],
  })
  expect(badField.isError).not.toBe(true)
  expect(badField.details).toMatchObject([
    {
      id: 'N0',
      values: { name: '一幕' },
      unavailable: ['text'],
      message: expect.stringContaining('原文摘录用 quote'),
    },
    { id: 'missing', values: {}, unavailable: ['summary'] },
  ])
  const getOutline = api.tools.find((tool) => tool.name === 'get_outline')!
  expect(() => getOutline.prepareArguments!({ kind: 'unassigned_nodes', id: 'E0' })).toThrow(/目录查询/)
  const doubts = api.tools.find((tool) => tool.name === 'manage_doubts')!
  expect(() => doubts.prepareArguments!({ action: 'resolve', id: 'D' })).toThrow(/reason/)
  const created = await call('manage_doubts', 'create', {
    action: 'create',
    statement: '资料遗留',
    eventIds: ['E1'],
  })
  expect(created.isError).not.toBe(true)
  await repo.transaction(true, (store) => store.remove('storyEvents', 'E1'))
  const removed = await call('manage_doubts', 'delete', { action: 'delete', id: (created.details as Row).id })
  expect(removed).toMatchObject({ details: { action: 'delete' } })
  const edit = api.tools.find((tool) => tool.name === 'edit_events')!
  expect(() =>
    edit.prepareArguments!({
      operations: [{ op: 'update_event', eventId: 'E0', summary: '概况', nodeIds: ['N0'] }],
    })
  ).toThrow(/第 1 个编辑（update_event）。.*nodeIds/)
  expect(() =>
    api.tools.find((t) => t.name === 'confirm')!.prepareArguments!({ handled_event_ids: ['E0'] })
  ).toThrow(/handled_event_ids.*confirm\(\{\}\)/)
  const invalidNode = await call('edit_events', 'hidden', {
    operations: [{ op: 'attach_nodes', eventId: 'E0', nodeIds: ['N1'] }],
  })
  expect(invalidNode.details).toMatchObject({
    tool: 'edit_events',
    code: 'OBJECT_OUT_OF_SCOPE',
    fields: ['nodeIds'],
    objectIds: ['N1'],
    reason: '节点尚未开放。',
  })
  const misplaced = await call('edit_events', 'unknown', {
    operations: [{ op: 'update_event', eventId: 'none', title: '未知对象' }],
  })
  expect(misplaced.details).toMatchObject({ code: 'SCOPE', operationNumber: 1, objectIds: ['none'] })
  const args = {}
  expect((await call('confirm', 'finish', args)).isError).not.toBe(true)
  expect((await call('confirm', 'finish', args)).isError).not.toBe(true)
  expect(await repo.transaction(false, (s) => s.get('storyEvents', 'E0'))).toMatchObject({
    nodeIds: ['N0', 'N1'],
    summary: '加入本批后更新概况',
    coreClue: '核心线索',
  })
  expect(await repo.transaction(false, (s) => s.get('pipelineRuns', 'r'))).toMatchObject({
    narrative: { batches: { event: 1, line: 0 } },
  })
})
it('旧批次从写入回执回放成员与当时的标题', () => {
  const task = {
    mode: 'node_batch',
    prompt: JSON.stringify({ targets: [{ id: 'N1', name: '送信' }], outline: { events: [] } }),
  } as NarrativeTask
  const receipt = {
    arguments: { operations: [{ op: 'create_event', title: '村口交信' }] },
    result: { changes: [{ opIndex: 0, kind: 'event', id: 'E1', addedIds: ['N1'] }] },
  }
  expect(receiptOutcome([receipt], task)).toEqual([
    { parent: { id: 'E1', title: '村口交信' }, items: [{ id: 'N1', title: '归入 · 送信' }] },
  ])
})

it('同一任务老轮次稳定，保留最近两轮，未配齐的调用保持完整', () => {
  const messages: Message[] = []
  for (let i = 0; i < 10; i++) {
    messages.push({
      role: 'assistant',
      timestamp: i,
      content: [{ type: 'toolCall', id: 'call' + i, name: 'get_detail', arguments: {} }],
    } as Message)
    messages.push({
      role: 'toolResult',
      toolCallId: 'call' + i,
      toolName: 'get_detail',
      timestamp: i,
      isError: false,
      content: [{ type: 'text', text: 'N' + i }],
    } as Message)
  }
  const four = narrativeContext(messages.slice(0, 6), 2, {})
  const five = narrativeContext(messages.slice(0, 8), 2, four.additions)
  expect(Object.keys(four.additions)).toEqual(['1'])
  expect(Object.keys(five.additions)).toEqual(['2'])
  const incremental = narrativeContext([...four.messages, ...messages.slice(6, 8)], 2, four.additions)
  expect(incremental).toEqual(five)
  const withContinuation = narrativeContext(
    [...four.messages, { role: 'user', content: '继续当前任务', timestamp: 100 }, ...messages.slice(6, 8)],
    2,
    four.additions
  )
  expect(withContinuation.messages).toContainEqual({ role: 'user', content: '继续当前任务', timestamp: 100 })
  expect(withContinuation.additions).toEqual(five.additions)
  expect(five.messages[0]).toEqual(four.messages[0])
  const ten = narrativeContext(messages.slice(0, 18), 2, { ...four.additions, ...five.additions })
  expect(ten.messages.slice(0, 2)).toEqual(five.messages.slice(0, 2))
  expect(ten.messages.filter((message) => message.role === 'assistant')).toHaveLength(2)
  expect(ten.messages.filter((message) => message.role === 'toolResult')).toHaveLength(2)
  expect(narrativeContext([messages[0], ...messages.slice(2)], 2, {}).messages[0].role).toBe('assistant')
})
