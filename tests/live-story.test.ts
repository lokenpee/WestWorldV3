import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { afterEach, it } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createModelService } from '../src/features/models/service'
import { createStoryService } from '../src/features/story/service'
import { defaultConfig } from '../src/features/models/types'

const opened: ReturnType<typeof createWorkspace>[] = []
const key = (() => {
  if (process.env.WESTWORLD_TEST_API_KEY) return process.env.WESTWORLD_TEST_API_KEY
  try {
    const file = readFileSync('.env.local', 'utf8')
    return file.split(/\r?\n/).find(line => line.startsWith('WESTWORLD_TEST_API_KEY='))?.slice('WESTWORLD_TEST_API_KEY='.length) ?? ''
  } catch { return '' }
})()
afterEach(async () => { for (const workspace of opened.splice(0)) { workspace.close(); for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name) } })

it.skipIf(!key)('真实 P3：小窗口串联产生请求轨迹、工具结果和检查点', async () => {
  const id = crypto.randomUUID(), workspace = createWorkspace({ settingsName: `live-story-${id}`, bookPrefix: `live-story-${id}-` }); opened.push(workspace)
  const book = { id: 'a', title: '真实叙事样本', sourceFileName: 'live-story.txt', createdAt: new Date().toISOString() }
  await workspace.settings.books.put(book)
  const db = workspace.openBook('a')
  const text = '同一封信从京城送到江南，收信人读完后回信。'
  await db.chapters.bulkPut([1, 2].map((index, order) => ({ bookId: 'a', chapterIndex: String(index), chapterName: `第${index}章`, order, charCount: text.length })))
  await db.table('chapterTexts').bulkPut([1, 2].map(index => ({ bookId: 'a', chapterIndex: String(index), text })))
  await db.table('extractionReceipts').bulkPut([1, 2].flatMap(index => ['worldAssets', 'narrativeAssets'].map(substep => ({ key: `${index}:${substep}`, bookId: 'a', chapterIndex: String(index), substep, inputFingerprint: 'fixture', originIds: [], committedAt: book.createdAt, runId: 'extract-fixture' }))))
  await db.table('nodes').bulkPut([1, 2].map((index, order) => ({ id: `C${index}-N001`, bookId: 'a', name: index === 1 ? '寄出信件' : '读信回信', summary: index === 1 ? '信件从京城寄出' : '收信人读信并回信', actors: [], quote: text, offset: 0, confidence: 1, revision: 1, createdBy: 'P1', chapterIndex: String(index), chapterName: `第${index}章`, order, eventLineIds: [] })))
  const models = createModelService(workspace, { fetch: globalThis.fetch.bind(globalThis), wait: async (ms, signal) => new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); const abort = () => { clearTimeout(timer); reject(signal.reason) }; signal.addEventListener('abort', abort, { once: true }) }) })
  await models.settings.save({ ...defaultConfig, providerId: process.env.WESTWORLD_TEST_PROVIDER ?? 'deepseek', baseUrl: process.env.WESTWORLD_TEST_BASE_URL ?? defaultConfig.baseUrl, aggregationModel: process.env.WESTWORLD_TEST_MODEL ?? 'deepseek-flash', aggregationContextWindow: 65536 }, key)
  const service = createStoryService(workspace, models)
  let started = false
  const finished = new Promise<void>(resolve => {
    service.subscribe(() => {
      const state = service.state('a')
      if (state?.running) started = true
      if (started && !state?.running) resolve()
    })
  })
  await service.start('a')
  await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error('P3 验证超时。')), 180000))])
  const read = await service.read('a')
  const entries = await db.table('storySessionEntries').toArray()
  const traces = entries.filter(row => row.type === 'request_trace' && typeof row.requestId === 'string')
  const snapshots = entries.filter(row => row.type === 'prompt_snapshot' || row.type === 'tool_snapshot')
  const evidence = {
    book: book.title, status: read.progress?.status, phase: read.progress?.phase, error: service.state('a')?.error,
    windows: read.completed, checkpoints: read.checkpoints.length, tasks: read.tasks.length,
    requests: traces.map(row => ({ requestId: row.requestId, executionId: row.executionId, purpose: row.purpose, status: row.status, final: row.final, complete: row.complete, tools: Array.isArray(row.toolCalls) ? row.toolCalls.map((tool: Record<string, unknown>) => tool.name) : [], usage: row.usage })),
    snapshots: snapshots.map(row => ({ type: row.type, snapshotId: row.snapshotId, length: String(row.content ?? '').length || (Array.isArray(row.schema) ? row.schema.length : 0) })),
    commits: read.commits.length, usage: read.usage,
  }
  mkdirSync('test-results', { recursive: true })
  writeFileSync('test-results/live-story.json', JSON.stringify(evidence, null, 2))
  if (!read.progress || read.progress.validity === 'stale' && read.progress.status !== 'completed') throw new Error(`P3 未完成：${service.state('a')?.error ?? read.progress?.status ?? '无进度'}`)
  if (!traces.length) throw new Error('P3 没有保存请求轨迹。')
  if (traces.some(row => !row.executionId || !row.requestId || !row.input)) throw new Error('P3 请求轨迹缺少执行号或输入。')
  if (!snapshots.length) throw new Error('P3 没有保存提示词或工具快照。')
}, 240000)
