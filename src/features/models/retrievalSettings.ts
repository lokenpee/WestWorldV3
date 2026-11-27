import type { createWorkspace } from '../../lib/storage/workspace'
import { transact } from '../../lib/storage/transaction'
import { legacyModels, retrievalCatalog, retrievalModels, retrievalUrl, siliconFlowUrl, type RetrievalRole } from './eventRetrieval'

type Workspace = ReturnType<typeof createWorkspace>
interface SavedConfig { baseUrl: string; modelId: string; revision: string }
interface Credential { providerId: string; type: 'api_key'; key: string }
const configKey = (role: RetrievalRole) => 'llm.retrieval.'+role
const credentialId = (role: RetrievalRole) => 'p3-retrieval-'+role

export function createRetrievalSettings(workspace: Workspace, send: typeof fetch) {
  const {settings} = workspace
  const tables = [settings.appSettings,settings.table<Credential>('credentials')]
  async function connection(role: RetrievalRole) {
    return transact(settings,'r',tables,async db=>{
      const saved = (await db.appSettings.get(configKey(role)))?.value as SavedConfig | undefined
      const id = saved ? credentialId(role) : 'p3-siliconflow-retrieval'
      const apiKey = (await db.table<Credential>('credentials').get(id))?.key.trim() ?? ''
      return {baseUrl:saved?.baseUrl ?? siliconFlowUrl,modelId:saved?.modelId ?? legacyModels[role],
        revision:saved?.revision ?? (apiKey ? 'legacy' : 'unset'),apiKey}
    })
  }
  return {
    async read(role: RetrievalRole) {
      const {baseUrl,modelId,apiKey} = await connection(role)
      return {baseUrl,modelId:apiKey ? modelId : '',configured:!!apiKey}
    },
    async catalog(role: RetrievalRole, address: string, key: string, signal: AbortSignal) {
      const saved = await connection(role)
      const baseUrl = retrievalUrl(address)
      const apiKey = key.trim() || (baseUrl===saved.baseUrl ? saved.apiKey : '')
      const catalog = await retrievalCatalog(role,{baseUrl,apiKey,modelId:''},signal,send)
      return {...catalog, async testAndSave(modelId: string, testSignal: AbortSignal) {
        if (!catalog.modelIds.includes(modelId) && !catalog.untypedIds.includes(modelId))
          throw Error('请选择当前平台返回的对应模型，或输入目录中未标注类型的模型 ID。')
        const selected = {baseUrl,apiKey,modelId}
        const client = retrievalModels({embedding:selected,rerank:selected},send)
        let result: string
        if (role==='embedding') {
          const [vector] = await client.embeddings(['信使递交密信。'],testSignal)
          result = '返回 '+vector.length+' 维向量'
        } else {
          const scores = await client.rerank('谁送来了密信？',['信使送来了一封密信。','庭院里开着梅花。'],testSignal)
          result = '返回两条评分，样例排序为 '+(scores[0]>=scores[1] ? '1、2' : '2、1')
        }
        testSignal.throwIfAborted()
        await transact(settings,'rw',tables,async db=>{
          await db.appSettings.put({key:configKey(role),value:{baseUrl,modelId,revision:crypto.randomUUID()}})
          await db.table<Credential>('credentials').put({providerId:credentialId(role),type:'api_key',key:apiKey})
        })
        return result
      }}
    },
    async runtime() {
      const [embedding,rerank] = await Promise.all([connection('embedding'),connection('rerank')])
      const vectorNamespace = embedding.baseUrl===siliconFlowUrl && embedding.modelId===legacyModels.embedding
        ? legacyModels.embedding : JSON.stringify([embedding.baseUrl,embedding.modelId])
      return {models:retrievalModels({embedding,rerank},send),vectorNamespace,
        configVersion:JSON.stringify([embedding.revision,rerank.revision])}
    },
  }
}
