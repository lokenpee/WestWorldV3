import type { Agent, AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import { getCurrentSystemMessage } from '@earendil-works/pi-ai'
import type { AgentInput } from '../models/gateway'
import { ModelError, type CallOptions, type CallResult } from '../models/types'
import { appendEntry, checkLease, domainOf, organizationWriteTools, rebaseReadSet, saveTask, taskOf, type ReadSet, type CommitAck } from './commands'
import { createAgentTools } from './tools'
import { canonical, hash, inputSchema, records, strings, text, validate, type AgentProfile, type Summary } from './contracts'
import type { AgentRepository, Row } from './repository'
import type { Scope } from './queries'
import { resolveSession } from './sessions'
import { compactSession, type SessionStatus } from './compaction'
import { projectSession, entryMessages, repairToolPairs } from './context'
import type { ModelService } from '../models/service'
import { outputDiscipline } from './output-discipline'
import { storyFingerprint, storyTable } from '../story/coverage'
import { renewOrganizationLease, withOrganizationLease } from './organizationLease'
import { leaseFailureKind } from '../world/leaseHeartbeat'
import { appendRequestLedger } from './ledger'
import { TraceSession } from './trace'

export type AgentRunner = (input: AgentInput, options?: CallOptions) => Promise<CallResult>
export interface AgentTaskOptions {
  profile: AgentProfile; phase: string; prompt: string; businessPrompt: string; workItems: Row[]; input: Row
  runId?: string; taskId?: string; sessionId?: string; probe?: boolean; signal?: AbortSignal
  maxRequests?: number; timeoutMs?: number; maxTokens?: number; onEvent?: (event: AgentEvent) => void
  afterCommit?: (ack: CommitAck) => Promise<void>
  leaseOwner?: string; retainLease?: boolean
  requiredLineIds?: string[]
  reviewScope?: 'all_assets' | 'relations'
  workflow?: 'character_organization_v1'
  contextId?: string; unitId?: string; organizationWorkKind?: 'directory' | 'candidate' | 'profile' | 'relations'; organizationStep?: string; shouldPause?: () => boolean; shouldCancel?: () => boolean
}
export interface AgentTaskResult { ok: boolean; bookId: string; runId: string; taskId: string; sessionId?: string; summary?: Summary; commitIds: string[]; result?: CallResult; error?: string; itemFailure?: string; readCalls: number; writeCalls: number }
const initialReadSet = (): ReadSet => ({ records: [], queries: [] })
const timestamp = () => new Date().toISOString()
const contentText = (message: AgentMessage) => typeof message.content === 'string' ? message.content : message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
export function createAgentRuntime(runner: AgentRunner, sessionOptions?: { generate: ModelService['generate']; onStatus?: (status: SessionStatus) => void }) {
  const instances = new Map<string, Agent>()
  const active = new Set<string>()
  async function run(repo: AgentRepository, options: AgentTaskOptions): Promise<AgentTaskResult> {
    const key = `${repo.bookId}:${options.profile}`
    const scope: Scope = { bookId: repo.bookId, profile: options.profile, phase: options.phase, runId: options.runId ?? crypto.randomUUID(), executionId: crypto.randomUUID(), taskId: options.taskId ?? crypto.randomUUID(), owner: options.leaseOwner ?? crypto.randomUUID(), sessionId: options.sessionId, probe: options.probe, workItemIds: options.workItems.map(row => text(row.workItemId)), workflow: options.workflow, contextId: options.contextId, unitId: options.unitId, workKind: options.organizationWorkKind, organizationStep: options.organizationStep }
    const organization = options.profile === 'asset_editor' && options.phase === 'character_organization'
    if (options.phase === 'asset_review') {
      const requested = options.reviewScope ?? text(options.input.reviewScope)
      scope.reviewScope = requested === 'relations' ? 'relations' : 'all_assets'
    }
    const outcome: AgentTaskResult = { ok: false, bookId: scope.bookId, runId: scope.runId, taskId: scope.taskId, commitIds: [], readCalls: 0, writeCalls: 0 }
    scope.requiredLineIds = options.requiredLineIds
    if (active.has(key)) return { ...outcome, error: '本书当前职责已有运行任务。' }
    active.add(key)
    let acquired = false; let heartbeat: ReturnType<typeof setInterval> | undefined
    let heartbeatFailure = ''
    const controller = new AbortController(); const abort = () => controller.abort()
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort()
    const identity = !options.probe && options.profile === 'asset_editor' && options.phase === 'ai_identity'
    const resumable = identity || organization || !options.probe && (options.profile === 'story_editor' || options.phase === 'asset_review')
    const maxRequests = options.probe ? 3 : options.maxRequests ?? 1_000_000
    const started = Date.now(), duration = organization ? 3600000 : identity ? 180000 : resumable ? 300000 : options.timeoutMs ?? 180000
    const timeLeft = () => Math.max(0, duration - (Date.now() - started))
    let agent: Agent | undefined; let loadedMessages: AgentMessage[] = []; let persistedMessages = 0
    let trace: TraceSession | undefined
    let deferredAfterValidation = false
    let failedSignatures = new Set<string>()
    let organizationConflicts = 0
    let adapter: ReturnType<typeof createAgentTools> | undefined
    try {
      controller.signal.throwIfAborted()
      if (!options.probe && (!options.workItems.length || new Set(scope.workItemIds).size !== scope.workItemIds.length || scope.workItemIds.some(id => !id))) throw new Error('INVALID_ARGS:正式任务须提供明确、唯一的分配项。')
      if (scope.profile === 'asset_editor' && !['ai_identity', 'optimize', 'asset_review', 'character_organization'].includes(scope.phase) || scope.profile === 'story_editor' && !['window_link', 'global_review'].includes(scope.phase)) throw new Error('SCOPE:职责与任务阶段不一致。')
      await repo.transaction(true, async store => {
        const leases = await store.rows('pipelineRuns')
        if (leases.some(row => row.recordType === 'lease' && (row.lockKey === domainOf(scope) || row.lockKey === 'extraction') && Number(row.expiresAt ?? Infinity) > Date.now() && !(options.retainLease && row.owner === scope.owner && row.runId === scope.runId))) throw new Error('CONFLICT:本书已有任务占用所需资料。')
        if (options.retainLease) {
          if (organization) await renewOrganizationLease(store, { ...scope, sessionId: undefined })
          else if (!leases.some(row => row.owner === scope.owner && row.runId === scope.runId && row.lockKey === domainOf(scope) && Number(row.expiresAt) > Date.now())) throw new Error('CONFLICT:整理阶段执行权已失效。')
        }
        if (scope.profile === 'story_editor' || organization) {
          const session = await resolveSession(store, scope.bookId, scope.sessionId, scope.profile, organization ? options.workflow : undefined, scope.runId)
          if (session?.leaseOwner && Number(session.leaseUntil) > Date.now() && !(options.retainLease && session.leaseOwner === scope.owner)) throw new Error('CONFLICT:会话正在其他窗口运行。')
          scope.sessionId = text(session.id); outcome.sessionId = scope.sessionId
          await store.put('storySessions', { ...session, leaseOwner: scope.owner, leaseUntil: Date.now() + 30000 })
          const entries = store.sessionEntries ? await store.sessionEntries(scope.sessionId!) : (await store.rows('storySessionEntries')).filter(row => row.sessionId === scope.sessionId)
          loadedMessages = organization && scope.unitId
            ? repairToolPairs(entries.filter(row => row.contextId === scope.contextId && row.unitId === scope.unitId && (!row.taskId || row.taskId === scope.taskId)).flatMap(entryMessages).filter(message => message.role !== 'system'))
            : projectSession(entries, text(session.leafId) || undefined).messages
        }
        let run = await store.get('pipelineRuns', scope.runId)
        validate(inputSchema(scope.probe ? 'AgentProbeTask' : scope.profile === 'asset_editor' ? (organization ? 'CharacterOrganizationTask' : scope.phase === 'asset_review' ? 'AssetReviewTask' : 'IdentityTask') : 'StoryTask'), options.input, 'INVALID_ARGS:任务输入不符合当前职责的契约。')
        if (!scope.probe && (options.input.bookId !== scope.bookId || options.input.runId !== scope.runId || options.input.taskId !== scope.taskId || options.input.phase !== scope.phase || scope.sessionId && options.input.sessionId !== scope.sessionId || scope.contextId && options.input.contextId !== scope.contextId || scope.unitId && options.input.unitId !== scope.unitId)) throw new Error('SCOPE:任务输入与绑定范围不一致。')
        if (run && (run.bookId !== scope.bookId || run.stage !== (scope.profile === 'asset_editor' ? 'P2' : 'P3'))) throw new Error('SCOPE:运行编号不属于当前书籍或职责。')
        if (!run) run = { id: scope.runId, recordType: 'run', bookId: scope.bookId, stage: scope.profile === 'asset_editor' ? 'P2' : 'P3', status: 'running', startedAt: timestamp(), planVersion: '2.2', scope: 'fullBook', tasks: [], commandIntents: [], appliedCommands: [], aiMode: 'agent' }
        let task = records(run.tasks).find(row => row.taskId === scope.taskId)
        if (task && (task.phase !== scope.phase || strings(task.workItemIds).join('|') !== scope.workItemIds.join('|'))) throw new Error('SCOPE:恢复任务的分配范围发生变化。')
        if (task && task.inputFingerprint !== await store.wait(hash(options.input))) throw new Error('CONFLICT:恢复任务须使用原有冻结输入。')
        if (!task) {
          const readSet = initialReadSet()
          if (scope.profile === 'story_editor' && options.input.contextHints) for (const work of options.workItems) {
            const table = storyTable(text(work.kind))
            const row = await store.get(table, text(work.id))
            if (!row || work.factFingerprint !== await store.wait(storyFingerprint(table, row))) throw new Error('CONFLICT:分配项摘要的依据已变化，请重新读取任务。')
            readSet.records.push({ table, id: text(work.id), resolvedId: text(work.id), revision: Number(row.revision ?? 0), factFingerprint: await store.wait(hash(row)) })
          }
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
      if (organization) repo = withOrganizationLease(repo, scope)
      const characterId = scope.unitId?.startsWith('profile:') || scope.unitId?.startsWith('relations:') ? scope.unitId.split(':')[1] : undefined
      if (!scope.probe && scope.sessionId) trace = new TraceSession(repo, { bookId: scope.bookId, runId: scope.runId, executionId: scope.executionId ?? scope.runId, taskId: scope.taskId, sessionId: scope.sessionId, ...(scope.contextId ? { contextId: scope.contextId } : {}), ...(scope.unitId ? { workId: scope.unitId } : {}), ...(characterId ? { characterId } : {}) }, { businessPrompt: options.businessPrompt, purpose: 'work' })
      const systemPrompt = [options.businessPrompt, outputDiscipline].join('\n')
      if (!organization && loadedMessages.length) loadedMessages.push({ role: 'system', content: systemPrompt, timestamp: Date.now() })
      persistedMessages = organization ? loadedMessages.length : loadedMessages.length ? loadedMessages.length - 1 : 0
      const prior = await repo.transaction(false, store => taskOf(store, scope))
      adapter = createAgentTools(repo, scope, { afterCommit: options.afterCommit, initialReadSet: prior.task.readSet as unknown as ReadSet })
      const tools = adapter
      // P2 由 service 层统一续租；运行层只保留 P3 的心跳，避免同一次运行出现两套执行者。
      if (!organization) {
        let failures = 0
        heartbeat = setInterval(() => { void repo.transaction(true, async store => {
          const lease = await store.get('pipelineRuns', `lease:${domainOf(scope)}`)
          if (lease?.owner !== scope.owner) throw new Error('CONFLICT:执行权已转移。')
          await store.put('pipelineRuns', { ...lease, expiresAt: Date.now() + 30000 })
          if (scope.sessionId) { const session = (await store.get('storySessions', scope.sessionId))!; if (session.leaseOwner !== scope.owner) throw new Error('CONFLICT:会话执行权已转移。'); await store.put('storySessions', { ...session, leaseUntil: Date.now() + 30000 }) }
        }).then(() => { failures = 0 }).catch(error => {
          const message = error instanceof Error ? error.message : '租约续期失败。'
          if (leaseFailureKind(error) === 'lost') { heartbeatFailure = message; controller.abort() }
          else if (++failures >= 3) { heartbeatFailure = `连续${failures}次无法确认执行权：${message}`; controller.abort() }
        }) }, 8000)
      }
      let persistQueue = Promise.resolve()
      const persistTail = () => persistQueue = persistQueue.then(async () => {
        if (!agent || !scope.sessionId) return
        const tail = agent.state.messages.slice(persistedMessages)
        if (!tail.length) return
        await repo.transaction(true, async store => { await checkLease(store, scope); for (const message of tail) await appendEntry(store, scope, { type: 'message', message }); await rebaseReadSet(store, scope, tools.reads, true); await saveTask(store, scope, { readSet: tools.reads }) })
        persistedMessages += tail.length
      })
      const consumeRequest = async () => repo.transaction(true, async store => {
          await checkLease(store, scope, controller.signal)
          const { task } = await taskOf(store, scope)
          if (Number(task.stepsUsed) >= maxRequests || resumable && timeLeft() === 0) throw new ModelError('budget', 'BUDGET:本任务的实际请求预算已用完。')
          usedRequests = Number(task.stepsUsed) + 1
          await saveTask(store, scope, { stepsUsed: Number(task.stepsUsed) + 1, attempt: Number(task.attempt) + 1 })
        })
      const prepareContext = async (context: { messages: AgentMessage[] }, window: number, force = false) => {
        await persistTail()
        if (organization || !scope.sessionId || !sessionOptions) return undefined
        const effectiveSystem = getCurrentSystemMessage(context.messages)
        const messages = await compactSession(repo, scope, { generate: request => sessionOptions.generate({ ...request, beforeRequest: consumeRequest }), contextWindow: window, prompt: options.prompt, systemMessage: effectiveSystem ? { ...effectiveSystem, content: systemPrompt } : undefined, force, signal: controller.signal, onStatus: sessionOptions.onStatus })
        await repo.transaction(true, async store => { await rebaseReadSet(store, scope, tools.reads, true); await saveTask(store, scope, { readSet: tools.reads }) })
        return messages
      }
      let usedRequests = Number(prior.task.stepsUsed ?? 0)
      const previousAgent = instances.get(key)
      outcome.result = await runner({ prompt: options.prompt, systemPrompt, tools: tools.currentTools(), getTools: () => tools.currentTools(), ...(loadedMessages.length ? { messages: loadedMessages } : {}), agent: !scope.probe && scope.profile === 'story_editor' && previousAgent?.sessionId === scope.sessionId ? previousAgent : undefined,
        onAgent: value => { agent = value; value.sessionId = scope.sessionId; if (!scope.probe && scope.profile === 'story_editor') instances.set(key, value) },
        onEvent: async event => {
          try { trace?.handleEvent(event) } catch { /* 观测失败不影响 Agent */ }
          if (event.type === 'message_end') await persistTail()
          if (event.type === 'tool_execution_end' && event.isError) await repo.transaction(true, async store => { await checkLease(store, scope, controller.signal); await saveTask(store, scope, { lastError: { code: 'TOOL_ERROR', message: `${event.toolName}：${JSON.stringify(event.result).slice(0, 2000)}` } }) })
          options.onEvent?.(event)
        },
        prepareRequest: async ({ context, model }) => {
          const messages = await prepareContext(context, model.contextWindow)
          if (!scope.probe) {
            const rawBase = messages ?? context.messages
            let seenPrompt = false
            const base = organization ? rawBase.filter(message => {
              if (message.role !== 'user' || contentText(message) !== options.prompt) return true
              if (seenPrompt) return false
              seenPrompt = true
              return true
            }) : rawBase
            const withPrompt = organization && !base.some(message => message.role === 'user' && contentText(message) === options.prompt)
              ? [...base, { role: 'user' as const, content: options.prompt, timestamp: Date.now() }]
              : base
            const left = maxRequests - usedRequests
            const note = resumable
              ? maxRequests >= 1_000_000
                ? `当前运行状态：剩余约${Math.ceil(timeLeft() / 1000)}秒；本任务不设固定请求轮数。`
                : `当前运行状态：剩余约${Math.ceil(timeLeft() / 1000)}秒；本任务最多${maxRequests}次实际请求，已用${usedRequests}次。`
              : `当前运行状态：本子任务还可请求${Math.max(0, left)}次。`

            const activeTools = tools.currentTools()
            if (agent) agent.state.tools = activeTools
            return { context: { ...context, messages: [...withPrompt, { role: 'user', content: note, timestamp: Date.now() }], tools: activeTools } }
          }
          const activeTools = tools.currentTools()
          if (agent) agent.state.tools = activeTools
          return messages ? { context: { ...context, messages, tools: activeTools } } : undefined
        },
        recoverContext: scope.sessionId && sessionOptions ? async (context, model) => {
          const activeTools = tools.currentTools()
          if (agent) agent.state.tools = activeTools
          if (organization) return { ...context, tools: activeTools, messages: [
            { role: 'user' as const, content: options.prompt, timestamp: Date.now() },
            { role: 'user' as const, content: '上一请求超出模型容量，已重建当前人物的小上下文。程序预装资料重新提供；如已保存过部分修改，用query_character_profile或query_relation_work刷新当前真实资料后继续，不要把旧工具结果当作仍然有效。', timestamp: Date.now() },
          ] }
          const messages = await prepareContext(context, model.contextWindow, true); return messages ? { ...context, messages, tools: activeTools } : undefined
        } : undefined,
        beforeRequest: consumeRequest,
        beforeToolCall: async ({ assistantMessage, toolCall }) => {
          if (toolCall.name === 'get_tools_detail') adapter?.activate(text((toolCall.arguments as Row).name))
          if (options.shouldCancel?.()) return { block: true, terminate: true, reason: 'CANCELLED:运行已取消，工具未执行。' }
          if (options.shouldPause?.()) return { block: true, terminate: true, reason: 'PAUSED:任务已暂停，工具未执行。' }
          const batch = assistantMessage.content.filter(part => part.type === 'toolCall')
          if (batch.some(call => call.name === 'submit_result') && batch.length !== 1) return { block: true, reason: '最终总结须独占本批调用，混合批全部操作均未执行。' }
          const { task } = await repo.transaction(false, store => taskOf(store, scope))
          if (!resumable && Number(task.stepsUsed) >= maxRequests && toolCall.name !== 'submit_result') return { block: true, reason: '最后一次请求只允许提交任务总结。' }
          return undefined
        },
        afterToolCall: async ({ toolCall, result, isError }) => {
          if (organization && tools.completed) return { terminate: true }
          if (organization) {
            if (!isError) { failedSignatures = new Set(); if ((organizationWriteTools as readonly string[]).includes(toolCall.name)) organizationConflicts = 0; return undefined }
            const signature = `${toolCall.name}:${canonical(toolCall.arguments)}`
            const message = result.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
            if (failedSignatures.has(signature)) {
              outcome.itemFailure = `相同工具和参数再次失败且没有新资料或提交，已留待处理：${message.slice(0, 500)}`
              return { terminate: true }
            }
            failedSignatures.add(signature)
            if (/CONFLICT|IDEMPOTENCY_CONFLICT/.test(message)) {
              organizationConflicts++
              if (organizationConflicts >= 3) {
                outcome.itemFailure = `连续${organizationConflicts}次写入冲突且没有新提交，已保留当前进度并暂停：${message.slice(0, 500)}`
                return { terminate: true }
              }
            } else organizationConflicts = 0
            return undefined
          }
          if (!isError || !['submit_result', 'commit_asset_changes', 'commit_story_changes'].includes(toolCall.name)) return undefined
          const message = result.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
          if (message.includes('CONFLICT:')) { agent?.steer({ role: 'user', content: '资料发生变化，请重新读取相关依据，再决定是否使用新的命令键提交。', timestamp: Date.now() }); return undefined }
          const terminate = await repo.transaction(true, async store => { const { task } = await taskOf(store, scope); if (Number(task.repairCount) >= 1) return true; await saveTask(store, scope, { repairCount: 1 }); return false })
          if (terminate && resumable) { deferredAfterValidation = true; outcome.itemFailure = message }
          if (!terminate) agent?.steer({ role: 'user', content: '这是本任务唯一一次结果修正机会。请根据工具错误修正；改变写入内容时使用新的命令键。', timestamp: Date.now() })
          return terminate ? { terminate: true } : undefined
        },
        finishTurn: () => options.shouldPause?.() || options.shouldCancel?.() || tools.summary || organization && tools.completed || resumable && (usedRequests >= maxRequests || resumable && timeLeft() === 0) ? { action: 'end' } : undefined,
        validateFinal: () => { if (!tools.completed && !tools.summary && !(resumable && (deferredAfterValidation || usedRequests >= maxRequests || resumable && timeLeft() === 0))) throw new ModelError(usedRequests >= maxRequests ? 'budget' : 'validation', usedRequests >= maxRequests ? 'BUDGET:子任务预算已用完，剩余工作交后续批次。' : '智能体尚未提交包含真实确认的任务总结。') },
      }, { signal: controller.signal, maxRequests, timeoutMs: resumable ? duration : Math.min(options.timeoutMs ?? (scope.probe ? 30000 : 180000), 180000), ...(resumable ? { cooperativeTimeout: true, requestTimeoutMs: identity ? 60000 : 120000 } : {}), maxTokens: options.maxTokens ?? (scope.probe ? 1024 : 8192), ...(scope.probe ? { temperature: 0 } : { unboundedRequests: true }), ...(trace ? { trace: trace.hooks, tracePurpose: 'work' as const } : {}) })
      outcome.summary = adapter.summary
      if (resumable && !outcome.itemFailure && outcome.result.error && ['validation', 'context_length', 'content_policy'].includes(outcome.result.error.kind)) outcome.itemFailure = outcome.result.error.message
      if (resumable && !outcome.summary && (outcome.result.ok || outcome.itemFailure || outcome.result.error?.kind === 'budget')) {
        await repo.transaction(true, async store => {
          await checkLease(store, scope, controller.signal)
          const { task } = await taskOf(store, scope)
          const reviewed = records(task.reviewedItems).filter(item => item.outcome === 'changed' && scope.workItemIds.includes(text(item.workItemId)))
          outcome.summary = { status: 'partial', commitIds: strings(task.appliedCommitIds), summary: '本任务已收尾，已提交修改保留，未完成项留待继续。', reviewedItems: reviewed as unknown as Summary['reviewedItems'], remainingWorkIds: scope.workItemIds.filter(id => !reviewed.some(item => item.workItemId === id)) }
          await saveTask(store, scope, { reviewedItems: reviewed })
        })
      }
      outcome.ok = tools.completed || !!outcome.summary && (outcome.result.ok || resumable && (!!outcome.itemFailure || outcome.result.error?.kind === 'budget'))
      if (!outcome.ok) outcome.error = outcome.result.error?.message ?? '任务总结未通过校验。'; else outcome.error = undefined
    } catch (error) { outcome.error = heartbeatFailure ? `任务因执行权异常暂停：${heartbeatFailure}` : controller.signal.aborted ? '任务已取消，已提交成果保留。' : error instanceof Error ? error.message : '智能体执行失败。' }
    finally {
      clearInterval(heartbeat); options.signal?.removeEventListener('abort', abort)
      outcome.readCalls = adapter?.readCalls ?? 0; outcome.writeCalls = adapter?.writeCalls ?? 0
      if (acquired) await repo.transaction(true, async store => {
        const { task, run } = await taskOf(store, scope)
        outcome.commitIds = strings(task.appliedCommitIds)
        const lease = await store.get('pipelineRuns', `lease:${domainOf(scope)}`)
        if (lease?.owner !== scope.owner) return
        const status = outcome.itemFailure ? 'failed' : outcome.ok ? outcome.summary?.status === 'partial' ? 'partial' : 'completed' : controller.signal.aborted ? heartbeatFailure ? 'failed' : 'cancelled' : 'partial'
        const failure = outcome.error ?? outcome.itemFailure
        await saveTask(store, scope, { status, ...(failure ? { lastError: { code: heartbeatFailure ? 'LEASE_LOST' : controller.signal.aborted ? 'cancelled' : outcome.result?.error?.kind === 'budget' ? 'BUDGET' : 'AGENT_FAILED', message: `${failure}${(task.lastError as Row | undefined)?.code === 'TOOL_ERROR' ? `；最近工具反馈：${text((task.lastError as Row).message)}` : ''}` } } : {}) })
        if (organization) await appendRequestLedger(store, scope, outcome.result?.attempts ?? [], outcome.result?.snapshot as Row | undefined, 'work')
        const updated = (await store.get('pipelineRuns', scope.runId))!
        const usage = outcome.result?.usage
        const previous = run.usage as Row | undefined
        await store.put('pipelineRuns', { ...updated, status: organization && !controller.signal.aborted && !outcome.error && !outcome.itemFailure ? 'running' : outcome.ok && outcome.summary?.status === 'completed' ? 'completed' : heartbeatFailure ? 'paused' : controller.signal.aborted ? 'cancelled' : 'paused', ...(organization ? {} : { finishedAt: timestamp() }), ...(usage ? { usage: { input: Number(previous?.input ?? 0) + usage.input, output: Number(previous?.output ?? 0) + usage.output, totalTokens: Number(previous?.totalTokens ?? 0) + usage.totalTokens, cost: Number(previous?.cost ?? 0) + (usage.cost ?? 0), costStatus: usage.costStatus }, cost: Number(previous?.cost ?? 0) + (usage.cost ?? 0) } : {}) })
        if (!options.retainLease) await store.remove('pipelineRuns', `lease:${domainOf(scope)}`)
        if (scope.sessionId && !options.retainLease) { const session = await store.get('storySessions', scope.sessionId); if (session?.leaseOwner === scope.owner) { const { leaseOwner: _owner, leaseUntil: _until, ...saved } = session; await store.put('storySessions', saved) } }
      }).catch(error => { outcome.ok = false; outcome.error = error instanceof Error ? error.message : '保存任务状态失败。' })
      active.delete(key)
      if (trace) await trace.close().catch(() => undefined)
    }
    return outcome
  }
  return { run, openSession: (repo: AgentRepository, sessionId?: string) => repo.transaction(true, store => resolveSession(store, repo.bookId, sessionId)), instance: (bookId: string, profile: AgentProfile) => instances.get(`${bookId}:${profile}`) }
}
