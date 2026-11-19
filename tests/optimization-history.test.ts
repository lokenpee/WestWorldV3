import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { createLocalStorageServer } from '../src/features/local-storage/server'
import type { StorageCall } from '../src/features/local-storage/client'
import { createWorkspace } from '../src/lib/storage/workspace'
import { pruneOrganizationHistory } from '../src/features/agents/p2History'
import type { Row } from '../src/features/agents/repository'

type Completion = { runId: string; step: 'profiles' | 'relations'; characterId: string }
// 旧实现忽略本次完成范围；同一固定样本也直接用于后续按人物清理实现。
const prune: (workspace: ReturnType<typeof createWorkspace>, bookId: string, completion?: Completion) => Promise<void> = pruneOrganizationHistory
const personId = (index: number) => `P${String(index).padStart(3, '0')}`
const makeRun = (id: string, person: string, startedAt: string): Row => ({ id, bookId: 'sample', stage: 'P2', recordType: 'run', status: 'completed', workflow: 'character_organization_v1', sessionId: `s-${id}`, startedAt,
  organization: { profileItems: [{ id: person, name: person, status: 'checked', outcome: 'no_change', commitIds: [] }], relationItems: [] },
  tasks: [{ taskId: `task-${id}`, input: { unitId: `profile:${person}` } }], appliedCommands: [{ commitId: `saved-${id}` }], report: { assetEdits: [{ id: person, commitId: `saved-${id}` }] } })
const makeEntry = (id: string, runId: string, person: string, type = 'request_trace', extra: Row = {}): Row => ({ id, bookId: 'sample', runId, sessionId: `s-${runId}`, unitId: `profile:${person}`, type, final: true, complete: true, ...extra })

test('opt10：历史已经清理后完成一个人物，计量真实历史读取范围并核对保留规则', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'westworld-opt10-'))
  const store = createLocalStorageServer(directory, { protect: value => Buffer.from(value).toString('base64'), unprotect: value => Buffer.from(value, 'base64').toString() })
  let collecting = false
  const reads: { table: string; action: string; query: unknown; rows: number; bytes: number; sessionIds: string[]; runIds: string[] }[] = []
  const call: StorageCall = async body => {
    const result = await store.execute(body)
    if (collecting && ['query', 'get'].includes(String(body.action))) {
      const records = (Array.isArray(result) ? result : result ? [result] : []) as { value?: Row }[]
      const rows = records.map(row => row.value ?? {})
      reads.push({ table: String(body.table), action: String(body.action), query: body.query ?? body.key, rows: rows.length, bytes: Buffer.byteLength(JSON.stringify(result ?? null)),
        sessionIds: [...new Set(rows.map(row => String(row.sessionId ?? (body.table === 'storySessions' ? row.id : ''))).filter(Boolean))], runIds: [...new Set(rows.map(row => String(row.runId ?? (body.table === 'pipelineRuns' ? row.id : ''))).filter(Boolean))] })
    }
    return structuredClone(result) as never
  }
  const workspace = createWorkspace({ settingsName: 'opt10', bookPrefix: 'opt10-' }, call)
  try {
    const db = workspace.openBook('sample'), people = 40, rounds = 3
    await workspace.settings.books.put({ id: 'sample', title: '人物历史读取样本', sourceFileName: 'fixture.txt', createdAt: '2026-11-19T00:00:00.000Z' })
    const runs: Row[] = [], sessions: Row[] = [], entries: Row[] = []
    for (let round = 0; round < rounds; round++) for (let person = 0; person < people; person++) {
      const id = `r${round}-${personId(person)}`
      runs.push(makeRun(id, personId(person), `2026-11-${10 + round}T00:00:00.000Z`))
      sessions.push({ id: `s-${id}`, bookId: 'sample', leafId: `message-${id}`, nextOrdinal: 3 })
      entries.push(makeEntry(`trace-${id}`, id, personId(person)), makeEntry(`message-${id}`, id, personId(person), 'message', { parentId: null, message: { role: 'user', content: `第${round}轮人物${person}的完整整理输入` } }))
    }
    const oldRunId = 'r2-P000', oldSessionId = `s-${oldRunId}`, activeSessionId = 's-r1-P001'
    entries.push(
      makeEntry('kept-root', oldRunId, 'P000', 'message', { unitId: 'directory:scan:0', parentId: null }),
      makeEntry('shared-snapshot', oldRunId, 'P000', 'prompt_snapshot', { snapshotId: 'shared-snapshot', content: '两个步骤共用的提示词' }),
      makeEntry('kept-relations', oldRunId, 'P000', 'request_trace', { unitId: 'relations:P000', input: { systemPromptSnapshotId: 'shared-snapshot' } }),
      makeEntry('kept-child', oldRunId, 'P000', 'message', { unitId: 'relations:P000', parentId: `message-${oldRunId}` }),
    )
    entries.find(row => row.id === `message-${oldRunId}`)!.parentId = 'kept-root'
    sessions.find(row => row.id === activeSessionId)!.leaseOwner = 'active-owner'
    sessions.find(row => row.id === activeSessionId)!.leaseUntil = Date.now() + 60000
    runs.push(makeRun('unfinished-detail', 'P002', '2026-11-13T00:00:00.000Z'))
    sessions.push({ id: 's-unfinished-detail', bookId: 'sample' })
    entries.push(makeEntry('unflushed-request', 'unfinished-detail', 'P002', 'request_trace', { final: false }))
    entries.push({ id: 'p3-keep', bookId: 'sample', sessionId: 'p3-session', runId: 'p3', type: 'message', unitId: 'profile:P000', content: 'P3链路保留' })
    await db.table('pipelineRuns').bulkPut(runs)
    await db.table('storySessions').bulkPut(sessions)
    await db.table('storySessionEntries').bulkPut(entries)
    // 模拟较早完成时已经执行过维护，测量后续单个人物完成的正常路径。
    await prune(workspace, 'sample')
    const activeBefore = await db.table('storySessionEntries').where('sessionId').equals(activeSessionId).toArray()
    expect(activeBefore).toHaveLength(2)
    expect(await db.table('storySessionEntries').get('trace-r2-P002')).toBeDefined()
    const othersBefore = (await db.table('storySessionEntries').toArray()).filter(row => row.sessionId !== oldSessionId)
    const target = makeRun('new-P000', 'P000', '2026-11-14T00:00:00.000Z')
    await db.table('pipelineRuns').put(target)
    await db.table('storySessions').put({ id: target.sessionId, bookId: 'sample', leafId: 'new-message', nextOrdinal: 3 })
    const newEntries = [makeEntry('new-trace', String(target.id), 'P000'), makeEntry('new-message', String(target.id), 'P000', 'message')]
    await db.table('storySessionEntries').bulkPut(newEntries)
    collecting = true
    const start = performance.now()
    await prune(workspace, 'sample', { runId: String(target.id), step: 'profiles', characterId: 'P000' })
    const elapsedMs = performance.now() - start
    collecting = false

    expect(await db.table('storySessionEntries').get(`trace-${oldRunId}`)).toBeUndefined()
    expect(await db.table('storySessionEntries').get(`message-${oldRunId}`)).toBeUndefined()
    expect(await db.table('storySessionEntries').get('shared-snapshot')).toBeDefined()
    expect(await db.table('storySessionEntries').get('kept-child')).toMatchObject({ parentId: 'kept-root' })
    expect(await db.table('storySessions').get(oldSessionId)).toMatchObject({ leafId: 'kept-root' })
    expect(await db.table('storySessionEntries').get('p3-keep')).toBeDefined()
    expect(await db.table('storySessionEntries').where('sessionId').equals(activeSessionId).toArray()).toEqual(activeBefore)
    expect(await db.table('pipelineRuns').get(oldRunId)).toEqual(runs.find(row => row.id === oldRunId))
    expect((await db.table('storySessionEntries').toArray()).filter(row => row.sessionId !== oldSessionId).sort((a, b) => String(a.id).localeCompare(String(b.id)))).toEqual([...othersBefore, ...newEntries].sort((a, b) => String(a.id).localeCompare(String(b.id))))
    const summarize = (table: string) => {
      const selected = reads.filter(row => row.table === table)
      return { requests: selected.length, returnedRows: selected.reduce((sum, row) => sum + row.rows, 0), returnedBytes: selected.reduce((sum, row) => sum + row.bytes, 0),
        sessionsRead: [...new Set(selected.flatMap(row => row.sessionIds))].length, runsRead: [...new Set(selected.flatMap(row => row.runIds))].length,
        emptyReads: selected.filter(row => !row.rows).length }
    }
    const result = { fixture: '真实本机存储适配器和SQLite临时目录；40人物、3轮，先完成全量维护，再新增P000完成记录', people, historyRounds: rounds, pipelineRuns: runs.length + 1, completedNow: 1,
      pipelineRunReads: summarize('pipelineRuns'), sessionReads: summarize('storySessions'), entryReads: summarize('storySessionEntries'),
      totalReadRequests: reads.length, totalReadBytes: reads.reduce((sum, row) => sum + row.bytes, 0), elapsedMs: +elapsedMs.toFixed(2),
      preserved: { unrelatedPeople: true, activeSession: true, partialNewDetailAndOldCompleteDetail: true, sharedSnapshot: true, parentChain: true, sessionLeaf: true, businessReceipts: true, p3: true },
    }
    if (process.env.WW_OPT10_EXPECT !== 'before') {
      expect(result.totalReadRequests).toBeLessThanOrEqual(6)
      expect(result.entryReads.sessionsRead).toBe(2)
      expect(result.pipelineRunReads.returnedRows).toBe(3)
    }
    if (process.env.WW_OPT10_RESULT) writeFileSync(process.env.WW_OPT10_RESULT, JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify(result))
  } finally {
    collecting = false
    workspace.close(); await store.close()
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('westworld-opt10-')) throw new Error('临时目录归属不符，停止清理')
    rmSync(directory, { recursive: true, force: true })
  }
}, 60000)
