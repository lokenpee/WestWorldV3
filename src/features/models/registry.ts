import type { Api, Model, ProviderStreams } from '@earendil-works/pi-ai'
import { ModelError, type ModelConfig, type ModelRole, type ResolvedModel } from './types'

export async function loadProtocol(api: ModelConfig['api']): Promise<ProviderStreams> {
  switch (api) {
    case 'openai-completions': return import('@earendil-works/pi-ai/api/openai-completions')
    case 'openai-responses': return import('@earendil-works/pi-ai/api/openai-responses')
    case 'anthropic-messages': return import('@earendil-works/pi-ai/api/anthropic-messages')
    default: throw new ModelError('unsupported_provider', '当前模型协议没有已注册的 Pi 适配器。')
  }
}
export async function resolveModel(config: ModelConfig, apiKey: string, role: ModelRole): Promise<ResolvedModel> {
  if (!apiKey.trim()) throw new ModelError('auth', '请先保存当前服务商的密钥。')
  let catalog: readonly Model<Api>[] = []
  if (config.providerId === 'deepseek') catalog = (await import('@earendil-works/pi-ai/providers/deepseek')).deepseekProvider().getModels()
  else if (config.providerId === 'openai') catalog = (await import('@earendil-works/pi-ai/providers/openai')).openaiProvider().getModels()
  else if (config.providerId === 'anthropic') catalog = (await import('@earendil-works/pi-ai/providers/anthropic')).anthropicProvider().getModels()
  const id = role === 'extraction' ? config.extractionModel : config.aggregationModel
  if (!id.trim()) throw new ModelError('validation', role === 'extraction' ? '请先选择提取模型，再测试连接。' : '请先选择整理模型，再测试连接。')
  const known = catalog.find(model => model.id === id && model.api === config.api)
  const official = known?.baseUrl.replace(/\/+$/, '') === config.baseUrl
  const contextWindow = role === 'aggregation' && config.aggregationContextWindow !== undefined ? config.aggregationContextWindow : known?.contextWindow ?? 8192
  const model = {
    ...(known ?? {}), id, name: known?.name ?? id, provider: config.providerId, api: config.api, baseUrl: config.baseUrl,
    input: known?.input ?? ['text'], reasoning: known?.reasoning ?? false, contextWindow,
    maxTokens: known?.maxTokens ?? 8192,
    cost: official ? { ...known!.cost } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as Model<ModelConfig['api']>
  return {
    model, apiKey,
    snapshot: { providerId: config.providerId, api: config.api, baseUrl: config.baseUrl, modelId: id, modelRole: role, contextWindow, maxTokens: model.maxTokens, metadataStatus: official ? 'catalog' : 'estimated', contextSource: role === 'aggregation' && config.aggregationContextWindow !== undefined ? 'configured' : official ? 'catalog' : 'estimated', capabilities: { text: true, tools: 'unverified' }, pricingStatus: official ? 'estimated' : 'unknown', ...(official ? { pricingCurrency: 'USD' as const } : {}), credentialRef: config.providerId },
  }
}
