import { useState } from 'react'

export function ModelPicker({ id, label, value, modelIds, disabled, onChange }: {
  id: string; label: string; value: string; modelIds: string[]; disabled: boolean; onChange: (value: string) => void
}) {
  const [manual, setManual] = useState(false)
  return <div className="model-field model-picker">
    <div className="model-picker-label"><label htmlFor={id}>{label}</label><button className="text-button" type="button" disabled={disabled} aria-label={`${manual ? '从列表选择' : '手动填写'}${label}`} onClick={() => setManual(current => !current)}>{manual ? '从列表选择' : '手动填写'}</button></div>
    {manual ? <input id={id} value={value} disabled={disabled} autoComplete="off" placeholder="填写服务商提供的模型名称" onChange={event => onChange(event.target.value)} /> : <select id={id} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
      <option value="">{modelIds.length ? '请选择模型' : '先拉取模型，或手动填写'}</option>
      {value && !modelIds.includes(value) && <option value={value}>{value}（当前配置）</option>}
      {modelIds.map(model => <option key={model} value={model}>{model}</option>)}
    </select>}
  </div>
}
