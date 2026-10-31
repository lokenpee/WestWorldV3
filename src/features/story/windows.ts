import type { Chapter } from '../../lib/storage/workspace'
import type { EventNode } from '../assets/types'

export interface StoryWindow { start: number; end: number; chapterIndices: string[] }
export function createStoryWindows(chapters: Chapter[]): StoryWindow[] {
  const originals: string[][] = []
  const byOriginal = new Map<string, string[]>()
  for (const chapter of [...chapters].sort((a, b) => a.order - b.order)) {
    const original = chapter.chapterIndex.split('.')[0]
    if (!byOriginal.has(original)) { const chunks: string[] = []; byOriginal.set(original, chunks); originals.push(chunks) }
    byOriginal.get(original)!.push(chapter.chapterIndex)
  }
  const result: StoryWindow[] = []
  for (let start = 0; start < originals.length; start += 80) {
    const end = Math.min(start + 100, originals.length)
    result.push({ start, end, chapterIndices: originals.slice(start, end).flat() })
    if (end === originals.length) break
  }
  return result
}
export function windowNodes(window: StoryWindow, chapters: Chapter[], nodes: EventNode[]) {
  const order = new Map(chapters.map(chapter => [chapter.chapterIndex, chapter.order]))
  const indices = new Set(window.chapterIndices)
  return nodes.filter(node => indices.has(node.chapterIndex)).sort((a, b) => (order.get(a.chapterIndex) ?? 0) - (order.get(b.chapterIndex) ?? 0) || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
export const windowKey = (window: StoryWindow) => `${window.start}-${window.end}`
