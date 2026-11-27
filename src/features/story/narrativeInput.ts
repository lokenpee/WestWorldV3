import { isEventWorkflow, eventDescriptions, linkConfirmDescription } from './eventToolsSchema.ts'
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
  if (task.mode === 'review_boundaries') return '只确认本组结构。completed 可附 reason 说明分界或转回结论。缺少依据用 pending_review 和 pending_issues。'
  if (task.mode === 'review_sequence') return '只确认当前事件。completed 表示经过已核实；pending_review 填 pending_issues；return_to_macro 填 event_ids（含当前事件）、evidence_node_ids 和 reason。'
  if (task.mode === 'link_node') return linkConfirmDescription
  if (isEventWorkflow(task.mode)) return eventDescriptions.confirm
  if (task.part !== 'batch')
    return '检查完本段后只调用一次 confirm({})。需要修正时先用编辑工具保存，在修改处简述原因。未改动的目标无需列举或说明。可在同一轮编辑后确认。'
  return '本组归线或疑点已保存后调用 confirm({})。仅当还要确认组外事件时，用 handled_event_ids 填写这些额外编号。'
}

function inputBlock(label: string, content: string) {
  return `【${label}开始】\n${content}\n【${label}结束】`
}

const reviewMaterialGuide = '事件卡已给出 event_id、name、overview、latest_progress、unresolved、clues、status。时间表给出 node_id、name、summary、event_ids。按 event_ids 中的事件编号筛选，即得该卡的全部成员。可直接使用这些资料。具体行动不清时，用 get_nodes 读取存疑节点的详细经过。需要展开组外事件，或核对已变动的事件资料时，再用 get_event。'

export function withReviewMaterialGuide(material: Record<string, unknown>) {
  const {资料说明: _previousGuide, ...fields} = material
  return {资料说明: reviewMaterialGuide, ...fields}
}

export function formatLinkNodeInput(material: {当前节点: unknown; 后文概览: unknown}, candidates: readonly unknown[], totalEvents = candidates.length) {
  const future = material.后文概览
  const list = JSON.stringify(candidates)
  const recall = candidates.length === totalEvents
    ? list + '\n事件库共 ' + totalEvents + ' 条，已列出全部事件。无需再用 search_events 查事件；核对早期起因仍可查前序节点。'
    : list
  return [
    inputBlock('当前节点概览', JSON.stringify(material.当前节点)),
    inputBlock('后文节拍概览', Array.isArray(future) && future.length ? JSON.stringify(future) : '无后续节点'),
    inputBlock('排序召回事件', recall),
    inputBlock('本轮任务', '请依据规则处理当前节点，完成后调用 confirm。'),
  ].join('\n\n')
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
