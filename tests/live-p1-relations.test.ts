import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { afterEach, it } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createModelService } from '../src/features/models/service'
import { createExtractionService } from '../src/features/extraction/service'
import { defaultConfig } from '../src/features/models/types'
import { DEFAULT_CHAPTER_PATTERN, splitChapters } from '../src/features/import/text'

const opened: ReturnType<typeof createWorkspace>[] = []
const key = (() => {
  if (process.env.WESTWORLD_TEST_API_KEY) return process.env.WESTWORLD_TEST_API_KEY
  try {
    const file = readFileSync('.env.local', 'utf8')
    return file.split(/\r?\n/).find(line => line.startsWith('WESTWORLD_TEST_API_KEY='))?.slice('WESTWORLD_TEST_API_KEY='.length) ?? ''
  } catch { return '' }
})()
afterEach(async () => { for (const workspace of opened.splice(0)) { workspace.close(); for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name) } })

it.skipIf(!key)('真实 P1 小样本：关系存在性、未知关系和传闻保留', async () => {
  const source = readFileSync('tests/fixtures/红楼之挽天-三河帮.txt', 'utf8').replace(/\r\n?/g, '\n')
  const chapters = splitChapters(source, DEFAULT_CHAPTER_PATTERN).filter(row => row.chapterIndex !== '0').slice(0, 2)
  const id = crypto.randomUUID(), workspace = createWorkspace({ settingsName: `live-p1-${id}`, bookPrefix: `live-p1-${id}-` }); opened.push(workspace)
  const book = { id: 'a', title: 'P1关系小样本', sourceFileName: '红楼之挽天-三河帮.txt', createdAt: new Date().toISOString() }
  await workspace.settings.books.put(book)
  const db = workspace.openBook('a')
  await db.chapters.bulkPut(chapters.map((row, order) => ({ bookId: 'a', chapterIndex: row.chapterIndex, chapterName: row.chapterName, order, charCount: row.text.length })))
  await db.table('chapterTexts').bulkPut(chapters.map(row => ({ bookId: 'a', chapterIndex: row.chapterIndex, text: row.text })))
  await db.table('compileProgress').put({ bookId: 'a', stage: 'P1', status: 'idle', totalChapters: chapters.length, completedChapters: [], failedChapters: [], updatedAt: book.createdAt })
  const models = createModelService(workspace, { fetch: globalThis.fetch.bind(globalThis), wait: async (ms, signal) => new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); const abort = () => { clearTimeout(timer); reject(signal.reason) }; signal.addEventListener('abort', abort, { once: true }) }) })
  await models.settings.save({ ...defaultConfig, providerId: process.env.WESTWORLD_TEST_PROVIDER ?? 'deepseek', baseUrl: process.env.WESTWORLD_TEST_BASE_URL ?? defaultConfig.baseUrl, extractionModel: process.env.WESTWORLD_TEST_MODEL ?? 'deepseek-flash', aggregationModel: process.env.WESTWORLD_TEST_MODEL ?? 'deepseek-flash' }, key)
  const service = createExtractionService(workspace, models)
  let started = false
  const finished = new Promise<void>(resolve => {
    service.subscribe(() => {
      const state = service.state('a')
      if (state?.running) started = true
      if (started && !state?.running) resolve()
    })
  })
  await service.start('a')
  await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error('P1 小样本验证超时。')), 300000))])
  const relations = await db.table('characterRelations').toArray() as Record<string, unknown>[]
  const nodes = await db.table('nodes').toArray() as Record<string, unknown>[]
  const texts = new Map((await db.table('chapterTexts').toArray() as { chapterIndex: string; text: string }[]).map(row => [row.chapterIndex, row.text]))
  const progress = await db.table('compileProgress').get('P1') as Record<string, unknown> | undefined
  const receipts = await db.table('extractionReceipts').toArray() as Record<string, unknown>[]
  const runs = await db.table('pipelineRuns').toArray() as Record<string, unknown>[]
  const evidenceOf = (row: Record<string, unknown>) => (Array.isArray(row.evidence) ? row.evidence[0] : undefined) as { chapterIndex?: string; quote?: string } | undefined
  const unknownPairs = relations.filter(row => String(row.forwardLabel) === '未知' && String(row.reverseLabel) === '未知')
  const evidence = {
    book: book.title,
    chapters: chapters.map(row => ({ index: row.chapterIndex, name: row.chapterName, chars: row.text.length })),
    error: service.state('a')?.error ?? null,
    progress: progress ? { status: progress.status, completedChapters: progress.completedChapters, failedChapters: progress.failedChapters, stepStates: progress.stepStates, usage: progress.usage } : null,
    receipts: receipts.map(row => ({ key: row.key, chapterIndex: row.chapterIndex, substep: row.substep })),
    runs: runs.map(row => ({ id: row.id, recordType: row.recordType, stage: row.stage, status: row.status, error: row.error, tasks: row.tasks, usage: row.usage, report: row.report })),
    relationCount: relations.length,
    unknownUnknown: unknownPairs.length,
    relations: relations.map(row => {
      const item = evidenceOf(row)
      return {
        chapterIndex: item?.chapterIndex ?? '', sourceName: row.sourceName, targetName: row.targetName,
        relationType: row.relationType, forwardLabel: row.forwardLabel, reverseLabel: row.reverseLabel,
        direction: row.direction, quote: item?.quote ?? '',
        quoteInChapter: !!item?.quote && (texts.get(item.chapterIndex ?? '') ?? '').includes(item.quote),
      }
    }),
    narrative: nodes.map(row => ({ chapterIndex: row.chapterIndex, name: row.name, summary: row.summary, process: row.process, newFacts: row.new_facts ?? [], quote: row.quote ?? '' })),
  }
  mkdirSync('test-results', { recursive: true })
  writeFileSync('test-results/live-p1-relations.json', JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ relationCount: evidence.relationCount, unknownUnknown: evidence.unknownUnknown, quoteMatched: evidence.relations.filter(row => row.quoteInChapter).length, error: evidence.error }))
  if (evidence.error) throw new Error(`P1 小样本未完成：${evidence.error}`)
}, 300000)
