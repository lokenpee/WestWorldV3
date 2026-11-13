import template from '../../../docs/v2/resources/v2.2/prompts/active/story.txt?raw'
import { records, text } from '../agents/contracts'
import type { Row } from '../agents/repository'

export function storyTaskPrompt(input: Row) {
  const hints = input.contextHints as Row | undefined
  const window = input.window as Row | null
  const content = {
    phase: input.phase, queue: input.queue,
    ...(window ? { chapterRange: [String(Number(window.start) + 1), String(window.end)] } : {}),
    remainingCount: input.remainingCount,
    workItems: records(hints?.assigned), related: records(hints?.related), moreRelated: hints?.truncated === true,
    workingSummary: text((input.memory as Row | undefined)?.workingSummary),
  }
  return template.replace('{taskJson}', JSON.stringify(content))
}
