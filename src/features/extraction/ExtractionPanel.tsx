import { useCallback, useEffect, useState } from 'react'
import { useLiveResult, bookInterests } from '../../hooks/useLiveResult'
import type { ExtractionService } from './service'
import { stepLabels, type Substep } from './types'
import './ExtractionPanel.css'

export function ExtractionPanel({ bookId, service }: { bookId: string; service: ExtractionService }) {
  const [, refresh] = useState(0)
  const [showResults, setShowResults] = useState(false)
  const [resultPage, setResultPage] = useState(0)
  const [recoveryError, setRecoveryError] = useState('')
  const [actionError, setActionError] = useState('')
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
  const progress = useLiveResult(query, 0, bookInterests(bookId, ['chapters', 'extractionReceipts', 'compileProgress', 'pipelineRuns', 'extractionTasks']))
  const state = service.state(bookId)
  const running = state?.running ?? false
  const saved = progress.status === 'ready' ? progress.value : undefined
  const jobs = saved?.extractionJobs ?? {}
  const ready = progress.status === 'ready' && !!saved && !recoveryError
  const togetherJobs = Object.values(jobs).filter(job => job?.group === 'together')
  const togetherRunning = togetherJobs.some(job => job?.status === 'running' || job && service.laneState(bookId, job.step)?.running) || (running && !Object.keys(jobs).length)
  const singleJobs = Object.values(jobs).some(job => job?.group === 'single' && job.scope === 'all')
  const complete = !!saved && saved.totalChapters > 0 && saved.completedSteps === saved.totalChapters * 2
  const checking = !!saved?.busy && !running
  const togetherLabel = togetherRunning ? (checking ? '正在确认任务状态…' : '暂停提取') : togetherJobs.some(job => job?.status !== 'completed') ? '继续提取' : complete ? '提取完成' : saved?.completedSteps ? '继续提取未完成章节' : '一起提取'
  async function act(work: () => Promise<void>) {
    setActionError('')
    setResultPage(0)
    try { await work() }
    catch (error) { setActionError(error instanceof Error ? error.message : '提取操作失败。') }
  }
  async function openReExtract(step: Substep) {
    setReExtract({ step })
    try {
      const preview = await service.previewLane(bookId, step)
      setReExtract({ step, preview })
    } catch (error) { setReExtract({ step, error: error instanceof Error ? error.message : '读取重提范围失败。' }) }
  }
  function confirmReExtract() {
    if (!reExtract?.preview || reExtract.preview.blockers.length) return
    const step = reExtract.step
    setReExtract(undefined)
    void act(() => service.startLane(bookId, step, { replace: true }))
  }
  function laneButton(step: Substep) {
    const name = step === 'worldAssets' ? '世界资产' : '叙事资产'
    const job = jobs[step]
    const local = service.laneState(bookId, step)?.running
    const active = local || job?.status === 'running'
    const retained = job?.group === 'single' && job.scope === 'all'
    const label = job?.group === 'single' && active ? `暂停${name}提取` : retained ? job.status === 'completed' ? `${name}提取完成` : `继续${name}提取` : `重新提取${name}`
    return <button key={step} className="secondary-button" disabled={!ready || !!saved?.externalBusy || togetherRunning || togetherJobs.some(item => item?.status !== 'completed') || (active && !local) || (retained && job.status === 'completed' && !active)} onClick={() => {
      if (active) service.pauseLane(bookId, step)
      else if (retained) void act(() => service.startLane(bookId, step, { resume: true }))
      else void openReExtract(step)
    }}>{label}</button>
  }
  const tokens = state?.results.reduce((sum, row) => sum + row.tokens, 0) ?? 0
  const expanded = running || showResults
  const results = state?.results ?? []
  const page = Math.min(resultPage, Math.max(0, Math.ceil(results.length / 50) - 1))
  const shownResults = results.slice(Math.max(0, results.length - (page + 1) * 50), results.length - page * 50)
  const statuses: Record<string, string> = { idle: '等待开始', running: '提取中', completed: '提取完成', failed: '有失败步骤', cancelled: '已取消', paused: '已暂停' }
  return <section className="extraction-panel" aria-label="逐章提取">
    <div className="extraction-heading"><h2>P1 逐章提取全书</h2><div className="extraction-actions">
      <button className="primary-button" disabled={!ready || !!saved?.externalBusy || singleJobs || checking || (!togetherRunning && complete && togetherJobs.every(job => job?.status === 'completed'))} onClick={() => {
        setShowResults(false)
        if (togetherRunning) service.pauseTogether(bookId)
        else void act(() => service.startTogether(bookId))
      }}>{togetherLabel}</button>
      {laneButton('worldAssets')}{laneButton('narrativeAssets')}
      <button className="secondary-button" disabled={!ready || (!running && !Object.keys(jobs).length && !saved?.busy)} onClick={() => void act(() => service.cancelAll(bookId))}>取消提取</button>
    </div></div>
    <p role="status">{saved ? `${statuses[saved.status] ?? saved.status} · 成功 ${saved.completedChapters.length}/${saved.totalChapters} 章 / 块 · 失败 ${saved.failedChapters.length} 章 / 块` : '读取提取进度…'}</p>
    <p className="muted">世界资产与叙事资产并行提取，各自按章节顺序保存。暂停可继续，取消后可补齐未完成章节。</p>
    {saved && <p className="muted">已保存 {saved.completedSteps}/{saved.totalChapters * 2} 个子步骤 · 待处理 {saved.totalChapters * 2 - saved.completedSteps} 个</p>}
    {saved?.externalBusy && <p className="muted">本书已有世界或叙事任务，提取按钮暂不可用。</p>}
    {checking && <p role="status">正在确认本书任务状态。运行中的标签页继续处理；中断任务在执行权到期后开放继续。</p>}
    {running && <p role="status">正在提取 · {state?.chapter} · {state?.step && stepLabels[state.step]}{state?.progress ? ` · 已请求 ${state.progress.attempts} 次${state.progress.state === 'waiting' ? '，等待重试' : ''}` : ' · 正在准备'}</p>}
    {progress.status === 'error' && <p role="alert">{progress.message}</p>}
    {recoveryError && <p role="alert">{recoveryError}</p>}
    {actionError && <p role="alert">{actionError}</p>}
    {state?.error && <p role="alert">{state.error}</p>}
    {!running && !state?.results.length && !!saved?.failures.length && <details><summary>待处理步骤（{saved.failures.length}）</summary>{saved.failures.map(row => <p key={`${row.chapterIndex}:${row.step}`}>第 {row.chapterIndex} 章 / 块 · {stepLabels[row.step]}：{row.message}</p>)}</details>}
    {!state?.results.length && saved?.usage && <p>最近一次提取用量：{saved.usage.totalTokens} tokens（计量单位） · {saved.usage.costStatus === 'unknown' ? '费用未知' : `估算费用：${saved.usage.cost.toFixed(6)} USD（美元）`}</p>}
    {!!state?.results.length && <><p>本次累计用量：{tokens} tokens（计量单位） · {state.results.every(row => row.cost !== undefined) ? `估算费用：${state.results.reduce((sum, row) => sum + (row.cost ?? 0), 0).toFixed(6)} USD（美元）` : '费用未知'}</p><div className="extraction-result-summary"><span>子步骤：成功 {state.results.filter(row => row.ok).length} 项 · 失败 {state.results.filter(row => !row.ok).length} 项</span>{!running && <button type="button" className="text-button" aria-expanded={expanded} aria-controls={`extraction-results-${bookId}`} onClick={() => setShowResults(value => !value)}>{expanded ? '收起章节结果' : '查看章节结果'}</button>}</div>{expanded && <div id={`extraction-results-${bookId}`} className="extraction-results" role="region" aria-label="章节提取结果">{shownResults.map((row, index) => <article key={`${index}:${row.chapterIndex}:${row.step}`} className={row.ok ? 'extraction-success' : 'extraction-failure'}><strong>第 {row.chapterIndex} 章 / 块 · {stepLabels[row.step]} · {row.ok ? '成功' : '失败'}</strong><p>{row.message}</p><small>实际请求 {row.attempts} 次 · 用量 {row.tokens} · {(row.elapsedMs / 1000).toFixed(2)} 秒</small></article>)}{results.length > 50 && <nav aria-label="提取结果分页"><button className="text-button" disabled={page === 0} onClick={() => setResultPage(page - 1)}>较新结果</button><span>第 {page + 1}/{Math.ceil(results.length / 50)} 页</span><button className="text-button" disabled={(page + 1) * 50 >= results.length} onClick={() => setResultPage(page + 1)}>较早结果</button></nav>}</div>}</>}
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
