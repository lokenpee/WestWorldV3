export const characterNetworkCacheKey = (bookId: string) => `wwv3:character-network:v1:${bookId}`
const clearedBooks = new Set<string>()
/** 删除成功后的旧视图可能尚未卸载，不能由其防抖或卸载回调重新生成缓存。 */
export function saveCharacterNetworkCache(bookId: string, value: unknown) {
  if (!clearedBooks.has(bookId)) localStorage.setItem(characterNetworkCacheKey(bookId), JSON.stringify(value))
}
export function clearCharacterNetworkCache(bookId: string) {
  clearedBooks.add(bookId)
  try { localStorage.removeItem(characterNetworkCacheKey(bookId)) } catch { /* 本机存储不可用时无需处理 */ }
}
