import type { NarrativeTask } from './narrativePlan'
import link from '../../../docs/v2/resources/v2.2/prompts/active/p3-event-link.md?raw'
import boundaries from '../../../docs/v2/resources/v2.2/prompts/active/p3-event-boundaries.md?raw'
import sequence from '../../../docs/v2/resources/v2.2/prompts/active/p3-event-sequence.md?raw'
import group from '../../../docs/v2/resources/v2.2/prompts/active/p3-line-group.md?raw'
import cycleStructure from '../../../docs/v2/resources/v2.2/prompts/active/p3-line-cycle-structure.md?raw'
import cycleDoubts from '../../../docs/v2/resources/v2.2/prompts/active/p3-line-cycle-doubts.md?raw'
import cycleUnassigned from '../../../docs/v2/resources/v2.2/prompts/active/p3-line-cycle-unassigned.md?raw'
import reviewStructure from '../../../docs/v2/resources/v2.2/prompts/active/p3-line-review-structure.md?raw'
import reviewDoubts from '../../../docs/v2/resources/v2.2/prompts/active/p3-line-review-doubts.md?raw'
import reviewUnassigned from '../../../docs/v2/resources/v2.2/prompts/active/p3-line-review-unassigned.md?raw'
import reviewDescriptions from '../../../docs/v2/resources/v2.2/prompts/active/p3-line-review-descriptions.md?raw'

const prompts: Partial<Record<NarrativeTask['mode'], Partial<Record<NarrativeTask['part'], string>>>> = {
  link_node: {batch: link},
  review_boundaries: {structure: boundaries},
  review_sequence: {structure: sequence},
  event_group: {batch: group},
  line_cycle: {structure: cycleStructure, doubts: cycleDoubts, unassigned: cycleUnassigned},
  line_review: {structure: reviewStructure, doubts: reviewDoubts, unassigned: reviewUnassigned, descriptions: reviewDescriptions},
}

export function narrativeSystemPrompt({mode, part}: Pick<NarrativeTask, 'mode' | 'part'>) {
  const prompt = prompts[mode]?.[part]
  if (!prompt) throw new Error(`未登记叙事任务提示词：${mode}/${part}`)
  return prompt.trim()
}
