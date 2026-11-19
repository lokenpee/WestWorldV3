import { writeFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { compactSession } from '../src/features/agents/compaction'
import { createMemoryAgentRepository } from '../src/features/agents/repository'
import { estimateTextTokens } from '../src/features/agents/context'
import type { ModelService } from '../src/features/models/service'
import type { Scope } from '../src/features/agents/queries'
import compactPrompt from '../docs/v2/resources/v2.2/prompts/active/compact.md?raw'

test('opt15：真实压缩入口按相同预算保留全部文本并减少多余分块', async () => {
  const measurements = []
  for (const [name, content] of [['ascii', 'x'.repeat(40000)], ['cjk', '汉'.repeat(20000)], ['mixed', '汉字ABCD😀\n'.repeat(5000)]] as const) {
    const scope: Scope = { bookId: 'book', runId: 'run', taskId: 'task', sessionId: 'session', profile: 'story_editor', phase: 'global_review', owner: 'owner', workItemIds: [] }
    const message = { role: 'user', content, timestamp: 1 }
    const repo = createMemoryAgentRepository('book', {
      storySessions: [{ id: 'session', bookId: 'book', leafId: 'entry', nextOrdinal: 2, leaseOwner: 'owner', leaseUntil: Date.now() + 60000 }],
      storySessionEntries: [{ id: 'entry', bookId: 'book', sessionId: 'session', ordinal: 1, type: 'message', message, parentId: null }],
      pipelineRuns: [{ id: 'run', bookId: 'book' }, { id: 'lease:narrative', bookId: 'book', owner: 'owner', runId: 'run', expiresAt: Date.now() + 60000 }],
    })
    const parts: string[] = []
    const generate: ModelService['generate'] = async request => {
      parts.push(String(request.context.messages[0].content).split('【需要压缩的原始会话数据】\n')[1])
      return { ok: true, value: { summary: '固定摘要，保留原始条目entry。' }, text: '', mode: 'direct', attempts: [], elapsedMs: 0, usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, costStatus: 'unknown' } } as never
    }
    const messages = await compactSession(repo, scope, { generate, contextWindow: 8192, prompt: '', force: true })
    const expected = `[原始条目 entry，角色 user]\n${JSON.stringify(message)}`
    expect(parts.join('')).toBe(expected)
    const budget = Math.max(256, Math.floor(8192 * 0.45) - estimateTextTokens(compactPrompt))
    expect(parts.every(part => estimateTextTokens(part) <= budget)).toBe(true)
    expect(parts.every(part => !/[\uD800-\uDBFF]$/.test(part) && !/^[\uDC00-\uDFFF]/.test(part))).toBe(true)
    expect(JSON.stringify(messages)).toContain('固定摘要')
    expect((await repo.transaction(false, store => store.get('storySessionEntries', 'entry')))?.message).toEqual(message)
    measurements.push({ name, sourceCharacters: content.length, transcriptTokens: estimateTextTokens(expected), budget, compressionRequests: parts.length, partTokens: parts.map(estimateTextTokens) })
  }
  const result = { optimization: 15, measurements, checks: { exactText: true, budgetPreserved: true, surrogatePairs: true, originalHistory: true } }
  if (process.env.WW_OPT15_RESULT) writeFileSync(process.env.WW_OPT15_RESULT, JSON.stringify(result, null, 2) + '\n')
})
