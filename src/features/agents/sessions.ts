import type { AgentStore, Row } from './repository'
import { text } from './contracts'

export async function resolveSession(store: AgentStore, bookId: string, sessionId?: string, profile: 'story_editor' | 'asset_editor' = 'story_editor', workflow?: string, runId?: string): Promise<Row & { id: string }> {
  let session = sessionId ? await store.get('storySessions', sessionId) : (await store.rows('storySessions')).find(row => row.profile === profile && row.status === 'active' && (workflow || row.kind !== 'review') && (!workflow || row.workflow === workflow) && (!runId || row.runId === runId))
  if (session && (session.bookId !== bookId || session.profile !== profile)) throw new Error('SCOPE:指定会话不属于当前书籍或职责。')
  if (sessionId && !session) throw new Error('SCOPE:指定会话不存在。')
  if (!session) {
    const timestamp = new Date().toISOString()
    session = { id: crypto.randomUUID(), bookId, profile, kind: profile === 'asset_editor' ? 'organization' : 'initial', title: profile === 'asset_editor' ? '人物整理' : '叙事整理', status: 'active', nextOrdinal: 0, ...(workflow ? { workflow } : {}), ...(runId ? { runId } : {}), createdAt: timestamp, updatedAt: timestamp }
    await store.put('storySessions', session)
  }
  return { ...session, id: text(session.id) }
}
