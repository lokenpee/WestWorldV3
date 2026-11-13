import { useEffect, useState } from 'react'
import { subscribeTraceHub, traceSessions } from './trace'
import { activityView } from './activity'
import type { ActivityInput } from './activity'
import './AgentActivity.css'

export function AgentActivity({ bookId, runId, workId, ...input }: ActivityInput & { bookId: string; runId?: string; workId?: string }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    let scheduled: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = subscribeTraceHub(() => { scheduled ??= setTimeout(() => { scheduled = undefined; setNow(Date.now()) }, 250) })
    const timer = input.status === 'running' ? setInterval(() => setNow(Date.now()), 1000) : undefined
    return () => { unsubscribe(); clearTimeout(scheduled); clearInterval(timer) }
  }, [bookId, runId, workId, input.status])
  const taskIds = new Set(input.tasks?.map(task => task.taskId))
  const requests = traceSessions(bookId).filter(session => session.identity.runId === runId && (!workId || session.identity.workId === workId))
    .flatMap(session => session.snapshot().records).filter(row => !taskIds.size || taskIds.has(row.taskId))
  const view = activityView({ ...input, requests, now })
  return <p className={`agent-activity${view.active ? ' is-active' : ''}${view.failed ? ' is-error' : ''}`} role={view.failed ? 'alert' : 'status'} title={view.message}>
    <span className="agent-activity-dot" aria-hidden="true" /><span className="agent-activity-text">{view.message}</span>
  </p>
}
