import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { createLocalStorageServer } from '../src/features/local-storage/server'
import type { StorageCall } from '../src/features/local-storage/client'
import type { StoredRecord } from '../src/features/local-storage/contracts'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createBookAgentRepository } from '../src/features/agents/repository'
import { createStoryService } from '../src/features/story/service'
import { navigateStoryReading, readingProgress, refreshReading, saveReading } from '../src/features/story/reading'

interface Measurement {
  phase: string
  name: string
  reads: Record<string, number>
  rows: Record<string, number>
  responseBytes: Record<string, number>
  sourceCharacters: number
  checkedPages?: number
  totalPages?: number
}

test('opt11：真实P3进度查询在心跳、元数据和正文变化后的读取量', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'westworld-opt11-'))
  const server = createLocalStorageServer(directory, { protect: value => Buffer.from(value).toString('base64'), unprotect: value => Buffer.from(value, 'base64').toString() })
  let collecting: Measurement | undefined
  let failNextSource = false, observedTraceBodies = 0
  const call: StorageCall = async body => {
    if (failNextSource && body.table === 'chapterTexts' && body.action === 'get') { failNextSource = false; throw new Error('临时正文读取失败') }
    const response = JSON.parse(JSON.stringify(await server.execute(JSON.parse(JSON.stringify(body))) ?? null))
    if (collecting && body.table === 'storySessionEntries' && body.action === 'query') observedTraceBodies += (response as StoredRecord[]).filter(row => row.value.type === 'request_trace').length
    if (collecting && ['nodes', 'eventLines', 'chapterTexts'].includes(String(body.table)) && ['query', 'get'].includes(String(body.action))) {
      const table = String(body.table), metadataOnly = (body.query as { keysOnly?: boolean } | undefined)?.keysOnly === true
      const key = `${table}:${metadataOnly ? 'metadata' : 'content'}`
      const rows = (body.action === 'get' ? response ? [response] : [] : response) as StoredRecord[]
      collecting.reads[key] = (collecting.reads[key] ?? 0) + 1
      collecting.rows[key] = (collecting.rows[key] ?? 0) + rows.length
      collecting.responseBytes[key] = (collecting.responseBytes[key] ?? 0) + Buffer.byteLength(JSON.stringify(response))
      if (table === 'chapterTexts') collecting.sourceCharacters += rows.reduce((sum, row) => sum + String(row.value.text ?? '').length, 0)
    }
    return response
  }
  const workspace = createWorkspace({ settingsName: 'opt11', bookPrefix: 'opt11-' }, call)
  const samples: Measurement[] = []
  try {
    for (const phase of ['window_link', 'global_review'] as const) {
      const bookId = phase, runId = `run-${phase}`, sessionId = `session-${phase}`
      const db = workspace.openBook(bookId), now = '2026-11-19T00:00:00.000Z'
      await workspace.settings.books.put({ id: bookId, title: 'P3状态量化样本', sourceFileName: 'sample.txt', createdAt: now })
      const chapters = Array.from({ length: 25 }, (_, index) => ({ bookId, chapterIndex: String(index + 1), chapterName: `第${index + 1}章`, order: index, charCount: 8000 }))
      await db.chapters.bulkPut(chapters)
      await db.table('chapterTexts').bulkPut(chapters.map(chapter => ({ bookId, chapterIndex: chapter.chapterIndex, text: '信件流转。'.padEnd(8000, '文') })))
      await db.table('extractionReceipts').bulkPut(chapters.flatMap(chapter => ['worldAssets', 'narrativeAssets'].map(substep => ({
        key: `${chapter.chapterIndex}:${substep}`, bookId, chapterIndex: chapter.chapterIndex, substep, originIds: [],
      }))))
      const nodes = chapters.map((chapter, index) => ({
        id: `N${String(index + 1).padStart(3, '0')}`, bookId, name: `信件事件${index + 1}`,
        summary: '信件继续流转', process: '信件在不同人物之间传递。', actors: [], quote: '',
        confidence: 1, revision: 1, createdBy: 'P1', chapterIndex: chapter.chapterIndex, chapterName: chapter.chapterName,
        order: 0, eventLineIds: index < 20 ? [`L${Math.floor(index / 10) + 1}`] : [],
      }))
      await db.table('nodes').bulkPut(nodes)
      await db.table('eventLines').bulkPut([0, 1].map(index => ({ id: `L${index + 1}`, bookId, title: `信件流转${index + 1}`,
        nodeIds: nodes.slice(index * 10, index * 10 + 10).map(node => node.id), summary: '信件线索逐步展开', cause: '', process: '', result: '', lineStatus: 'open', revision: 1 })))
      await db.table('storySessions').put({ id: sessionId, bookId, profile: 'story_editor', status: 'active', nextOrdinal: 0, createdAt: now, updatedAt: now })
      await db.table('pipelineRuns').put({ id: runId, bookId, recordType: 'run', stage: 'P3', phase, status: 'paused', startedAt: now,
        tasks: [], coverageItems: [], commandIntents: [], appliedCommands: [], usage: { totalTokens: 100, cost: 0.001 } })
      await db.table('compileProgress').put({ bookId, stage: 'P3', phase, status: 'paused', runId, editorSessionId: sessionId,
        planKey: 'story-pages-v3', validity: 'current', totalChapters: 25, completedChapters: [], failedChapters: [], updatedAt: now })
      const repo = createBookAgentRepository(workspace, bookId)
      const checkedNode = await repo.transaction(true, async store => {
        const initial = await refreshReading(store, runId, sessionId, phase)
        await saveReading(store, runId, phase, initial)
        const first = initial.pages[0]!
        await navigateStoryReading(store, { bookId, runId, sessionId, phase, taskId: 'seed' }, { direction: 'next', currentPageId: first.id }, 'seed-page')
        return nodes.find(node => node.id === first.ids[0])!
      })
      // read只访问存储；该样本不建立模型服务或网络请求。
      const service = createStoryService(workspace, {} as never)
      await db.table('storySessionEntries').put({ id: 'large-trace', bookId, sessionId, type: 'request_trace', input: { messages: '大段请求'.repeat(10000) } })
      async function measure(name: string) {
        const sample: Measurement = { phase, name, reads: {}, rows: {}, responseBytes: {}, sourceCharacters: 0 }
        collecting = sample
        try {
          const status = await service.read(bookId)
          sample.checkedPages = status.reading?.checked; sample.totalPages = status.reading?.totalPages
          expect(status.covered).toBe(true)
          expect(status.reading).toBeDefined()
          return status
        } finally { collecting = undefined; samples.push(sample) }
      }
      expect((await measure('initial_status')).reading?.checked).toBe(1)
      await db.table('pipelineRuns').put({ id: 'lease:narrative', bookId, recordType: 'lease', lockKey: 'narrative', owner: 'sample', runId, expiresAt: Date.now() + 60_000 })
      expect((await measure('heartbeat_only')).reading?.checked).toBe(1)
      await db.table('nodes').put({ ...checkedNode, revision: checkedNode.revision + 1, updatedAt: now })
      expect((await measure('node_metadata_only')).reading?.checked).toBe(1)
      await db.table('nodes').put({ ...checkedNode, summary: '信件已经丢失，等待追回', revision: checkedNode.revision + 2 })
      expect((await measure('node_content_changed')).reading?.checked).toBe(0)
      await db.table('nodes').put(checkedNode)
      await db.table('chapterTexts').put({ bookId, chapterIndex: checkedNode.chapterIndex, text: '信件丢失。'.padEnd(8000, '文') })
      expect((await measure('source_changed_same_length')).reading?.checked).toBe(0)
      expect(observedTraceBodies).toBe(0)
      if (process.env.WW_OPT11_EXPECT !== 'before') {
        const heartbeat = samples.find(row => row.phase === phase && row.name === 'heartbeat_only')!
        expect(heartbeat.sourceCharacters).toBe(0)
        expect(heartbeat.reads['nodes:content'] ?? 0).toBe(0)
        expect(heartbeat.reads['eventLines:content'] ?? 0).toBe(0)
        expect(samples.find(row => row.phase === phase && row.name === 'source_changed_same_length')!.sourceCharacters).toBe(8000)
      }
      const compareUncached = async () => {
        const expected = await repo.transaction(false, store => refreshReading(store, runId, sessionId, phase))
        const actual = (await service.read(bookId)).reading!
        expect(actual).toMatchObject(readingProgress(expected))
        expect(actual.pages).toEqual(expected.pages.map(page => ({ id: page.id, type: page.type, reason: page.reason, checked: page.fingerprint === page.checkedFingerprint })))
      }
      await db.table('chapterTexts').put({ bookId, chapterIndex: checkedNode.chapterIndex, text: '信件找回。'.padEnd(8000, '文') })
      if (process.env.WW_OPT11_EXPECT !== 'before') {
        failNextSource = true
        await expect(service.read(bookId)).rejects.toThrow('临时正文读取失败')
      }
      await compareUncached()
      await db.table('storyEditorNotes').put({ id: 'note', bookId, sessionId, status: 'active', statement: '信件仍有去向待核查', nodeIds: [checkedNode.id], lineIds: ['L1'], evidence: [], basisFingerprint: '' })
      await compareUncached()
      await db.table('eventLines').update('L1', { nodeIds: [], title: '重新核对信件线' })
      await compareUncached()
      await db.chapters.update('1', { order: 99 })
      await compareUncached()
      await db.table('nodes').delete('N001')
      await compareUncached()
      const other = createWorkspace({ settingsName: 'opt11', bookPrefix: 'opt11-' }, call)
      try {
        await other.openBook(bookId).table('nodes').update('N002', { summary: '其他窗口新增说明' })
        await compareUncached()
        expect((await createStoryService(other, {} as never).read(bookId)).reading).toEqual((await service.read(bookId)).reading)
      } finally { other.close() }
    }
    const result = { optimization: 11, sample: { chapters: 25, sourceCharacters: 200000, nodes: 25, lines: 2, checkedPages: 1 }, measurements: samples }
    if (process.env.WW_OPT11_RESULT) writeFileSync(process.env.WW_OPT11_RESULT, `${JSON.stringify(result, null, 2)}\n`)
    console.log(JSON.stringify(result))
  } finally {
    workspace.close()
    await server.close()
    if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error('临时目录不在预定位置。')
    rmSync(directory, { recursive: true, force: true })
  }
})
