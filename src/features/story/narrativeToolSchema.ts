import { outlineOperations } from './outlineToolSchema.ts'
import { confirmationInstruction } from './narrativeInput.ts'
import type { TSchema } from 'typebox'
import type { NarrativeTask } from './narrativePlan'

import type { EventLine, EventNode, StoryEvent } from '../assets/types'

export const detailFields = {
  node: [
    'id',
    'name',
    'summary',
    'process',
    'actors',
    'targets',
    'actorBindings',
    'targetBindings',
    'manualActorIds',
    'manualTargetCharacterIds',
    'confidence',
    'quoteStatus',
    'timeCoord',
    'timePrecision',
    'actorIds',
    'targetCharacterIds',
    'locationNames',
    'chapterIndex',
    'chapterName',
    'order',
    'quote',
    'offset',
    'clues',
    'new_facts',
    'world_delta',
    'started_actions',
    'time_text',
    'time_hint',
  ] satisfies (keyof EventNode)[],
  event: ['id', 'title', 'nodeIds', 'summary', 'coreClue'] satisfies (keyof StoryEvent)[],
  line: [
    'id',
    'title',
    'eventIds',
    'summary',
    'coreClue',
    'role',
    'lineStatus',
    'chapters',
    'timeRange',
  ] satisfies (keyof EventLine)[],
}
export const nodeFieldAliases = {
  chapter: 'chapterIndex',
  locations: 'locationNames',
} as const satisfies Record<string, keyof EventNode>
export type DetailKind = keyof typeof detailFields
export function readableFields(kind: DetailKind): string[] {
  return [...detailFields[kind], ...(kind === 'node' ? Object.keys(nodeFieldAliases) : [])]
}

const narrativeDescriptions: Record<string, string> = {
  edit_events:
    '按顺序原子编辑事件和节点成员。create_event、update_event 可分别填写 summary（概况）、coreClue（核心关键线索），省略的已有说明保留。拆合可在同次调用创建、迁移成员、删除。ref 在本次调用用 $ref 引用。',
  edit_storylines:
    '按顺序原子编辑故事线和事件成员。create_line、update_line 可分别填写 summary（概况）、coreClue（核心关键线索），省略的已有说明保留。拆合可在同次调用创建、迁移、删除。',
  get_detail:
    '批量查编号和字段，可用 *。每个编号单独返回可用资料及缺项。节点章节用 chapter 或 chapterIndex、地点用 locations 或 locationNames、经过用 process、原文摘录用 quote。字段文本或列表每段 2000 字符或 20 项，用 offset 续读。',
  get_outline: '查事件或故事线目录，指定 id 展开成员。查未归属对象只填 kind 和分页 offset。',
  manage_doubts:
    '管理本会话疑点。create 提交陈述，归属疑点带对应节点或事件编号。resolve 提交解决依据。按 action 的参数填写。',
}
export function narrativeToolDescription(name: string, task: Pick<NarrativeTask, 'mode' | 'part'>) {
  if (name === 'confirm') return confirmationInstruction(task)
  if (task.part === 'descriptions' && (name === 'edit_events' || name === 'edit_storylines'))
    return (
      '填写本段对象的说明。使用 ' +
      (name === 'edit_events' ? 'update_event 和 eventId' : 'update_line 和 lineId') +
      '，每项可填 summary（概况）或 coreClue（核心关键线索），省略的已有说明保留。'
    )
  if (name === 'get_outline' && task.part === 'unassigned')
    return '仅在需要寻找归属候选时查询事件或故事线；指定 id 可展开候选成员，offset 按对象分页。'
  if (name === 'get_outline' && ['node_batch', 'event_cycle', 'event_review'].includes(task.mode))
    return '查当前事件目录或未归属节点。指定事件 id 展开可见节点，offset 按对象分页。'
  return narrativeDescriptions[name]
}

export interface NarrativeRules {
  common: Record<string, TSchema>
  eventOps: string[]
  lineOps: string[]
}
export function narrativeToolSchemas(
  task: Pick<NarrativeTask, 'mode' | 'part'>,
  rules: NarrativeRules,
  spec: TSchema
) {
  const eventLayer = ['node_batch', 'event_cycle', 'event_review'].includes(task.mode)
  const edit = eventLayer ? 'edit_events' : 'edit_storylines'
  const descriptionOnly = task.part === 'descriptions'
  const ops = descriptionOnly
    ? [eventLayer ? 'update_event' : 'update_line']
    : eventLayer
      ? rules.eventOps
      : rules.lineOps
  const operations = outlineOperations(spec)
    .filter((rule) => ops.includes(rule.properties.op.const))
    .map((rule) => {
      const op = structuredClone(rule) as unknown as {
        properties: Record<string, unknown>
        required: string[]
        anyOf?: { required: string[] }[]
      }
      const remove = (key: string) => {
        delete op.properties[key]
        op.required = op.required.filter((k) => k !== key)
      }
      if (rule.properties.op.const === 'create_event') remove('lineId')
      if (rule.properties.op.const === 'delete_event') remove('expectedLineIds')
      if (op.properties.ref) op.properties.ref = { type: 'string', minLength: 1 }
      if (task.part !== 'batch') op.properties.reason = { type: 'string', description: '本次修改的简短原因。' }
      if (descriptionOnly) {
        remove('title')
        remove('role')
        op.anyOf = [{ required: ['summary'] }, { required: ['coreClue'] }]
      }
      if (['create_event', 'update_event', 'create_line', 'update_line'].includes(rule.properties.op.const)) {
        op.properties.summary = { type: 'string', minLength: 1, description: '用一句短句概括主要行动和结果。' }
        op.properties.coreClue = {
          type: 'string',
          minLength: 1,
          description: '用一个短语指出本段围绕的人物、事件或地点，如“凤姐放印子钱”。',
        }
      }
      return op
    })
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['operations'],
    properties: { operations: { type: 'array', minItems: 1, items: { oneOf: operations } } },
  } as unknown as TSchema
  const common = structuredClone(rules.common)
  const confirmation = common.confirm as unknown as {
    properties: Record<string, unknown>
    required: string[]
  }
  if (task.part === 'batch') {
    if (eventLayer) delete confirmation.properties.handled_event_ids
    else {
      delete confirmation.properties.retained_unassigned_nodes
      confirmation.properties.handled_event_ids = {
        ...(confirmation.properties.handled_event_ids as object), description: '可选，另行确认已处理的组外事件编号。',
      }
    }
  } else {
    delete confirmation.properties.handled_event_ids
    delete confirmation.properties.retained_unassigned_nodes
    confirmation.required = []
  }
  const outline = common.get_outline as unknown as { properties: Record<string, object> }
  const outlineKinds = eventLayer
    ? ['events', 'unassigned_nodes']
    : ['lines', 'events', 'unassigned_nodes', 'unassigned_events']
  common.get_outline = {
    type: 'object',
    oneOf: outlineKinds
      .filter((kind) => task.part !== 'unassigned' || kind === 'events' || kind === 'lines')
      .map((kind) => ({
        type: 'object',
        additionalProperties: false,
        required: ['kind'],
        properties: {
          kind: { type: 'string', const: kind },
          offset: outline.properties.offset,
          ...(kind === 'lines' || kind === 'events' ? { id: outline.properties.id } : {}),
        },
      })),
  } as TSchema
  const note = common.manage_doubts as unknown as {
    properties: Record<string, object> & { category: { enum: string[] } }
  }
  if (eventLayer) {
    note.properties.category.enum = ['NODE_ASSIGNMENT', 'OTHER']
    delete note.properties.lineIds
  }
  const targets = ['category', 'statement', 'nodeIds', 'eventIds', ...(eventLayer ? [] : ['lineIds'])]
  const actions = [
    { action: 'list', required: [], optional: ['id', 'offset'] },
    { action: 'create', required: ['statement'], optional: targets },
    { action: 'update', required: ['id'], optional: targets },
    { action: 'resolve', required: ['id', 'reason'], optional: [] },
    { action: 'reopen', required: ['id'], optional: [] },
    { action: 'merge', required: ['id', 'otherId'], optional: targets },
    { action: 'delete', required: ['id'], optional: [] },
  ]
  common.manage_doubts = {
    type: 'object',
    oneOf: actions.map(({ action, required, optional }) => ({
      type: 'object',
      additionalProperties: false,
      required: ['action', ...required],
      properties: {
        ...Object.fromEntries([...new Set([...required, ...optional, ...(task.part !== 'batch' && action !== 'list' ? ['reason'] : [])])].map((k) => [k, note.properties[k]])),
        action: { type: 'string', const: action },
      },
    })),
  } as TSchema
  const requests = (
    common.get_detail as unknown as {
      properties: { requests: { items: { properties: { fields: object } } | { oneOf: unknown[] } } }
    }
  ).properties.requests
  Object.assign(requests, { minItems: 1 })
  const item = requests.items
  if (!('properties' in item)) throw Error('查字段基础契约缺少请求对象。')
  const kinds: DetailKind[] = eventLayer ? ['node', 'event'] : ['node', 'event', 'line']
  requests.items = {
    oneOf: kinds.map((kind) => ({
      ...item,
      properties: {
        ...item.properties,
        kind: { type: 'string', const: kind },
        fields: {
          ...item.properties.fields,
          minItems: 1,
          description: '可读字段：*、' + readableFields(kind).join('、'),
        },
      },
    })),
  }
  if (task.part !== 'batch' && task.part !== 'unassigned') delete common.get_outline
  return { [edit]: schema, ...common }
}
