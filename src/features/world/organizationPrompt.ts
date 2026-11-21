import type { WorkKind } from './types'

type Row = Record<string, unknown>

const labels: Record<WorkKind, string> = {
  directory: '人物目录扫描',
  candidate: '疑似同人组核对',
  profile: '人物资料整理',
  relations: '人物关系整理',
}

const text = (value: unknown) => typeof value === 'string' ? value : ''
const records = (value: unknown): Row[] => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') as Row[] : []
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const list = (value: unknown) => {
  const items = strings(value)
  return items.length ? items.join('、') : '（无）'
}
const conclusion = (checked: unknown) => {
  const value = checked && typeof checked === 'object' ? checked as Row : undefined
  if (!value?.outcome) return '未核对'
  const reason = text(value.reason)
  return `${text(value.outcome)}${reason ? `（${reason}）` : ''}`
}

function relationBody(data: Row): string {
  const relations = records(data.relations)
  const unlinked = records(data.unlinkedRelations)
  const lines = [
    `已有关系 ${relations.length} 对；未关联原始关系 ${unlinked.length} 条。`,
    '以下关系概览已由程序读取，不需要再次查询列表。',
    '',
    `## 已有关系（${relations.length}）`,
  ]
  if (!relations.length) lines.push('（无）')
  relations.forEach((row, index) => {
    lines.push(`${index + 1}. ${text(row.targetId)}｜${text(row.targetName) || '未命名'}`)
    if (text(row.identity)) lines.push(`   身份：${text(row.identity)}`)
    lines.push(`   当前人物 → 目标：${list(row.forward)}`)
    lines.push(`   目标 → 当前人物：${list(row.reverse)}`)
    lines.push(`   状态：${text(row.state) || '未知'}；方向存疑：${row.unclear === true ? '是' : '否'}；上次结论：${conclusion(row.checked)}`)
  })
  lines.push('', `## 未关联原始关系（${unlinked.length}）`)
  if (!unlinked.length) lines.push('（无）')
  unlinked.forEach((row, index) => {
    lines.push(`${index + 1}. ${text(row.sourceName) || '未命名'} → ${text(row.targetName) || '未命名'}`)
    lines.push(`   正向：${text(row.forward) || '（空）'}；反向：${text(row.reverse) || '（空）'}；方向：${text(row.direction) || '未记录'}`)
  })
  return lines.join('\n')
}

function dataBlock(kind: WorkKind, data: Row): string {
  if (kind === 'relations') return relationBody(data)
  const clean: Row = { ...data }
  if (kind === 'profile') {
    delete clean.revision
    delete clean.fields
    delete clean.mergeFacts
  }
  if (kind === 'candidate') return ['```json', JSON.stringify(clean, null, 2), '```'].join('\n')
  return ['```json', JSON.stringify(clean, null, 2), '```'].join('\n')
}

const instructions: Record<WorkKind, string[]> = {
  directory: [],
  candidate: [
    '- 以上是待核对组的成员和原因；读取成员详情后判断是否同一人，不需要重新扫描全书。',
    '- 合并前必须核对成员的实际资料和原文依据；无法确认时登记为待核对。',
  ],
  profile: [
    '- 以上已完整提供本次要整理的人物档案字段。空字段表示当前没有这部分资料；人物资料少时也直接整理，无需重复查详情或补齐空项。',
    '- 有具体疑点才查原文。`sourceChapters` 是书内章节索引，传给 `read_original` 的 `chapter_indices`。`asset_ids` 填上面的对象编号。',
  ],
  relations: [
    '- 上面的 `已有关系` 是当前人物全部关系概览，已经由程序读取；不要再用 `query_relation_work` 读取关系列表。',
    '- 只有需要逐字原文证据时，才调用 `query_relation_work`，并指定 `targetIds`；不要全量查询证据。',
    '- `未关联原始关系` 是尚未关联到人物的原始记录，不是已建立的人物对，不要把它当成已核对关系。',
    '- 常规整理使用当前已开放的工具；只有确实缺少工具时，才调用 `get_tools`。',
    '- `forward` 是当前人物相对目标人物的身份，`reverse` 是目标人物相对当前人物的身份。',
  ],
}

export function organizationPrompt(unit: { kind: WorkKind; characterId?: string; summary: string; data: Row }): string {
  const data = unit.data
  const objectId = unit.kind === 'directory'
    ? text(data.pageId)
    : unit.kind === 'candidate'
      ? text((data.group as Row | undefined)?.id)
      : text(data.id)
  const objectName = unit.kind === 'directory'
    ? `人物目录 ${data.pageNumber ?? 1}/${data.totalPages ?? 1} 页`
    : unit.kind === 'candidate'
      ? unit.summary
      : `${text(data.name) || unit.summary}（${objectId}）`
  return [
    '# 当前任务',
    labels[unit.kind],
    `任务类型：${unit.kind}`,
    '',
    '# 当前对象',
    objectName,
    `对象编号：${objectId}`,
    '',
    '# 已提供的资料',
    dataBlock(unit.kind, data),
    '',
    ...(instructions[unit.kind].length ? ['# 工作说明'] : []),
    ...instructions[unit.kind],
  ].join('\n')
}
