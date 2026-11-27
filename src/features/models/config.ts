import { createRetrievalSettings } from './retrievalSettings'
import { transact } from '../../lib/storage/transaction'
import type { createWorkspace } from '../../lib/storage/workspace'
import { credentialPresent } from '../local-storage/client'
import { defaultConfig, modelApis, ModelError, type ModelConfig, type ModelSettings } from './types'

type Workspace = ReturnType<typeof createWorkspace>
interface Credential { providerId: string; type: 'api_key'; key: string }
const configKey = 'llm.config'

export function validateConfig(input: ModelConfig, requireModels = true): ModelConfig {
  if (!input || typeof input !== 'object' || !modelApis.includes(input.api)) throw new ModelError('unsupported_provider', '请选择支持的模型协议。')
  if (typeof input.providerId !== 'string' || !/^[a-z][a-z0-9._-]*$/i.test(input.providerId.trim())) throw new ModelError('validation', '服务商标识须以字母开头，使用字母、数字、点、下划线或连字符。')
  if (['p3-siliconflow-retrieval','p3-retrieval-embedding','p3-retrieval-rerank'].includes(input.providerId.trim().toLowerCase())) throw new ModelError('validation', '该标识已用于事件检索。')
  let url: URL
  try { url = new URL(input.baseUrl.trim()) } catch { throw new ModelError('validation', '请输入完整的服务基础地址。') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ModelError('validation', '服务地址须使用 HTTP 或 HTTPS，凭据请填写在密钥栏。')
  if (typeof input.extractionModel !== 'string' || typeof input.aggregationModel !== 'string' || (requireModels && (!input.extractionModel.trim() || !input.aggregationModel.trim()))) throw new ModelError('validation', '请填写提取模型和整理模型。')
  const window = input.aggregationContextWindow
  if (window !== undefined && (!Number.isSafeInteger(window) || window < 8192)) throw new ModelError('validation', '上下文容量须为不小于 8192 的整数，或留空使用默认值。')
  const baseUrl = url.href.replace(/\/+$/, '')
  return { providerId: input.providerId.trim().toLowerCase(), api: input.api, baseUrl: input.api === 'anthropic-messages' ? baseUrl.replace(/\/v1$/, '') : baseUrl, extractionModel: input.extractionModel.trim(), aggregationModel: input.aggregationModel.trim(), ...(window === undefined ? {} : { aggregationContextWindow: window }) }
}

export function createModelConfigStore(workspace: Workspace, send: typeof fetch = fetch) {
  const { settings } = workspace
  const credentials = settings.table<Credential>('credentials')
  async function readConfig(settings: Workspace['settings']) {
    const stored = (await settings.appSettings.get(configKey))?.value
    const config = validateConfig({ ...defaultConfig, ...(stored && typeof stored === 'object' ? stored : {}) }, false)
    return config
  }
  async function read(): Promise<ModelSettings> {
    return transact(settings, 'r', [settings.appSettings, credentials], async (settings) => {
      const config = await readConfig(settings)
      const configured = await credentialPresent(settings, config.providerId) ?? !!(await settings.table<Credential>('credentials').get(config.providerId))?.key.trim()
      return { config, configured }
    })
  }
  async function persist(input: ModelConfig, apiKey: string, requireModels: boolean) {
    const config = validateConfig(input, requireModels)
    await transact(settings, 'rw', [settings.appSettings, credentials], async (settings) => {
      await settings.appSettings.put({ key: configKey, value: config })
      if (apiKey.trim()) await settings.table<Credential>('credentials').put({ providerId: config.providerId, type: 'api_key', key: apiKey.trim() })
    })
    return read()
  }
  return {
    read,
    retrieval: createRetrievalSettings(workspace,send),
    save: (input: ModelConfig, apiKey = '') => persist(input, apiKey, true),
    saveDraft: (input: ModelConfig, apiKey = '') => persist(input, apiKey, false),
    async isCredentialConfigured(providerId: string) { const id = providerId.trim().toLowerCase(); return await credentialPresent(settings, id) ?? !!(await credentials.get(id))?.key.trim() },
    async clearCredential(providerId: string) { await credentials.delete(providerId); return read() },
    async load() {
      return transact(settings, 'r', [settings.appSettings, credentials], async (settings) => {
        const config = await readConfig(settings)
        const credential = await settings.table<Credential>('credentials').get(config.providerId)
        const apiKey = credential?.key.trim() ?? ''
        return { config, configured: !!apiKey, apiKey }
      })
    },
  }
}
export type ModelConfigStore = ReturnType<typeof createModelConfigStore>
