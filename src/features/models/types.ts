import type { AssistantMessage, Context, Model, Usage } from '@earendil-works/pi-ai'

export const modelApis = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const
export type ModelApi = typeof modelApis[number]
export type ModelRole = 'extraction' | 'aggregation'
export type CallMode = 'direct' | 'agent' | 'catalog'
export type ErrorKind = 'network' | 'rate_limit' | 'server' | 'auth' | 'context_length' | 'content_policy' | 'validation' | 'cancelled' | 'unsupported_provider' | 'unsupported_capability' | 'unknown'
export interface ModelConfig {
  providerId: string; api: ModelApi; baseUrl: string; extractionModel: string; aggregationModel: string; aggregationContextWindow?: number
}
export type ModelConnection = Pick<ModelConfig, 'providerId' | 'api' | 'baseUrl'>
export interface CatalogResult extends CallResult { modelIds: string[]; connection?: ModelConnection }
export interface ModelSettings { config: ModelConfig; configured: boolean }
export interface ModelSnapshot {
  providerId: string; api: ModelApi; baseUrl: string; modelId: string; modelRole: ModelRole
  contextWindow: number; maxTokens: number; metadataStatus: 'catalog' | 'estimated'
  contextSource: 'catalog' | 'configured' | 'estimated'
  capabilities: { text: true; tools: 'unverified' }
  pricingStatus: 'estimated' | 'unknown'; pricingCurrency?: 'USD'; credentialRef: string
}
export interface ResolvedModel { snapshot: ModelSnapshot; model: Model<ModelApi>; apiKey: string }
export interface ModelFailure { kind: ErrorKind; message: string; stopReason?: string; status?: number }
export interface Attempt {
  ordinal: number; turn: number; elapsedMs: number; status?: number; errorKind?: ErrorKind; usage?: Usage
}
export interface UsageSummary { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; costStatus: 'estimated' | 'unknown'; cost?: number; currency?: 'USD' }
export interface CallResult {
  ok: boolean; mode: CallMode; snapshot?: ModelSnapshot; text: string; elapsedMs: number; attempts: Attempt[]
  usage: UsageSummary; error?: ModelFailure; message?: AssistantMessage
}
export interface CallProgress { state: 'preparing' | 'requesting' | 'waiting'; attempts: number; delayMs?: number }
export interface CallOptions { signal?: AbortSignal; onProgress?: (progress: CallProgress) => void; timeoutMs?: number; maxRequests?: number; maxTokens?: number; temperature?: number }
export interface DirectRequest<T = string> extends CallOptions {
  role: ModelRole; context: Context; validate?: (message: AssistantMessage) => T; repairPrompt?: string
}
export class ModelError extends Error {
  readonly kind: ErrorKind
  readonly status?: number
  constructor(kind: ErrorKind, message: string, status?: number) { super(message); this.name = 'ModelError'; this.kind = kind; this.status = status }
}
export const defaultConfig: ModelConfig = { providerId: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com', extractionModel: 'deepseek-flash', aggregationModel: 'deepseek-v4-pro' }
