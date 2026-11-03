import { afterEach, expect, it, vi } from 'vitest'
import { characterNetworkCacheKey, clearCharacterNetworkCache, saveCharacterNetworkCache } from '../src/features/character-network/cache'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('删除清理后延迟保存与卸载保存不能写回，其他书及新副本仍可保存', () => {
  vi.useFakeTimers()
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
  const deleted = crypto.randomUUID(), other = crypto.randomUUID(), restored = crypto.randomUUID()
  saveCharacterNetworkCache(deleted, { layout: 'before' })
  setTimeout(() => saveCharacterNetworkCache(deleted, { layout: 'late timer' }), 300)
  clearCharacterNetworkCache(deleted)
  vi.advanceTimersByTime(300)
  saveCharacterNetworkCache(deleted, { layout: 'late unmount' })
  expect(values.has(characterNetworkCacheKey(deleted))).toBe(false)
  for (const id of [other, restored]) {
    saveCharacterNetworkCache(id, { layout: 'retained' })
    expect(JSON.parse(values.get(characterNetworkCacheKey(id))!)).toEqual({ layout: 'retained' })
  }
})
