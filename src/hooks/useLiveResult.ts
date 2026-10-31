import { liveQuery } from 'dexie'
import { useEffect, useState } from 'react'

type Result<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string }

export function useLiveResult<T>(query: () => Promise<T>, attempt = 0): Result<T> {
  const [snapshot, setSnapshot] = useState<{ query: typeof query; attempt: number; result: Result<T> }>()
  useEffect(() => {
    let failed = false
    const subscription = liveQuery(query).subscribe({
      next: value => { if (!failed) setSnapshot({ query, attempt, result: { status: 'ready', value } }) },
      error: (error: unknown) => {
        failed = true
        setSnapshot({ query, attempt, result: { status: 'error', message: error instanceof Error ? error.message : '本地存储暂时不可用，请重试。' } })
        // Keep a stable error and retry action until the user explicitly retries.
        queueMicrotask(() => subscription.unsubscribe())
      },
    })
    return () => subscription.unsubscribe()
  }, [query, attempt])
  // A new book must never render the previous book's pending query result.
  return snapshot?.query === query && snapshot.attempt === attempt ? snapshot.result : { status: 'loading' }
}
