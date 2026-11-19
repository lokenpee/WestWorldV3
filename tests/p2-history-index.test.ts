import 'fake-indexeddb/auto'
import { afterEach, expect, test } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { pruneOrganizationHistory } from '../src/features/agents/p2History'
import { historyIndexId, registerCompletedHistory } from '../src/features/agents/p2HistoryIndex'
import { createMemoryAgentRepository, type Row } from '../src/features/agents/repository'
import { applyOrganizationTool } from '../src/features/agents/organizationCommands'
import { createOrganizationStepState } from '../src/features/world/organization'
import { emptyTables, validateBookData } from '../src/features/backup/data'
import { encodeBackup, inspectBackup } from '../src/features/backup/codec'

const opened: ReturnType<typeof createWorkspace>[] = []
afterEach(async () => { for (const w of opened.splice(0)) { await w.openBook('b').delete(); await w.settings.delete(); w.close() } })
const position = (unit: string, ids = ['old']): Row => ({ id: historyIndexId(unit), bookId: 'b', recordType: 'history_index', stage: 'P2', status: 'completed', startedAt: '2026-01-01', planVersion: '2.2', historyIndexVersion: 1, historyUnit: unit, historyRunIds: ids })

test.each(['profiles', 'relations'] as const)('真实%s完成提交原子登记详情位置；重复登记不重复存储', async step => {
  const unit = `${step === 'profiles' ? 'profile' : 'relations'}:A`
  const repo = createMemoryAgentRepository('b', { characters: [{ id: 'A', bookId: 'b', name: '甲', revision: 1, aliases: [], confidence: 1, createdBy: 'P1' }], pipelineRuns: [position(unit)] })
  await repo.transaction(true, async store => {
    const organization = await createOrganizationStepState(store, step, 'all')
    organization.activeWork = { id: unit, kind: step === 'profiles' ? 'profile' : 'relations', characterId: 'A', contextId: step, status: 'running', requestCount: 1, draft: null, commitIds: [], dataVersion: 1 }
    await store.put('pipelineRuns', { id: 'new', bookId: 'b', organization })
    const scope = { bookId: 'b', runId: 'new', taskId: 't', profile: 'asset_editor' as const, phase: 'character_organization', workflow: 'character_organization_v1' as const, owner: 'owner', workItemIds: [] }
    const result = await applyOrganizationTool(store, scope, step === 'profiles' ? 'submit_profile_review' : 'submit_relation_review', { patch: {}, changes: [], done: true, reason: '资料已核对' }, { records: [], queries: [] }, 'commit', '2026-01-01')
    expect(result).toMatchObject({ done: true })
    const run = (await store.get('pipelineRuns', 'new'))!
    await registerCompletedHistory(store, run, run.organization as Row)
    expect((await store.get('pipelineRuns', historyIndexId(unit)))!.historyRunIds).toEqual(['old', 'new'])
  })
})

test('清理位置保存失败回滚删除；租约到期、日志落盘后同人物再次清理', async () => {
  const prefix = crypto.randomUUID(), w = createWorkspace({ settingsName: prefix, bookPrefix: `${prefix}-` }); opened.push(w)
  const db = w.openBook('b'), unit = 'profile:A', scope = { runId: 'new', step: 'profiles' as const, characterId: 'A' }
  for (const id of ['old', 'new']) {
    await db.table('pipelineRuns').put({ id, bookId: 'b', stage: 'P2', status: 'completed', startedAt: id === 'old' ? '1' : '2', workflow: 'character_organization_v1', sessionId: `s-${id}`, organization: { profileItems: [{ id: 'A', status: 'checked' }], relationItems: [] } })
    await db.table('storySessionEntries').put({ id: `trace-${id}`, bookId: 'b', sessionId: `s-${id}`, runId: id, unitId: unit, type: 'request_trace', final: id === 'old', complete: true })
  }
  await db.table('storySessions').put({ id: 's-old', bookId: 'b', leaseOwner: 'other', leaseUntil: Date.now() + 60000 })
  await pruneOrganizationHistory(w, 'b', scope)
  expect((await db.table('pipelineRuns').get(historyIndexId(unit))).historyRunIds).toEqual(['new', 'old'])
  await db.table('storySessionEntries').update('trace-new', { final: true })
  await pruneOrganizationHistory(w, 'b', scope)
  expect(await db.table('storySessionEntries').get('trace-old')).toBeDefined()
  await db.table('storySessions').update('s-old', { leaseUntil: 0 })
  const fail = (_changes: unknown, key: unknown) => { if (key === historyIndexId(unit)) throw new Error('位置保存失败') }
  db.table('pipelineRuns').hook('updating', fail)
  await expect(pruneOrganizationHistory(w, 'b', scope)).rejects.toThrow('位置保存失败')
  expect(await db.table('storySessionEntries').get('trace-old')).toBeDefined()
  db.table('pipelineRuns').hook('updating').unsubscribe(fail)
  await pruneOrganizationHistory(w, 'b', scope)
  expect(await db.table('storySessionEntries').get('trace-old')).toBeUndefined()
  expect((await db.table('pipelineRuns').get(historyIndexId(unit))).historyRunIds).toEqual(['new'])
  // 恢复备份不含派生位置，首次维护从真实运行重建。
  await db.table('pipelineRuns').delete(historyIndexId(unit))
  await pruneOrganizationHistory(w, 'b', scope)
  expect((await db.table('pipelineRuns').get(historyIndexId(unit))).historyRunIds).toEqual(['new'])
})

test('历史位置允许本机校验，备份不携带派生位置', async () => {
  const data = { book: { id: 'b', title: '临时样本', sourceFileName: 'test.txt', createdAt: '2026-01-01' }, tables: emptyTables() }
  data.tables.pipelineRuns = [position('profile:A')]
  data.tables.chapters = [{ bookId: 'b', chapterIndex: '1', chapterName: '第一章', order: 0, charCount: 2 }]
  data.tables.chapterTexts = [{ bookId: 'b', chapterIndex: '1', text: '正文' }]
  expect(await validateBookData(data)).toEqual([])
  const backup = await encodeBackup(data)
  const restored = await inspectBackup(backup.bytes)
  expect(restored.ok).toBe(true)
  expect(restored.data!.tables.pipelineRuns).toEqual([])
})
