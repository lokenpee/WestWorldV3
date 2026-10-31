import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveResult } from '../../hooks/useLiveResult'
import type { ModelService } from './service'
import { defaultConfig, type CallMode, type CallProgress, type CallResult, type ModelConfig, type ModelConnection, type ModelSettings as SavedSettings } from './types'
import { ModelPicker } from './ModelPicker'
import { AgentProbePanel } from '../agents/AgentProbePanel'
import './ModelSettings.css'

type Form = Omit<ModelConfig, 'aggregationContextWindow'> & { aggregationContextWindow: string }
const formOf = (config: ModelConfig): Form => ({ ...config, aggregationContextWindow: config.aggregationContextWindow === undefined ? '' : String(config.aggregationContextWindow) })
const presets = [
  { id: 'deepseek', label: 'DeepSeek', providerId: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com' },
  { id: 'openai', label: 'OpenAI', providerId: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
  { id: 'anthropic', label: 'Claude / Anthropic', providerId: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' },
  { id: 'compatible', label: '其他兼容服务 / 中转平台', providerId: 'custom', api: 'openai-completions', baseUrl: '' },
] as const
const presetOf = (config: ModelConnection) => presets.find(preset => preset.id !== 'compatible' && preset.providerId === config.providerId)?.id ?? 'compatible'
const connectionKey = (config: ModelConnection) => {
  let address = config.baseUrl.trim()
  try { address = new URL(address).href } catch { /* 输入中的地址按原值比较。 */ }
  address = address.replace(/\/+$/, '')
  if (config.api === 'anthropic-messages') address = address.replace(/\/v1$/, '')
  return JSON.stringify([config.providerId.trim().toLowerCase(), config.api, address])
}
interface Operation { running: boolean; progress?: CallProgress; result?: CallResult }
const labels: Record<CallMode, string> = { direct: '提取测试', agent: '整理测试', catalog: '模型目录' }
function CallFeedback({ operation, mode, onCancel }: { operation: Operation; mode: CallMode; onCancel: () => void }) {
  const { result, progress, running } = operation
  return <section className="model-feedback" aria-label={`${labels[mode]}结果`}>
    {running && <div role="status"><p>{progress?.state === 'waiting' ? `已发起 ${progress.attempts} 次请求，等待 ${Math.ceil((progress.delayMs ?? 0) / 1000)} 秒后重试…` : progress?.state === 'requesting' ? `正在发送第 ${progress.attempts} 次请求…` : '正在读取已保存配置并准备调用…'}</p><button type="button" className="secondary-button" onClick={onCancel}>取消{labels[mode]}</button></div>}
    {result && <div className={result.ok ? 'model-result-success' : result.error?.kind === 'cancelled' ? 'model-result-cancelled' : 'model-result-error'} role={result.ok || result.error?.kind === 'cancelled' ? 'status' : 'alert'}>
      <strong>{result.ok ? `${labels[mode]}成功` : result.error?.kind === 'cancelled' ? '已取消' : `${labels[mode]}失败`}</strong>
      {result.snapshot && <p>本次模型：{result.snapshot.modelId}</p>}
      {mode === 'catalog' && 'connection' in result && !!result.connection && <p>本次连接：{(result.connection as ModelConnection).baseUrl}</p>}
      {result.ok && <p className="model-reply">{result.text.slice(0, 180)}</p>}
      {mode === 'catalog' && result.ok && 'modelIds' in result && Array.isArray(result.modelIds) && result.modelIds.length === 0 && <p>服务未返回可选模型，可手动填写平台提供的模型名称后测试。</p>}
      {result.error && <p>{result.error.message}</p>}
      <p>耗时：{(result.elapsedMs / 1000).toFixed(2)} 秒 · 实际请求：{result.attempts.length} 次</p>
      {mode !== 'catalog' && <details className="model-diagnostics"><summary>查看用量与连接详情</summary>{result.snapshot && <p>{result.mode === 'agent' ? 'Agent 基础调用' : '直接调用'} · {result.snapshot.baseUrl}<br />上下文容量：{result.snapshot.contextWindow.toLocaleString()}（{result.snapshot.contextSource === 'catalog' ? '模型目录' : result.snapshot.contextSource === 'configured' ? '已配置' : '估算'}）</p>}<p>{result.usage.totalTokens > 0 ? `输入 ${result.usage.input} · 输出 ${result.usage.output} · 缓存读取 ${result.usage.cacheRead} · 缓存写入 ${result.usage.cacheWrite} · 总用量 ${result.usage.totalTokens}` : '服务未返回用量'}<br />{result.usage.costStatus === 'unknown' ? '费用未知' : `估算费用：${result.usage.cost?.toFixed(6)} ${result.usage.currency}`}</p></details>}
    </div>}
  </section>
}

export function ModelSettings({ service }: { service: ModelService }) {
  const [attempt, setAttempt] = useState(0)
  const query = useCallback(() => service.settings.read(), [service])
  const stored = useLiveResult(query, attempt)
  const [baseline, setBaseline] = useState<SavedSettings>()
  const [form, setForm] = useState<Form>(() => formOf(defaultConfig))
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [catalog, setCatalog] = useState<{ scope: string; ids: string[] }>()
  const [advanced, setAdvanced] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const catalogEpoch = useRef(0)
  const [operations, setOperations] = useState<Record<CallMode, Operation>>({ direct: { running: false }, agent: { running: false }, catalog: { running: false } })
  const controllers = useRef<Partial<Record<CallMode, AbortController>>>({})
  const mounted = useRef(true)
  const savingRef = useRef(false)
  useEffect(() => { mounted.current = true; const active = controllers.current; return () => { mounted.current = false; for (const controller of Object.values(active)) controller?.abort() } }, [])
  const dirty = !!baseline && (apiKey.length > 0 || JSON.stringify(form) !== JSON.stringify(formOf(baseline.config)))
  const credentialQuery = useCallback(() => service.settings.isCredentialConfigured(form.providerId), [service, form.providerId])
  const credential = useLiveResult(credentialQuery)
  const hasCredential = !!apiKey.trim() || (credential.status === 'ready' && credential.value)
  const scope = connectionKey(form)
  const modelIds = catalog?.scope === scope ? catalog.ids : []
  if (stored.status === 'ready' && (!baseline || (!dirty && JSON.stringify(stored.value.config) !== JSON.stringify(baseline.config)))) { setBaseline(stored.value); setForm(formOf(stored.value.config)) }
  const load = (value: SavedSettings) => { setBaseline(value); setForm(formOf(value.config)); setApiKey(''); setShowKey(false) }
  async function save(): Promise<SavedSettings | undefined> {
    if (savingRef.current) return undefined
    savingRef.current = true; setSaving(true); setError(''); setMessage('')
    try {
      const capacity = form.aggregationContextWindow.trim()
      const input = { ...form, aggregationContextWindow: capacity ? Number(capacity) : undefined }
      const value = await service.settings.saveDraft(input, apiKey)
      if (mounted.current) { load(value); setMessage('模型配置已保存，下一次调用使用此配置。') }
      return value
    } catch (error) { if (mounted.current) { const text = error instanceof Error ? error.message : '保存失败，请重试。'; setError(text); if (text.includes('上下文容量') || text.includes('服务商标识') || text.includes('协议')) setAdvanced(true) }; return undefined }
    finally { savingRef.current = false; if (mounted.current) setSaving(false) }
  }
  async function clearKey() {
    if (saving || !form.providerId) return
    setSaving(true); setError('')
    try { await service.settings.clearCredential(form.providerId.trim().toLowerCase()); if (mounted.current) { setApiKey(''); setMessage('已清除当前服务商的密钥。') } }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : '清除失败，请重试。') }
    finally { if (mounted.current) setSaving(false) }
  }
  async function run(mode: CallMode) {
    if (controllers.current[mode] || savingRef.current) return
    const controller = new AbortController(); controllers.current[mode] = controller
    const epoch = catalogEpoch.current
    setOperations(current => ({ ...current, [mode]: { running: true } }))
    const options = { signal: controller.signal, onProgress: (progress: CallProgress) => { if (mounted.current && controllers.current[mode] === controller) setOperations(current => ({ ...current, [mode]: { running: true, progress } })) } }
    try {
      if (dirty && !await save()) return
      if (controller.signal.aborted) return
      const result = mode === 'catalog' ? await service.catalog(options) : await service.probe(mode, options)
      if (mounted.current && controllers.current[mode] === controller) {
        setOperations(current => ({ ...current, [mode]: { running: false, result } }))
        if (mode === 'catalog' && result.ok && 'modelIds' in result && 'connection' in result && result.connection && epoch === catalogEpoch.current) setCatalog({ scope: connectionKey(result.connection as ModelConnection), ids: result.modelIds as string[] })
      }
    } finally { if (controllers.current[mode] === controller) delete controllers.current[mode]; if (mounted.current) setOperations(current => current[mode].running ? { ...current, [mode]: { running: false } } : current) }
  }
  if (stored.status === 'loading') return <p role="status">正在读取模型配置…</p>
  if (stored.status === 'error') return <section className="model-settings error-panel" role="alert"><p>{stored.message}</p><button className="secondary-button" onClick={() => setAttempt(value => value + 1)}>重新读取模型配置</button></section>
  const update = (key: keyof Form, value: string) => { if (['providerId', 'api', 'baseUrl'].includes(key)) { catalogEpoch.current++; setCatalog(undefined) }; setForm(current => ({ ...current, [key]: value })); setError(''); setMessage('') }
  const choosePreset = (id: string) => {
    const preset = presets.find(row => row.id === id)!
    catalogEpoch.current++; setCatalog(undefined); setApiKey(''); setShowKey(false); setError(''); setMessage('')
    setForm(current => ({ ...current, providerId: preset.providerId, api: preset.api, baseUrl: preset.baseUrl, extractionModel: id === 'deepseek' ? defaultConfig.extractionModel : '', aggregationModel: id === 'deepseek' ? defaultConfig.aggregationModel : '' }))
  }
  const configChanged = baseline && JSON.stringify(stored.value.config) !== JSON.stringify(baseline.config)
  const connectionReady = !!form.baseUrl.trim() && !!form.providerId.trim() && hasCredential
  const active = (mode: CallMode) => operations[mode].running
  const canTest = (mode: 'direct' | 'agent') => connectionReady && !!(mode === 'direct' ? form.extractionModel.trim() : form.aggregationModel.trim()) && !saving && !active(mode)
  const feedback = (mode: CallMode) => (operations[mode].running || operations[mode].result) && <CallFeedback operation={operations[mode]} mode={mode} onCancel={() => controllers.current[mode]?.abort()} />
  return <section className="model-settings" aria-labelledby="models-heading">
    <div className="model-section-heading"><h2 id="models-heading">模型与 API</h2><span className={`model-key-status${hasCredential ? ' is-ready' : ''}`}>{hasCredential ? apiKey.trim() ? '密钥待保存' : '密钥已配置' : '填写密钥后连接'}</span></div>
    <p className="model-help">填写地址和密钥 → 拉取模型 → 选择模型并测试连接。</p>
    {configChanged && <p className="model-notice">已保存配置有更新，当前输入已保留。<button type="button" className="text-button" onClick={() => load(stored.value)}>载入已保存配置</button></p>}
    <form noValidate onSubmit={event => { event.preventDefault(); void save() }}>
      <div className="model-connection-fields">
        <div className="model-field"><label htmlFor="model-service">模型服务</label><select id="model-service" value={presetOf(form)} disabled={saving} onChange={event => choosePreset(event.target.value)}>{presets.map(preset => <option value={preset.id} key={preset.id}>{preset.label}</option>)}</select></div>
        <div className="model-field"><label htmlFor="model-base-url">服务地址</label><input id="model-base-url" type="url" aria-label="服务基础地址" placeholder="填写平台提供的地址，通常以 /v1 结尾" value={form.baseUrl} disabled={saving} onChange={event => update('baseUrl', event.target.value)} /></div>
      </div>
      <div className="model-field"><label htmlFor="model-api-key">API Key（密钥）</label><div className="model-key-input"><input id="model-api-key" type={showKey ? 'text' : 'password'} autoComplete="new-password" value={apiKey} disabled={saving} onChange={event => { catalogEpoch.current++; setCatalog(undefined); setApiKey(event.target.value); setError(''); setMessage('') }} placeholder={credential.status === 'ready' && credential.value ? '已保存密钥，留空保留' : '粘贴此平台的 API Key'} /><button className="secondary-button" type="button" disabled={saving || !apiKey} aria-label={showKey ? '隐藏密钥' : '显示密钥'} onClick={() => setShowKey(value => !value)}>{showKey ? '隐藏' : '显示'}</button><button className="secondary-button" type="button" aria-label="清除当前服务密钥" disabled={saving || credential.status !== 'ready' || !credential.value} onClick={() => void clearKey()}>清除</button></div><small>当前服务 {form.providerId || '未命名'}：{credential.status === 'ready' && credential.value ? '密钥已配置' : apiKey.trim() ? '将随配置保存' : '密钥未配置'}。密钥保存在当前浏览器，书籍备份排除密钥。</small></div>
      <div className="model-connection-actions"><button className="primary-button" type="button" disabled={saving || active('catalog') || !connectionReady} onClick={() => void run('catalog')}>{active('catalog') ? '正在拉取…' : dirty ? '保存并拉取模型' : '拉取模型'}</button><button className="secondary-button" type="button" aria-label={dirty ? '保存并测试服务连接' : '测试服务连接'} disabled={!canTest('direct')} onClick={() => void run('direct')}>{active('direct') ? '正在测试…' : dirty ? '保存并测试连接' : '测试连接'}</button><button className="text-button" type="submit" aria-label="保存模型配置" disabled={saving}>{saving ? '正在保存…' : '保存配置'}</button></div>
      {!hasCredential && <p className="model-help">填入当前服务的密钥后，即可拉取模型和测试连接。</p>}
      {error && <p className="model-error" role="alert">{error}</p>}
      {message && <p role="status" className="model-saved">{message}</p>}
      {feedback('catalog')}
      {modelIds.length > 0 && <p className="model-help">已拉取 {modelIds.length} 个模型，请在下方选择。也可手动填写平台提供的模型名称。</p>}
      <div className="model-cards">
        <section className="model-role-card" aria-label="提取模型配置"><ModelPicker id="model-extraction" label="提取模型" value={form.extractionModel} modelIds={modelIds} disabled={saving} onChange={value => update('extractionModel', value)} /><p className="model-help">逐章提取资料，建议选速度快、成本低的模型。</p><button className="secondary-button" type="button" aria-label={dirty ? '保存并测试提取模型' : '测试提取模型'} disabled={!canTest('direct')} onClick={() => void run('direct')}>{active('direct') ? '正在测试…' : dirty ? '保存并测试' : '测试连接'}</button>{!form.extractionModel.trim() && <small className="model-help">先选择提取模型</small>}{feedback('direct')}</section>
        <section className="model-role-card" aria-label="整理模型配置"><ModelPicker id="model-aggregation" label="整理模型" value={form.aggregationModel} modelIds={modelIds} disabled={saving} onChange={value => update('aggregationModel', value)} /><p className="model-help">整理人物与事件，建议选推理能力较强的模型。</p><button className="secondary-button" type="button" aria-label={dirty ? '保存并测试整理模型' : '测试整理模型'} disabled={!canTest('agent')} onClick={() => void run('agent')}>{active('agent') ? '正在测试…' : dirty ? '保存并测试' : '测试连接'}</button>{!form.aggregationModel.trim() && <small className="model-help">先选择整理模型</small>}{feedback('agent')}</section>
      </div>
      <details className="model-advanced" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}><summary>高级设置（可选）</summary><p className="model-help">常见服务已自动匹配连接方式。平台有特殊要求时再调整。</p><div className="model-form-grid"><div className="model-field"><label htmlFor="model-provider">服务商标识</label><input id="model-provider" value={form.providerId} disabled={saving} onChange={event => update('providerId', event.target.value)} /></div><div className="model-field"><label htmlFor="model-api">调用协议</label><select id="model-api" value={form.api} disabled={saving} onChange={event => update('api', event.target.value)}><option value="openai-completions">通用兼容模式（Chat Completions）</option><option value="openai-responses">OpenAI 原生响应模式（Responses）</option><option value="anthropic-messages">Claude 原生消息模式（Messages）</option></select></div></div><div className="model-field"><label htmlFor="model-context-window">整理模型上下文容量</label><input id="model-context-window" type="number" min={8192} step={1024} placeholder="自动" value={form.aggregationContextWindow} disabled={saving} onChange={event => update('aggregationContextWindow', event.target.value)} /><small>留空使用模型资料；自定义模型可按平台说明填写。</small></div></details>
    </form>
    <AgentProbePanel service={service} enabled={connectionReady && !!form.aggregationModel.trim() && !saving} dirty={dirty} prepare={async () => !dirty || !!await save()} />
  </section>
}
