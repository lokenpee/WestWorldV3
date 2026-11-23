import 'fake-indexeddb/auto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { expect, it } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createModelService } from '../src/features/models/service'
import { defaultConfig } from '../src/features/models/types'
import { createStoryService } from '../src/features/story/service'
import { readStoryExecution } from '../src/features/story/execution'
import { executionStats } from '../src/features/agents/executionStats'
import type { Row } from '../src/features/agents/repository'

// 显式指定只含 P1 输入的副本。每次在进程内的隔离书库从空大纲启动。
type Directory = Awaited<ReturnType<typeof import('../src/features/story/reviewDirectory').storyDirectory>>
function evaluate(directory: Directory, nodes: Row[]) {
  const names = new Map(nodes.map(node => [node.id, String(node.name)]))
  if (!names.get('C21-N001')?.includes('《三国演义》') || !names.get('C13-N001')?.includes('蔡权')) return []
  const rules = JSON.parse(readFileSync('tests/fixtures/p3-归类判例.json', 'utf8')) as { level: string; nodes: string[]; expected: boolean; reason: string }[]
  if (!rules.every(rule => rule.nodes.every(id => names.has(id)))) return []
  const events = new Map(directory.events.map(event => [event.id, event.nodeIds]))
  const lines = directory.lines.map(line => new Set(line.eventIds.flatMap(id => events.get(id) ?? [])))
  return rules.map(rule => {
    const same = rule.level === '同线' ? lines.some(line => rule.nodes.every(id => line.has(id)))
      : directory.events.some(event => rule.nodes.every(id => event.nodeIds.includes(id)))
    return { ...rule, passed: same === rule.expected }
  })
}

const fixture = process.env.P3_EVALUATION_FIXTURE
it.skipIf(!fixture)('真实模型按阶段保存目录、请求统计与完成情况', async () => {
  const source = JSON.parse(readFileSync(fixture!, 'utf8')) as { tables: Record<string, Row[]> }
  const label = basename(fixture!, '.json')
  const id = String(source.tables.nodes[0].bookId)
  const uid = crypto.randomUUID()
  const workspace = createWorkspace({ settingsName: 'evaluation-' + uid, bookPrefix: uid + '-' })
  try {
    const now = new Date().toISOString()
    await workspace.settings.books.put({ id, title: label, sourceFileName: label + '.txt', createdAt: now })
    const db = workspace.openBook(id)
    for (const name of ['chapters', 'chapterTexts', 'nodes', 'extractionReceipts']) {
      const rows = source.tables[name].map(row => name === 'nodes' ? { ...row, eventLineIds: [] } : row)
      await db.table(name).bulkPut(rows)
    }
    const key = process.env.WESTWORLD_TEST_API_KEY
    if (!key) throw new Error('缺少评测密钥')
    const models = createModelService(workspace)
    const model = process.env.WESTWORLD_TEST_MODEL ?? defaultConfig.aggregationModel
    await models.settings.save({ ...defaultConfig, aggregationModel: model, aggregationContextWindow: 65536 }, key)
    const service = createStoryService(workspace, models)
    mkdirSync('test-results', { recursive: true })
    for (const phase of ['window_link', 'global_review'] as const) {
      const start = Date.now()
      const runPhase = () => phase === 'window_link' ? service.start(id) : service.review(id)
      await runPhase()
      // 保留同一会话和已提交的页，和界面上的“继续”走相同入口。
      const interruptions: string[] = []
      for (let retry = 0; retry < 2 && service.state(id)?.error; retry++) {
        const error = String(service.state(id)?.error)
        if (!/SUMMARY_TOO_LONG|超时|连接中断/.test(error)) break
        interruptions.push(error)
        await runPhase()
      }
      const elapsedMs = Date.now() - start
      const progress = await db.table('compileProgress').get('P3')
      const run = await db.table('pipelineRuns').get(progress.runId)
      const execution = await readStoryExecution(workspace, id, phase)
      const error = service.state(id)?.error
      const result = { model, phase, elapsedMs, interruptions, status: progress.status, error,
        stats: executionStats(execution?.chain.requests ?? []), directory: run.stageDirectories?.[phase],
        currentPageId: run.storyReading?.[phase]?.currentPageId,
        remainingPages: run.storyReading?.[phase]?.pages?.filter((page: Row) => page.checkedFingerprint !== page.fingerprint).length,
        descriptions: await Promise.all(['eventLines', 'storyEvents'].map(async name => (await db.table(name).toArray()).map(row => ({ id: row.id, title: row.title, summary: row.summary, coreClue: row.coreClue })))) }
      const cases = result.directory ? evaluate(result.directory, source.tables.nodes) : []
      writeFileSync('test-results/' + label + '-' + phase + '.json', JSON.stringify({ ...result, cases }, null, 2))
      expect(error).toBeUndefined()
      expect(progress.status).toBe('completed')
      if (phase === 'global_review' && cases.length) expect(cases.filter(item => !item.passed).map(item => item.reason)).toEqual([])
    }
  } finally { workspace.close() }
}, 3600000)
