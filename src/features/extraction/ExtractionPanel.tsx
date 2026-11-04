import { useCallback, useEffect, useState } from 'react'
import { useLiveResult } from '../../hooks/useLiveResult'
import type { ExtractionService } from './service'
import { stepLabels, type Substep } from './types'
import './ExtractionPanel.css'

export function ExtractionPanel({ bookId, service }: { bookId: string; service: ExtractionService }) {
  const [, refresh] = useState(0)
  const [showResults, setShowResults] = useState(false)
  const [recoveryError, setRecoveryError] = useState('')
  const [reExtract, setReExtract] = useState<{ step: Substep; preview?: { counts: { characters: number; locations: number; relations: number; nodes: number; eventLines: number }; blockers: string[] }; error?: string }>()
  useEffect(() => service.subscribe(() => refresh(value => value + 1)), [service])
  useEffect(() => {
    let active = true; let pending = false
    const recover = async () => {
      if (pending) return
      pending = true
      try { await service.recover(bookId); if (active) setRecoveryError('') }
      catch (error) { if (active) setRecoveryError(error instanceof Error ? error.message : '恢复进度读取失败，请刷新重试。') }
      finally { pending = false }
    }
    void recover()
    const timer = setInterval(() => void recover(), 1000)
    return () => { active = false; clearInterval(timer) }
  }, [service, bookId])
  const query = useCallback(() => service.progress(bookId), [service, bookId])
  const progress = useLiveResult(query)
  const state = service.state(bookId)
  const running = state?.running ?? false
  const saved = progress.status === 'ready' ? progress.value : undefined
  const complete = saved?.status === 'completed'
  const checking = !running && (saved?.busy || saved?.status === 'running' || saved?.status === 'cancelling')
  const resumable = !!saved && saved.status !== 'idle' && !complete
  const pending = saved?.reExtract
  const stepHasCompleted = (step: Substep) => !!saved && Object.values(saved.steps).some(row => row[step]?.status === 'completed')
  async function openReExtract(step: Substep) {
    setReExtract({ step })
    try {
      const preview = await service.reExtractPreview(bookId, { scope: 'all', step })
      setReExtract({ step, preview })
    } catch (error) { setReExtract({ step, error: error instanceof Error ? error.message : '读取重提范围失败。' }) }
  }
  async function confirmReExtract() {
    if (!reExtract?.preview || reExtract.preview.blockers.length) return
    try {
      await service.reExtract(bookId, { scope: 'all', step: reExtract.step })
      setReExtract(undefined)
    } catch (error) { setReExtract({ ...reExtract, error: error instanceof Error ? error.message : '重新提取失败。' }) }
  }
  const tokens = state?.results.reduce((sum, row) => sum + row.tokens, 0) ?? 0
  const expanded = running || showResults
  const statuses: Record<string, string> = { idle: '等待开始', running: '提取中', completed: '提取完成', failed: '有失败步骤', cancelled: '已取消', paused: '已暂停' }
  const primaryLabel = running ? '正在提取…' : pending ? `继续重提${pending.step === 'worldAssets' ? '世界资产' : '叙事资产'}` : complete ? '已完成提取' : checking ? '正在确认任务状态…' : resumable ? '继续提取' : '开始提取'
  return <section className="extraction-panel" aria-label="逐章提取">
    <div className="extraction-heading"><h2>P1 逐章提取全书</h2><div className="extraction-actions"><button className="primary-button" disabled={running || checking || (!pending && complete) || !!recoveryError || progress.status !== 'ready'} onClick={() => { setShowResults(false); if (pending) void service.continueReExtract(bookId); else void service.start(bookId) }}>{primaryLabel}</button><button className="secondary-button" disabled={running || checking || !!pending || !!recoveryError || progress.status !== 'ready' || !stepHasCompleted('worldAssets')} onClick={() => void openReExtract('worldAssets')}>重新提取世界资产</button><button className="secondary-button" disabled={running || checking || !!pending || !!recoveryError || progress.status !== 'ready' || !stepHasCompleted('narrativeAssets')} onClick={() => void openReExtract('narrativeAssets')}>重新提取叙事资产</button>{running && <button className="secondary-button" onClick={() => service.cancel(bookId)}>取消提取</button>}</div></div>
    <p role="status">{saved ? `${statuses[saved.status] ?? saved.status} · 成功 ${saved.completedChapters.length}/${saved.totalChapters} 章 / 块 · 失败 ${saved.failedChapters.length} 章 / 块` : '读取提取进度…'}</p>
    <p className="muted">每章先提取人物与地点，再提取事件节点。保存后即可查看、编辑，成功内容持续保留。</p>
    {saved && <p className="muted">已保存 {saved.completedSteps}/{saved.totalChapters * 2} 个子步骤 · 待处理 {saved.totalChapters * 2 - saved.completedSteps} 个</p>}
    {checking && <p role="status">正在确认本书任务状态。运行中的标签页继续处理；中断任务在执行权到期后开放继续。</p>}
    {resumable && !checking && !running && <p className="muted">点击“继续提取”处理尚未成功的步骤，已保存的人工修改、合并和删除结果保留。</p>}
    {running && <p role="status">{state?.chapter} · {state?.step && stepLabels[state.step]}{state?.progress ? ` · 已请求 ${state.progress.attempts} 次${state.progress.state === 'waiting' ? '，等待重试' : ''}` : ' · 正在准备'}</p>}
    {progress.status === 'error' && <p role="alert">{progress.message}</p>}
    {recoveryError && <p role="alert">{recoveryError}</p>}
    {state?.error && <p role="alert">{state.error}</p>}
    {!running && !state?.results.length && !!saved?.failures.length && <details><summary>待处理步骤（{saved.failures.length}）</summary>{saved.failures.map(row => <p key={`${row.chapterIndex}:${row.step}`}>第 {row.chapterIndex} 章 / 块 · {stepLabels[row.step]}：{row.message}</p>)}</details>}
    {!state?.results.length && saved?.usage && <p>最近一次提取用量：{saved.usage.totalTokens} tokens（计量单位） · {saved.usage.costStatus === 'unknown' ? '费用未知' : `估算费用：${saved.usage.cost.toFixed(6)} USD（美元）`}</p>}
    {!!state?.results.length && <><p>本次累计用量：{tokens} tokens（计量单位） · {state.results.every(row => row.cost !== undefined) ? `估算费用：${state.results.reduce((sum, row) => sum + (row.cost ?? 0), 0).toFixed(6)} USD（美元）` : '费用未知'}</p><div className="extraction-result-summary"><span>子步骤：成功 {state.results.filter(row => row.ok).length} 项 · 失败 {state.results.filter(row => !row.ok).length} 项</span>{!running && <button type="button" className="text-button" aria-expanded={expanded} aria-controls={`extraction-results-${bookId}`} onClick={() => setShowResults(value => !value)}>{expanded ? '收起章节结果' : '查看章节结果'}</button>}</div>{expanded && <div id={`extraction-results-${bookId}`} className="extraction-results" role="region" aria-label="章节提取结果">{state.results.map(row => <article key={`${row.chapterIndex}:${row.step}`} className={row.ok ? 'extraction-success' : 'extraction-failure'}><strong>第 {row.chapterIndex} 章 / 块 · {stepLabels[row.step]} · {row.ok ? '成功' : '失败'}</strong><p>{row.message}</p><small>实际请求 {row.attempts} 次 · 用量 {row.tokens} · {(row.elapsedMs / 1000).toFixed(2)} 秒</small></article>)}</div>}</>}
    {pending && <p role="status">待继续重提：{pending.scope === 'chapter' ? `第${pending.chapterIndex}章` : '整书'}{stepLabels[pending.step]}。点击主按钮继续，不会重新清空。</p>}
    {reExtract && <div className="extraction-dialog-backdrop"><section role="dialog" aria-modal="true" aria-label="确认重新提取" className="extraction-dialog">
      <h3>确认重新提取{reExtract.step === 'worldAssets' ? '世界资产' : '叙事资产'}？</h3>
      {!reExtract.preview && !reExtract.error && <p role="status">正在读取清空范围…</p>}
      {reExtract.error && <p className="field-error" role="alert">{reExtract.error}</p>}
      {reExtract.preview && <>
        <p>将先清空全书对应旧资产，再逐章重新提取。清空后不可恢复。</p>
        <p>{reExtract.step === 'worldAssets' ? `人物 ${reExtract.preview.counts.characters} · 地点 ${reExtract.preview.counts.locations} · 关系 ${reExtract.preview.counts.relations}；事件节点保留，P2整理结果清除，P3进度失效。` : `事件节点 ${reExtract.preview.counts.nodes} · 事件线 ${reExtract.preview.counts.eventLines}；人物、地点、关系保留，P3结果清除。`}</p>
        {!!reExtract.preview.blockers.length && <p className="field-error" role="alert">{reExtract.preview.blockers.join('；')}</p>}
      </>}
      <div className="editor-actions"><button type="button" className="danger-button" disabled={!reExtract.preview || !!reExtract.preview.blockers.length} onClick={() => void confirmReExtract()}>清空并重新提取</button><button type="button" className="secondary-button" onClick={() => setReExtract(undefined)}>取消</button></div>
    </section></div>}
  </section>
}
