import { eventDescriptions, eventToolsSchema, isEventWorkflow } from './eventToolsSchema.ts'
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
    'actorBindings',
    'manualActorIds',
    'confidence',
    'quoteStatus',
    'timeCoord',
    'timePrecision',
    'actorIds',
    'locationNames',
    'chapterIndex',
    'chapterName',
    'order',
    'quote',
    'offset',
    'clues',
    'new_facts',
    'world_delta',
    'time_text',
    'time_hint',
  ] satisfies (keyof EventNode)[],
  event: ['id', 'title', 'nodeIds', 'summary', 'latestProgress','unresolved','clues','status'] satisfies (keyof StoryEvent)[],
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
  edit_storylines:
    '按顺序原子编辑故事线和事件成员。create_line、update_line 可分别填写 summary（概况）、coreClue（核心关键线索），省略的已有说明保留。拆合可在同次调用创建、迁移、删除。',
  get_detail:
    '批量查编号和字段，可用 *。每个编号单独返回可用资料及缺项。节点章节用 chapter 或 chapterIndex、地点用 locations 或 locationNames、经过用 process、原文摘录用 quote。字段文本或列表每段 2000 字符或 20 项，用 offset 续读。',
  get_outline: '查事件或故事线目录，指定 id 展开成员。查未归属对象只填 kind 和分页 offset。',
  manage_doubts:
    '管理本会话疑点。create 提交陈述，归属疑点带对应节点或事件编号。resolve 提交解决依据。按 action 的参数填写。',
}
export function narrativeToolDescription(name: string, task: Pick<NarrativeTask, 'mode' | 'part'>) {
  if (task.mode === 'link_node' && name === 'get_nodes') return '按 node_ids 读取当前、前序或后文概览中的节点，默认返回名称和详细经过；用 return_fields 按需读取引文 quote、位置 source_position 或归属 event_ids。'
  if ((task.mode === 'review_boundaries' || task.mode === 'review_sequence') && name === 'get_event')
    return '按 event_id 返回 event_id、name、overview、latest_progress、unresolved、clues、status 和 members（每项 node_id、name）。任务中的事件卡和时间表已提供这些资料，可直接据此编辑。用于展开组外事件，或核对已变动的资料。查节点详细经过请用 get_nodes。'
  if (task.mode === 'review_sequence' && name === 'edit_events') return '只允许 update 当前主审事件。nodeIds 是修改后的完整成员列表。拆并或新建请转回宏观。'
  if (task.mode === 'review_boundaries' && name === 'edit_events') return '同一批 changes 可新建、更新、撤销事件，每项写 reason。合并时 update 保留卡（nodeIds 为完整成员），delete 重复卡并用 replacement_event_ids 指向保留卡。组内成员已完整提供。修改组外成员或撤销组外卡前用 get_event 读取。先保存新建事件再引用其 ID。'
  if (task.mode === 'link_node' && name === 'edit_events') return '整批新建或修改事件。每项写明理由，可附证据节点。nodeIds 提交完整非空列表并保留原成员，仅追加当前或早期节点；clues 整组替换。候选卡的完整成员可直接使用。新建由程序分配编号。'
  if (isEventWorkflow(task.mode)) return name === 'confirm' ? confirmationInstruction(task) : eventDescriptions[name]
  if (name === 'confirm') return confirmationInstruction(task)
  if (task.part === 'descriptions' && name === 'edit_storylines')
    return (
      '填写本段对象的说明。使用 ' +
      'update_line 和 lineId' +
      '，每项可填 summary（概况）或 coreClue（核心关键线索），省略的已有说明保留。'
    )
  if (name === 'get_outline' && task.part === 'unassigned')
    return '仅在需要寻找归属候选时查询事件或故事线；指定 id 可展开候选成员，offset 按对象分页。'
  return narrativeDescriptions[name]
}

export interface NarrativeRules {
  common: Record<string, TSchema>
  lineOps: string[]
}
export function narrativeToolSchemas(
  task: Pick<NarrativeTask, 'mode' | 'part'>,
  rules: NarrativeRules,
  spec: TSchema
) {
  if (isEventWorkflow(task.mode)) return eventToolsSchema(task.mode)
  if (!['event_group','line_review','line_cycle'].includes(task.mode)) throw Error('旧整理任务请在副本重建。')
  const descriptionOnly = task.part === 'descriptions'
  const ops = descriptionOnly ? ['update_line'] : rules.lineOps
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
      if (op.properties.ref) op.properties.ref = { type: 'string', minLength: 1 }
      if (task.part !== 'batch') op.properties.reason = { type: 'string', description: '本次修改的简短原因。' }
      if (descriptionOnly) {
        remove('title')
        remove('role')
        op.anyOf = [{ required: ['summary'] }, { required: ['coreClue'] }]
      }
      if (['create_line', 'update_line'].includes(rule.properties.op.const)) {
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
    confirmation.properties.handled_event_ids = {
      ...(confirmation.properties.handled_event_ids as object), description: '可选，另行确认已处理的组外事件编号。',
    }
  } else {
    delete confirmation.properties.handled_event_ids
    confirmation.required = []
  }
  const outline = common.get_outline as unknown as { properties: Record<string, object> }
  const outlineKinds = ['lines', 'events', 'unassigned_nodes', 'unassigned_events']
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
  const targets = ['category', 'statement', 'nodeIds', 'eventIds', 'lineIds']
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
  const kinds: DetailKind[] = ['node', 'event', 'line']
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
  return { edit_storylines: schema, ...common }
}
