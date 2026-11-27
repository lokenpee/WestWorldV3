export const labels = {
  link_node: '节点串联',
  review_event: '旧版事件复核',
  review_boundaries: '宏观边界复核',
  review_sequence: '逐事件主审',
  node_batch: '按幕整理节点',
  event_cycle: '周期事件复核',
  event_review: '全书事件复核',
  event_group: '事件归入故事线',
  line_cycle: '周期故事线复核',
  line_review: '全书故事线复核',
}
export const parts = {
  batch: '当前批次',
  structure: '检查故事线里的事件是否分对',
  doubts: '处理待复核疑点',
  unassigned: '复查未归线事件和单事件故事线',
  descriptions: '核对故事线概况和核心线索',
}

export function partLabel(eventLayer: boolean, part: keyof typeof parts) {
  if (!eventLayer) return parts[part]
  return {
    batch: parts.batch,
    structure: '检查事件里的节点是否分对',
    doubts: '处理待复核疑点',
    unassigned: '复查未归属节点和单节点事件',
    descriptions: '核对事件概况和核心线索',
  }[part]
}
