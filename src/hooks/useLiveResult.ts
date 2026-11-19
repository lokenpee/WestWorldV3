import { liveQuery } from '../lib/storage/observe'
import { useEffect, useState } from 'react'
import type { StorageInterest } from '../features/local-storage/contracts'

type Result<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string }

export const bookInterests = (bookId: string, tables?: readonly string[], category?: StorageInterest['category']): StorageInterest[] => [
  { scope: `book:${bookId}`, tables, category }, { scope: 'settings', tables: ['books'] },
]

export function useLiveResult<T>(query: () => Promise<T>, attempt = 0, interests?: readonly StorageInterest[]): Result<T> {
  const interestKey = JSON.stringify(interests)
  const [snapshot, setSnapshot] = useState<{ query: typeof query; attempt: number; result: Result<T> }>()
  useEffect(() => {
    let failed = false
    const subscription = liveQuery(query, interestKey ? JSON.parse(interestKey) as StorageInterest[] : undefined).subscribe({
      next: value => { if (!failed) setSnapshot({ query, attempt, result: { status: 'ready', value } }) },
      error: (error: unknown) => {
        failed = true
        setSnapshot({ query, attempt, result: { status: 'error', message: error instanceof Error ? error.message : '本地存储暂时不可用，请重试。' } })
        // Keep a stable error and retry action until the user explicitly retries.
        queueMicrotask(() => subscription.unsubscribe())
      },
    })
    return () => subscription.unsubscribe()
  }, [query, attempt, interestKey])
  // A new book must never render the previous book's pending query result.
  return snapshot?.query === query && snapshot.attempt === attempt ? snapshot.result : { status: 'loading' }
}
