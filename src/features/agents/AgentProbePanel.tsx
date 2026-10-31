import { useEffect, useRef, useState } from 'react'
import type { ModelService } from '../models/service'
import type { ProbeResult } from './probe'
import './AgentProbePanel.css'

export function AgentProbePanel({ service, enabled, dirty, prepare }: { service: ModelService; enabled: boolean; dirty: boolean; prepare: () => Promise<boolean> }) {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('')
  const [results, setResults] = useState<ProbeResult[]>([])
  const [error, setError] = useState('')
  const controller = useRef<AbortController | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort() } }, [])
  async function run() {
    if (controller.current) return
    const current = new AbortController(); controller.current = current
    setRunning(true); setError(''); setResults([]); setProgress('准备测试')
    try {
      if (!await prepare() || current.signal.aborted) return
      const outcome = await service.probeTools({ signal: current.signal, onProgress: value => { if (mounted.current) setProgress(`${value.suite === 'asset' ? '世界资产' : '叙事资产'} · ${value.step === '模型生成' || value.step === '准备隔离样本' ? value.step : value.step.startsWith('commit_') ? '写入与提交确认' : value.step === 'submit_result' ? '核对最终总结' : '读取资料'}`) } })
      if (mounted.current) { setResults(outcome.results); setProgress(outcome.cancelled ? '已取消工具测试' : outcome.ok ? '两套工具测试通过' : '工具测试未全部通过') }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : '工具测试失败，请重试。') }
    finally { controller.current = undefined; if (mounted.current) setRunning(false) }
  }
  return <section className="agent-probe-panel" aria-label="智能体工具测试"><div className="agent-probe-heading"><h3>整理工具测试</h3><button type="button" className="secondary-button" disabled={!enabled || running} onClick={() => void run()}>{running ? '正在测试工具…' : dirty ? '保存并测试工具' : '测试工具读写'}</button>{running && <button type="button" className="text-button" onClick={() => controller.current?.abort()}>取消工具测试</button>}</div><p>依次检查人物合并与叙事工作记忆，使用临时样本验证真实读取、写入和提交确认。</p>{progress && <p role="status">{progress}</p>}{error && <p role="alert">{error}</p>}{!!results.length && <div className="agent-probe-results">{results.map(result => <article key={result.suite}><strong>{result.suite === 'asset' ? '世界资产' : '叙事资产'} · {result.ok ? '通过' : '失败'}</strong><p>读取 {result.readCalls} 次 · 写入 {result.writeCalls} 次 · 实际请求 {result.attempts} 次</p>{result.error && <p role="alert">{result.error}</p>}<details><summary>查看提交确认</summary><p>{result.commitIds.join('、') || '尚无提交确认'}</p></details></article>)}</div>}</section>
}
