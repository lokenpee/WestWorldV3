import type { Agent, AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import { getCurrentSystemMessage } from '@earendil-works/pi-ai'
import type { AgentInput } from '../models/gateway'
import { ModelError, type CallOptions, type CallResult } from '../models/types'
import { appendEntry, checkLease, domainOf, rebaseReadSet, saveTask, taskOf, type ReadSet, type CommitAck } from './commands'
import { createAgentTools } from './tools'
import { hash, inputSchema, records, strings, text, validate, type AgentProfile, type Summary } from './contracts'
import type { AgentRepository, Row } from './repository'
import type { Scope } from './queries'
import { resolveSession } from './sessions'
import { compactSession, type SessionStatus } from './compaction'
import { projectSession } from './context'
import type { ModelService } from '../models/service'
import wrapper from '../../../docs/v2/resources/v2.2/prompts/active/agent-wrapper.txt?raw'

export type AgentRunner = (input: AgentInput, options?: CallOptions) => Promise<CallResult>
export interface AgentTaskOptions {
  profile: AgentProfile; phase: string; prompt: string; businessPrompt: string; workItems: Row[]; input: Row
  runId?: string; taskId?: string; sessionId?: string; probe?: boolean; signal?: AbortSignal
  maxRequests?: number; timeoutMs?: number; maxTokens?: number; onEvent?: (event: AgentEvent) => void
  afterCommit?: (ack: CommitAck) => Promise<void>
  leaseOwner?: string; retainLease?: boolean
  requiredLineIds?: string[]
}
export interface AgentTaskResult { ok: boolean; bookId: string; runId: string; taskId: string; sessionId?: string; summary?: Summary; commitIds: string[]; result?: CallResult; error?: string; readCalls: number; writeCalls: number }
const initialReadSet = (): ReadSet => ({ records: [], queries: [] })
const timestamp = () => new Date().toISOString()
export function createAgentRuntime(runner: AgentRunner, sessionOptions?: { generate: ModelService['generate']; onStatus?: (status: SessionStatus) => void }) {
  const instances = new Map<string, Agent>()
  const active = new Set<string>()
  async function run(repo: AgentRepository, options: AgentTaskOptions): Promise<AgentTaskResult> {
    const key = `${repo.bookId}:${options.profile}`
    const scope: Scope = { bookId: repo.bookId, profile: options.profile, phase: options.phase, runId: options.runId ?? crypto.randomUUID(), taskId: options.taskId ?? crypto.randomUUID(), owner: options.leaseOwner ?? crypto.randomUUID(), sessionId: options.sessionId, probe: options.probe, workItemIds: options.workItems.map(row => text(row.workItemId)) }
    const outcome: AgentTaskResult = { ok: false, bookId: scope.bookId, runId: scope.runId, taskId: scope.taskId, commitIds: [], readCalls: 0, writeCalls: 0 }
    scope.requiredLineIds = options.requiredLineIds
    if (active.has(key)) return { ...outcome, error: '本书当前职责已有运行任务。' }
    active.add(key)
    let acquired = false; let heartbeat: ReturnType<typeof setInterval> | undefined
    const controller = new AbortController(); const abort = () => controller.abort()
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort()
    const maxRequests = Math.min(options.maxRequests ?? (options.probe ? 3 : 6), options.probe ? 3 : 6)
    let agent: Agent | undefined; let loadedMessages: AgentMessage[] = []; let persistedMessages = 0
    let adapter: ReturnType<typeof createAgentTools> | undefined
    try {
      controller.signal.throwIfAborted()
      if (!options.probe && (!options.workItems.length || new Set(scope.workItemIds).size !== scope.workItemIds.length || scope.workItemIds.some(id => !id))) throw new Error('INVALID_ARGS:正式任务须提供明确、唯一的分配项。')
      if (scope.profile === 'asset_editor' && !['ai_identity', 'optimize'].includes(scope.phase) || scope.profile === 'story_editor' && !['window_link', 'global_review'].includes(scope.phase)) throw new Error('SCOPE:职责与任务阶段不一致。')
      await repo.transaction(true, async store => {
        const leases = await store.rows('pipelineRuns')
        if (leases.some(row => row.recordType === 'lease' && (row.lockKey === domainOf(scope) || row.lockKey === 'extraction') && Number(row.expiresAt ?? Infinity) > Date.now() && !(options.retainLease && row.owner === scope.owner && row.runId === scope.runId))) throw new Error('CONFLICT:本书已有任务占用所需资料。')
        if (options.retainLease && !leases.some(row => row.owner === scope.owner && row.runId === scope.runId && row.lockKey === domainOf(scope) && Number(row.expiresAt) > Date.now())) throw new Error('CONFLICT:整理阶段执行权已失效。')
        if (scope.profile === 'story_editor') {
          const session = await resolveSession(store, scope.bookId, scope.sessionId)
          if (session?.leaseOwner && Number(session.leaseUntil) > Date.now() && !(options.retainLease && session.leaseOwner === scope.owner)) throw new Error('CONFLICT:会话正在其他窗口运行。')
          scope.sessionId = text(session.id); outcome.sessionId = scope.sessionId
          await store.put('storySessions', { ...session, leaseOwner: scope.owner, leaseUntil: Date.now() + 30000 })
          loadedMessages = projectSession((await store.rows('storySessionEntries')).filter(row => row.sessionId === scope.sessionId), text(session.leafId) || undefined).messages
        }
        let run = await store.get('pipelineRuns', scope.runId)
        validate(inputSchema(scope.probe ? 'AgentProbeTask' : scope.profile === 'asset_editor' ? 'IdentityTask' : 'StoryTask'), options.input, 'INVALID_ARGS:任务输入不符合当前职责的契约。')
        if (!scope.probe && (options.input.bookId !== scope.bookId || options.input.runId !== scope.runId || options.input.taskId !== scope.taskId || options.input.phase !== scope.phase || scope.sessionId && options.input.sessionId !== scope.sessionId)) throw new Error('SCOPE:任务输入与绑定范围不一致。')
        if (run && (run.bookId !== scope.bookId || run.stage !== (scope.profile === 'asset_editor' ? 'P2' : 'P3'))) throw new Error('SCOPE:运行编号不属于当前书籍或职责。')
        if (!run) run = { id: scope.runId, recordType: 'run', bookId: scope.bookId, stage: scope.profile === 'asset_editor' ? 'P2' : 'P3', status: 'running', startedAt: timestamp(), planVersion: '2.2', scope: 'fullBook', tasks: [], commandIntents: [], appliedCommands: [], aiMode: 'agent' }
        let task = records(run.tasks).find(row => row.taskId === scope.taskId)
        if (task && (task.phase !== scope.phase || strings(task.workItemIds).join('|') !== scope.workItemIds.join('|'))) throw new Error('SCOPE:恢复任务的分配范围发生变化。')
        if (task && task.inputFingerprint !== await store.wait(hash(options.input))) throw new Error('CONFLICT:恢复任务须使用原有冻结输入。')
        if (!task) {
          const readSet = initialReadSet()
          if (scope.profile === 'story_editor' && options.input.memory) {
            const memory = options.input.memory as Row
            if (memory.id !== scope.sessionId || memory.bookId !== scope.bookId) throw new Error('SCOPE:任务工作记忆不属于当前会话。')
            const actual = await store.get('storyEditorMemory', scope.sessionId!)
            if (Number(memory.revision) !== Number(actual?.revision ?? 0) || text(memory.workingSummary) !== text(actual?.workingSummary) || text(memory.dataFingerprint) !== text(actual?.dataFingerprint)) throw new Error('CONFLICT:任务工作记忆已变化，请重新读取。')
            readSet.records.push({ table: 'storyEditorMemory', id: scope.sessionId!, resolvedId: actual ? scope.sessionId! : null, revision: Number(actual?.revision ?? 0), factFingerprint: await store.wait(hash(actual ?? null)) })
          }
          task = { taskId: scope.taskId, ordinal: records(run.tasks).length, callId: crypto.randomUUID(), phase: scope.phase, status: 'running', workItemIds: scope.workItemIds, input: options.input, inputFingerprint: await store.wait(hash(options.input)), promptHash: await store.wait(hash(options.businessPrompt)), attempt: 0, repairCount: 0, stepsUsed: 0, appliedCommitIds: [], reviewedItems: [], readSet, createdAt: timestamp(), updatedAt: timestamp() }
        }
        if (Number(task.stepsUsed) >= maxRequests) throw new Error('BUDGET:本子任务已用完请求预算，请将剩余工作分配到新任务。')
        await store.put('pipelineRuns', { ...run, status: 'running', tasks: [...records(run.tasks).filter(row => row.taskId !== scope.taskId), { ...task, status: 'running' }] })
        await store.put('pipelineRuns', { id: `lease:${domainOf(scope)}`, recordType: 'lease', bookId: scope.bookId, lockKey: domainOf(scope), owner: scope.owner, runId: scope.runId, expiresAt: Date.now() + 30000 })
      }); acquired = true
      const systemPrompt = wrapper.replace(/\{(\w+)\}/g, (_, name: string) => ({ ...scope, maxSteps: maxRequests, roleInstruction: scope.profile === 'asset_editor' ? '只整理人物地点，不读取故事会话或修改叙事资料。' : '只整理节点、事件线和工作记忆，不合并人物地点。', businessPrompt: options.businessPrompt } as Record<string, unknown>)[name]?.toString() ?? `{${name}}`)
      if (loadedMessages.length) loadedMessages.push({ role: 'system', content: systemPrompt, timestamp: Date.now() })
      persistedMessages = loadedMessages.length ? loadedMessages.length - 1 : 0
      const prior = await repo.transaction(false, store => taskOf(store, scope))
      adapter = createAgentTools(repo, scope, { afterCommit: options.afterCommit, initialReadSet: prior.task.readSet as unknown as ReadSet })
      const tools = adapter
      heartbeat = setInterval(() => { void repo.transaction(true, async store => {
        const lease = await store.get('pipelineRuns', `lease:${domainOf(scope)}`)
        if (lease?.owner !== scope.owner) throw new Error('CONFLICT:执行权已转移。')
        await store.put('pipelineRuns', { ...lease, expiresAt: Date.now() + 30000 })
        if (scope.sessionId) { const session = (await store.get('storySessions', scope.sessionId))!; if (session.leaseOwner !== scope.owner) throw new Error('CONFLICT:会话执行权已转移。'); await store.put('storySessions', { ...session, leaseUntil: Date.now() + 30000 }) }
      }).catch(() => controller.abort()) }, 8000)
      const persistTail = async () => {
        if (!agent || !scope.sessionId) return
        const tail = agent.state.messages.slice(persistedMessages)
        if (!tail.length) return
        await repo.transaction(true, async store => { await checkLease(store, scope); for (const message of tail) await appendEntry(store, scope, { type: 'message', message }); await rebaseReadSet(store, scope, tools.reads, true); await saveTask(store, scope, { readSet: tools.reads }) })
        persistedMessages += tail.length
      }
      const prepareContext = async (context: { messages: AgentMessage[] }, window: number, force = false) => {
        await persistTail()
        if (!scope.sessionId || !sessionOptions) return undefined
        const effectiveSystem = getCurrentSystemMessage(context.messages)
        const messages = await compactSession(repo, scope, { generate: sessionOptions.generate, contextWindow: window, prompt: options.prompt, systemMessage: effectiveSystem ? { ...effectiveSystem, content: systemPrompt } : undefined, force, signal: controller.signal, onStatus: sessionOptions.onStatus })
        await repo.transaction(true, async store => { await rebaseReadSet(store, scope, tools.reads, true); await saveTask(store, scope, { readSet: tools.reads }) })
        return messages
      }
      const previousAgent = instances.get(key)
      outcome.result = await runner({ prompt: options.prompt, systemPrompt, tools: tools.tools, ...(loadedMessages.length ? { messages: loadedMessages } : {}), agent: !scope.probe && scope.profile === 'story_editor' && previousAgent?.sessionId === scope.sessionId ? previousAgent : undefined,
        onAgent: value => { agent = value; value.sessionId = scope.sessionId; if (!scope.probe) instances.set(key, value) },
        onEvent: async event => { if (event.type === 'message_end') await persistTail(); options.onEvent?.(event) },
        prepareRequest: async ({ context, model }) => { const messages = await prepareContext(context, model.contextWindow); return messages ? { context: { ...context, messages } } : undefined },
        recoverContext: scope.sessionId && sessionOptions ? async (context, model) => { const messages = await prepareContext(context, model.contextWindow, true); return messages ? { ...context, messages } : undefined } : undefined,
        beforeRequest: async () => repo.transaction(true, async store => {
          await checkLease(store, scope, controller.signal)
          const { task } = await taskOf(store, scope)
          if (Number(task.stepsUsed) >= maxRequests) throw new ModelError('validation', '本任务的实际请求预算已用完。')
          await saveTask(store, scope, { stepsUsed: Number(task.stepsUsed) + 1, attempt: Number(task.attempt) + 1 })
        }),
        beforeToolCall: async ({ assistantMessage, toolCall }) => {
          const batch = assistantMessage.content.filter(part => part.type === 'toolCall')
          if (batch.some(call => call.name === 'submit_result') && batch.length !== 1) return { block: true, reason: '最终总结须独占本批调用，混合批全部操作均未执行。' }
          const { task } = await repo.transaction(false, store => taskOf(store, scope))
          if (Number(task.stepsUsed) >= maxRequests && toolCall.name !== 'submit_result') return { block: true, reason: '最后一次请求只允许提交任务总结。' }
          return undefined
        },
        afterToolCall: async ({ toolCall, result, isError }) => {
          if (!isError || !['submit_result', 'commit_asset_changes', 'commit_story_changes'].includes(toolCall.name)) return undefined
          const message = result.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
          if (message.includes('CONFLICT:')) { agent?.steer({ role: 'user', content: '资料发生变化，请重新读取相关依据，再决定是否使用新的命令键提交。', timestamp: Date.now() }); return undefined }
          const terminate = await repo.transaction(true, async store => { const { task } = await taskOf(store, scope); if (Number(task.repairCount) >= 1) return true; await saveTask(store, scope, { repairCount: 1 }); return false })
          if (!terminate) agent?.steer({ role: 'user', content: '这是本任务唯一一次结果修正机会。请根据工具错误修正；改变写入内容时使用新的命令键。', timestamp: Date.now() })
          return terminate ? { terminate: true } : undefined
        },
        finishTurn: () => tools.summary ? { action: 'end' } : undefined,
        validateFinal: () => { if (!tools.summary) throw new ModelError('validation', '智能体尚未提交包含真实确认的任务总结。') },
      }, { signal: controller.signal, maxRequests, timeoutMs: Math.min(options.timeoutMs ?? (scope.probe ? 30000 : 180000), 180000), maxTokens: options.maxTokens ?? (scope.probe ? 1024 : 8192), ...(scope.probe ? { temperature: 0 } : {}) })
      outcome.summary = adapter.summary; outcome.ok = outcome.result.ok && !!outcome.summary
      if (!outcome.ok) outcome.error = outcome.result.error?.message ?? '任务总结未通过校验。'
    } catch (error) { outcome.error = controller.signal.aborted ? '任务已取消，已提交成果保留。' : error instanceof Error ? error.message : '智能体执行失败。' }
    finally {
      clearInterval(heartbeat); options.signal?.removeEventListener('abort', abort)
      outcome.readCalls = adapter?.readCalls ?? 0; outcome.writeCalls = adapter?.writeCalls ?? 0
      if (acquired) await repo.transaction(true, async store => {
        const { task, run } = await taskOf(store, scope)
        outcome.commitIds = strings(task.appliedCommitIds)
        const lease = await store.get('pipelineRuns', `lease:${domainOf(scope)}`)
        if (lease?.owner !== scope.owner) return
        const status = outcome.ok ? outcome.summary?.status === 'partial' ? 'partial' : 'completed' : controller.signal.aborted ? 'cancelled' : 'partial'
        await saveTask(store, scope, { status, ...(outcome.error ? { lastError: { code: controller.signal.aborted ? 'cancelled' : 'AGENT_FAILED', message: outcome.error } } : {}) })
        const updated = (await store.get('pipelineRuns', scope.runId))!
        const usage = outcome.result?.usage
        const previous = run.usage as Row | undefined
        await store.put('pipelineRuns', { ...updated, status: outcome.ok && outcome.summary?.status === 'completed' ? 'completed' : controller.signal.aborted ? 'cancelled' : 'paused', finishedAt: timestamp(), ...(usage ? { usage: { input: Number(previous?.input ?? 0) + usage.input, output: Number(previous?.output ?? 0) + usage.output, totalTokens: Number(previous?.totalTokens ?? 0) + usage.totalTokens, cost: Number(previous?.cost ?? 0) + (usage.cost ?? 0), costStatus: usage.costStatus }, cost: Number(previous?.cost ?? 0) + (usage.cost ?? 0) } : {}) })
        if (!options.retainLease) await store.remove('pipelineRuns', `lease:${domainOf(scope)}`)
        if (scope.sessionId && !options.retainLease) { const session = await store.get('storySessions', scope.sessionId); if (session?.leaseOwner === scope.owner) { const { leaseOwner: _owner, leaseUntil: _until, ...saved } = session; await store.put('storySessions', saved) } }
      }).catch(error => { outcome.ok = false; outcome.error = error instanceof Error ? error.message : '保存任务状态失败。' })
      active.delete(key)
    }
    return outcome
  }
  return { run, openSession: (repo: AgentRepository, sessionId?: string) => repo.transaction(true, store => resolveSession(store, repo.bookId, sessionId)), instance: (bookId: string, profile: AgentProfile) => instances.get(`${bookId}:${profile}`) }
}
