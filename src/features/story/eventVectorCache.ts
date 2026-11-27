import type { createWorkspace } from '../../lib/storage/workspace'
import { hash } from '../agents/contracts'

export interface VectorCache {
  read(texts: string[]): Promise<(number[] | undefined)[]>
  save(texts: string[], vectors: number[][]): Promise<void>
  retain(texts: string[]): Promise<void>
}

// 每本书单独存放。键同时标识模型与输入原文，修改其他节点或事件字段不会使向量失效。
export function bookVectorCache(workspace: ReturnType<typeof createWorkspace>, bookId: string, namespace: string): VectorCache {
  const table = workspace.openBook(bookId).table<{id:string; vector:number[]},string>('eventRetrievalVectors')
  const keys = new Map<string,string>()
  async function key(body: string) {
    const saved = keys.get(body)
    if (saved) return saved
    const id = namespace + ':' + await hash(body)
    keys.set(body,id)
    return id
  }
  return {
    async read(texts) {
      const rows = await table.bulkGet(await Promise.all(texts.map(key)))
      return rows.map(row=>row?.vector)
    },
    async save(texts,vectors) {
      const ids = await Promise.all(texts.map(key))
      await table.bulkPut(ids.map((id,i)=>({id,vector:vectors[i]})))
    },
    async retain(texts) {
      const live = new Set(await Promise.all([...new Set(texts.filter(s=>s.trim()))].map(key)))
      const stale = (await table.toCollection().primaryKeys()).filter(id=>id.startsWith(namespace+':') && !live.has(id))
      if (stale.length) await table.bulkDelete(stale)
    },
  }
}
