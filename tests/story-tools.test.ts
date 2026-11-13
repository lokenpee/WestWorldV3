import { expect, it } from 'vitest'
import { createMemoryAgentRepository, type Row } from '../src/features/agents/repository'
import { createAgentTools } from '../src/features/agents/tools'
import { hash, inputSchema, validate } from '../src/features/agents/contracts'
import type { Scope } from '../src/features/agents/queries'
import { storyTaskPrompt } from '../src/features/story/prompt'

const node = (id: string, chapterIndex: string): Row => ({ id, bookId: 'b', name: `三河帮事件${id}`, summary: '三河帮追查旧信', process: '信件的线索得到回应', actors: [], quote: '', chapterIndex, chapterName: chapterIndex, order: 0, confidence: 1, revision: 1, createdBy: 'P1', eventLineIds: [] })
async function fixture(chapters = ['1', '20', '120'], workflow = 'story_lines_v2') {
  const nodes = chapters.map((chapter, index) => node(`N${index + 1}`, chapter))
  const workItems = nodes.map(row => ({ kind: 'node', id: row.id, workItemId: `w:${row.id}` }))
  const memory = { id: 's', bookId: 'b', sessionId: 's', workingSummary: '三河帮线索待核对', revision: 1, dataFingerprint: '', updatedAt: new Date().toISOString() }
  const scope: Scope = { bookId: 'b', profile: 'story_editor', phase: 'window_link', workflow, runId: 'r', taskId: 't', owner: 'o', sessionId: 's', workItemIds: workItems.map(item => item.workItemId) }
  const repo = createMemoryAgentRepository('b', { nodes, chapters: chapters.map((chapterIndex, order) => ({ bookId: 'b', chapterIndex, chapterName: chapterIndex, order })), chapterTexts: chapters.map(chapterIndex => ({ bookId: 'b', chapterIndex, text: '三河帮收到旧信，信中说明旧事的来由。' })), storyEditorMemory: [memory],
    storySessions: [{ id: 's', bookId: 'b', leaseOwner: 'o', leaseUntil: Date.now() + 60000, nextOrdinal: 0 }],
    pipelineRuns: [{ id: 'lease:narrative', bookId: 'b', runId: 'r', owner: 'o', expiresAt: Date.now() + 60000 }, { id: 'r', bookId: 'b', status: 'running', tasks: [{ taskId: 't', phase: 'window_link', input: { workItems }, appliedCommitIds: [], reviewedItems: [] }], appliedCommands: [], commandIntents: [] }],
  })
  const adapter = createAgentTools(repo, scope, { initialReadSet: { queries: [], records: [{ table: 'storyEditorMemory', id: 's', resolvedId: 's', revision: 1, factFingerprint: await hash(memory) }] } })
  const call = async (name: string, args: Row, id: string = crypto.randomUUID()) => {
    const tool = adapter.tools.find(tool => tool.name === name)!
    const result = await tool.execute(id, args)
    return JSON.parse(result.content.filter(part => part.type === 'text').map(part => part.text).join('')) as Row
  }
  const rows = (table: string) => repo.transaction(false, store => store.rows(table))
  const detail = (kind: string, ids: string[], extra: Row = {}) => call('get_story_detail', { kind, ids, ...extra })
  const create = (title: string, nodeIds: string[]) => call('save_story_lines', { operations: [workflow === 'story_pages_v3' ? { action: 'create', title, nodeIds, summary: '旧信留下疑问，线索持续发展，尚待后续。' } : { action: 'create', title, nodeIds, cause: '旧信留下疑问', process: '线索持续发展', result: '待后续', lineStatus: 'open', reason: '同一封旧信', confidence: 1, evidenceNodeIds: nodeIds }] })
  return { repo, scope, adapter, call, rows, detail, create, workItems }
}

it('只开放七工具，跨章追加保留脉络且不重写记忆，一节点可属于两线', async () => {
  const f = await fixture()
  expect(f.adapter.initialTools.map(tool => tool.name).sort()).toEqual(['search_story_context', 'get_story_detail', 'read_original', 'save_story_lines', 'save_story_notes', 'add_story_nodes', 'finish_story_batch'].sort())
  expect(JSON.stringify(f.adapter.initialTools.map(tool => tool.parameters))).not.toContain('operationKey')
  await f.detail('node', ['N1', 'N2', 'N3'])
  const first = await f.create('三河帮旧信', ['N1']), id = (first.lineIds as string[])[0]
  await f.detail('eventLine', [id])
  await f.call('save_story_lines', { operations: [{ action: 'append', lineId: id, nodeIds: ['N2', 'N3'], confidence: 1, reason: '后文回应旧信', evidenceNodeIds: ['N1', 'N2', 'N3'] }] })
  expect(await f.rows('eventLines')).toMatchObject([{ id, nodeIds: ['N1', 'N2', 'N3'], cause: '旧信留下疑问', process: '线索持续发展', lineStatus: 'open' }])
  const second = await f.create('送信人的身世', ['N2'])
  expect((await f.rows('nodes')).find(row => row.id === 'N2')!.eventLineIds).toEqual(expect.arrayContaining([id, (second.lineIds as string[])[0]]))
  expect(await f.rows('storyEditorMemory')).toMatchObject([{ revision: 1, workingSummary: '三河帮线索待核对' }])
  const run = (await f.rows('pipelineRuns')).find(row => row.id === 'r')!
  for (const intent of run.commandIntents as Row[]) expect(() => validate(inputSchema('CommandIntent'), intent)).not.toThrow()
  const edits = run.assetEdits as Row[]
  expect(edits).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'eventLine', id, reason: '后文回应旧信', fieldChanges: expect.arrayContaining([{ field: 'nodeIds', before: ['N1'], after: ['N1', 'N2', 'N3'] }]) })]))
  for (const edit of edits) expect(() => validate(inputSchema('AssetEditRecord'), edit)).not.toThrow()
})

it('同节点可构成不同主题的线，合线及调整成员保持其他归属', async () => {
  const f = await fixture(); await f.detail('node', ['N1', 'N2', 'N3'])
  const a = ((await f.create('旧信', ['N1'])).lineIds as string[])[0]
  const b = ((await f.create('身世', ['N1'])).lineIds as string[])[0]
  const c = ((await f.create('旧信续篇', ['N2'])).lineIds as string[])[0]
  expect(a).not.toBe(b)
  await f.detail('eventLine', [a, b, c])
  await f.call('save_story_lines', { operations: [{ action: 'merge', lineId: a, mergeLineIds: [c], reason: '同一封信的发展', evidenceNodeIds: ['N1', 'N2'], confidence: 1 }] })
  await f.detail('eventLine', [a])
  await f.call('save_story_lines', { operations: [{ action: 'update', lineId: a, nodeIds: ['N2', 'N3'], process: '修正成员', reason: '首项只属于身世线', evidenceNodeIds: ['N2', 'N3'], confidence: 1 }] })
  expect((await f.rows('nodes')).find(row => row.id === 'N1')!.eventLineIds).toEqual([b])
  expect((await f.rows('eventLines')).map(row => row.id)).not.toContain(c)
})

it('读过原文才能补点，回执丢失重放和新调用重试都复用已保存节点', async () => {
  const f = await fixture()
  const args = { nodes: [{ chapterIndex: '20', name: '收到旧信', summary: '三河帮收到旧信', actors: [], quote: '三河帮收到旧信' }] }
  await expect(f.call('add_story_nodes', args)).rejects.toThrow('读取对应章节原文')
  await f.call('read_original', { chapter_indices: ['20'] })
  const first = await f.call('add_story_nodes', args, 'lost-receipt')
  const replay = await f.call('add_story_nodes', args, 'lost-receipt')
  expect(replay).toMatchObject({ alreadyApplied: true, nodes: first.nodes, commitId: first.commitId })
  const repeated = await f.call('add_story_nodes', args)
  expect(repeated).toMatchObject({ changed: false, nodes: [{ id: (first.nodes as Row[])[0].id, reused: true }] })
  expect(await f.rows('nodes')).toHaveLength(4)
  const id = String((first.nodes as Row[])[0].id)
  await f.detail('node', [id]); await f.create('补提旧信事件', [id])
  expect((await f.rows('eventLines'))[0].nodeIds).toEqual([id])
})

it('批量有一项无依据时全部回滚，失败不产生成功提交', async () => {
  const f = await fixture(); await f.detail('node', ['N1'])
  const op = (nodeIds: string[]) => ({ action: 'create', title: '旧信', nodeIds, cause: '', process: '', result: '', lineStatus: 'open', confidence: 1, reason: '核对旧信', evidenceNodeIds: nodeIds })
  await expect(f.call('save_story_lines', { operations: [op(['N1']), op(['N2'])] })).rejects.toThrow('get_story_detail')
  expect(await f.rows('eventLines')).toHaveLength(0)
  expect((await f.rows('pipelineRuns')).find(row => row.id === 'r')!.appliedCommands).toEqual([])
})

it('空修改可直接完成，未检查项返回partial，伪称已修改不被接受', async () => {
  const f = await fixture()
  await f.detail('node', ['N1', 'N2', 'N3'])
  await expect(f.call('finish_story_batch', { items: [{ kind: 'node', id: 'N1', outcome: 'changed', reason: '没有实际修改' }] })).rejects.toThrow('真实写入依据')
  const partial = await f.call('finish_story_batch', { items: [] })
  expect(partial).toMatchObject({ status: 'partial', commitIds: [], remaining: [{ kind: 'node', id: 'N1' }, { kind: 'node', id: 'N2' }, { kind: 'node', id: 'N3' }] })
  const result = await f.call('finish_story_batch', { items: f.workItems.map(({ kind, id }) => ({ kind, id, outcome: 'no_change', reason: '各自独立的事件' })) })
  expect(result).toMatchObject({ status: 'completed', commitIds: [], remaining: [] })
  expect(f.adapter.summary?.status).toBe('completed')
  expect((await f.rows('pipelineRuns')).find(row => row.id === 'r')!.appliedCommands).toEqual([])
})

it('线索独立保存，回收前读取旧事项，未传摘要保持原版本', async () => {
  const f = await fixture(); await f.detail('node', ['N1', 'N3'])
  await f.call('save_story_notes', { notes: [{ key: 'old-letter', status: 'active', statement: '三河帮为何收到旧信', nodeIds: ['N1'] }] })
  const note = (await f.rows('storyEditorNotes'))[0]
  await expect(f.call('save_story_notes', { notes: [{ key: 'old-letter', status: 'resolved', statement: '后文回应旧信', nodeIds: ['N1', 'N3'] }] })).rejects.toThrow('核对该事项')
  await f.detail('note', [String(note.id)])
  await f.call('save_story_notes', { notes: [{ key: 'old-letter', status: 'resolved', statement: '后文回应旧信', nodeIds: ['N1', 'N3'] }] })
  expect(await f.rows('storyEditorNotes')).toMatchObject([{ id: note.id, status: 'resolved', revision: 2 }])
  expect(await f.rows('storyEditorMemory')).toMatchObject([{ revision: 1 }])
})

it('目录浏览、章节过滤和长事件线成员分页可完整读取', async () => {
  const f = await fixture(Array.from({ length: 6 }, (_, i) => String(i + 1)))
  const page = await f.call('search_story_context', { kind: 'node', chapter_range: ['2', '4'], limit: 2 })
  expect(page).toMatchObject({ totalCount: 3, truncated: true, nextOffset: 2 })
  const next = await f.call('search_story_context', { kind: 'node', chapter_range: ['2', '4'], limit: 2, offset: 2 })
  expect((next.data as Row[])).toHaveLength(1)
  await f.detail('node', ['N1', 'N2', 'N3', 'N4', 'N5', 'N6'])
  const id = ((await f.create('完整旧信线', ['N1', 'N2', 'N3', 'N4', 'N5', 'N6'])).lineIds as string[])[0]
  const first = (await f.detail('eventLine', [id], { memberLimit: 2 })).data as Row[]
  expect(first[0]).toMatchObject({ nodeIds: ['N1', 'N2'], memberCount: 6, nextMemberOffset: 2 })
  const second = (await f.detail('eventLine', [id], { memberOffset: 2, memberLimit: 4 })).data as Row[]
  expect(second[0]).toMatchObject({ nodeIds: ['N3', 'N4', 'N5', 'N6'], nextMemberOffset: null })
})

it('当前任务消息只包含业务资料，内部任务与记忆版本留在程序', () => {
  const prompt = storyTaskPrompt({ phase: 'window_link', queue: 'window_nodes', window: { start: 80, end: 180 }, runId: 'secret-run', taskId: 'secret-task', sessionId: 'secret-session', remainingCount: 5, resume: { nextOperationKey: 'secret-key' }, contextHints: { assigned: [{ id: 'N1', kind: 'node', summary: '三河帮收信' }], related: [{ id: 'L1', kind: 'eventLine' }], truncated: true }, memory: { id: 's', revision: 99, workingSummary: '待查旧信' } })
  expect(prompt).not.toMatch(/secret-|revision|operationKey|sessionId|runId|workItemId/)
  expect(prompt).toContain('待查旧信'); expect(prompt).toContain('"chapterRange":["81","180"]')
})

it('发展段可增量追加和按段号改写，重放不重复追加且不用复述旧句', async () => {
  const f = await fixture(); await f.detail('node', ['N1', 'N2', 'N3'])
  const id = ((await f.create('三河帮旧信', ['N1'])).lineIds as string[])[0]
  await f.detail('eventLine', [id])
  const args = { operations: [{ action: 'append', lineId: id, nodeIds: ['N2'], processAppend: 'N2：收到旧信后开始追查，推动下一步调查。', evidenceNodeIds: ['N2'] }] }
  await f.call('save_story_lines', args, 'append-once')
  await f.call('save_story_lines', args, 'append-once')
  const detail = (await f.detail('eventLine', [id])).data as Row[]
  expect(detail[0].processSegments).toEqual([{ segment: 1, text: '线索持续发展' }, { segment: 2, text: 'N2：收到旧信后开始追查，推动下一步调查。' }])
  await f.call('save_story_lines', { operations: [{ action: 'update', lineId: id, processEdits: [{ segment: 2, text: 'N2提供了核查来历的线索；线索的真实性仍待后文验证。' }], result: '收到线索，尚未查清来历' }] })
  expect((await f.rows('eventLines'))[0]).toMatchObject({ nodeIds: ['N1', 'N2'], cause: '旧信留下疑问', process: '线索持续发展\n\nN2提供了核查来历的线索；线索的真实性仍待后文验证。', result: '收到线索，尚未查清来历', lineStatus: 'open' })
})

it('当前P3只有六工具，搜索目录足以保存，续接省略概述时保留旧内容', async () => {
  const f = await fixture(undefined, 'story_pages_v3')
  expect(f.adapter.initialTools.map(tool => tool.name).sort()).toEqual(['search_story_context', 'get_story_detail', 'save_story_lines', 'save_story_notes', 'navigate_story_pages', 'finish_story_batch'].sort())
  await f.call('search_story_context', { kind: 'node' })
  const id = ((await f.create('旧信', ['N1'])).lineIds as string[])[0]
  await f.call('search_story_context', { kind: 'eventLine' })
  await f.call('save_story_lines', { operations: [{ action: 'append', lineId: id, nodeIds: ['N2'] }] })
  expect((await f.rows('eventLines'))[0]).toMatchObject({ nodeIds: ['N1', 'N2'], summary: '旧信留下疑问，线索持续发展，尚待后续。' })
  await f.call('save_story_lines', { operations: [{ action: 'update', lineId: id, summary: '后文回应旧信，来历已明。' }] })
  expect((await f.rows('eventLines'))[0].summary).toBe('后文回应旧信，来历已明。')
})

it('节点详情按正文分页且不泄露证据和存储字段，目录概述不截断', async () => {
  const f = await fixture(undefined, 'story_pages_v3')
  await f.repo.transaction(true, async store => {
    const row = (await store.get('nodes', 'N1'))!
    await store.put('nodes', { ...row, summary: '重要伏笔'.repeat(200), process: '详细经过'.repeat(300), quote: '秘密引文', relationEvidence: ['秘密关系'] })
  })
  const search = await f.call('search_story_context', { kind: 'node' })
  expect((search.data as Row[]).find(row => row.id === 'N1')?.summary).toBe('重要伏笔'.repeat(200))
  const first = (await f.detail('node', ['N1'], { maxChars: 100 })).data as Row[]
  expect(first[0]).toMatchObject({ process: '详细经过'.repeat(25), nextCharOffset: 100 })
  expect(JSON.stringify(first)).not.toMatch(/秘密|bookId|revision|confidence|quote|relationEvidence/)
  const next = (await f.detail('node', ['N1'], { char_offset: 100, maxChars: 100 })).data as Row[]
  expect(next[0].process).toBe('详细经过'.repeat(25))
})

it('合线未重写说明时保留双方起因经过结果，并保持尚在发展的状态', async () => {
  const f = await fixture(); await f.detail('node', ['N1', 'N2'])
  const save = (title: string, id: string, lineStatus: string) => f.call('save_story_lines', { operations: [{ action: 'create', title, nodeIds: [id], cause: `${title}起因`, process: `${title}发展`, result: `${title}结果`, lineStatus }] })
  const first = ((await save('旧信', 'N1', 'closed')).lineIds as string[])[0]
  const second = ((await save('旧信后续', 'N2', 'open')).lineIds as string[])[0]
  await f.detail('eventLine', [first, second])
  await f.call('save_story_lines', { operations: [{ action: 'merge', lineId: first, mergeLineIds: [second] }] })
  expect(await f.rows('eventLines')).toMatchObject([{ id: first, nodeIds: ['N1', 'N2'], cause: '旧信起因\n\n旧信后续起因', process: '旧信发展\n\n旧信后续发展', result: '旧信结果\n\n旧信后续结果', lineStatus: 'open' }])
})

it('新阅读流程不硬性限制摘要和事项长度，存储与备份仍可校验', async () => {
  const f = await fixture(undefined, 'story_pages_v3')
  const workingSummary = '三河帮旧信的来历、沿途经手人与后续回应仍需合并核对。'.repeat(100)
  const statement = '旧信解释了早年经历，但人物隐瞒事实的动机还要查阅后文。'.repeat(50)
  const quote = '旧信中概括交代了过往事情发生的原因，以及帮众之间尚未解开的疑问。'.repeat(40)
  expect(workingSummary.length).toBeGreaterThan(2000)
  expect(statement.length).toBeGreaterThan(1000)
  expect(quote.length).toBeGreaterThan(1000)
  await f.call('save_story_notes', { workingSummary, notes: [{ key: 'letter-summary', status: 'active', statement }] })
  await f.call('save_story_notes', { notes: [{ key: 'unresolved-purpose', status: 'active', statement: '三河帮的真正目标尚待查阅后文。' }] })
  const notes = await f.rows('storyEditorNotes'), memory = await f.rows('storyEditorMemory')
  expect(notes).toHaveLength(2)
  expect(notes.find(note => note.key === 'letter-summary')).toMatchObject({ statement })
  expect(notes.find(note => note.key === 'unresolved-purpose')).toMatchObject({ nodeIds: [], lineIds: [], status: 'active' })
  expect(memory).toMatchObject([{ workingSummary }])
  const run = (await f.rows('pipelineRuns')).find(row => row.id === 'r')!
  expect(run.commandIntents).toHaveLength(2)
  for (const [schema, values] of [['StoryEditorMemory', memory], ['StoryEditorNote', notes], ['CommandIntent', run.commandIntents as Row[]]] as const) {
    for (const value of values) expect(() => validate(inputSchema(schema), JSON.parse(JSON.stringify(value)))).not.toThrow()
  }
  await expect(f.call('save_story_notes', { notes: [{ key: 'wrong-reference', status: 'active', statement: '不存在的章节', evidence: [{ chapterIndex: '999', quote: '概括内容' }] }] })).rejects.toThrow('工具参数不符合要求')
})


it('简短保存合线、改成员和回执重放保留旧叙述，整批失败不留下半条线', async () => {
  const f = await fixture(undefined, 'story_pages_v3')
  await f.call('search_story_context', { kind: 'node' })
  const a = ((await f.create('旧信', ['N1'])).lineIds as string[])[0]
  const b = ((await f.create('旧信后续', ['N2'])).lineIds as string[])[0]
  await f.repo.transaction(true, async store => { const row = (await store.get('eventLines', a))!; await store.put('eventLines', { ...row, cause: '旧起因', process: '旧经过', result: '旧结果', lineStatus: 'closed' }) })
  await f.detail('eventLine', [a, b])
  const args = { operations: [{ action: 'merge', lineId: a, mergeLineIds: [b], summary: '旧信经后续查证，来历已经明确。' }] }
  const merged = await f.call('save_story_lines', args, 'merge-once')
  expect(merged.lines).toEqual([{ lineId: a, added: 1, removed: 0 }])
  expect(await f.call('save_story_lines', args, 'merge-once')).toMatchObject({ alreadyApplied: true, commitId: merged.commitId })
  expect(await f.rows('eventLines')).toMatchObject([{ id: a, summary: args.operations[0].summary, nodeIds: ['N1', 'N2'], cause: '旧起因', process: '旧经过', result: '旧结果', lineStatus: 'closed' }])
  const updated = await f.call('save_story_lines', { operations: [{ action: 'update', lineId: a, nodeIds: ['N2'] }] })
  expect(updated.lines).toEqual([{ lineId: a, added: 0, removed: 1 }])
  await expect(f.call('save_story_lines', { operations: [{ action: 'create', title: '新线', nodeIds: ['N3'], summary: '关联' }, { action: 'create', title: '错误', nodeIds: ['missing'], summary: '关联' }] })).rejects.toThrow()
  expect(await f.rows('eventLines')).toHaveLength(1)
})
