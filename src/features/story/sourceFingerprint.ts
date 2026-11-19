import type { AgentStore } from '../agents/repository'
import { hash, text } from '../agents/contracts'

export type ReadingSourceStore = AgentStore & { chapterHash?: (id: string, missing: 'null' | 'empty') => Promise<string> }

export async function readingSourceFingerprint(store: ReadingSourceStore, chapter: string, missing: 'null' | 'empty' = 'null') {
  if (store.chapterHash) return store.chapterHash(chapter, missing)
  const source = await store.get('chapterTexts', chapter)
  return store.wait(hash(source ? text(source.text) : missing === 'empty' ? '' : null))
}
