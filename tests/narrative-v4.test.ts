import {
  narrativeSystemPrompt,
} from '../src/features/story/narrativePrompts'
import { receiptOutcome } from '../src/features/story/narrativeOutcome'
import { narrativeMaterial } from './support/agent-protocol'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import {
  newNarrativePlan,
  scheduleNarrative,
  confirmNarrative,
  narrativeDefaults,
  type NarrativeAssets,
  type Mode,
  type NarrativeTask,
} from '../src/features/story/narrativePlan'
import { validate } from '../src/features/agents/contracts'
import type { Row } from '../src/features/agents/repository'
import { toolDefinitions } from '../src/features/story/narrativeTools'
import { narrativeContext } from '../src/features/story/narrativeContext'
import type { Message } from '@earendil-works/pi-ai'


it.each([
  ['event_group', 'event_group'],
  ['line_cycle', 'line_cycle-unassigned'],
  ['line_review', 'line_review-descriptions'],
] as const)(
  '%s 只给本阶段的编辑参数',
  (mode, exampleId) => {
    const event = ['node_batch', 'event_cycle', 'event_review'].includes(mode)
    const example = JSON.parse(
      readFileSync('docs/v2/resources/v2.2/request-examples/PROMPT-P3-NARRATIVE-V4-' + exampleId + '.json', 'utf8')
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
    expect(example.context.messages[0].content).toContain(narrativeSystemPrompt({ mode, part }))
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
it.each(['link_node','review_boundaries','review_sequence'] as const)('%s 请求示例和运行时一致', mode => {
  const example = JSON.parse(readFileSync('docs/v2/resources/v2.2/request-examples/PROMPT-P3-NARRATIVE-V4-'+mode+'.json','utf8'))
  const tools = toolDefinitions(example.input)
  expect(Object.keys(tools).sort()).toEqual(['confirm','edit_events','get_event','get_nodes','search_events',mode === 'link_node' ? 'search_prior_nodes' : 'search_nodes'])
  expect(example.context.tools.map((t:Row)=>t.parameters)).toEqual(Object.values(tools))
  expect(example.context.messages[0].content).toContain(narrativeSystemPrompt(example.input))
  const content = example.context.messages[1].content
  const ruleFile = {link_node:'p3-event-link.md',review_boundaries:'p3-event-boundaries.md',review_sequence:'p3-event-sequence.md'}[mode]
  const rule = readFileSync('docs/v2/resources/v2.2/prompts/active/'+ruleFile,'utf8').trim()
  expect(narrativeSystemPrompt(example.input)).toBe(rule)
  if (mode !== 'link_node') {
    const material=JSON.parse(content)
    expect(Object.keys(material)[0]).toBe('资料说明')
    const eventRead = example.context.tools.find((tool:Row)=>tool.name==='get_event').description
    for (const field of ['event_id','name','overview','latest_progress','unresolved','clues','status']) {
      expect(material.资料说明).toContain(field)
      expect(eventRead).toContain(field)
    }
    if (mode==='review_boundaries') {
      const merge=JSON.parse(rule.split('```json')[1].split('```')[0])
      expect(()=>validate(tools.edit_events,merge)).not.toThrow()
      expect(merge.changes.map((change:Row)=>change.op)).toEqual(['update','delete'])
    }
    for (const key of mode==='review_sequence'?['主审事件','成员时间表']:['本组事件','节点时间表']) {
      expect(material).toHaveProperty(key)
      expect(rule).toContain(key)
    }
    expect(material).not.toHaveProperty('全书事件目录')
    expect(()=>validate(tools.confirm,{result:'completed'})).not.toThrow()
    expect(()=>validate(tools.confirm,{result:'completed',reviewed_event_ids:['E1']})).toThrow()
  }
  if (mode === 'link_node') {
    const system = example.context.messages[0].content
    for (const heading of ['一、身份与定义','二、任务','三、Q&A','四、字段要求','五、工具使用约定','六、核心规则'])
      expect(system).toContain('## '+heading)
    expect(system).toContain('6. **按事实维护状态**')
    expect(system).not.toContain('search_nodes')
    expect(system).not.toContain('每次完整复核当前一个事件')
    expect(Object.keys(example.context.tools.find((t:Row)=>t.name==='confirm').parameters.properties)).toEqual(['result','unassigned_reason'])
    expect([...content.matchAll(/【(.+?)开始】/g)].map(m => m[1])).toEqual(['当前节点概览','后文节拍概览','排序召回事件','本轮任务'])
    expect(narrativeMaterial(content).material.当前节点).toEqual(example.input.material.当前节点)
  } else expect(JSON.parse(content)).toEqual(example.input.material)
  expect(()=>validate(tools.confirm,{})).toThrow()
})
it('全书故事线整段确认后带入仅关联故事线的疑点', () => {
  const a = sceneBook(1)
  a.notes.push({ id: 'D', category: 'OTHER', status: 'active', statement: '篇章结尾待查', lineIds: ['S'] })
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

it('既有归线组按未分配事件切组', () => {
  const a=sceneBook(30)
  a.lines[0].eventIds=['E0','E1']
  const plan={...newNarrativePlan(),reuseAssigned:true,layer:'line' as const}
  expect(scheduleNarrative(plan,a)?.ids).toEqual(a.events.slice(2,22).map(e=>e.id))
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

it('当前 P3 每种调度任务独占一份已登记的提示词正文',()=>{
  const base='docs/v2/resources/'
  const prefix='PROMPT-P3-NARRATIVE-V4-'
  const manifest=JSON.parse(readFileSync(base+'v2.2/prompt-call-manifest.json','utf8'))
  const registered=(manifest.calls as {id:string;prompt:string}[]).filter(c=>c.id.startsWith(prefix))
  const parts: Partial<Record<Mode,NarrativeTask['part'][]>>={
    link_node:['batch'],review_boundaries:['structure'],review_sequence:['structure'],
    event_group:['batch'],line_cycle:['structure','doubts','unassigned'],line_review:['structure','doubts','unassigned','descriptions'],
  }
  const used=new Set<string>()
  for(const [key,stages] of Object.entries(parts)){
    const mode=key as Mode
    for(const part of stages){
      const qualified=mode==='line_review' || mode==='line_cycle'
      const id=prefix+mode+(qualified ? '-'+part : '')
      const route=registered.find(c=>c.id===id)!
      expect(used.has(route.prompt)).toBe(false)
      used.add(route.prompt)
      expect(narrativeSystemPrompt({mode,part})).toBe(readFileSync(base+route.prompt,'utf8').trim())
    }
  }
  expect(used.size).toBe(registered.length)
})
