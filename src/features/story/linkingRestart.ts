import { strings, text } from '../agents/contracts'
import type { AgentStore, Row } from '../agents/repository'
import { noteFingerprint } from '../agents/queries'
import { resolveSession } from '../agents/sessions'

export async function restartLinkingSession(store: AgentStore, bookId: string, runId: string, session: Row, keepOutline: boolean, notesSessionId = text(session.id)) {
  const now = new Date().toISOString()
  const { leaseOwner: _owner, leaseUntil: _until, ...previous } = session
  await store.put('storySessions', { ...previous, status: 'archived', updatedAt: now })
  const next = await resolveSession(store, bookId, undefined, 'story_editor', 'story_pages_v3', runId)
  if (keepOutline) {
    for (const note of await store.rows('storyEditorNotes')) if (note.sessionId === notesSessionId) {
      await store.put('storyEditorNotes', { ...note, id: crypto.randomUUID(), sessionId: next.id })
    }
  } else {
    for (const line of await store.rows('eventLines')) await store.remove('eventLines', text(line.id))
    for (const lifecycle of await store.rows('assetLifecycle')) if (lifecycle.kind === 'eventLine' && lifecycle.state !== 'deleted') {
      const { currentId: _current, ...rest } = lifecycle
      await store.put('assetLifecycle', { ...rest, state: 'deleted', revision: Number(lifecycle.revision) + 1, updatedAt: now })
    }
    for (const event of await store.rows('storyEvents')) await store.remove('storyEvents', text(event.id))
    for (const node of await store.rows('nodes')) if (strings(node.eventLineIds).length) {
      await store.put('nodes', { ...node, eventLineIds: [], revision: Number(node.revision) + 1, updatedAt: now })
    }
  }
  return next
}

/** 复核只继承当前大纲的事项，聊天及工作摘要由新会话自行积累。 */
export async function createReviewSession(store: AgentStore, bookId: string, runId: string, linking: Row, previous: Row) {
  const session = await resolveSession(store, bookId, undefined, 'story_editor', 'story_outline_review', runId)
  const review = { ...session, kind: 'review', title: '全书复核', parentSessionId: linking.id }
  await store.put('storySessions', review)
  for (const note of await store.rows('storyEditorNotes')) if (note.sessionId === previous.id) {
    const copy = { ...note, id: crypto.randomUUID(), sessionId: review.id, basisVersion: 2 }
    const wasCurrent = note.basisFingerprint === await noteFingerprint(store, note)
    await store.put('storyEditorNotes', { ...copy, basisFingerprint: wasCurrent ? await noteFingerprint(store, copy) : note.basisFingerprint })
  }
  if (previous.kind === 'review') await store.put('storySessions', { ...previous, status: 'archived' })
  return review
}
