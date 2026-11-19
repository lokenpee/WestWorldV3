import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { writeFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createAssetService } from '../src/features/assets/service'
import { createModelService } from '../src/features/models/service'
import { defaultConfig } from '../src/features/models/types'
import { createWorldService } from '../src/features/world/service'
import { agentStream } from './support/agent-protocol'

type Kind = 'directory' | 'profile' | 'relations'
type Body = { messages: { role: string; content: unknown }[]; reasoning_effort?: string; thinking?: { type: string } }
const opened: ReturnType<typeof createWorkspace>[] = []
const bodyOf = (init?: RequestInit): Body => JSON.parse(init?.body as string)
const completion = (kind: Kind) => agentStream([{ name: kind === 'directory' ? 'navigate_identity_pages' : kind === 'profile' ? 'submit_profile_review' : 'submit_relation_review', args: kind === 'directory' ? { currentPageId: 'scan:0', direction: 'next' } : kind === 'profile' ? { patch: {}, done: true, reason: '当前人物已整理。' } : { changes: [], done: true, reason: '当前人物关系已整理。' } }])

function assistantStream({ thinking = '', text = '', finish = 'length', calls = [] }: { thinking?: string; text?: string; finish?: string; calls?: { name: string; args: unknown }[] }) {
  const frame = (delta: object, finishReason: string | null) => ({ id: 'thinking-fixture', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-pro', choices: [{ index: 0, delta, finish_reason: finishReason }] })
  const frames = [frame({ role: 'assistant', ...(thinking ? { reasoning_content: thinking } : {}), ...(text ? { content: text } : {}), ...(calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: `fixture-call-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}) }, null), frame({}, finish), { ...frame({}, null), choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }]
  return new Response(frames.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
}

async function setup(fetcher: typeof fetch) {
  const id = crypto.randomUUID(), workspace = createWorkspace({ settingsName: `thinking-${id}`, bookPrefix: `thinking-book-${id}-` })
  opened.push(workspace)
  const now = new Date().toISOString(), db = workspace.openBook('a'), text = '沈青性情沉稳，是青石渡的船夫。'
  await workspace.settings.books.put({ id: 'a', title: '思考截断样本', sourceFileName: 'sample.txt', createdAt: now })
  await db.chapters.put({ bookId: 'a', chapterIndex: '1', chapterName: '第一章', order: 0, charCount: text.length })
  await db.table('chapterTexts').put({ bookId: 'a', chapterIndex: '1', text })
  await db.table('characters').put({ id: 'A', bookId: 'a', name: '沈青', aliases: [], personality: '性情沉稳', confidence: 1, revision: 1, createdBy: 'P1', chapterIndex: '1', chapterName: '第一章' })
  await db.table('extractionReceipts').bulkPut(['worldAssets', 'narrativeAssets'].map(substep => ({ key: `1:${substep}`, bookId: 'a', chapterIndex: '1', substep, inputFingerprint: 'fixture', originIds: [], committedAt: now, runId: 'fixture-extraction' })))
  const models = createModelService(workspace, { fetch: fetcher, wait: async (_ms, signal) => signal.throwIfAborted() })
  await models.settings.save({ ...defaultConfig, baseUrl: 'https://thinking-fixture.invalid/v1', aggregationContextWindow: 65536 }, 'fixture-only')
  const service = createWorldService(workspace, models, createAssetService(workspace), { assetReview: false })
  const wait = () => vi.waitFor(() => expect(service.state('a')?.running).toBe(false), { timeout: 10000 })
  const start = async (kind: Kind) => {
    const runId = kind === 'directory' ? await service.startOrganizationStep('a', 'scan') : await service.startCharacterOrganization('a', 'A', kind)
    await wait()
    return runId
  }
  return { workspace, db, models, service, wait, start }
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const workspace of opened.splice(0)) {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name)
  }
})

it('量化记录：P2三步骤实际档位及连续纯思考截断', async () => {
  const samples = []
  const phase = process.env.OPTIMIZATION_21_PHASE
  const resumedSamples = []
  const singleTruncationSamples = []
  for (const kind of ['directory', 'profile', 'relations'] as const) {
    const bodies: Body[] = []
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(bodyOf(init))
      return bodies.length <= 3 ? assistantStream({ thinking: `固定思考片段${bodies.length}` }) : completion(kind)
    })
    const { start, db, service, wait } = await setup(fetcher)
    const runId = await start(kind), run = await db.table('pipelineRuns').get(runId)
    const entries = await db.table('storySessionEntries').toArray()
    const messages = entries.filter(row => row.type === 'message' && row.message?.role === 'assistant')
    const traces = entries.filter(row => row.type === 'request_trace')
    const thinkingResponses = Math.min(3, bodies.length)
    expect(bodies.length).toBeLessThanOrEqual(4)
    for (let index = 1; index <= thinkingResponses; index++) expect(JSON.stringify(messages)).toContain(`固定思考片段${index}`)
    expect(run.usage).toMatchObject({ input: thinkingResponses * 10, output: thinkingResponses * 20, totalTokens: thinkingResponses * 30 })
    samples.push({ kind, requests: bodies.length, lowRequests: bodies.filter(body => body.reasoning_effort === 'low').length, reasoningEfforts: [...new Set(bodies.map(body => body.reasoning_effort))], thinkingEnabled: bodies.every(body => body.thinking?.type === 'enabled'), runStatus: run.status, activeWorkKind: run.organization.activeWork?.kind ?? null, activeCharacterId: run.organization.activeWork?.characterId ?? null, preservedThinkingMessages: messages.filter(row => row.message.content.some((part: { type: string }) => part.type === 'thinking')).length, traceRequests: traces.length, inputTokens: run.usage.input, outputTokens: run.usage.output, fallbackCompletionRequested: bodies.length === 4, directedContinuationRequests: bodies.filter(body => JSON.stringify(body.messages).includes('上次回复仅返回思考')).length })
    if (phase !== 'before') {
      const beforeResume = bodies.length
      await service.continueOrganization('a'); await wait()
      const resumed = await db.table('pipelineRuns').get(runId)
      expect(resumed.status).toBe('completed')
      expect(resumed.usage).toMatchObject({ input: 30, output: 60, totalTokens: 90 })
      resumedSamples.push({ kind, requestsAfterUserResume: bodies.length - beforeResume, totalRequests: bodies.length, runStatus: resumed.status, inputTokens: resumed.usage.input, outputTokens: resumed.usage.output })
      const singleFetcher = vi.fn<typeof fetch>(async (): Promise<Response> => singleFetcher.mock.calls.length === 1 ? assistantStream({ thinking: '单次截断，随后完成。' }) : completion(kind))
      const single = await setup(singleFetcher), singleRunId = await single.start(kind), singleRun = await single.db.table('pipelineRuns').get(singleRunId)
      expect(singleRun.status).toBe('completed')
      expect(singleFetcher).toHaveBeenCalledTimes(2)
      singleTruncationSamples.push({ kind, requests: singleFetcher.mock.calls.length, runStatus: singleRun.status, inputTokens: singleRun.usage.input, outputTokens: singleRun.usage.output })
    }
  }
  if (phase === 'before' || phase === 'after') writeFileSync(new URL(`../openspec/changes/optimize-pipeline-increments/evidence/21-${phase}.json`, import.meta.url), JSON.stringify({ phase, method: 'fixed HTTP SSE responses with isolated fake-indexeddb; no real model calls', fixture: 'three thinking-only length replies, then a completion tool if requested; 10 input / 20 output tokens per thinking reply', samples, ...(phase === 'after' ? { resumedSamples, singleTruncationSamples, interpretation: 'Automatic request counts verify the pause threshold, not equal-outcome model cost or quality. User resume completes the same fixture in four total requests.' } : {}) }, null, 2) + '\n')
  if (phase !== 'before') {
    expect(samples.every(sample => sample.requests === 2 && sample.lowRequests === 2 && sample.runStatus === 'paused' && !sample.fallbackCompletionRequested)).toBe(true)
    expect(samples.every(sample => sample.directedContinuationRequests === 1)).toBe(true)
  }
}, 30000)

it.each(['profile', 'relations'] as const)('%s截断暂停保留当前人物，继续不跳到其他人物', async kind => {
  let blocked = true
  const fetcher = vi.fn<typeof fetch>(async () => blocked ? assistantStream({ thinking: '尚未输出行动。' }) : completion(kind))
  const { start, db, service, wait } = await setup(fetcher)
  await db.table('characters').put({ id: 'B', bookId: 'a', name: '另一人物', aliases: [], confidence: 1, revision: 1, createdBy: 'P1' })
  const runId = await start(kind), paused = await db.table('pipelineRuns').get(runId)
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(paused.status).toBe('paused')
  expect(paused.organization.activeWork).toMatchObject({ kind, characterId: 'A', status: 'error' })
  expect(paused.organization.pauseNotice).toContain('THINKING_TRUNCATED:')
  expect(paused.organization[kind === 'profile' ? 'profileItems' : 'relationItems'][0]).toMatchObject({ id: 'A', status: 'pending' })
  blocked = false
  await service.continueCharacterOrganization('a', 'A'); await wait()
  const completed = await db.table('pipelineRuns').get(runId)
  expect(completed.status).toBe('completed')
  expect(fetcher).toHaveBeenCalledTimes(3)
  expect(completed.organization[kind === 'profile' ? 'profileItems' : 'relationItems'].find((row: { id: string }) => row.id === 'A')).toMatchObject({ status: 'checked' })
  expect((await db.table('characters').get('B')).revision).toBe(1)
})

it('成功查询后允许新的单次截断恢复，普通说明不会清除未进展计数', async () => {
  for (const successfulQuery of [true, false]) {
    const fetcher = vi.fn<typeof fetch>(async (): Promise<Response> => {
      const call = fetcher.mock.calls.length
      if (call === 1 || call === 3) return assistantStream({ thinking: `截断${call}` })
      if (call === 2) return successfulQuery ? agentStream([{ name: 'query_character_profile', args: {} }]) : assistantStream({ text: '继续核对当前人物。', finish: 'stop' })
      return completion('profile')
    })
    const { start, db } = await setup(fetcher), runId = await start('profile'), run = await db.table('pipelineRuns').get(runId)
    expect(fetcher).toHaveBeenCalledTimes(successfulQuery ? 4 : 3)
    expect(run.status).toBe(successfulQuery ? 'completed' : 'paused')
    expect(JSON.stringify(await db.table('storySessionEntries').toArray())).toContain('截断3')
  }
})

it('失败工具不会重置纯思考截断计数', async () => {
  const fetcher = vi.fn<typeof fetch>(async (): Promise<Response> => fetcher.mock.calls.length === 2
    ? agentStream([{ name: 'unavailable_tool', args: {} }])
    : assistantStream({ thinking: '无成功行动的思考。' }))
  const { start, db } = await setup(fetcher), runId = await start('profile'), run = await db.table('pipelineRuns').get(runId)
  expect(fetcher).toHaveBeenCalledTimes(3)
  expect(run.organization.pauseNotice).toContain('THINKING_TRUNCATED:')
  expect(run.organization.activeWork.characterId).toBe('A')
})

it.each([
  { name: '有正文的length', reply: { text: '已有可见结论，继续整理。', finish: 'length' } },
  { name: '思考和正文同时length', reply: { thinking: '分析过程。', text: '已有可见结论。', finish: 'length' } },
  { name: '思考正常stop', reply: { thinking: '正常分析片段。', finish: 'stop' } },
  { name: '空回复length', reply: { finish: 'length' } },
])('$name不套用纯思考截断次数', async ({ reply }) => {
  const fetcher = vi.fn<typeof fetch>(async (): Promise<Response> => fetcher.mock.calls.length <= 3 ? assistantStream(reply) : completion('profile'))
  const { start, db } = await setup(fetcher), runId = await start('profile'), run = await db.table('pipelineRuns').get(runId)
  expect(fetcher).toHaveBeenCalledTimes(4)
  expect(run.status).toBe('completed')
  expect(JSON.stringify(run.tasks)).not.toContain('THINKING_TRUNCATED:')
})

it('含工具的length保持SDK截断错误，不能执行其写入', async () => {
  const fetcher = vi.fn<typeof fetch>(async (): Promise<Response> => fetcher.mock.calls.length === 1
    ? assistantStream({ thinking: '分析完成，准备修改。', calls: [{ name: 'submit_profile_review', args: { patch: { personality: '被截断的修改' }, done: true, reason: '不能执行' } }] })
    : completion('profile'))
  const { start, db } = await setup(fetcher), runId = await start('profile'), run = await db.table('pipelineRuns').get(runId)
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(run.status).toBe('completed')
  expect((await db.table('characters').get('A')).personality).toBe('性情沉稳')
  expect(JSON.stringify(run.tasks)).not.toContain('THINKING_TRUNCATED:')
  expect(bodyOf(fetcher.mock.calls[1][1]).messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('truncated'))).toBe(true)
})

it('已提交修改与原文次数在截断暂停和继续后保留', async () => {
  let resumed = false
  const fetcher = vi.fn<typeof fetch>(async (_url, init): Promise<Response> => {
    const call = fetcher.mock.calls.length
    if (call === 1 || resumed && call === 5) return agentStream([{ name: 'read_original', args: { chapter_indices: ['1'] } }])
    if (call === 2) return agentStream([{ name: 'submit_profile_review', args: { patch: { personality: '沉稳果断' }, done: false, reason: '先保存已确定部分。' } }])
    if (!resumed) return assistantStream({ thinking: `提交后的思考${call}` })
    const results = bodyOf(init).messages.filter(message => message.role === 'tool').map(message => JSON.parse(String(message.content)))
    expect(results.at(-1)).toMatchObject({ readLimitReached: true })
    return completion('profile')
  })
  const { start, db, service, wait } = await setup(fetcher), runId = await start('profile'), paused = await db.table('pipelineRuns').get(runId)
  expect(fetcher).toHaveBeenCalledTimes(4)
  expect(paused.status).toBe('paused')
  expect(paused.organization.activeWork.characterId).toBe('A')
  const partialCommit = paused.appliedCommands.find((command: { result?: { changed?: boolean } }) => command.result?.changed)
  expect(partialCommit).toBeDefined()
  const changed = await db.table('characters').get('A')
  expect(changed.personality).toBe('沉稳果断')
  resumed = true
  await service.continueCharacterOrganization('a', 'A'); await wait()
  const completed = await db.table('pipelineRuns').get(runId)
  expect(completed.status).toBe('completed')
  expect(fetcher).toHaveBeenCalledTimes(6)
  expect((await db.table('characters').get('A')).revision).toBe(changed.revision)
  expect(completed.appliedCommands.filter((command: { result?: { changed?: boolean } }) => command.result?.changed)).toHaveLength(1)
  expect(completed.appliedCommands.some((command: { commitId: string }) => command.commitId === partialCommit.commitId)).toBe(true)
  const entries = JSON.stringify(await db.table('storySessionEntries').toArray())
  expect(entries).toContain('提交后的思考3')
  expect(entries).toContain('提交后的思考4')
  expect(completed.usage).toMatchObject({ input: 20, output: 40, totalTokens: 60 })
})
