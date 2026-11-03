import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createImportService } from '../src/lib/storage/importService'
import { DEFAULT_CHAPTER_PATTERN, splitChapters } from '../src/features/import/text'
import { createBackupService } from '../src/features/backup/service'
import { createModelService } from '../src/features/models/service'
import { defaultConfig } from '../src/features/models/types'
import { createAssetService } from '../src/features/assets/service'
import { createExtractionService } from '../src/features/extraction/service'
import { createWorldService } from '../src/features/world/service'
import { createStoryService } from '../src/features/story/service'
import { hash } from '../src/features/agents/contracts'
import { emptyTables, type BookData } from '../src/features/backup/data'
import { restoredTables } from '../src/features/backup/codec'
import { coverageFingerprint, identityWorkId, saveIdentityQueue } from '../src/features/world/queue'
import { createMemoryAgentRepository } from '../src/features/agents/repository'
import { agentStream } from './support/agent-protocol'
import { storyResponse } from './support/story-protocol'

const opened: ReturnType<typeof createWorkspace>[] = [], importers: ReturnType<typeof createImportService>[] = []
afterEach(async () => { importers.splice(0).forEach(value => value.close()); for (const workspace of opened.splice(0)) { workspace.close(); for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name) } })

it('当前格式全流程备份恢复保留有效P2待办、P3完成状态和原始会话', async () => {
  let finishWorld = false
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string)
    if (body.tools.length === 1) {
      if (body.tools[0].function.parameters.properties.characters) return agentStream([{ name: 'submit_result', args: { characters: [{ name: '沈青', confidence: 1 }, { name: '顾衡', confidence: 1 }], locations: [] } }])
      return agentStream([{ name: 'submit_result', args: { nodes: [{ name: '收信', summary: '沈青收到信', actors: ['沈青'], quote: '沈青收到信。', confidence: 1 }, { name: '转交信', summary: '沈青转交信', actors: ['沈青'], quote: '沈青转交信。', confidence: 1 }] } }])
    }
    if (body.tools.some((tool: { function: { name: string } }) => tool.function.name === 'get_editor_memory')) return storyResponse(body)
    const users = body.messages.filter((row: { role: string }) => row.role === 'user').map((row: { content: string | { text: string }[] }) => typeof row.content === 'string' ? row.content : row.content.map(part => part.text).join(''))
    const input = JSON.parse(users.find((value: string) => value.startsWith('{'))!)
    if (!finishWorld && input.workItems[0].id === 'C1-P002') return agentStream([{ name: 'submit_result', args: { status: 'partial', commitIds: [], summary: '待核实', reviewedItems: [], remainingWorkIds: [input.workItems[0].workItemId] } }])
    if (!body.messages.some((row: { role: string }) => row.role === 'tool')) return agentStream([{ name: 'get_character_detail', args: { ids: input.workItems.map((item: { id: string }) => item.id) } }])
    return agentStream([{ name: 'submit_result', args: { status: 'completed', commitIds: [], summary: '核实完成', remainingWorkIds: [], reviewedItems: input.workItems.map((item: { workItemId: string }) => ({ workItemId: item.workItemId, outcome: 'no_change', reason: '独立人物' })) } }])
  })
  const key = crypto.randomUUID(), workspace = createWorkspace({ settingsName: `restore-proof-${key}`, bookPrefix: `restore-proof-${key}-book-` }); opened.push(workspace)
  const importer = createImportService(workspace); importers.push(importer)
  const source = '第一章 书信\n沈青收到信。沈青转交信。'
  const book = await importer.importNovel({ fileName: '书信.txt', text: source, byteLength: new TextEncoder().encode(source).length, encoding: 'UTF-8', pattern: DEFAULT_CHAPTER_PATTERN, chapters: splitChapters(source, DEFAULT_CHAPTER_PATTERN) })
  const models = createModelService(workspace, { fetch: fetcher })
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://restore-proof.invalid/v1', aggregationContextWindow: 65536 }, 'fake-key')
  const assets = createAssetService(workspace), extraction = createExtractionService(workspace, models), world = createWorldService(workspace, models, assets, { assetReview: false }), story = createStoryService(workspace, models)
  await extraction.start(book.id)
  const person = (await assets.read(book.id)).characters.find(row => row.id === 'C1-P001')!
  await assets.update(book.id, 'character', person.id, person.revision, { background: '人工补充保留' })
  await world.start(book.id); await story.start(book.id); await story.review(book.id)
  expect(world.state(book.id)?.error).toBeUndefined(); expect(story.state(book.id)?.error).toBeUndefined()
  expect((await world.reports(book.id))[0].coverage?.checked).toBe(1)
  expect((await story.read(book.id)).review.pending).toBe(0)
  const db = workspace.openBook(book.id)
  const originalMessages = JSON.parse(JSON.stringify((await db.table('storySessionEntries').toArray()).filter(row => row.type === 'message').map(row => row.message)))
  const originalRuns = await db.table('pipelineRuns').toArray()
  const backups = createBackupService(workspace, importer)
  const exported = await backups.exportBook(book.id)
  const restored = await backups.importBackup(exported.bytes)
  const copy = workspace.openBook(restored.id)
  expect((await copy.table('chapterTexts').toArray()).map(row => row.text).join('')).toBe(source)
  expect((await assets.read(restored.id)).characters.find(row => row.id === person.id)?.background).toBe('人工补充保留')
  expect((await copy.table('storySessionEntries').toArray()).filter(row => row.type === 'message').map(row => row.message)).toEqual(originalMessages)
  const runs = await copy.table('pipelineRuns').toArray()
  expect(runs.find(row => row.stage === 'P1').tasks.map((task: { inputFingerprint: string }) => task.inputFingerprint)).toEqual(originalRuns.find(row => row.stage === 'P1').tasks.map((task: { inputFingerprint: string }) => task.inputFingerprint))
  for (const run of runs.filter(row => row.stage !== 'P1')) for (const task of run.tasks ?? []) expect(task.inputFingerprint).toBe(await hash(task.input))
  const restoredStory = createStoryService(workspace, models)
  expect((await restoredStory.read(restored.id)).completed).toBe(1)
  const calls = fetcher.mock.calls.length
  await createExtractionService(workspace, models).start(restored.id)
  expect(fetcher).toHaveBeenCalledTimes(calls)
  await restoredStory.review(restored.id)
  expect(restoredStory.state(restored.id)?.error).toBeUndefined()
  expect(fetcher).toHaveBeenCalledTimes(calls)
  finishWorld = true
  await createWorldService(workspace, models, assets, { assetReview: false }).start(restored.id)
  expect(fetcher.mock.calls.length - calls).toBe(2)
  expect(await copy.table('eventLines').count()).toBe(1)
  expect((await backups.inspectBackup((await backups.exportBook(restored.id)).bytes)).ok).toBe(true)
  expect(await db.table('pipelineRuns').toArray()).toEqual(originalRuns)
}, 30000)

it('恢复只转换有效证明，已经失效的结论仍保留待核实', async () => {
  const data: BookData = { book: { id: 'old', title: '原书', sourceFileName: 'a.txt', createdAt: new Date().toISOString() }, tables: emptyTables() }
  data.tables.chapters = [{ bookId: 'old', chapterIndex: '1', chapterName: '第一章', order: 0, charCount: 2 }]
  data.tables.chapterTexts = [{ bookId: 'old', chapterIndex: '1', text: '原文' }]
  const valid = { id: 'A', bookId: 'old', name: '沈青', revision: 1 }, changed = { id: 'B', bookId: 'old', name: '实际新名', revision: 2 }
  data.tables.characters = [valid, changed]
  data.tables.pipelineRuns = [{ id: 'run', bookId: 'old', recordType: 'run', coverageItems: [
    { workItemId: identityWorkId('character', 'A'), kind: 'character', id: 'A', status: 'checked', coveredFingerprint: await coverageFingerprint('characters', valid), dependencies: { records: [], queries: [] } },
    { workItemId: identityWorkId('character', 'B'), kind: 'character', id: 'B', status: 'checked', coveredFingerprint: await coverageFingerprint('characters', { ...changed, name: '过去旧名' }), dependencies: { records: [], queries: [] } },
  ] }]
  const before = structuredClone(data)
  const tables = await restoredTables(data, 'new')
  const repo = createMemoryAgentRepository('new', tables)
  const queue = await saveIdentityQueue(repo, 'run')
  expect(queue.items.find(item => item.id === 'A')?.status).toBe('checked')
  expect(queue.items.find(item => item.id === 'B')?.status).toBe('pending')
  expect(data).toEqual(before)
})
