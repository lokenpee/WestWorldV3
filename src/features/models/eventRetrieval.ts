import type { CandidateModels } from '../story/eventCandidates'

export type RetrievalRole = 'embedding' | 'rerank'
export interface RetrievalConnection { baseUrl: string; modelId: string; apiKey: string }
export const retrievalLabels = {embedding:'Embedding 向量化', rerank:'Rerank 重排'}
export const siliconFlowUrl = 'https://api.siliconflow.cn/v1'
export const legacyModels = {embedding:'Qwen/Qwen3-Embedding-8B', rerank:'Qwen/Qwen3-Reranker-8B'}

export function retrievalUrl(value: string) {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw Error('请填写完整的 API 基础地址。') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw Error('请填写 HTTP 或 HTTPS 基础地址，密钥填在 API Key 栏。')
  return url.href.replace(/\/+$/, '')
}

async function request(send: typeof fetch, role: RetrievalRole, connection: RetrievalConnection,
  path: string, signal: AbortSignal, body?: object) {
  const label = retrievalLabels[role]
  if (!connection.apiKey) throw Error(label+' 缺少密钥，请在设置页配置。')
  const timeout = AbortSignal.timeout(30000)
  try {
    const response = await send(connection.baseUrl+'/'+path, {
      method:body ? 'POST' : 'GET', redirect:'error', credentials:'omit',
      headers:{Authorization:'Bearer '+connection.apiKey, ...(body && {'Content-Type':'application/json'})},
      body: body && JSON.stringify(body), signal:AbortSignal.any([timeout,signal]),
    })
    if (!response.ok) throw Error(label+' '+path+' 返回 HTTP '+response.status)
    return await response.json()
  } catch (error) {
    signal.throwIfAborted()
    if (timeout.aborted) throw Error(label+' '+path+' 请求超时')
    if (error instanceof Error && error.message.startsWith(label+' ')) throw error
    throw Error(label+' '+path+' 请求失败，请检查地址、跨域权限和响应格式。')
  }
}

function ordered<T>(items: unknown, count: number, read: (item: Record<string,unknown>) => T) {
  if (!Array.isArray(items) || items.length !== count) throw Error('模型接口返回条数不符')
  const values = new Map<number,T>()
  for (const item of items) {
    const i = item?.index
    if (!Number.isInteger(i) || i < 0 || i >= count || values.has(i)) throw Error('模型接口返回编号无效')
    values.set(i, read(item))
  }
  return Array.from({ length: count }, (_,k) => values.get(k)!)
}

function modelRole(value: string): RetrievalRole | 'other' | undefined {
  if (/rerank|re-rank/i.test(value)) return 'rerank'
  if (/embed|(?:^|[/_-])bge-(?:m3|large|base|small)(?:[-:/]|$)|(?:^|[/_-])e5-(?:large|base|small)/i.test(value)) return 'embedding'
  if (/chat|completion|generat|image|video|speech|audio|moderation|^llm$/i.test(value)) return 'other'
}

export async function retrievalCatalog(role: RetrievalRole, connection: RetrievalConnection, signal: AbortSignal, send: typeof fetch) {
  const serverFiltered = connection.baseUrl === siliconFlowUrl
  const path = serverFiltered ? 'models?sub_type='+(role==='embedding' ? 'embedding' : 'reranker') : 'models'
  const result = await request(send,role,connection,path,signal)
  if (!Array.isArray(result?.data)) throw Error('模型目录缺少 data 列表。')
  const matched = new Set<string>(), untyped = new Set<string>()
  for (const item of result.data) {
    if (typeof item?.id !== 'string' || !item.id.trim()) continue
    const id = item.id.trim()
    if (serverFiltered) { matched.add(id); continue }
    const metadata = [item.sub_type,item.model_type,item.type,item.task,item.capabilities,item.supported_endpoints]
      .flatMap(value => typeof value === 'object' && value && !Array.isArray(value)
        ? Object.keys(value).filter(key => value[key] === true) : value)
      .filter((v): v is string => typeof v === 'string')
    const roles = metadata.map(modelRole).filter(Boolean)
    if (!roles.length) {
      const inferred = modelRole(id)
      if (inferred) roles.push(inferred)
      else untyped.add(id)
    }
    if (roles.includes(role)) matched.add(id)
  }
  return {modelIds:[...matched].sort(), untypedIds:[...untyped].sort()}
}

export function retrievalModels(connections: Record<RetrievalRole,RetrievalConnection>, send: typeof fetch = fetch): CandidateModels {
  return {
    async embeddings(input, signal) {
      const config = connections.embedding
      const result = await request(send,'embedding',config,'embeddings',signal,{model:config.modelId,input,encoding_format:'float'})
      const vectors = ordered(result?.data,input.length,item=>{
        const v = item.embedding
        if (!Array.isArray(v) || !v.length || !v.every(Number.isFinite) || !v.some(n=>n!==0))
          throw Error('Embedding 接口返回无效向量。')
        return v as number[]
      })
      if (vectors.some(v=>v.length!==vectors[0].length)) throw Error('Embedding 返回的向量维数不一致。')
      return vectors
    },
    async rerank(query, documents, signal) {
      const config = connections.rerank
      const result = await request(send,'rerank',config,'rerank',signal,{
        model:config.modelId,query,documents,top_n:documents.length,return_documents:false,
      })
      return ordered(result?.results,documents.length,item=>{
        if (typeof item.relevance_score !== 'number' || !Number.isFinite(item.relevance_score))
          throw Error('Rerank 接口返回无效分数。')
        return item.relevance_score
      })
    },
  }
}
