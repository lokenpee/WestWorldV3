import type { ReviewProgress } from './narrativePlan'
import { labels, parts, partLabel } from './narrativeLabels.ts'

type Material = {
  mode: keyof typeof labels
  part: keyof typeof parts
  targets: unknown[]
  outline?: unknown
  config?: unknown
  openDoubts?: unknown[]
  reviewProgress?: ReviewProgress
  periodIds?: string[]
  evidence?: { nodes?: unknown[]; events?: unknown[] }
}

type TaskKind = Pick<Material, 'part' | 'mode'>
const isEventTask = (mode: Material['mode']) => ['node_batch', 'event_cycle', 'event_review'].includes(mode)

export function confirmationInstruction(task: TaskKind) {
  if (task.part !== 'batch')
    return '检查完本段后只调用一次 confirm({})。需要修正时先用编辑工具保存，在修改处简述原因。未改动的目标无需列举或说明。可在同一轮编辑后确认。'
  return task.mode === 'node_batch'
    ? '归属或疑点已保存后调用 confirm({})。独立保留的节点填写 retained_unassigned_nodes 及理由。'
    : '本组归线或疑点已保存后调用 confirm({})。仅当还要确认组外事件时，用 handled_event_ids 填写这些额外编号。'
}

export function narrativeSystemPrompt(template: string, task: TaskKind) {
  const sections = new Map<string, string>()
  for (const block of template.trim().split(/^## /m).filter(Boolean)) {
    const [heading, ...lines] = block.split(/\r?\n/)
    sections.set(heading.trim(), lines.join('\n').trim())
  }
  const layer = isEventTask(task.mode) ? '事件' : '故事线'
  const names = [
    task.part === 'batch' ? '通用' : '复核共用',
    task.part === 'batch' ? layer : layer + '复核范围',
    labels[task.mode],
  ]
  if (task.part !== 'batch') {
    names.push(
      {
        structure: layer + '结构',
        doubts: layer + '疑点',
        unassigned: layer + '未归属',
        descriptions: layer + '说明',
      }[task.part]
    )
  }
  const instructions = names.map((name) => {
    const value = sections.get(name)
    if (!value) throw new Error('缺少叙事提示词段落：' + name)
    return value
  })
  return [...instructions, confirmationInstruction(task)].join('\n\n')
}

export const reviewMaterialSections = {
  structure: '本段结构核对表',
  doubts: '本段待复核疑点表',
  unassigned: '本段未归属项',
  descriptions: '本段说明核对表',
}

export const eventCandidateSection = '本段未归属节点和单节点事件'

export const lineCandidateSection = '本段未归线事件和单事件故事线'

export const includesNarrativeDirectory = (part: Material['part']) =>
  part === 'batch' || part === 'structure' || part === 'unassigned'

export function formatNarrativeInput(input: Material) {
  const { mode, part, targets, outline, openDoubts, config, periodIds } = input
  const eventLayer = isEventTask(mode)
  const compactReview = part === 'doubts' || part === 'unassigned'
  const focus =
    part === 'batch' ? (eventLayer ? '本批节点资料' : '本组事件资料') : part === 'unassigned' ? (eventLayer ? eventCandidateSection : lineCandidateSection) : reviewMaterialSections[part]
  return JSON.stringify(
    {
      任务说明: {
        mode,
        part,
        目标: labels[mode] + ' · ' + partLabel(eventLayer, part),
        完成条件: confirmationInstruction(input),
      },
      ...(!compactReview && input.reviewProgress ? { 本轮复核进度: input.reviewProgress } : {}),
      ...(includesNarrativeDirectory(part)
        ? { [eventLayer ? '事件与可见节点目录' : '故事线与事件目录']: outline }
        : {}),
      [focus]: targets,
      ...(!compactReview && input.evidence ? { 本段查证材料: input.evidence } : {}),
      ...(part === 'structure' && periodIds ? { 本周期范围: periodIds } : {}),
      ...(part === 'batch' ? { 未决疑点: openDoubts, 运行参数: config } : {}),
    },
    null,
    2
  )
}
