import type { AgentStore, Row } from './repository'
import { text } from './contracts'

export async function resolveSession(store: AgentStore, bookId: string, sessionId?: string): Promise<Row & { id: string }> {
  let session = sessionId ? await store.get('storySessions', sessionId) : (await store.rows('storySessions')).find(row => row.profile === 'story_editor' && row.status === 'active')
  if (session && (session.bookId !== bookId || session.profile !== 'story_editor')) throw new Error('SCOPE:指定会话不属于当前书籍或职责。')
  if (sessionId && !session) throw new Error('SCOPE:指定会话不存在。')
  if (!session) {
    const timestamp = new Date().toISOString()
    session = { id: crypto.randomUUID(), bookId, profile: 'story_editor', kind: 'initial', title: '叙事整理', status: 'active', nextOrdinal: 0, createdAt: timestamp, updatedAt: timestamp }
    await store.put('storySessions', session)
  }
  return { ...session, id: text(session.id) }
}
