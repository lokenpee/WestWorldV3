import { readEventTool, editEvents, confirmEvent } from './eventWorkflow'
import { captureEventDisplay } from './eventTaskOutcome'
import { historicalEventReply, eventToolReply } from './eventToolReply'
import { isEventWorkflow } from './eventToolsSchema'
import { Value } from 'typebox/value'
import { NarrativeToolError, type NarrativeErrorDetails } from './narrativeErrors'
import { confirmationInstruction } from './narrativeInput'
import { confirmedOutcome, type Outcome } from './narrativeOutcome'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { canonical, records, strings, text, validate, toolContracts } from '../agents/contracts'
import { checkLease, type ReadSet } from '../agents/commands'
import type { Scope } from '../agents/queries'
import type { AgentRepository, Row } from '../agents/repository'
import type { TSchema } from 'typebox'
import contractText from '../../../docs/v2/resources/v2.2/tool-contracts.json?raw'
import {
  detailFields,
  nodeFieldAliases,
  readableFields,
  type DetailKind,
  narrativeToolDescription,
  narrativeToolSchemas,
  type NarrativeRules,
} from './narrativeToolSchema'
import { applyOutline, OutlineError } from './outlineCommands'
import { narrativeVersions, changeKeys, checkNarrativeVersions } from './narrativeBasis'
import {
  catalog,
  confirmNarrative,
  narrativeAssets,
  visibleNodes,
  type NarrativeAssets,
  type NarrativePlan,
  type NarrativeTask,
} from './narrativePlan'

const rules = JSON.parse(contractText).narrativeV4 as NarrativeRules
export const toolDefinitions = (task: NarrativeTask) =>
  narrativeToolSchemas(
    task,
    rules,
    toolContracts.story_editor.find((x) => x.name === 'save_story_outline')!.parameters
  )
const argumentFields = (schema: TSchema, value: unknown, prefix = '') => {
  const object = value && typeof value === 'object' ? value : {}
  const required = strings((schema as { required?: unknown }).required).filter(
    (key) => !Object.hasOwn(object, key)
  )
  const paths = [...Value.Errors(schema, value)]
    .flatMap(error => {
      const params = error.params as {requiredProperties?:string[];additionalProperties?:string[]}
      const keys = params.requiredProperties ?? params.additionalProperties
      return keys ? keys.map(key => error.instancePath + '/' + key) : [error.instancePath]
    })
    .filter((path) => path && path !== '/')
  return [...new Set([...required.map((key) => '/' + key), ...paths])]
    .slice(0, 8)
    .map((path) => prefix + path)
}

function failurePayload(error: unknown, tool: string, task: NarrativeTask, raw?: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const prefix = /^([A-Z_]+):\s*/.exec(message)
  const code = error instanceof NarrativeToolError ? error.code : (prefix?.[1] ?? 'TOOL_FAILED')
  const context: NarrativeErrorDetails = error instanceof NarrativeToolError ? { ...error.context } : {}
  if (error instanceof OutlineError && error.opIndex !== undefined) {
    const operation = records((raw as Row | undefined)?.operations)[error.opIndex]
    const ids = [
      operation?.eventId,
      operation?.lineId,
      operation?.fromEventId,
      operation?.fromLineId,
      ...strings(operation?.nodeIds),
    ]
    context.operationNumber = error.opIndex + 1
    context.objectIds = ids.filter((id): id is string => typeof id === 'string')
  }
  const hint =
    context.hint ??
    (tool === 'confirm'
      ? confirmationInstruction(task)
      : code === 'READ_REQUIRED' || code === 'SCOPE' || code === 'UNKNOWN_OBJECT' || code === 'CONFLICT'
        ? '核对当前任务中的对象编号与范围，重新读取后提交。'
        : '按错误位置修正参数或对象；确认前核对工具返回。')
  return {
    ok: false,
    tool,
    code,
    reason: prefix ? message.slice(prefix[0].length) : message,
    taskId: task.id,
    mode: task.mode,
    part: task.part,
    ...context,
    hint,
  }
}

function sliceValue(v: unknown, offset: number) {
  if (typeof v === 'string' && (offset || v.length > 2000))
    return {
      value: v.slice(offset, offset + 2000),
      total: v.length,
      next: offset + 2000 < v.length ? offset + 2000 : null,
    }
  if (Array.isArray(v) && (offset || v.length > 20))
    return {
      value: v.slice(offset, offset + 20),
      total: v.length,
      next: offset + 20 < v.length ? offset + 20 : null,
    }
  return v
}
function details(args: Row, a: NarrativeAssets, visible: Set<string>, eventLayer: boolean) {
  return records(args.requests).map((req) => {
    const id = text(req.id),
      kind = req.kind
    const rows = kind === 'node' ? a.nodes : kind === 'event' ? a.events : a.lines
    const r = rows.find((row) => row.id === id)
    const requested = strings(req.fields)
    if (!r || (kind === 'node' && !visible.has(id)) || (kind === 'line' && eventLayer))
      return { id, values: {}, unavailable: requested, message: '该编号没有本任务可读取的资料。' }
    const complete = kind !== 'event' || strings(r.nodeIds).every((i) => visible.has(i))
    const allowed = readableFields(kind as DetailKind)
    const unsupported = requested.filter((field) => field !== '*' && !allowed.includes(field))
    const fields = requested.includes('*')
      ? [...new Set([...detailFields[kind as DetailKind], ...requested.filter((field) => field !== '*')])]
      : requested
    const hint = kind === 'node' && unsupported.includes('text') ? '。原文摘录用 quote，经过用 process' : ''
    const source =
      kind === 'node'
        ? {
            ...r,
            ...Object.fromEntries(Object.entries(nodeFieldAliases).map(([alias, key]) => [alias, r[key]])),
          }
        : r
    const available = (field: string) =>
      allowed.includes(field) &&
      source[field] !== undefined &&
      (complete || (field !== 'summary' && field !== 'coreClue' && field !== 'clues'))
    return {
      id,
      values: Object.fromEntries(
        fields
          .filter((k) => available(k))
          .map((k) => [
            k,
            sliceValue(
              kind === 'event' && k === 'nodeIds' ? strings(r[k]).filter((i) => visible.has(i)) : source[k],
              Number(req.offset ?? 0)
            ),
          ])
      ),
      unavailable: fields.filter((k) => !available(k)),
      ...(unsupported.length ? { message: '该对象不支持字段 ' + unsupported.join('、') + hint + '。' } : {}),
    }
  })
}
function directory(args: Row, a: NarrativeAssets, visible: Set<string>, plan: NarrativePlan) {
  if (plan.layer === 'event' && ['lines', 'unassigned_events'].includes(text(args.kind)))
    throw Error('本阶段只可查事件与节点。')
  const index = catalog(plan, a, visible, false)
  let rows: unknown[]
  if (args.id) {
    const line = args.kind === 'lines',
      parent = (line ? a.lines : a.events).find((r) => r.id === args.id)
    if (!parent)
      throw new NarrativeToolError('UNKNOWN_OBJECT', '目录中找不到要展开的对象。', {
        fields: ['id'],
        objectIds: [text(args.id)],
        hint: '按当前目录中的编号查询，kind 要与对象类型一致。',
      })
    const members = strings(parent[line ? 'eventIds' : 'nodeIds'])
    rows = (line ? a.events : a.nodes)
      .filter((r) => members.includes(text(r.id)) && (line || visible.has(text(r.id))))
      .map((r) => ({ id: r.id, name: r.title ?? r.name }))
  } else if (args.kind === 'unassigned_nodes')
    rows = a.nodes
      .filter(
        (r) => visible.has(text(r.id)) && !a.events.some((e) => strings(e.nodeIds).includes(text(r.id)))
      )
      .map((r) => ({ id: r.id, name: r.name, summary: r.summary }))
  else if (args.kind === 'unassigned_events')
    rows = a.events
      .filter((r) => !a.lines.some((l) => strings(l.eventIds).includes(text(r.id))))
      .map((r) => ({ id: r.id, title: r.title, summary: r.summary }))
  else rows = args.kind === 'lines' ? (index.lines ?? []) : index.events
  const offset = Number(args.offset ?? 0)
  return {
    rows: rows.slice(offset, offset + plan.config.segmentSize),
    total: rows.length,
    next: offset + plan.config.segmentSize < rows.length ? offset + plan.config.segmentSize : null,
  }
}
export function narrativeTools(repo: AgentRepository, scope: Scope, initial: NarrativeTask) {
  let confirmed = false
  let pendingReview = false
  const currentSchemas = toolDefinitions(initial)
  function checkArguments(name: string, raw: unknown) {
    // 旧版串联工具曾公开复核参数；恢复旧调用时只确认当前节点。
    if (initial.mode === 'link_node' && name === 'confirm' && raw && typeof raw === 'object' && Object.hasOwn(raw,'reviewed_event_ids')) {
      const {reviewed_event_ids: _ignored, ...nodeArgs} = raw as Row
      raw = nodeArgs
    }
    type Branch = TSchema & { properties: Record<string, { const?: string }> }
    const schema = currentSchemas[name]
    const validateBranch = (
      branches: Branch[],
      key: string,
      value: unknown,
      label: string,
      index?: number,
      listKey = 'operations'
    ) => {
      const prefix = index === undefined ? '' : '/' + listKey + '/' + index
      const position = index === undefined ? {} : { operationNumber: index + 1 }
      const rawValue = value as Row | null
      const branch = branches.find((candidate) => candidate.properties[key].const === rawValue?.[key])
      if (!branch) {
        const expectedValues = branches.map((candidate) => text(candidate.properties[key].const))
        throw new NarrativeToolError(
          'INVALID_ARGUMENT',
          label + '允许 ' + key + ' 为 ' + expectedValues.join('、'),
          {
            ...position,
            fields: [prefix + '/' + key],
            expectedValues,
          }
        )
      }
      try {
        validate(branch, value, label + '参数不符合要求。')
      } catch (error) {
        throw new NarrativeToolError('INVALID_ARGUMENT', (error as Error).message, {
          ...position,
          fields: argumentFields(branch, value, prefix),
        })
      }
    }
    try {
      validate(currentSchemas[name], raw)
    } catch (error) {
      if (name === 'edit_events' || name === 'edit_storylines') {
        const listKey = isEventWorkflow(initial.mode) ? 'changes' : 'operations'
        const operations = (raw as Row | null)?.[listKey]
        const branches = (schema as unknown as { properties: Record<string,{items:{oneOf:Branch[]}}> })
          .properties[listKey].items.oneOf
        if (Array.isArray(operations))
          for (const [index, op] of operations.entries())
            validateBranch(
              branches,
              'op',
              op,
              '第 ' + (index + 1) + ' 个编辑（' + (text(op?.op) || '缺少 op') + '）。',
              index, listKey
            )
      } else if (name === 'manage_doubts' || name === 'get_outline') {
        validateBranch(
          (schema as unknown as { oneOf: Branch[] }).oneOf,
          name === 'manage_doubts' ? 'action' : 'kind',
          raw,
          name === 'manage_doubts' ? '疑点操作。' : '目录查询。'
        )
      }
      if (name === 'confirm') {
        const extra = Object.keys((raw ?? {}) as Row).filter(
          (key) => !Object.hasOwn((currentSchemas.confirm as unknown as { properties: Row }).properties, key)
        )
        const fields = [...Value.Errors(schema, raw)].flatMap(error => {
          const params = error.params as { requiredProperties?: string[]; additionalProperties?: string[] }
          const keys = params.requiredProperties ?? params.additionalProperties
          return keys ? keys.map(key => error.instancePath + '/' + key) : [error.instancePath || '/']
        })
        const reason = extra.length
          ? '当前任务不接受 ' + extra.join('、')
          : error instanceof Error
            ? error.message
            : String(error)
        throw new NarrativeToolError('INVALID_ARGUMENT', '确认失败，仍在当前任务。' + reason, {
          fields: extra.length ? extra : [...new Set(fields)],
          hint: confirmationInstruction(initial),
        })
      }
      throw new NarrativeToolError(
        'INVALID_ARGUMENT',
        error instanceof Error ? error.message : String(error),
        {
          fields: argumentFields(schema, raw),
        }
      )
    }
    return raw
  }
  const tools: AgentTool[] = Object.entries(currentSchemas).map(([name, parameters]) => ({
    name,
    label: name,
    description: narrativeToolDescription(name, initial),
    parameters,
    prepareArguments: (raw: unknown) => {
      try {
        return checkArguments(name, raw)
      } catch (error) {
        throw new Error(JSON.stringify(failurePayload(error, name, initial, raw)))
      }
    },
    async execute(callId, raw, signal) {
      try {
        const args = checkArguments(name, raw) as Row,
          timestamp = new Date().toISOString()
        const result = await repo.transaction(
          true,
          async (store) => {
            await checkLease(store, scope, signal)
            const run = (await store.get('pipelineRuns', scope.runId))!
            const plan = run.narrative as NarrativePlan
            const receiptId = scope.taskId + ':' + callId
            const old = await store.get('pipelineRuns', receiptId)
            if (old) {
              if (old.runId !== scope.runId || old.signature !== canonical([name, args]))
                throw Error('操作键与原请求内容不符。')
              return isEventWorkflow(initial.mode)
                ? historicalEventReply(store,initial,scope.sessionId)(callId,name,args,old.result as Row)
                : old.result
            }
            const task = plan.active
            if (task?.id !== scope.taskId || task.mode !== initial.mode || task.part !== initial.part)
              throw Error('当前任务已切换，请重新读取。')
            const a = await narrativeAssets(store, scope.sessionId!),
              visible = visibleNodes(plan, task, a)
            const snapshot = (await store.get('pipelineRuns', task.id))!
            const seen = snapshot.observed as Record<string, string>,
              current = narrativeVersions(a, visible, plan.layer === 'event')
            let refreshed: string[] = []
            let outcome: Outcome | undefined
            let reviewResults: ReturnType<typeof confirmNarrative>
            let value: unknown
            if (isEventWorkflow(task.mode)) {
              if (name === 'edit_events') {
                const keys = records(args.changes).flatMap(change => [
                  ...(change.event_id ? ['event:'+change.event_id] : []),
                  ...strings(change.replacement_event_ids).map(id=>'event:'+id),
                  ...[...strings((change.fields as Row)?.nodeIds), ...strings(change.evidence_node_ids)].map(id=>'node:'+id),
                ])
                for (const change of records(args.changes)) {
                  if (task.mode==='review_boundaries' && change.op==='delete' && seen['read:event:'+change.event_id]!==current['event:'+change.event_id]) throw Error('请用 get_event 核对要撤销事件的最新资料。')
                  const id = text(change.event_id)
                  if (change.op==='update' && (change.fields as Row)?.nodeIds &&
                    !(task.mode==='review_event' && task.ids.includes(id)) && seen['members:event:'+id]!==current['event:'+id])
                    throw Error('请用 get_event 取得该事件最新完整成员，再替换 nodeIds。')
                }
                checkNarrativeVersions(keys,seen,current)
                value = await editEvents(store,scope.bookId,args,task,plan,a)
              } else if (name === 'confirm') {
                checkNarrativeVersions(task.mode === 'review_boundaries' ? task.ids.map(id=>'event:'+id) : task.mode === 'link_node' ? ['node:'+task.ids[0]] :
                  [task.ids[0],...strings(args.reviewed_event_ids)].map(id=>'event:'+id),seen,current)
                if (task.mode === 'review_event') for (const id of strings(args.reviewed_event_ids))
                  if (!task.ids.includes(id) && seen['read:event:'+id]!==current['event:'+id])
                    throw Error('尚未读全该事件的最新版本，请用 get_event 核对后再连带确认。')
                confirmEvent(plan,a,args)
                if (task.mode === 'link_node') outcome = confirmedOutcome(task,plan,a,args)
                value = {confirmed:true, result:args.result, taskId:task.id}
              } else {
                const result = readEventTool(name,args,task,a)
                if (name === 'get_nodes' || name === 'search_prior_nodes') refreshed = records(result.items).map(n=>'node:'+n.node_id)
                if (name === 'get_event' && result.status !== 'not_found') {
                  const key='event:'+result.event_id
                  refreshed=[key]
                  seen['members:'+key]=current[key]
                  seen['read:'+key]=current[key]
                }
                value = result
              }
            } else if (name === 'get_detail') {
              value = details(args, a, visible, plan.layer === 'event')
              refreshed = records(args.requests).map((r) => r.kind + ':' + r.id)
            } else if (name === 'get_outline') value = directory(args, a, visible, plan)
            else if (name === 'manage_doubts') {
              const note = a.notes.find((n) => n.id === args.id)
              if (args.action === 'list') {
                value = a.notes
                  .filter((n) => (args.id ? n.id === args.id : n.status === 'active'))
                  .slice(Number(args.offset ?? 0), Number(args.offset ?? 0) + plan.config.segmentSize)
                  .map(({ nodeIds, lineIds, ...note }) => ({
                    ...note,
                    nodeIds: strings(nodeIds).filter((id) => visible.has(id)),
                    ...(plan.layer === 'line' ? { lineIds: strings(lineIds) } : {}),
                  }))
                refreshed = records(value).map((n) => 'doubt:' + n.id)
              } else {
                checkNarrativeVersions(
                  [args.id, args.otherId].filter(Boolean).map((id) => 'doubt:' + id),
                  seen,
                  current
                )
                if (args.action === 'create' && args.id !== undefined) throw Error('新疑点由程序分配编号。')
                if (args.action !== 'create' && !note)
                  throw new NarrativeToolError('UNKNOWN_OBJECT', '找不到该疑点。', {
                    fields: ['id'],
                    objectIds: [text(args.id)],
                  })
                if (args.action === 'delete') {
                  await store.remove('storyEditorNotes', text(note!.id))
                  value = { id: note!.id, action: args.action }
                } else {
                  const ids = strings(args.nodeIds ?? note?.nodeIds),
                    events = strings(args.eventIds ?? note?.eventIds),
                    lines = strings(args.lineIds ?? note?.lineIds)
                  const category = text(args.category ?? note?.category ?? 'OTHER'),
                    statement = text(args.statement ?? note?.statement).trim()
                  if (!statement) throw Error('请填写疑点陈述 statement。')
                  if (args.nodeIds !== undefined && ids.some((id) => !visible.has(id)))
                    throw Error('nodeIds 只能关联当前可读取的节点。')
                  if (args.eventIds !== undefined && events.some((id) => !a.events.some((r) => r.id === id)))
                    throw Error('eventIds 只能关联目录中的事件。')
                  if (args.lineIds !== undefined && lines.some((id) => !a.lines.some((r) => r.id === id)))
                    throw Error('lineIds 只能关联目录中的故事线。')
                  if (category === 'NODE_ASSIGNMENT' && !ids.length)
                    throw Error('节点归属疑点须在 nodeIds 填写待核对的节点编号。')
                  if (category === 'EVENT_ASSIGNMENT' && !events.length)
                    throw Error('事件归属疑点须在 eventIds 填写待核对的事件编号。')
                  const id = text(note?.id) || crypto.randomUUID()
                  const updated: Row = {
                    ...note,
                    id,
                    key: note?.key ?? id,
                    bookId: scope.bookId,
                    sessionId: scope.sessionId,
                    kind: 'review',
                    stage: 'P3',
                    category,
                    statement,
                    nodeIds: ids,
                    eventIds: events,
                    lineIds: lines,
                    evidence: note?.evidence ?? [],
                    basisFingerprint: canonical([ids, events, lines]),
                    createdAt: note?.createdAt ?? timestamp,
                    updatedAt: timestamp,
                    revision: Number(note?.revision ?? 0) + 1,
                    status:
                      args.action === 'resolve'
                        ? 'resolved'
                        : args.action === 'reopen'
                          ? 'active'
                          : (note?.status ?? 'active'),
                  }
                  if (args.action === 'resolve') {
                    if (!text(args.reason).trim()) throw Error('请填写解决依据。')
                    if (
                      category === 'NODE_ASSIGNMENT' &&
                      ids.some(
                        (node) =>
                          !plan.retained[node] &&
                          !a.events.some((event) => strings(event.nodeIds).includes(node))
                      )
                    )
                      throw Error('请先核实节点归属或保留为独立节点。')
                    if (
                      category === 'EVENT_ASSIGNMENT' &&
                      events.some((event) => !a.lines.some((line) => strings(line.eventIds).includes(event)))
                    )
                      throw Error('请先保存事件的故事线归属。')
                    updated.resolution = args.reason
                  }
                  if (args.action === 'merge') {
                    const other = a.notes.find((n) => n.id === args.otherId && n.id !== id)
                    if (!other || other.category !== category) throw Error('请选择另一条同类疑点。')
                    for (const key of ['nodeIds', 'eventIds', 'lineIds'])
                      updated[key] = [...new Set([...strings(updated[key]), ...strings(other[key])])]
                    await store.remove('storyEditorNotes', text(other.id))
                  }
                  await store.put('storyEditorNotes', updated)
                  value = { id, action: args.action }
                }
              }
            } else if (name === 'confirm') {
              const kind =
                task.part === 'doubts'
                  ? 'doubt'
                  : task.part === 'batch' || task.part === 'unassigned'
                    ? plan.layer === 'event'
                      ? 'node'
                      : 'event'
                    : plan.layer
              checkNarrativeVersions(
                [...new Set([...task.ids, ...strings(args.handled_event_ids)])].map((id) => kind + ':' + id),
                seen,
                current
              )
              reviewResults = confirmNarrative(plan, a, args)
              if (task.part === 'batch') outcome = confirmedOutcome(task, plan, a, args)
              value = { confirmed: true, taskId: task.id }
            } else {
              const ops = records(args.operations)
              checkNarrativeVersions(changeKeys(ops), seen, current)
              for (const [index, op] of ops.entries()) {
                const unavailable = strings(op.nodeIds).filter((id) => !visible.has(id))
                if (unavailable.length)
                  throw new NarrativeToolError('OBJECT_OUT_OF_SCOPE', '节点尚未开放。', {
                    fields: ['nodeIds'],
                    objectIds: unavailable,
                    operationNumber: index + 1,
                    hint: '只使用当前任务可见的节点编号。',
                  })
                if (
                  op.op === 'delete_event' &&
                  a.events.some(
                    (e) => e.id === op.eventId && strings(e.nodeIds).some((id) => !visible.has(id))
                  )
                )
                  throw new NarrativeToolError('OBJECT_OUT_OF_SCOPE', '事件仍含后批节点。', {
                    fields: ['eventId'],
                    objectIds: [text(op.eventId)],
                    operationNumber: index + 1,
                    hint: '先处理可见节点，等后批节点开放后再删除事件。',
                  })
                if (task.part === 'descriptions' && !task.ids.includes(text(op.eventId ?? op.lineId)))
                  throw new NarrativeToolError('OBJECT_OUT_OF_SCOPE', '只能填写本段对象的说明。', {
                    fields: [plan.layer === 'event' ? 'eventId' : 'lineId'],
                    objectIds: [text(op.eventId ?? op.lineId)],
                    expectedValues: task.ids,
                    operationNumber: index + 1,
                  })
              }
              const reads: ReadSet = { records: [], queries: [] }
              for (const [table, rows] of [
                ['nodes', a.nodes.filter((n) => visible.has(text(n.id)))],
                ['storyEvents', a.events],
                ['eventLines', plan.layer === 'line' ? a.lines : []],
              ] as const)
                for (const r of rows)
                  reads.records.push({
                    table,
                    id: text(r.id),
                    resolvedId: text(r.id),
                    revision: Number(r.revision),
                    factFingerprint: '',
                  })
              const result = await applyOutline(store, scope, args, reads, timestamp)
              plan.affected = [
                ...new Set([
                  ...plan.affected,
                  ...result.changes
                    .filter((r) => r.kind === (plan.layer === 'event' ? 'event' : 'eventLine'))
                    .map((r) => text(r.id)),
                ]),
              ]
              value = {
                ...result,
                changes: result.changes.filter((r) => plan.layer === 'line' || r.kind === 'event'),
              }
            }
            const write =
              !['get_nodes','get_event','search_events','search_nodes','search_prior_nodes'].includes(name) &&
              name !== 'get_detail' &&
              name !== 'get_outline' &&
              !(name === 'manage_doubts' && args.action === 'list')
            if (write) {
              const after = narrativeVersions(
                await narrativeAssets(store, scope.sessionId!),
                visible,
                plan.layer === 'event'
              )
              for (const key of new Set([...Object.keys(current), ...Object.keys(after)]))
                if (current[key] !== after[key]) {
                  if (after[key] === undefined) delete seen[key]
                  else seen[key] = after[key]
                }
              if (isEventWorkflow(task.mode) && name==='edit_events') {
                const operations = records(args.changes)
                for (const [index, change] of records((value as Row).changes).entries()) {
                  const key = 'event:' + change.event_id
                  const submittedMembers = Array.isArray((operations[index].fields as Row | undefined)?.nodeIds)
                  for (const prefix of ['members:', 'read:']) {
                    const proof = prefix + key
                    const wasCurrent = Object.hasOwn(seen,proof) && seen[proof] === current[key]
                    if (after[key] && (wasCurrent || (prefix === 'members:' && submittedMembers))) seen[proof] = after[key]
                    else delete seen[proof]
                  }
                }
              }
              await store.put('pipelineRuns', {
                ...run,
                narrative: plan,
                ...(name === 'confirm'
                  ? {
                      tasks: records(run.tasks).map((t) =>
                        t.taskId === task.id ? { ...t, status: args.result === 'pending_review' ? 'partial' : 'completed', updatedAt: timestamp } : t
                      ),
                    }
                  : {}),
              })
              await store.put('pipelineRuns', {
                id: receiptId,
                bookId: scope.bookId,
                stage: 'P3',
                recordType: 'narrative_receipt',
                runId: scope.runId,
                taskId: scope.taskId,
                name,
                signature: canonical([name, args]),
                result: isEventWorkflow(task.mode) && (name === 'edit_events' || name === 'confirm')
                  ? {...value as Row, display:captureEventDisplay(a,task,name,args,value as Row)}
                  : value,
                arguments: args,
                ...(reviewResults ? { reviewResults } : {}),
                status: 'completed',
                startedAt: timestamp,
                planVersion: '2.2',
              })
            }
            for (const key of refreshed) if (current[key] !== undefined) seen[key] = current[key]
            if (write || refreshed.length)
              await store.put('pipelineRuns', {
                ...snapshot,
                observed: seen,
                ...(outcome ? { outcome } : {}),
                ...(name === 'confirm' ? { status: args.result === 'pending_review' ? 'paused' : 'completed' } : {}),
              })
            return isEventWorkflow(task.mode) ? eventToolReply(name,args,value as Row,task) : value
          },
          { lockKey: 'narrative', owner: scope.owner, runId: scope.runId }
        )
        if (name === 'confirm') { confirmed = true; pendingReview = args.result === 'pending_review' }
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
      } catch (e) {
        const failure = failurePayload(e, name, initial, raw)
        return {
          content: [{ type: 'text', text: JSON.stringify(failure) }],
          details: failure,
          isError: true,
        }
      }
    },
  }))
  return {
    tools,
    get pendingReview() { return pendingReview },
    get confirmed() {
      return confirmed
    },
  }
}
