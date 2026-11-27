import { storyMessages } from '../story/views'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { getCurrentSystemMessage } from '@earendil-works/pi-ai'
import type { ModelService } from '../models/service'
import { ModelError, type UsageSummary } from '../models/types'
import { appendEntry, checkLease } from './commands'
import { TraceSession } from './trace'
import { appendRequestLedger } from './ledger'
import { estimateContextTokens, estimateMessageTokens, estimateTextTokens, textTokenWeight, entryMessages, findCutPoint, projectSession, projectWorkSession, settingsForWindow } from './context'
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
export async function sessionProjection(repo: AgentRepository, sessionId: string, unitId?: string, lightweightStory = false, outline = false) {
  return repo.transaction(false, async store => {
    const session = await store.get('storySessions', sessionId)
    if (!session || session.bookId !== repo.bookId) throw new Error('会话不属于当前书籍。')
    const entries = unitId && store.sessionEntries ? await store.sessionEntries(sessionId) : (await store.rows('storySessionEntries')).filter(row => row.sessionId === sessionId)
    const history = entries.filter(row => row.type === 'message' && (row.message as AgentMessage).role !== 'system')
    const projected = lightweightStory ? storyMessages(history.map(row => row.message as AgentMessage), outline) : []
    let index = 0
    const projectedEntries = lightweightStory ? entries.map(row => row.type === 'message' && (row.message as AgentMessage).role !== 'system'
      ? { ...row, message: projected[index++] } : row) : entries
    return { ...(unitId ? projectWorkSession(entries, unitId) : projectSession(projectedEntries, text(session.leafId) || undefined)), session, allEntries: entries }
  })
}
function withTask(messages: AgentMessage[], prompt: string) {
  if (!prompt) return messages
  if (messages.some(message => message.role === 'user' && message.content === prompt)) return messages
  const index = messages.findIndex(message => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('[历史会话压缩摘要'))
  return [...messages.slice(0, index + 1), { role: 'user' as const, content: prompt, timestamp: Date.now() }, ...messages.slice(index + 1)]
}
export async function compactSession(repo: AgentRepository, scope: Scope, options: {
  generate: ModelService['generate']; contextWindow: number; prompt: string; currentTask?: () => Promise<string>; systemMessage?: AgentMessage; force?: boolean; signal?: AbortSignal; onStatus?: (status: SessionStatus) => void
}): Promise<AgentMessage[]> {
  const projection = await sessionProjection(repo, scope.sessionId!, scope.unitId === 'directory:identity' ? scope.unitId : undefined, scope.workflow === 'story_pages_v3', scope.outline)
  const settings = settingsForWindow(options.contextWindow)
  const before = estimateContextTokens(projection.entries, projection.messages)
  const capacity = options.contextWindow - settings.reserve
  if (!options.force && before <= capacity) return withTask(projection.messages, options.prompt)
  options.onStatus?.({ state: 'compressing', before })
  const characterId = scope.unitId?.startsWith('profile:') || scope.unitId?.startsWith('relations:') ? scope.unitId.split(':')[1] : undefined
  const trace = new TraceSession(repo, { bookId: scope.bookId, runId: scope.runId, executionId: scope.executionId ?? scope.runId, taskId: scope.taskId, sessionId: scope.sessionId, ...(scope.contextId ? { contextId: scope.contextId } : {}), ...(scope.unitId ? { workId: scope.unitId } : {}), ...(characterId ? { characterId } : {}) }, { businessPrompt: options.prompt, purpose: 'compaction' })
  try {
    let cut = findCutPoint(projection.entries, settings.keep)
    if (!cut) cut = findCutPoint(projection.entries, 64)
    if (!cut) cut = projection.entries.length
    const system = options.systemMessage ?? getCurrentSystemMessage(projection.messages)
    const currentTask = options.currentTask ? { role: 'user' as const, content: await options.currentTask(), timestamp: Date.now() } : undefined
    const messagesFor = (summary: string, keep: Row[]) => withTask([
      ...(system ? [system] : []),
      { role: 'user', content: `[历史会话压缩摘要：仅作历史参考，可按原始条目 ID 回查]\n${summary}`, timestamp: Date.now() },
      ...keep.flatMap(entryMessages).filter(message => message.role !== 'system'),
      ...(currentTask ? [currentTask] : []),
    ], options.prompt)
    let keep = projection.entries.slice(cut)
    if (!projection.entries.slice(0, cut).some(entry => entry.type !== 'compaction' && entryMessages(entry).some(message => message.role !== 'system'))) { cut = projection.entries.length; keep = [] }
    if (messagesFor('', keep).reduce((sum, message) => sum + estimateMessageTokens(message), 0) > capacity) { cut = projection.entries.length; keep = [] }
    const prefix = projection.entries.slice(0, cut)
    const transcript = prefix.filter(row => row.type !== 'compaction').flatMap(row => entryMessages(row).filter(message => message.role !== 'system').map(message => `[原始条目 ${row.id}，角色 ${message.role}]\n${JSON.stringify(message)}`)).join('\n\n')
    if (!transcript.trim()) throw new Error('当前任务超过上下文容量，请缩小任务后继续。')
    let summary = text(projection.entries.findLast(row => row.type === 'compaction')?.summary)
    const chunks: string[] = []; let chunk = '', tokens = 0
    const chunkBudget = Math.max(256, Math.floor(options.contextWindow * 0.45) - estimateTextTokens(compactPrompt))
    for (const char of transcript) {
      const cost = textTokenWeight(char)
      if (tokens + cost > chunkBudget && chunk) { chunks.push(chunk); chunk = ''; tokens = 0 }
      chunk += char; tokens += cost
    }
    if (chunk) chunks.push(chunk)
    const usage = { input: 0, output: 0, totalTokens: 0, cost: 0 }
    const maxTokens = Math.min(16384, Math.max(128, Math.floor(options.contextWindow / 8)))
    const maxChars = Math.max(64, Math.floor(maxTokens / 2))
    for (const part of chunks) {
      options.signal?.throwIfAborted()
      await repo.transaction(false, store => checkLease(store, scope, options.signal))
      let validation: { code: string; path?: string } | undefined
      const outlineGuide = scope.workflow === 'story_pages_v3' && scope.outline
        ? `当期目录、归属和交接事项将从书库重新提供。只摘要仍影响下一批的决定、未决对象及必要回查编号，通常用 ${Math.min(600, maxChars)} 字以内。省去逐页台账、已提交成员清单和重复证据。`
        : ''
      const result = await options.generate({ role: 'aggregation', context: { systemPrompt: `${compactPrompt}\n本次摘要建议控制在${maxChars}字符以内。合并重复信息，以条目编号回查长证据，保留仍有效的判断和下一步。${outlineGuide}`, messages: [{ role: 'user', content: `【旧摘要】\n${summary || '无'}\n【需要压缩的原始会话数据】\n${part}`, timestamp: Date.now() }], tools: [{ name: 'submit_result', description: '提交历史会话摘要', parameters: summarySchema, constrainedSampling: { type: 'json_schema', strict: 'prefer' } }] },
        validate(message) {
          const summaryError = (code: string, detail: string) => {
            validation = { code, path: 'summary' }
            return new ModelError('validation', `${code}:${detail}`)
          }
          if (message.stopReason === 'length') throw summaryError('OUTPUT_TRUNCATED', `模型输出被截断，未能返回完整摘要。`)
          const calls = message.content.filter(part => part.type === 'toolCall')
          if (calls.length !== 1 || calls[0].name !== 'submit_result') throw summaryError('SUMMARY_TOOL', `压缩摘要须且只须通过submit_result返回，本次工具调用${calls.length}个。`)
          const args = calls[0].arguments as Row | undefined
          if (!args || typeof args !== 'object' || !Object.hasOwn(args, 'summary')) throw summaryError('SUMMARY_MISSING', '结果缺少summary字段。')
          if (typeof args.summary !== 'string') throw summaryError('SUMMARY_TYPE', `summary须为字符串，实际为${Array.isArray(args.summary) ? 'array' : typeof args.summary}。`)
          if (!args.summary.trim()) throw summaryError('SUMMARY_EMPTY', 'summary内容为空或只有空白。')
          try { validate(summarySchema, args, '压缩摘要格式不符。') } catch (error) { throw summaryError('SUMMARY_TYPE', error instanceof Error ? error.message : 'summary结构不符合Schema。') }
          return { summary: args.summary }
        }, repairPrompt: `请仅通过submit_result返回summary，摘要建议控制在${maxChars}字符以内，合并重复信息，保留判断与回查编号。${outlineGuide}`, signal: options.signal, maxTokens, temperature: 0, trace: trace.hooks, tracePurpose: 'compaction' })
      await repo.transaction(true, async store => {
        await checkLease(store, scope)
        await appendEntry(store, scope, { type: 'request_trace', attemptId: crypto.randomUUID(), purpose: validation ? 'compaction_repair' : 'compaction', ok: result.ok, errorCode: validation?.code ?? result.error?.kind, validation: validation ?? null, message: result.message ?? null, usage: result.usage, attempts: result.attempts }, { advanceLeaf: false })
        await appendRequestLedger(store, scope, result.attempts, result.snapshot as Row | undefined, validation ? 'repair' : 'compaction')
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
      if (currentTask) await appendEntry(store, scope, { type: 'message', message: currentTask })
    })
    options.onStatus?.({ state: 'compacted', before, after })
    return messages
  } catch (error) { options.onStatus?.({ state: 'compression_failed', before }); throw error }
  finally { await trace.close() }
}
