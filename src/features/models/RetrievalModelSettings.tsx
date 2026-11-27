import { useEffect, useRef, useState } from 'react'
import type { ModelService } from './service'
import { retrievalLabels, siliconFlowUrl, type RetrievalRole } from './eventRetrieval'

type Catalog = Awaited<ReturnType<ModelService['settings']['retrieval']['catalog']>>

export function RetrievalModelSettings({role,service}:{role:RetrievalRole;service:ModelService}) {
  const settings = service.settings.retrieval
  const label = retrievalLabels[role]
  const [address,setAddress] = useState(siliconFlowUrl)
  const [key,setKey] = useState('')
  const [model,setModel] = useState('')
  const [saved,setSaved] = useState({baseUrl:'',modelId:'',configured:false})
  const [catalog,setCatalog] = useState<Catalog>()
  const [manual,setManual] = useState(false)
  const [busy,setBusy] = useState<'loading'|'catalog'|'test'|null>('loading')
  const [message,setMessage] = useState('')
  const [error,setError] = useState('')
  const active = useRef<AbortController|null>(null)
  useEffect(()=>{
    let live = true
    void settings.read(role).then(value=>{
      if (live) { setSaved(value); setAddress(value.baseUrl); setModel(value.modelId) }
    }).catch(()=>{if (live) setError('读取检索模型设置失败。')})
      .finally(()=>{if (live) setBusy(null)})
    return ()=>{live=false;active.current?.abort()}
  },[settings,role])

  function resetCatalog() {
    setCatalog(undefined); setModel(''); setManual(false); setMessage(''); setError('')
  }
  async function run(test: boolean) {
    if (active.current) return
    const request = new AbortController()
    active.current = request
    setBusy(test ? 'test' : 'catalog'); setMessage(''); setError('')
    try {
      const list = test && catalog ? catalog : await settings.catalog(role,address,key,request.signal)
      request.signal.throwIfAborted()
      setCatalog(list)
      if (test) {
        const result = await list.testAndSave(model.trim(),request.signal)
        if (request.signal.aborted) return
        setSaved({baseUrl:address,modelId:model.trim(),configured:true})
        setKey(''); setMessage(model.trim()+' 测试成功，'+result+'。已保存。')
      } else {
        const known = list.modelIds.includes(model)
        const untyped = list.untypedIds.includes(model)
        setModel(known || untyped ? model : '')
        setManual(untyped || (!list.modelIds.length && !!list.untypedIds.length))
        setMessage('找到 '+list.modelIds.length+' 个匹配模型，另有 '+list.untypedIds.length+' 个未标注类型的候选。')
      }
    } catch (cause) {
      if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : '模型请求失败。')
      if (!test) setCatalog(undefined)
    } finally {
      active.current = null
      if (!request.signal.aborted) setBusy(null)
    }
  }
  const hasKey = !!key.trim() || (saved.configured && address.trim()===saved.baseUrl)
  const candidate = catalog
    ? catalog.modelIds.includes(model.trim()) || catalog.untypedIds.includes(model.trim())
    : saved.configured && model===saved.modelId
  return <section className="model-role-card" aria-label={label}>
    <h4>{label}</h4>
    <div className="model-field"><label htmlFor={role+'-url'}>API 基础地址</label>
      <input id={role+'-url'} type="url" value={address} disabled={!!busy}
        onChange={e=>{setAddress(e.target.value);resetCatalog()}} /></div>
    <div className="model-field"><label htmlFor={role+'-key'}>API Key</label>
      <input id={role+'-key'} type="password" autoComplete="new-password" value={key} disabled={!!busy}
        placeholder={saved.configured && address===saved.baseUrl ? '已保存，留空沿用' : '填写此服务的 API Key'}
        onChange={e=>{setKey(e.target.value);resetCatalog()}} /></div>
    <div className="model-connection-actions"><button type="button" className="secondary-button"
      aria-label={'拉取'+label+'模型'} disabled={!!busy || !address.trim() || !hasKey} onClick={()=>void run(false)}>{busy==='catalog' ? '正在拉取…' : '拉取模型'}</button></div>
    <div className="model-field">
      <div className="model-picker-label"><label htmlFor={role+'-model'}>{manual ? '平台候选 ID' : '模型'}</label>
        {!!catalog?.untypedIds.length && <button type="button" className="text-button" disabled={!!busy}
          onClick={()=>{setManual(!manual);setModel('');setMessage('');setError('')}}>{manual ? '从列表选择' : '输入未标注类型的候选 ID'}</button>}</div>
      {manual ? <input id={role+'-model'} value={model} disabled={!!busy} placeholder="输入平台目录中的完整模型 ID"
          onChange={e=>{setModel(e.target.value);setMessage('');setError('')}} />
        : <select id={role+'-model'} value={model} disabled={!!busy || !catalog}
          onChange={e=>{setModel(e.target.value);setMessage('');setError('')}}>
          <option value="">{catalog ? '选择模型' : '先拉取模型'}</option>
          {!catalog && saved.modelId && <option value={saved.modelId}>{saved.modelId}</option>}
          {catalog?.modelIds.map(id=><option key={id} value={id}>{id}</option>)}
        </select>}
      {manual && model.trim() && !candidate && <small>该 ID 不在此服务返回的可用候选中。</small>}
    </div>
    <div className="model-actions"><button type="button" className="primary-button" disabled={!!busy || !candidate || !hasKey}
      onClick={()=>void run(true)}>{busy==='test' ? '正在测试…' : '测试并保存'}</button></div>
    {message && <p role="status">{message}</p>}
    {error && <p role="alert" className="model-error">{error}</p>}
  </section>
}
