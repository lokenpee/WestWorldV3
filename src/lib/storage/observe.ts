import { liveQuery as browserLiveQuery } from 'dexie'
import { onStorageChanged } from '../../features/local-storage/client'
import type { StorageInterest } from '../../features/local-storage/contracts'

export function liveQuery<T>(query: () => Promise<T>, interests?: readonly StorageInterest[]) {
  return { subscribe(input: { next?: (value: T) => void; error?: (error: unknown) => void } | ((value: T) => void)) {
    const observer = typeof input === 'function' ? { next: input, error: undefined } : input
    let stopped = false, running = false, again = false
    const refresh = async () => {
      if (stopped) return
      if (running) { again = true; return }
      running = true
      try { const result = await query(); if (!stopped) observer.next?.(result) }
      catch (error) { if (!stopped) observer.error?.(error) }
      finally { running = false; if (again) { again = false; void refresh() } }
    }
    const unsubscribe = onStorageChanged(() => { void refresh() }, interests)
    const native = browserLiveQuery(query).subscribe({ next: value => { if (!stopped) observer.next?.(value) }, error: error => { if (!stopped) observer.error?.(error) } })
    return { unsubscribe() { stopped = true; unsubscribe(); native.unsubscribe() } }
  } }
}
