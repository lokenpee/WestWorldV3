import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { getCurrentSystemMessage } from '@earendil-works/pi-ai'
import type { ModelService } from '../models/service'
import { ModelError, type UsageSummary } from '../models/types'
import { appendEntry, checkLease } from './commands'
import { estimateContextTokens, estimateMessageTokens, estimateTextTokens, entryMessages, findCutPoint, projectSession, settingsForWindow } from './context'
import { text, validate } from './contracts'
import type { AgentRepository, Row } from './repository'
import type { Scope } from './queries'
import compactPrompt from '../../../docs/v2/resources/v2.2/prompts/active/compact.md?raw'
import schemasText from '../../../docs/v2/resources/schemas.json?raw'

const summarySchema = JSON.parse(schemasText).SessionCompactionResultSchema
export type SessionStatus = { state: 'compressing' | 'compacted' | 'compression_failed'; before?: number; after?: number }
export function addUsage(previous: Row | undefined, usage: UsageSummary): Row {
  const known = usage.costStatus === 'estimated' && (!previous || previous.costStatus === 'estimated')
  return { input: Number(previous?.input ?? 0) + usage.input, output: Number(previous?.output ?? 0) + usage.output, totalTokens: Number(previous?.totalTokens ?? 0) + usage.totalTokens, cost: Number(previous?.cost ?? 0) + (usage.cost ?? 0), costStatus: known ? 'estimated' : 'unknown' }
}
export async function sessionProjection(repo: AgentRepository, sessionId: string) {
  return repo.transaction(false, async store => {
    const session = await store.get('storySessions', sessionId)
    if (!session || session.bookId !== repo.bookId) throw new Error('会话不属于当前书籍。')
    const entries = (await store.rows('storySessionEntries')).filter(row => row.sessionId === sessionId)
    return { ...projectSession(entries, text(session.leafId) || undefined), session, allEntries: entries }
  })
}
function withTask(messages: AgentMessage[], prompt: string) {
  if (messages.some(message => message.role === 'user' && message.content === prompt)) return messages
  const index = messages.findIndex(message => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('[历史会话压缩摘要'))
  return [...messages.slice(0, index + 1), { role: 'user' as const, content: prompt, timestamp: Date.now() }, ...messages.slice(index + 1)]
}
export async function compactSession(repo: AgentRepository, scope: Scope, options: {
  generate: ModelService['generate']; contextWindow: number; prompt: string; systemMessage?: AgentMessage; force?: boolean; signal?: AbortSignal; onStatus?: (status: SessionStatus) => void
}): Promise<AgentMessage[]> {
  const projection = await sessionProjection(repo, scope.sessionId!)
  const settings = settingsForWindow(options.contextWindow)
  const before = estimateContextTokens(projection.entries, projection.messages)
  const capacity = options.contextWindow - settings.reserve
  if (!options.force && before <= capacity) return withTask(projection.messages, options.prompt)
  options.onStatus?.({ state: 'compressing', before })
  try {
    let cut = findCutPoint(projection.entries, settings.keep)
    if (!cut) cut = findCutPoint(projection.entries, 64)
    if (!cut) cut = projection.entries.length
    const system = options.systemMessage ?? getCurrentSystemMessage(projection.messages)
    const messagesFor = (summary: string, keep: Row[]) => withTask([
      ...(system ? [system] : []),
      { role: 'user', content: `[历史会话压缩摘要：仅作历史参考，可按原始条目 ID 回查]\n${summary}`, timestamp: Date.now() },
      ...keep.flatMap(entryMessages).filter(message => message.role !== 'system'),
    ], options.prompt)
    let keep = projection.entries.slice(cut)
    if (messagesFor('', keep).reduce((sum, message) => sum + estimateMessageTokens(message), 0) > capacity) { cut = projection.entries.length; keep = [] }
    const prefix = projection.entries.slice(0, cut)
    const transcript = prefix.filter(row => row.type !== 'compaction').flatMap(row => entryMessages(row).filter(message => message.role !== 'system').map(message => `[原始条目 ${row.id}，角色 ${message.role}]\n${JSON.stringify(message)}`)).join('\n\n')
    if (!transcript.trim()) throw new Error('当前任务超过上下文容量，请缩小任务后继续。')
    let summary = text(projection.entries.findLast(row => row.type === 'compaction')?.summary)
    const chunks: string[] = []; let chunk = '', tokens = 0
    const chunkBudget = Math.max(256, Math.floor(options.contextWindow * 0.45) - estimateTextTokens(compactPrompt))
    for (const char of transcript) {
      const cost = estimateTextTokens(char)
      if (tokens + cost > chunkBudget && chunk) { chunks.push(chunk); chunk = ''; tokens = 0 }
      chunk += char; tokens += cost
    }
    if (chunk) chunks.push(chunk)
    const usage = { input: 0, output: 0, totalTokens: 0, cost: 0 }
    const maxTokens = Math.min(16384, Math.max(128, Math.floor(options.contextWindow / 8)))
    const maxChars = Math.min(64000, Math.max(64, Math.floor(maxTokens / 2)))
    const outputSchema = { ...summarySchema, properties: { summary: { ...summarySchema.properties.summary, maxLength: maxChars } } }
    for (const part of chunks) {
      options.signal?.throwIfAborted()
      await repo.transaction(false, store => checkLease(store, scope, options.signal))
      const result = await options.generate({ role: 'aggregation', context: { systemPrompt: `${compactPrompt}\n本次摘要最多${maxChars}字符。合并重复信息，以条目编号回查长证据，保留仍有效的判断和下一步。`, messages: [{ role: 'user', content: `【旧摘要】\n${summary || '无'}\n【需要压缩的原始会话数据】\n${part}`, timestamp: Date.now() }], tools: [{ name: 'submit_result', description: '提交历史会话摘要', parameters: outputSchema, constrainedSampling: { type: 'json_schema', strict: 'prefer' } }] },
        validate(message) {
          const calls = message.content.filter(part => part.type === 'toolCall')
          if (calls.length !== 1 || calls[0].name !== 'submit_result') throw new ModelError('validation', '压缩摘要须通过指定工具返回。')
          try { validate(outputSchema, calls[0].arguments, '压缩摘要格式或长度不符。') } catch { throw new ModelError('validation', `压缩摘要须包含非空summary，长度至多${maxChars}字符。`) }
          const value = calls[0].arguments as { summary: string }
          if (!value.summary.trim()) throw new ModelError('validation', '压缩摘要为空。')
          return value
        }, repairPrompt: `请仅通过submit_result返回summary，摘要至多${maxChars}字符，合并重复信息，保留判断与回查编号。`, signal: options.signal, maxTokens, temperature: 0 })
      await repo.transaction(true, async store => {
        await checkLease(store, scope)
        const run = (await store.get('pipelineRuns', scope.runId))!
        await store.put('pipelineRuns', { ...run, usage: addUsage(run.usage as Row | undefined, result.usage), cost: Number(run.cost ?? 0) + (result.usage.cost ?? 0) })
      })
      for (const key of ['input', 'output', 'totalTokens', 'cost'] as const) usage[key] += result.usage[key] ?? 0
      if (!result.ok || !result.value?.summary.trim()) throw new Error(result.error?.message ?? '会话压缩未产生有效摘要，请重试。')
      summary = result.value.summary
    }
    options.signal?.throwIfAborted()
    const messages = messagesFor(summary, keep)
    const after = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
    if (after >= before || after > capacity) throw new Error('压缩后仍超过上下文预算，请缩小当前任务后继续。')
    await repo.transaction(true, async store => {
      await checkLease(store, scope, options.signal)
      const session = (await store.get('storySessions', scope.sessionId!))!
      if (session.leafId !== projection.session.leafId) throw new Error('压缩期间会话已变化，请重试。')
      await appendEntry(store, scope, { type: 'compaction', summary, firstKeptEntryId: text(keep[0]?.id), tokensBefore: before, tokensAfter: after, ...(system ? { systemMessage: system } : {}), usage })
    })
    options.onStatus?.({ state: 'compacted', before, after })
    return messages
  } catch (error) { options.onStatus?.({ state: 'compression_failed', before }); throw error }
}
