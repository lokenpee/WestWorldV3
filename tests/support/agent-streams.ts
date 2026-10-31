import { agentResponse } from './agent-protocol'
import { vi } from 'vitest'
import type { Row } from '../../src/features/agents/repository'

export function createAgentFixture(bookId: string): Record<string, Row[]> {
  const original = '第二章的沈青就是第一章的沈青。'
  return { chapters: ['1', '2'].map((chapterIndex, order) => ({ bookId, chapterIndex, chapterName: `第${chapterIndex}章`, order, charCount: original.length })), chapterTexts: ['1', '2'].map(chapterIndex => ({ bookId, chapterIndex, text: original })), characters: ['C1-P001', 'C2-P001'].map(id => ({ id, bookId, name: '沈青', aliases: [], confidence: 1, revision: 1, createdBy: 'P1' })) }
}
export { agentStream } from './agent-protocol'
export function scriptedAgentFetcher() {
  return vi.fn<typeof fetch>().mockImplementation(async (_input, init) => agentResponse(JSON.parse(init?.body as string)))
}
