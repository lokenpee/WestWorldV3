import { useCallback, useState } from 'react'
import { useLiveResult } from '../../hooks/useLiveResult'
import type { Row } from '../agents/repository'
import type { StoryService } from './service'

function HistoryEntry({ entry }: { entry: Row }) {
  const [offset, setOffset] = useState(0)
  const raw = JSON.stringify(entry.type === 'compaction' ? entry : entry.message ?? entry.summary ?? entry, null, 2)
  const label = entry.type === 'compaction' ? '压缩摘要' : entry.type === 'commit' ? '代码提交确认' : ({ user: '任务', assistant: '模型回复', toolResult: '工具结果', system: '系统设置' } as Record<string, string>)[String((entry.message as { role?: string })?.role)] ?? '会话记录'
  return <details><summary>#{Number(entry.ordinal) + 1} · {label}</summary><p>条目编号：{String(entry.id)}</p><pre>{raw.slice(offset, offset + 12000)}</pre>{raw.length > 12000 && <div className="story-history-pages"><button className="text-button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 12000))}>上一段内容</button><span>{offset + 1}–{Math.min(offset + 12000, raw.length)} / {raw.length} 字符</span><button className="text-button" disabled={offset + 12000 >= raw.length} onClick={() => setOffset(offset + 12000)}>下一段内容</button></div>}</details>
}
export function SessionHistory({ bookId, service }: { bookId: string; service: StoryService }) {
  const [offset, setOffset] = useState(0)
  const history = useLiveResult(useCallback(() => service.history(bookId, offset), [service, bookId, offset]))
  if (history.status === 'loading') return <p>正在读取会话历史…</p>
  if (history.status === 'error') return <p role="alert">{history.message}</p>
  return <div className="story-history" aria-label="本书会话历史"><p>会话编号：{history.value.sessionId}</p><div className="story-history-pages"><button className="text-button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页记录</button><span>{history.value.total ? offset + 1 : 0}–{Math.min(offset + 20, history.value.total)} / {history.value.total}</span><button className="text-button" disabled={offset + 20 >= history.value.total} onClick={() => setOffset(offset + 20)}>下一页记录</button></div><div className="story-details-body">{history.value.entries.map(entry => <HistoryEntry key={String(entry.id)} entry={entry} />)}</div></div>
}
