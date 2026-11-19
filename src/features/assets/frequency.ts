import type { createWorkspace } from '../../lib/storage/workspace'
import { transact } from '../../lib/storage/transaction'
import { versionedTable } from '../local-storage/client'
import { createFrequencyCounter } from './derive'
import type { Character, LocationAsset } from './types'

type Terms = ReadonlyMap<string, number>
type BookDatabase = ReturnType<ReturnType<typeof createWorkspace>['openBook']>
interface ChapterCounts { version: number; terms: Terms }
interface CachedCounts { names: string; chapters: Map<string, ChapterCounts> }
interface FrequencyCache { people: CachedCounts; places: CachedCounts }
const caches = new WeakMap<object, FrequencyCache>()

/** P1分章统计只复用词项计数，人物归属、分位及人工层级每次重新汇总。 */
export async function readBookFrequencies(db: BookDatabase, people: Character[], places: LocationAsset[], options: {
  chapterIndices?: readonly string[]
  signal?: AbortSignal
  cacheOwner?: object
  yieldToUi?: boolean
} = {}) {
  const personCounter = createFrequencyCounter(people, true), placeCounter = createFrequencyCounter(places, false)
  const included = options.chapterIndices && new Set(options.chapterIndices)
  let yieldedAt = performance.now()
  const yieldIfNeeded = async () => {
    if (options.yieldToUi !== false && performance.now() - yieldedAt >= 8) {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      yieldedAt = performance.now()
    }
    options.signal?.throwIfAborted()
  }
  options.signal?.throwIfAborted()
  if (!versionedTable(db, 'chapterTexts')) {
    // 旧IndexedDB没有正文版本，完整扫描沿用原算法，不依赖异步通知推断未变。
    const texts = await db.table<{ chapterIndex: string; text: string }>('chapterTexts').toArray()
    for (const row of texts) {
      if (included && !included.has(row.chapterIndex)) continue
      options.signal?.throwIfAborted()
      personCounter.add(row); placeCounter.add(row)
      await yieldIfNeeded()
    }
    options.signal?.throwIfAborted()
    return { people: personCounter.result(), places: placeCounter.result() }
  }

  const cacheOwner = options.cacheOwner ?? db, previous = caches.get(cacheOwner)
  const next: FrequencyCache = {
    people: { names: JSON.stringify(personCounter.names), chapters: new Map() },
    places: { names: JSON.stringify(placeCounter.names), chapters: new Map() },
  }
  const previousPeople = previous?.people.names === next.people.names ? previous.people.chapters : undefined
  const previousPlaces = previous?.places.names === next.places.names ? previous.places.chapters : undefined
  const empty: Terms = new Map()
  const cached = (rows: Map<string, ChapterCounts> | undefined, key: string, version: number) => version > 0 && rows?.get(key)?.version === version ? rows.get(key)!.terms : undefined
  await transact(db, 'r', [db.table('chapterTexts')], async scoped => {
    const source = versionedTable(scoped, 'chapterTexts')!
    for (const entry of await source.versions()) {
      if (included && !included.has(entry.key)) continue
      options.signal?.throwIfAborted()
      let version = entry.version
      let personTerms = personCounter.names.length ? cached(previousPeople, entry.key, version) : empty
      let placeTerms = placeCounter.names.length ? cached(previousPlaces, entry.key, version) : empty
      const scanned = !personTerms || !placeTerms
      if (scanned) {
        const row = await source.get(entry.key)
        if (!row) continue
        version = row.version
        // 正文与版本来自同一记录；version=0属于事务待提交数据，不能跨调用复用。
        personTerms = personCounter.names.length ? cached(previousPeople, entry.key, version) ?? personCounter.countTerms(row.value.text as string) : empty
        placeTerms = placeCounter.names.length ? cached(previousPlaces, entry.key, version) ?? placeCounter.countTerms(row.value.text as string) : empty
      }
      personCounter.addTerms(entry.key, personTerms!)
      placeCounter.addTerms(entry.key, placeTerms!)
      if (version > 0) {
        next.people.chapters.set(entry.key, { version, terms: personTerms! })
        next.places.chapters.set(entry.key, { version, terms: placeTerms! })
      }
      await yieldIfNeeded()
    }
  })
  options.signal?.throwIfAborted()
  caches.set(cacheOwner, next)
  return { people: personCounter.result(), places: placeCounter.result() }
}
