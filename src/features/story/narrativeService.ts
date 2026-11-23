import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core'
import type { Chapter, createWorkspace } from '../../lib/storage/workspace'
import { createBookAgentRepository, type AgentStore } from '../agents/repository'
import { synchronizeOutline, usesOutline } from './outline'
import { appendEntry, checkLease } from '../agents/commands'
import { entryMessages, repairToolPairs } from '../agents/context'
import { canonical, hash, records, text } from '../agents/contracts'
import type { Scope } from '../agents/queries'
import { resolveSession } from '../agents/sessions'
import { TraceSession } from '../agents/trace'
import { createAssetService } from '../assets/service'
import { coverage, type Receipt } from '../extraction/recovery'
import type { ModelService } from '../models/service'
import { createMechanicalQueue } from '../world/mechanical'
import { findExactNameGroups } from '../world/candidates'
import type { Character } from '../assets/types'
import {
  narrativeAssets,
  newNarrativePlan,
  refreshNarrativeTaskInput,
  scheduleNarrative,
  type NarrativePlan,
  type NarrativeTask,
} from './narrativePlan'
import { narrativeTools, toolDefinitions } from './narrativeTools'
import { narrativeContext } from './narrativeContext'
import { narrativeVersions } from './narrativeBasis'
import { visibleNodes } from './narrativePlan'
import { narrativeSystemPrompt } from './narrativeInput'
import prompt from '../../../docs/v2/resources/v2.2/prompts/active/p3-narrative-v4.md?raw'

type Workspace = ReturnType<typeof createWorkspace>
type Models = Pick<ModelService, 'settings' | 'agent'>
const now = () => new Date().toISOString()
async function available(store: AgentStore) {
  const chapters = await store.rows('chapters')
  if (
    !chapters.length ||
    !coverage(
      chapters as unknown as Chapter[],
      (await store.rows('extractionReceipts')) as unknown as Receipt[]
    ).allCovered
  )
    throw Error('请先完成全书逐章提取。')
  if (
    (await store.rows('pipelineRuns')).some(
      (r) => r.recordType === 'lease' && Number(r.expiresAt ?? Infinity) > Date.now()
    )
  )
    throw Error('本书已有处理任务，请等待执行权释放。')
  return chapters.length
}
export function createNarrativeService(workspace: Workspace, models: Models) {
  const listeners = new Set<() => void>()
  const controls = new Map<string, { controller: AbortController; cancel: boolean }>()
  const messages = new Map<string, string>()
  const publish = (book: string, message: string) => {
    messages.set(book, message)
    listeners.forEach((f) => f())
  }
  const mechanical = createMechanicalQueue(
    workspace,
    createAssetService(workspace),
    (id, state) => publish(id, state.phase),
    () => false
  )
  async function eligibility(bookId: string) {
    const db = workspace.openBook(bookId)
    const [chapters, receipts, leases] = await Promise.all([
      db.chapters.toArray(),
      db.table<Receipt>('extractionReceipts').toArray(),
      db.table('pipelineRuns').where('recordType').equals('lease').toArray(),
    ])
    if (!chapters.length || !coverage(chapters, receipts).allCovered) return '请先完成全书逐章提取。'
    if (leases.some((r) => Number(r.expiresAt ?? Infinity) > Date.now()))
      return '本书已有处理任务，请等待执行权释放。'
    return ''
  }
  async function read(bookId: string) {
    const db = workspace.openBook(bookId),
      progress = await db.table('compileProgress').get('P3')
    if (progress?.planKey !== 'narrative-v4') return undefined
    const run = await db.table('pipelineRuns').get(progress.runId)
    if (!run?.narrative) return undefined
    const plan = run.narrative as NarrativePlan
    const [nodes, events, lines, notes] = await Promise.all(
      ['nodes', 'storyEvents', 'eventLines', 'storyEditorNotes'].map((name) => db.table(name).toArray())
    )
    const stats = {
      totalNodes: nodes.length,
      totalEvents: events.length,
      assignedNodes: new Set(events.flatMap((e) => e.nodeIds ?? [])).size,
      assignedEvents: new Set(lines.flatMap((l) => l.eventIds ?? [])).size,
      reviewed: records(run.tasks)
        .filter((t) => t.status === 'completed' && (t.input as NarrativeTask)?.part !== 'batch')
        .reduce((n, t) => n + ((t.input as NarrativeTask)?.ids.length ?? 0), 0),
      doubts: notes
        .filter((n) => n.sessionId === run.sessionId)
        .map((n) => ({
          id: text(n.id),
          statement: text(n.statement),
          status: text(n.status),
          resolution: text(n.resolution),
          targets: [...(n.nodeIds ?? []), ...(n.eventIds ?? []), ...(n.lineIds ?? [])] as string[],
        })),
      independentReasons: Object.entries(plan.retained)
        .filter(([id]) => !events.some((e) => e.nodeIds?.includes(id)))
        .map(([id, note]) => id + ' · ' + note),
    }
    return {
      stats,
      runId: text(run.id),
      plan: run.narrative as NarrativePlan,
      status: text(run.status),
      error: text(run.lastNarrativeError),
      usage: run.narrativeUsage as
        | {
            requests: number
            input: number
            output: number
            cacheRead: number
            cacheWrite: number
            cost: number
            unknown?: boolean
          }
        | undefined,
    }
  }
  async function start(bookId: string) {
    if (controls.has(bookId)) return
    const control = { controller: new AbortController(), cancel: false },
      signal = control.controller.signal
    controls.set(bookId, control)
    publish(bookId, '正在准备叙事整理…')
    const repo = createBookAgentRepository(workspace, bookId)
    const scope: Scope = {
      bookId,
      runId: '',
      sessionId: '',
      taskId: '',
      owner: crypto.randomUUID(),
      profile: 'story_editor',
      phase: 'window_link',
      workflow: 'narrative_v4',
      outline: true,
      workItemIds: [],
    }
    let lease = false,
      timer: ReturnType<typeof setInterval> | undefined,
      agent: Agent | undefined,
      lost = false
    async function updateStatus(status: string, error = '') {
      await repo.transaction(true, async (store) => {
        await checkLease(store, scope)
        const run = (await store.get('pipelineRuns', scope.runId))!,
          p = (await store.get('compileProgress', 'P3'))!
        await store.put('pipelineRuns', { ...run, status, lastNarrativeError: error, finishedAt: now() })
        await store.put('compileProgress', { ...p, status, updatedAt: now() })
      })
    }
    try {
      const settings = await models.settings.read()
      if (!settings.configured || !settings.config.aggregationModel) throw Error('请先保存整理模型与密钥。')
      const initial = await repo.transaction(false, async (store) => {
        await available(store)
        return store.get('compileProgress', 'P3')
      })
      const resume =
        initial?.planKey === 'narrative-v4' && ['paused', 'running'].includes(text(initial.status))
      if (!resume) await mechanical.mergeExactNames(bookId, 'storyCharacters')
      signal.throwIfAborted()
      const identity = await repo.transaction(true, async (store) => {
        const totalChapters = await available(store)
        const p = await store.get('compileProgress', 'P3')
        if (p?.runId !== initial?.runId || p?.status !== initial?.status)
          throw Error('本书进度已变化，请刷新后继续。')
        const duplicates = findExactNameGroups(
          'character',
          (await store.rows('characters')) as unknown as Character[]
        )
        if (duplicates.length) throw Error('同名人物尚待合并：' + duplicates[0].memberIds.join('、'))
        const prior = resume ? await store.get('pipelineRuns', text(p?.runId)) : undefined
        if (resume && !prior?.narrative) throw Error('缺少本轮叙事任务记录。')
        const runId = prior ? text(prior.id) : crypto.randomUUID()
        const session = await resolveSession(
          store,
          bookId,
          prior ? text(prior.sessionId) : undefined,
          'story_editor',
          'narrative_v4',
          runId
        )
        if (session.leaseOwner && Number(session.leaseUntil) > Date.now())
          throw Error('本书故事编辑会话仍被占用。')
        const plan = (prior?.narrative as NarrativePlan) ?? { ...newNarrativePlan(), reuseAssigned: true }
        if (!resume) {
          const direct = (await store.rows('eventLines')).filter((line) => !usesOutline(line))
          for (const line of direct)
            await store.put('eventLines', {
              ...line,
              legacyNodeIds: line.legacyNodeIds ?? line.nodeIds,
              eventIds: line.eventIds ?? [],
              outlinePending: false,
              revision: Number(line.revision) + 1,
            })
          if (direct.length) await synchronizeOutline(store, now())
        }
        await store.put('pipelineRuns', {
          ...prior,
          bookId,
          id: runId,
          stage: 'P3',
          recordType: 'run',
          status: 'running',
          planVersion: '2.2',
          startedAt: prior?.startedAt ?? now(),
          sessionId: session.id,
          narrative: plan,
          phase: plan.layer === 'event' ? 'window_link' : 'global_review',
          tasks: prior?.tasks ?? [],
          lastNarrativeError: '',
        })
        await store.put('pipelineRuns', {
          bookId,
          id: 'lease:narrative',
          recordType: 'lease',
          lockKey: 'narrative',
          owner: scope.owner,
          runId,
          expiresAt: Date.now() + 30000,
        })
        await store.put('storySessions', {
          ...session,
          leaseOwner: scope.owner,
          leaseUntil: Date.now() + 30000,
        })
        await store.put('compileProgress', {
          bookId,
          stage: 'P3',
          planKey: 'narrative-v4',
          status: 'running',
          phase: plan.layer === 'event' ? 'window_link' : 'global_review',
          runId,
          editorSessionId: session.id,
          totalChapters,
          completedChapters: [],
          failedChapters: [],
          updatedAt: now(),
          validity: 'current',
          scope: 'fullBook',
          planVersion: '2.2',
          unit: 'item',
        })
        return { runId, sessionId: session.id }
      })
      Object.assign(scope, identity)
      lease = true
      timer = setInterval(() => {
        void repo
          .transaction(true, async (store) => {
            await checkLease(store, scope)
            const l = (await store.get('pipelineRuns', 'lease:narrative'))!,
              s = (await store.get('storySessions', identity.sessionId))!
            await store.put('pipelineRuns', { ...l, expiresAt: Date.now() + 30000 })
            await store.put('storySessions', { ...s, leaseUntil: Date.now() + 30000 })
          })
          .catch(() => {
            lost = true
            control.controller.abort()
          })
      }, 8000)
      for (;;) {
        signal.throwIfAborted()
        const next = await repo.transaction(true, async (store) => {
          await checkLease(store, scope, signal)
          const run = (await store.get('pipelineRuns', scope.runId))!,
            plan = run.narrative as NarrativePlan
          const assets = await narrativeAssets(store, identity.sessionId)
          const task = scheduleNarrative(plan, assets)
          const taskInputVersion = plan.layer === 'line' ? 7 : 6
          const phase = plan.layer === 'event' ? 'window_link' : 'global_review'
          const summaries = records(run.tasks)
          const summary = task && summaries.find((row) => row.taskId === task.id)
          if (task && !summary) {
            const systemPrompt = narrativeSystemPrompt(prompt, task)
            summaries.push({
              taskId: task.id,
              ordinal: summaries.length,
              callId: crypto.randomUUID(),
              phase,
              status: 'running',
              workItemIds: task.ids,
              input: task,
              inputFingerprint: await store.wait(hash(task)),
              promptHash: await store.wait(hash(systemPrompt)),
              attempt: 0,
              repairCount: 0,
              stepsUsed: 0,
              appliedCommitIds: [],
              reviewedItems: [],
              readSet: { records: [], queries: [] },
              createdAt: now(),
              updatedAt: now(),
            })
            await store.put('pipelineRuns', {
              bookId,
              id: task.id,
              runId: scope.runId,
              recordType: 'narrative_task',
              stage: 'P3',
              planVersion: '2.2',
              startedAt: now(),
              status: 'running',
              snapshot: task,
              taskInputVersion,
              systemPrompt,
              toolSchemas: toolDefinitions(task),
              placeholders: {},
              observed: narrativeVersions(assets, visibleNodes(plan, task, assets), plan.layer === 'event'),
            })
          } else if (task && summary) {
            const record = (await store.get('pipelineRuns', task.id))!
            const systemPrompt = narrativeSystemPrompt(prompt, task)
            const upgradeInput = record.taskInputVersion !== taskInputVersion
            const toolSchemas = toolDefinitions(task)
            if (
              upgradeInput ||
              record.systemPrompt !== systemPrompt ||
              canonical(record.toolSchemas) !== canonical(toolSchemas)
            ) {
              let updated: typeof record = { ...record, systemPrompt, toolSchemas }
              if (upgradeInput) {
                const session = (await store.get('storySessions', identity.sessionId))!
                refreshNarrativeTaskInput(plan, assets, task)
                summary.input = task
                summary.inputFingerprint = await store.wait(hash(task))
                updated = {
                  ...updated,
                  snapshot: task,
                  taskInputVersion,
                  contextStartOrdinal: Number(session.nextOrdinal),
                  placeholders: {},
                  observed: narrativeVersions(
                    assets,
                    visibleNodes(plan, task, assets),
                    plan.layer === 'event'
                  ),
                }
              }
              summary.promptHash = await store.wait(hash(systemPrompt))
              await store.put('pipelineRuns', updated)
            }
          }
          const progress = (await store.get('compileProgress', 'P3'))!
          if (progress.phase !== phase)
            await store.put('compileProgress', { ...progress, phase, updatedAt: now() })
          await store.put('pipelineRuns', { ...run, narrative: plan, phase, tasks: summaries })
          return { task, phase, keep: plan.config.keepRecentRounds }
        })
        const { task } = next
        if (!task) {
          await updateStatus('completed')
          publish(bookId, '全书叙事整理完成。')
          break
        }
        scope.taskId = task.id
        scope.phase = next.phase

        const restored = await repo.transaction(false, async (store) => {
          const record = (await store.get('pipelineRuns', task.id))!
          const entries = (
            store.sessionEntries
              ? await store.sessionEntries(identity.sessionId)
              : await store.rows('storySessionEntries')
          )
            .filter(
              (r) =>
                r.taskId === task.id &&
                r.type === 'message' &&
                (record.contextStartOrdinal === undefined ||
                  Number(r.ordinal) >= Number(record.contextStartOrdinal))
            )
            .sort((a, b) => Number(a.ordinal) - Number(b.ordinal))
          const raw = entries.flatMap(entryMessages),
            existing = new Set(raw.filter((m) => m.role === 'toolResult').map((m) => m.toolCallId))
          const messages = await Promise.all(
            repairToolPairs(raw).map(async (message) => {
              if (message.role !== 'toolResult' || existing.has(message.toolCallId)) return message
              const receipt = await store.get('pipelineRuns', task.id + ':' + message.toolCallId)
              return receipt?.recordType === 'narrative_receipt'
                ? {
                    ...message,
                    isError: false,
                    content: [{ type: 'text' as const, text: JSON.stringify(receipt.result) }],
                  }
                : message
            })
          )
          return { messages, record }
        })
        const tools = narrativeTools(repo, { ...scope }, task)
        const systemPrompt = text(restored.record.systemPrompt)
        const trace = new TraceSession(
          repo,
          { ...identity, bookId, taskId: task.id, executionId: crypto.randomUUID() },
          { businessPrompt: systemPrompt, purpose: 'work', captureRawBody: true }
        )
        publish(bookId, '正在处理 ' + task.ids.length + ' 项')
        try {
          let priorEditFailure = ''
          const saved = restored.record.placeholders as Record<string, string>
          const result = await models.agent(
            {
              systemPrompt,
              prompt: restored.messages.length ? '继续当前任务，已保存的操作可按编号查阅。' : task.prompt,
              tools: tools.tools,
              agent,
              messages:
                restored.messages[0]?.role === 'system'
                  ? [{ ...restored.messages[0], content: systemPrompt }, ...restored.messages.slice(1)]
                  : [
                      {
                        role: 'system',
                        content: systemPrompt,
                        timestamp: Date.parse(text(restored.record.startedAt)),
                      },
                      ...restored.messages,
                    ],
              onAgent: (value) => {
                agent = value
                agent.sessionId = identity.sessionId
              },
              beforeRequest: () => repo.transaction(false, (store) => checkLease(store, scope, signal)),
              beforeToolCall: async ({ toolCall }) =>
                toolCall.name === 'confirm' && priorEditFailure
                  ? { block: true, reason: '同轮的 ' + priorEditFailure + ' 未保存成功。依据工具回执修正后再确认。' }
                  : undefined,
              afterToolCall: async () => (tools.confirmed ? { terminate: true } : undefined),
              prepareRequest: async ({ context }) => {
                const projection = narrativeContext(context.messages, next.keep, saved)
                if (Object.keys(projection.additions).length) {
                  await repo.transaction(true, async (store) => {
                    await checkLease(store, scope, signal)
                    const r = (await store.get('pipelineRuns', task.id))!
                    await store.put('pipelineRuns', {
                      ...r,
                      placeholders: { ...saved, ...projection.additions },
                    })
                  })
                  Object.assign(saved, projection.additions)
                }
                return { context: { ...context, messages: projection.messages, tools: tools.tools } }
              },
              observeEvent: (event) => {
                if (event.type === 'message_start' && event.message.role === 'assistant') priorEditFailure = ''
                if (event.type === 'tool_execution_end' && event.isError &&
                  ['edit_events', 'edit_storylines', 'manage_doubts'].includes(event.toolName)) priorEditFailure = event.toolName
                trace.handleEvent(event)
              },
              onEvent: async (event) => {
                if (event.type === 'message_end')
                  await repo.transaction(true, async (store) => {
                    await checkLease(store, scope)
                    await appendEntry(store, scope, {
                      type: 'message',
                      message: event.message as AgentMessage,
                    })
                  })
              },
              validateFinal: () => {
                if (!tools.confirmed) throw Error('当前任务尚未确认，已保存进度。')
              },
              finishTurn: ({ message }) => {
                if (tools.confirmed || signal.aborted || ['error', 'aborted'].includes(message.stopReason))
                  return { action: 'end' }
                if (!message.content.some((p) => p.type === 'toolCall')) {
                  agent?.steer({
                    role: 'user',
                    content: '当前任务尚未确认。请查阅并保存必要修改，完成后调用 confirm。',
                    timestamp: Date.now(),
                  })
                  return { action: 'continue' }
                }
                return undefined
              },
            },
            {
              signal,
              cooperativeTimeout: true,
              messagesLast: true,
              unboundedRequests: true,
              requestTimeoutMs: 120000,
              useModelToolOutput: true,
              reasoning: 'low',
              trace: trace.hooks,
              tracePurpose: 'work',
            }
          )
          await repo.transaction(true, async (store) => {
            await checkLease(store, scope)
            const run = (await store.get('pipelineRuns', scope.runId))!,
              r = (await store.get('pipelineRuns', task.id))!
            const u = (run.narrativeUsage as Record<string, number>) ?? {}
            const usage = {
              ...u,
              unknown: Boolean(u.unknown) || result.usage.costStatus === 'unknown',
              requests: (u.requests ?? 0) + result.attempts.length,
            }
            for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'cost'] as const)
              Object.assign(usage, { [key]: (u[key] ?? 0) + (result.usage[key] ?? 0) })
            const status = tools.confirmed ? 'completed' : 'paused'
            await store.put('pipelineRuns', { ...r, status })
            await store.put('pipelineRuns', {
              ...run,
              narrativeUsage: usage,
              tasks: records(run.tasks).map((t) =>
                t.taskId === task.id
                  ? {
                      ...t,
                      status: tools.confirmed ? 'completed' : 'partial',
                      stepsUsed: Number(t.stepsUsed) + result.attempts.length,
                      updatedAt: now(),
                    }
                  : t
              ),
            })
          })
          if (!tools.confirmed) throw Error(result.error?.message ?? '当前任务尚未确认，已保存进度。')
        } finally {
          await trace.close()
        }
      }
    } catch (error) {
      const msg = lost
        ? '叙事执行权已变化。'
        : control.cancel
          ? '已取消叙事整理。'
          : signal.aborted
            ? '已暂停叙事整理。'
            : error instanceof Error
              ? error.message
              : String(error)
      if (lease && !lost) await updateStatus(control.cancel ? 'cancelled' : 'paused', msg).catch(() => {})
      publish(bookId, msg)
    } finally {
      clearInterval(timer)
      try {
        if (lease)
          await repo.transaction(true, async (store) => {
            const l = await store.get('pipelineRuns', 'lease:narrative')
            if (l?.owner !== scope.owner) return
            await store.remove('pipelineRuns', 'lease:narrative')
            const s = (await store.get('storySessions', scope.sessionId!))!
            if (s?.leaseOwner === scope.owner) {
              delete s.leaseOwner
              delete s.leaseUntil
              await store.put('storySessions', s)
            }
          })
      } finally {
        controls.delete(bookId)
        listeners.forEach((f) => f())
      }
    }
  }
  async function stop(bookId: string, cancel = false) {
    const control = controls.get(bookId)
    if (control) {
      control.cancel = cancel
      control.controller.abort()
      if (mechanical.isRunning(bookId)) await mechanical.stop(bookId)
      return
    }
    if (!cancel) return
    await createBookAgentRepository(workspace, bookId).transaction(true, async (store) => {
      const p = await store.get('compileProgress', 'P3')
      if (p?.planKey !== 'narrative-v4' || !['paused', 'running'].includes(text(p.status))) return
      if (Number((await store.get('pipelineRuns', 'lease:narrative'))?.expiresAt) > Date.now())
        throw Error('任务仍在其他窗口执行。')
      const r = (await store.get('pipelineRuns', text(p.runId)))!
      await store.put('pipelineRuns', { ...r, status: 'cancelled' })
      await store.put('compileProgress', { ...p, status: 'cancelled', updatedAt: now() })
    })
    publish(bookId, '已取消叙事整理。')
  }
  return {
    start,
    stop,
    read,
    eligibility,
    running: (id: string) => controls.has(id),
    message: (id: string) => messages.get(id),
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}
