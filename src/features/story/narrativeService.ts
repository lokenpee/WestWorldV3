import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core'
import type { Chapter, createWorkspace } from '../../lib/storage/workspace'
import { createBookAgentRepository, type AgentStore, type Row } from '../agents/repository'
import { historicalEventReply, inputAssignment } from './eventToolReply'
import { isEventWorkflow } from './eventToolsSchema'
import { indexReviewGroups, pairKey, pairVersion, rankCluePairs, type ReviewIndex } from './eventReviewGroups'
import { newReviewState, reviewIndexKey, twoStepMode } from './twoStepReview'
import { nodeMaterial } from './eventWorkflow'
import { bookVectorCache } from './eventVectorCache'
import { EventCandidateLoader } from './eventCandidates'
import { appendEntry, checkLease } from '../agents/commands'
import { entryMessages, repairToolPairs } from '../agents/context'
import { canonical, hash, records, strings, text } from '../agents/contracts'
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
  storylinesOnHold,
  type NarrativeAssets,
  type NarrativePlan,
  type NarrativeTask,
} from './narrativePlan'
import { narrativeTools, toolDefinitions } from './narrativeTools'
import { narrativeContext } from './narrativeContext'
import { narrativeVersions } from './narrativeBasis'
import { visibleNodes } from './narrativePlan'
import { formatLinkNodeInput, withReviewMaterialGuide } from './narrativeInput'
import { narrativeSystemPrompt } from './narrativePrompts'

type Workspace = ReturnType<typeof createWorkspace>
type Models = Pick<ModelService, 'settings' | 'agent'>
const now = () => new Date().toISOString()
function retrievalBasis(assets: NarrativeAssets) {
  return canonical([assets.nodes.map(node => [node.id,node.revision]),assets.events.map(event => [event.id,event.revision])])
}
async function available(store: AgentStore, reviewOnly=false) {
  const chapters = await store.rows('chapters')
  if (
    !reviewOnly && (!chapters.length ||
    !coverage(
      chapters as unknown as Chapter[],
      (await store.rows('extractionReceipts')) as unknown as Receipt[]
    ).allCovered)
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
  async function requiresCopy(bookId: string) {
    const db = workspace.openBook(bookId)
    const [progress, events, lines] = await Promise.all([db.table('compileProgress').get('P3'),
      db.table('storyEvents').count(), db.table('eventLines').count()])
    if (progress?.planKey === 'narrative-events-v1' && ['paused','running'].includes(progress.status)) return false
    return !!(progress?.runId || events || lines)
  }
  const canContinue = (row?: Row) => row?.status === 'paused' || row?.status === 'running'
  const cancelMessage = '已取消 P3。再次开始事件复核时将重新分组。'
  function latestReview<T extends Row>(rows: T[]) {
    return rows.filter(r=>r.recordType==='run' && (r.narrative as NarrativePlan | undefined)?.reviewOnly)
      .sort((a,b)=>text(b.startedAt).localeCompare(text(a.startedAt)))[0]
  }
  async function cancelProgress(store: AgentStore) {
    const progress = await store.get('compileProgress','P3')
    const review = latestReview(await store.rows('pipelineRuns'))
    const finishedAt = now()
    const cancelRun = (run: Row) => store.put('pipelineRuns',{
      ...run, status:'cancelled', finishedAt, lastNarrativeError:cancelMessage,
    })
    if (progress?.planKey === 'narrative-events-v1' && canContinue(progress)) {
      const main = await store.get('pipelineRuns',text(progress.runId))
      if (main && canContinue(main)) await cancelRun(main)
      await store.put('compileProgress',{...progress,status:'cancelled',updatedAt:finishedAt})
    }
    if (review && canContinue(review)) await cancelRun(review)
  }
  async function reviewRun(bookId:string) {
    const rows=await workspace.openBook(bookId).table('pipelineRuns').where('recordType').equals('run').toArray()
    return latestReview(rows)
  }
  async function read(bookId: string, reviewOnly=false) {
    const db = workspace.openBook(bookId)
    const progress = reviewOnly ? undefined : await db.table('compileProgress').get('P3')
    if (!reviewOnly && progress?.planKey !== 'narrative-events-v1') return undefined
    const run = reviewOnly ? await reviewRun(bookId) : await db.table('pipelineRuns').get(progress!.runId)
    if (!run?.narrative) return undefined
    const plan = run.narrative as NarrativePlan
    const [nodes, events, lines, notes] = await Promise.all(
      ['nodes', 'storyEvents', 'eventLines', 'storyEditorNotes'].map((name) => db.table(name).toArray())
    )
    const stats = {
      microDone: events.filter(e=>plan.twoStep?.checked[text(e.id)]===String(e.revision ?? 0)).length,
      macroDone: records(run.tasks).filter(t=>t.status==='completed' && (t.input as NarrativeTask)?.mode==='review_boundaries' && (t.input as NarrativeTask).part==='structure').length,
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
  async function start(bookId: string, reviewOnly=false) {
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
    const retrievalController = new AbortController()
    let lease = false,
      timer: ReturnType<typeof setInterval> | undefined,
      agent: Agent | undefined,
      lost = false
    async function updateStatus(status: string, error = '') {
      await repo.transaction(true, async (store) => {
        await checkLease(store, scope)
        const run = (await store.get('pipelineRuns', scope.runId))!,
          p = reviewOnly ? undefined : await store.get('compileProgress', 'P3')
        await store.put('pipelineRuns', { ...run, status, lastNarrativeError: error, finishedAt: now() })
        if (p) await store.put('compileProgress', { ...p, status, updatedAt: now() })
      })
    }
    try {
      const settings = await models.settings.read()
      if (!settings.configured || !settings.config.aggregationModel) throw Error('请先保存整理模型与密钥。')
      const lastReview=reviewOnly ? await reviewRun(bookId) : undefined
      const reviewProgress=(r:Row|undefined)=>r && ({planKey:'narrative-events-v1',runId:r.id,status:r.status})
      const initial = await repo.transaction(false, async (store) => {
        await available(store,reviewOnly)
        if (reviewOnly) return reviewProgress(lastReview)
        return store.get('compileProgress', 'P3')
      })
      const resume =
        initial?.planKey === 'narrative-events-v1' && ['paused', 'running'].includes(text(initial.status))
      if (!reviewOnly && !resume && await requiresCopy(bookId)) throw Error('这本书已有整理成果，请在副本中重建。')
      if (!reviewOnly && !resume) await mechanical.mergeExactNames(bookId, 'storyCharacters')
      signal.throwIfAborted()
      const identity = await repo.transaction(true, async (store) => {
        const totalChapters = await available(store,reviewOnly)
        const p = reviewOnly ? reviewProgress(lastReview && await store.get('pipelineRuns',text(lastReview.id))) : await store.get('compileProgress', 'P3')
        if (p?.runId !== initial?.runId || p?.status !== initial?.status)
          throw Error('本书进度已变化，请刷新后继续。')
        const duplicates = reviewOnly ? [] : findExactNameGroups(
          'character',
          (await store.rows('characters')) as unknown as Character[]
        )
        if (duplicates.length) throw Error('同名人物尚待合并：' + duplicates[0].memberIds.join('、'))
        const prior = resume ? await store.get('pipelineRuns', text(p?.runId)) : undefined
        if (resume && !prior?.narrative) throw Error('缺少本轮叙事任务记录。')
        const plan = (prior?.narrative as NarrativePlan) ?? { ...newNarrativePlan(), reuseAssigned: true }
        if (reviewOnly && !resume && !(await store.rows('storyEvents')).length) throw Error('当前书还没有可复核的事件。')
        if (reviewOnly) {
          plan.reviewOnly=true
          if (!prior) {
            const main=await store.get('compileProgress','P3')
            const original=main?.runId && await store.get('pipelineRuns',text(main.runId))
            plan.retained={...((original as Row)?.narrative as NarrativePlan)?.retained}
          }
        }
        const retiredTask=plan.active?.mode==='review_event' || (plan.active?.mode==='review_boundaries' && plan.active.part==='unassigned')
        if (plan.layer==='event' && (!plan.twoStep || retiredTask)) {
          if (retiredTask && plan.active) {
            const old=await store.get('pipelineRuns',plan.active.id)
            if (old) await store.put('pipelineRuns',{...old,status:'cancelled'})
            const history=records(prior?.tasks).find(t=>t.taskId===plan.active!.id)
            if (history) history.status='cancelled'
            delete plan.active
          }
          delete plan.awaitingStorylines
          plan.twoStep ??= newReviewState()
        }
        if (plan.twoStep?.pausedGroup?.orphanIds) {
          delete plan.twoStep.pausedGroup
          delete plan.twoStep.macroIssue
          delete plan.twoStep.retryMacro
        }
        const interrupted=plan.active
        if (resume && plan.twoStep && interrupted && twoStepMode(interrupted.mode)) {
          const snapshot=await store.get('pipelineRuns',interrupted.id)
          const observed=snapshot?.observed as Record<string,string>|undefined
          const events=await store.rows('storyEvents')
          const versions=new Map(events.map(e=>[text(e.id),String(e.revision ?? 0)]))
          if (observed && interrupted.ids.some(id=>observed['event:'+id]!==versions.get(id))) {
            await store.put('pipelineRuns',{...snapshot!,status:'cancelled'})
            const oldTask=records(prior?.tasks).find(t=>t.taskId===interrupted.id)
            if (oldTask) oldTask.status='cancelled'
            delete plan.active
            plan.twoStep.phase='macro'
          }
        }
        if (plan.twoStep && prior?.lastNarrativeError==='事件复核待核实，补充依据后可继续。') {
          plan.twoStep.retryIds=Object.keys(plan.twoStep.pending)
          plan.twoStep.retryMacro=true
        }
        if (storylinesOnHold && (plan.awaitingStorylines || plan.layer === 'line'))
          throw Error('第一阶段测试期间，故事线整理已暂停。')
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
        if (!reviewOnly && !resume && ((await store.rows('storyEvents')).length || (await store.rows('eventLines')).length))
          throw Error('书籍已有整理结果，请在副本中重建。')
        if (resume && prior?.lastNarrativeError === '事件复核待核实，补充依据后可继续。' && plan.eventReview)
          plan.eventReview.retryIds = Object.keys(plan.eventReview.pending)
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
        if (!reviewOnly) await store.put('compileProgress', {
          bookId,
          stage: 'P3',
          planKey: 'narrative-events-v1',
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
      const retrieval = await models.settings.retrieval.runtime()
      const loader = new EventCandidateLoader(retrieval.models, AbortSignal.any([signal,retrievalController.signal]), bookVectorCache(workspace,bookId,retrieval.vectorNamespace))
      const scoreCache=new Map<string,number>()
      let cachedIndex:ReviewIndex|undefined, rankedIndex:ReviewIndex|undefined, indexKey='', rankError=''
      const excluded=await repo.transaction(false,async store=>(await Promise.all(['characters','locations'].map(t=>store.rows(t))))
        .flat().flatMap(r=>[text(r.name),...strings(r.aliases),...strings(r.verifiedAliases)]))
      for (;;) {
        signal.throwIfAborted()
        const next = await repo.transaction(true, async (store) => {
          await checkLease(store, scope, signal)
          const run = (await store.get('pipelineRuns', scope.runId))!,
            plan = run.narrative as NarrativePlan
          const assets = await narrativeAssets(store, identity.sessionId)
          const requiresIndex=plan.layer==='event' && !plan.active && (plan.reviewOnly || assets.nodes.every(n=>Object.hasOwn(plan.nodes,text(n.id))))
          const macro=plan.twoStep?.phase!=='micro'
          const key=requiresIndex ? (macro?'macro':'micro')+reviewIndexKey(assets) : ''
          if (requiresIndex && (!cachedIndex || indexKey!==key)) return {refreshAssets:assets,macro,key}
          if (requiresIndex && macro && cachedIndex && rankedIndex!==cachedIndex && !rankError &&
              !plan.twoStep?.pausedGroup && !plan.twoStep?.referral) {
            const index=cachedIndex, reviewed=plan.twoStep?.pairs ?? {}
            const needs=({ids}:{ids:string[]})=>reviewed[pairKey(ids)]!==pairVersion(ids,index.events)
            if (!index.overlap.some(needs) && index.semantic.some(needs)) return {rankIndex:index}
          }
          const task = scheduleNarrative(plan, assets,cachedIndex)
          if (task?.mode==='review_boundaries' && rankError) task.retrieval={degraded:rankError}
          const taskInputVersion = plan.layer === 'line' ? 9 : task?.mode === 'link_node' ? 7 : task && twoStepMode(task.mode) ? 2 : 1
          const phase = plan.layer === 'event' ? 'window_link' : 'global_review'
          const summaries = records(run.tasks)
          const summary = task && summaries.find((row) => row.taskId === task.id)
          if (task && !summary) {
            const systemPrompt = narrativeSystemPrompt(task)
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
              observed: { ...narrativeVersions(assets, visibleNodes(plan, task, assets), plan.layer === 'event'), ...((twoStepMode(task.mode) || task.mode === 'review_event') && task.basis) },
            })
          } else if (task && summary) {
            const record = (await store.get('pipelineRuns', task.id))!
            const systemPrompt = narrativeSystemPrompt(task)
            const upgradeInput = record.taskInputVersion !== taskInputVersion
            const toolSchemas = toolDefinitions(task)
            if (
              upgradeInput ||
              record.systemPrompt !== systemPrompt ||
              canonical(record.toolSchemas) !== canonical(toolSchemas)
            ) {
              let updated: typeof record = { ...record, systemPrompt, toolSchemas }
              if (upgradeInput && task.mode === 'link_node') {
                delete task.retrieval
                summary.input = task
                summary.inputFingerprint = await store.wait(hash(task))
                updated = { ...updated, snapshot: task, taskInputVersion }
              } else if (upgradeInput && twoStepMode(task.mode)) {
                task.prompt = JSON.stringify(withReviewMaterialGuide(JSON.parse(task.prompt)))
                summary.input = task
                summary.inputFingerprint = await store.wait(hash(task))
                updated = { ...updated, snapshot: task, taskInputVersion }
              } else if (upgradeInput) {
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
          const progress = reviewOnly ? undefined : await store.get('compileProgress', 'P3')
          const waiting = !task && plan.awaitingStorylines === true
          if (progress && (waiting || progress.phase !== phase))
            await store.put('compileProgress', { ...progress, phase, status: waiting ? 'paused' : progress.status, updatedAt: now() })
          await store.put('pipelineRuns', { ...run, narrative: plan, phase, tasks: summaries, status: waiting ? 'paused' : run.status })
          const nextNode = task?.mode === 'link_node'
            ? assets.nodes.find(n=>n.id!==task.ids[0] && !Object.hasOwn(plan.nodes,text(n.id))) : undefined
          return { task, phase, waiting, keep: plan.config.keepRecentRounds, nextNodeId:text(nextNode?.id),
            assets: task?.mode === 'link_node' ? assets : undefined }
        })
        if (next.refreshAssets) {
          const source=next.refreshAssets
          cachedIndex=indexReviewGroups(source,excluded,next.macro)
          indexKey=next.key
          continue
        }
        if (next.rankIndex) {
          rankedIndex=next.rankIndex
          try { await rankCluePairs(rankedIndex,retrieval.models,signal,scoreCache) }
          catch(error) {
            signal.throwIfAborted()
            rankError='线索候选重排降级：'+(error instanceof Error ? error.message : String(error))
          }
          continue
        }
        const { task } = next
        if (next.waiting) break
        if (!task) {
          await updateStatus('completed')
          publish(bookId, reviewOnly ? '事件复核完成。' : '全书叙事整理完成。')
          break
        }
        const basis = next.assets && retrievalBasis(next.assets)
        const sourceFingerprint = basis && await hash(basis)
        let vectorError: string | undefined
        if (task.mode === 'link_node') {
          vectorError = await loader.prepare(next.assets!, (ready,total) => {
            publish(bookId, '正在计算向量 · 已就绪 '+ready+'/'+total+' 项')
          })
          signal.throwIfAborted()
        }
        if (task.mode === 'link_node' && (task.retrieval?.sourceFingerprint !== sourceFingerprint || task.retrieval?.configVersion !== retrieval.configVersion || task.retrieval?.degraded || vectorError)) {
          const assets = next.assets!
          const index = assets.nodes.findIndex(n => n.id === task.ids[0])
          if (index < 0) throw Error('当前节点已移除，请核对本书节点。')
          publish(bookId, vectorError ?? '向量已就绪，正在为当前节点排序候选事件…')
          const result = await loader.rankPrepared(task.ids[0],assets,vectorError)
          const persisted = await repo.transaction(true, async store => {
            await checkLease(store,scope,signal)
            const latest = await narrativeAssets(store,identity.sessionId)
            if (basis !== retrievalBasis(latest)) return false
            const run = (await store.get('pipelineRuns',scope.runId))!
            const plan = run.narrative as NarrativePlan
            if (plan.active?.id !== task.id) throw Error('当前节点任务已切换。')
            const node = latest.nodes[index]
            const material = nodeMaterial(node,latest,index)
            task.prompt = formatLinkNodeInput(material, result.candidates, latest.events.length)
            task.retrieval = {sourceFingerprint,configVersion:retrieval.configVersion, ...(result.degraded && {degraded:result.degraded})}
            plan.active = task
            const record = (await store.get('pipelineRuns',task.id))!
            const fingerprint = await store.wait(hash(task))
            const observed = {
              ...record.observed as Record<string,string>,
              ...narrativeVersions(latest,visibleNodes(plan,task,latest),true),
            }
            // 候选卡已列出全部成员，可直接基于同一版本修改归属。
            const candidates = new Map(result.candidates.map(candidate => [candidate.event_id, candidate]))
            for (const event of latest.events) {
              const id = text(event.id)
              const candidate = candidates.get(id)
              if (candidate && candidate.members.length === strings(event.nodeIds).length)
                observed['members:event:'+id] = observed['event:'+id]
            }
            const original = record.snapshot as NarrativeTask
            const initialNodeAssigned = record.initialNodeAssigned ?? inputAssignment(original.prompt,task.ids[0])
            await store.put('pipelineRuns',{...record,snapshot:task,observed,...(typeof initialNodeAssigned === 'boolean' && {initialNodeAssigned})})
            await store.put('pipelineRuns',{...run,narrative:plan,tasks:records(run.tasks).map(t=>t.taskId===task.id ?
              {...t,input:task,inputFingerprint:fingerprint} : t)})
            return true
          })
          if (!persisted) continue
        } else if (task.mode === 'link_node') {
          // 即使可以复用候选，补算向量期间也可能有新的书库版本。
          const latestBasis = await repo.transaction(false, async store => retrievalBasis(await narrativeAssets(store,identity.sessionId)))
          if (latestBasis !== basis) continue
        }
        if (scope.taskId !== task.id) agent=undefined
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
          if (isEventWorkflow(task.mode) && raw.length) {
            const inputIndex = raw.findIndex(message => {
              if (message.role !== 'user') return false
              const body = typeof message.content === 'string' ? message.content
                : message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
              if (task.mode === 'review_boundaries') return /^\{\s*"(?:资料说明|本组事件)"/.test(body)
              if (task.mode === 'review_sequence') return /^\{\s*"(?:资料说明|主审事件)"/.test(body)
              if (task.mode === 'review_event') return /^\{\s*"(?:当前事件|全书事件目录)"/.test(body)
              return body.startsWith('【当前节点概览开始】') || /^\{\s*"当前节点"/.test(body)
            })
            const previous = raw[inputIndex]
            if (previous?.role === 'user') raw[inputIndex] = {...previous,content:task.prompt}
            else raw.splice(raw[0].role === 'system' ? 1 : 0,0,{role:'user',content:task.prompt,timestamp:raw[0].timestamp})
          }
          const calls = new Map(raw.flatMap(m => m.role === 'assistant'
            ? m.content.flatMap(part => part.type === 'toolCall' ? [[part.id,part.arguments] as const] : []) : []))
          const projectReply = historicalEventReply(store,task,identity.sessionId)
          const messages = await Promise.all(
            repairToolPairs(raw).map(async message => {
              if (message.role !== 'toolResult') return message
              const missing = !existing.has(message.toolCallId)
              const receipt = missing ? await store.get('pipelineRuns',task.id + ':' + message.toolCallId) : undefined
              if (missing && receipt?.recordType !== 'narrative_receipt') return message
              if (!missing && (message.isError || !isEventWorkflow(task.mode))) return message
              let body = receipt?.result ?? message.details
              if (!body) {
                const part = message.content.find(part => part.type === 'text')
                if (part?.type !== 'text') return message
                try { body = JSON.parse(part.text) } catch { return message }
              }
              const args = receipt?.arguments ?? calls.get(message.toolCallId) ?? {}
              const reply = isEventWorkflow(task.mode)
                ? await projectReply(message.toolCallId,message.toolName,args as Row,body as Row) : body
              return {...message, isError:false, details:reply as typeof message.details, content:[{type:'text' as const,text:JSON.stringify(reply)}]}
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
        publish(bookId, task.mode === 'link_node'
          ? (vectorError ? vectorError+' ' : '')+'正在串联节点 '+task.ids[0]
          : task.mode==='review_sequence' ? '正在逐件主审 · '+task.ids[0] : task.mode==='review_boundaries' ? '正在宏观复核 · '+(task.ids.length+' 件事件') : '正在处理 ' + task.ids.length + ' 项')
        try {
          if (next.nextNodeId && next.assets) loader.prefetch(next.nextNodeId,next.assets)
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
                const projection = narrativeContext(context.messages, next.keep, saved, task.mode)
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
              reasoning: twoStepMode(task.mode) ? 'high' : 'low',
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
            const status = tools.confirmed && !tools.pendingReview ? 'completed' : 'paused'
            await store.put('pipelineRuns', { ...r, status })
            await store.put('pipelineRuns', {
              ...run,
              narrativeUsage: usage,
              tasks: records(run.tasks).map((t) =>
                t.taskId === task.id
                  ? {
                      ...t,
                      status: tools.confirmed && !tools.pendingReview ? 'completed' : 'partial',
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
          ? cancelMessage
          : signal.aborted
            ? '已暂停叙事整理。'
            : error instanceof Error
              ? error.message
              : String(error)
      if (lease && !lost && !control.cancel) await updateStatus('paused', msg).catch(() => {})
      publish(bookId, msg)
    } finally {
      retrievalController.abort()
      clearInterval(timer)
      try {
        if (lease || control.cancel)
          await repo.transaction(true, async (store) => {
            const l = await store.get('pipelineRuns', 'lease:narrative')
            if (control.cancel && !lost) {
              if ((lease && l?.owner !== scope.owner) || (l?.owner !== scope.owner && Number(l?.expiresAt)>Date.now()))
                throw Error('任务执行权已变化，请刷新后核对 P3 状态。')
              await cancelProgress(store)
            }
            if (!lease || l?.owner !== scope.owner) return
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
      control.cancel ||= cancel
      control.controller.abort()
      if (mechanical.isRunning(bookId)) await mechanical.stop(bookId)
      return
    }
    if (!cancel) return
    await createBookAgentRepository(workspace,bookId).transaction(true, async store => {
      if (Number((await store.get('pipelineRuns','lease:narrative'))?.expiresAt)>Date.now())
        throw Error('任务仍在其他窗口执行。')
      await cancelProgress(store)
    })
    publish(bookId, cancelMessage)
  }
  return {
    start,
    stop,
    read,
    eligibility,
    requiresCopy,
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
