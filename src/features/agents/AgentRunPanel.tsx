import { useEffect, useMemo, useRef, useState } from 'react'
import type { Row } from './repository'
import { subscribeTraceHub, traceSessions } from './trace'
import './AgentRunPanel.css'

export interface TraceData { requests: Row[]; snapshots: Map<string, Row>; warning?: string; leaseActive?: boolean; total?: number }
export interface RunTraceRun { id: string; status?: string; startedAt?: string; requestLedger?: readonly unknown[]; report?: { assetEdits?: readonly unknown[] } }
type Mode = 'p2' | 'p3'
interface ContextGroup { key: string; label: string; requests: Row[] }
interface WindowGroup { key: string; label: string; contexts: ContextGroup[] }

const text = (value: unknown) => typeof value === 'string' ? value : ''
const num = (value: unknown) => typeof value === 'number' ? String(value) : '未知'
const record = (value: unknown): Row => value && typeof value === 'object' ? value as Row : {}
const list = (value: unknown): Row[] => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') as Row[] : []
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter(item => typeof item === 'string') as string[] : []
const purpose = (value: unknown) => ({ work: '工作请求', compaction: '压缩', repair: '修正' } as Record<string, string>)[text(value)] ?? text(value)
const status = (value: unknown) => ({ running: '进行中', succeeded: '成功', failed: '失败', cancelled: '取消', interrupted: '已中断' } as Record<string, string>)[text(value)] ?? text(value)
const toolStatus = (value: unknown) => ({ pending: '待执行', running: '执行中', succeeded: '成功', failed: '失败' } as Record<string, string>)[text(value)] ?? (text(value) || '待执行')
const when = (value: unknown) => text(value) ? new Date(text(value)).toLocaleString('zh-CN') : '未记录'
const full = (value: unknown) => {
  if (value === undefined) return '未记录'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) ?? String(value) } catch { return '无法显示该内容' }
}
const usageText = (row: Row) => {
  const usage = record(row.usage)
  if (!Object.keys(usage).length) return '用量未记录'
  const value = (key: string) => typeof usage[key] === 'number' ? usage[key] : '未知'
  return `输入 ${value('input')} · 缓存读 ${value('cacheRead')} · 输出 ${value('output')}`
}
const stageLabel = (stage: string) => ({ directory: '目录扫描', scan: '目录扫描', candidate: '疑似同人', profile: '人物资料', relations: '人物关系' } as Record<string, string>)[stage] ?? (stage || '其他工作')

function deltaMessages(row: Row, previous?: Row) {
  const messages = list(record(row.input).messages)
  const hashes = strings(record(row.input).messageHashes)
  const previousMessages = previous ? list(record(previous.input).messages) : []
  const previousHashes = previous ? strings(record(previous.input).messageHashes) : []
  let prefix = 0
  if (previousHashes.length && hashes.length) while (prefix < previousHashes.length && prefix < hashes.length && previousHashes[prefix] === hashes[prefix]) prefix++
  else if (previousMessages.length) prefix = Math.min(previousMessages.length, messages.length)
  return messages.slice(prefix).filter(message => text(message.role) === 'user')
}

export function RequestCard({ row, snapshots, previous }: { row: Row; snapshots: Map<string, Row>; previous?: Row }) {
  const input = record(row.input)
  const tools = list(row.toolCalls)
  const snapshot = (id: unknown) => snapshots.get(text(id))
  const snapshotText = (id: unknown) => text(snapshot(id)?.content) || (id ? '[快照缺失或不完整]' : '未记录')
  const toolRows = list(input.toolSchemaSnapshotId ? snapshot(input.toolSchemaSnapshotId)?.schema : [])
  const messages = list(input.messages)
  const added = deltaMessages(row, previous)
  return <article className="run-turn">
    <header className="run-turn-heading">
      <strong>第 {String(row.requestOrdinal ?? '?')} 回合</strong>
      <span>{when(row.startedAt)} · {purpose(row.purpose)} · {status(row.status)}{row.model ? ` · ${text(row.model)}` : ''}</span>
      <span className="run-request-usage">{usageText(row)}</span>
    </header>
    <p className="run-meta">执行 {text(row.executionId)} · 会话 {text(row.sessionId)} · 工作 {text(row.unitId ?? row.characterId) || '未记录'} · 尝试 {strings(row.attemptIds).length} 次</p>
    {added.length > 0 && <section className="run-turn-input" aria-label="本轮新增用户或程序消息">
      {added.map((message, index) => <div className={`run-message run-message-${text(message.role)}`} key={index}><strong>程序注入 / 用户</strong><pre>{full(message.content)}</pre></div>)}
    </section>}
    {text(row.thinking) ? <details><summary>思考</summary><pre>{text(row.thinking)}</pre></details> : <p className="field-help">本次模型未返回推理内容。</p>}
    {text(row.text) && <details><summary>助手回复</summary><pre>{text(row.text)}</pre></details>}
    <section className="run-tools" aria-label="工具调用">
      <h4>工具调用（{tools.length}）</h4>
      {tools.map(tool => <details key={text(tool.toolCallId)} className="run-tool">
        <summary>工具 {text(tool.name)} · {toolStatus(tool.state)}{tool.isError ? ' · 错误' : ''}</summary>
        <h5>参数</h5><pre>{full(tool.arguments)}</pre>
        {tool.result === undefined && tool.resultPreview === undefined ? <p className="field-help">等待返回或未记录工具结果。</p> : <details><summary>完整结果</summary><pre>{full(tool.result ?? tool.resultPreview)}</pre></details>}
      </details>)}
      {!tools.length && <p className="field-help">本回合没有工具调用。</p>}
    </section>
    <details className="run-input"><summary>本轮完整上下文（含 system prompt 与全部历史）</summary>
      {input.completeness === 'partial' && <p role="status">本次输入未完整保存：{text(input.incompleteReason) || '容量或引用限制'}。</p>}
      {!!input.missingRefs && <p role="status">缺失引用：{strings(input.missingRefs).join('、')}</p>}
      <p>估算输入 {num(input.estimatedContextTokens)} · 供应商输入 {num(input.providerInputTokens)} · 缓存读 {num(input.providerCacheReadTokens)}</p>
      <h5>系统提示词</h5><pre>{snapshotText(input.systemPromptSnapshotId)}</pre>
      <h5>业务提示词</h5><pre>{snapshotText(input.businessPromptSnapshotId)}</pre>
      <h5>工具定义（{toolRows.length}）</h5>
      {toolRows.map((tool, index) => <details key={index}><summary>{text(tool.name) || `工具 ${index + 1}`}</summary><pre>{full(tool)}</pre></details>)}
      {!toolRows.length && <p className="field-help">未记录工具定义快照。</p>}
      <h5>消息（{messages.length}）</h5>
      {messages.map((message, index) => <details key={index}><summary>{index + 1}. {text(message.role)}</summary><pre>{full(message.content)}</pre></details>)}
    </details>
    {!!row.error && <p role="alert">{full(row.error)}</p>}
  </article>
}

function UsageView({ run }: { run?: RunTraceRun }) {
  const ledger = list(run?.requestLedger)
  const total = ledger.reduce<{ input: number; output: number; cacheRead: number; knownCost: number; unknown: number }>((sum, row) => ({ input: sum.input + (Number(row.input) || 0), output: sum.output + (Number(row.output) || 0), cacheRead: sum.cacheRead + (Number(row.cacheRead) || 0), knownCost: sum.knownCost + (Number(row.cost) || 0), unknown: sum.unknown + (row.costStatus === 'unknown' || row.usageStatus === 'missing' ? 1 : 0) }), { input: 0, output: 0, cacheRead: 0, knownCost: 0, unknown: 0 })
  return <section className="run-usage"><p>本轮 {ledger.length} 次实际请求 · 输入 {total.input}（缓存读 {total.cacheRead}）· 输出 {total.output} · 已知费用 {total.knownCost.toFixed(6)} 美元 · 用量或费用未知 {total.unknown} 次</p>
    {!ledger.length && <p className="field-help">当前运行没有逐请求账本；旧运行可能只有汇总。</p>}
    {ledger.map(row => <details key={text(row.attemptId)}><summary>{when(row.startedAt)} · {purpose(row.purpose)} · {status(row.status)}{row.errorCode ? ` · ${text(row.errorCode)}` : ''}</summary>
      <p>人物/工作：{text(row.characterId ?? row.workId ?? '未关联')} · 上下文：{text(row.contextId ?? '未记录')} · 请求：{text(row.requestId ?? '旧记录未记录')} · 执行：{text(row.executionId ?? '旧记录未记录')}</p>
      <p>估算输入 {num(row.estimatedInput)} · 输出预留 {num(row.outputReserve)} · 实际输入 {num(row.input)} · 缓存读 {num(row.cacheRead)} · 缓存写 {num(row.cacheWrite)} · 输出 {num(row.output)} · 总token {num(row.totalTokens)}</p>
      <p>费用：{row.cost === null || row.cost === undefined ? '未知' : `${Number(row.cost).toFixed(6)} ${text(row.currency)}`} · 计价：{text(row.costStatus) || '未知'}</p>
    </details>)}
  </section>
}

function ResultView({ requests, edits, characterNames }: { requests: Row[]; edits: Row[]; characterNames?: Map<string, string> }) {
  const submits = requests.flatMap(row => list(row.toolCalls)).filter(tool => ['submit_profile_review', 'submit_relation_review', 'submit_result', 'commit_asset_changes', 'commit_story_changes'].includes(text(tool.name)))
  const groups = new Map<string, Row[]>()
  for (const edit of edits) {
    const id = text(edit.characterId) || text(edit.id)
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id)!.push(edit)
  }
  return <section className="run-results">
    <h3>实际写库修改</h3>
    {!edits.length && <p className="field-help">本轮没有实际写库修改。提交工具调用不等于保存成功，见下方“提交记录”。</p>}
    {[...groups.entries()].map(([id, rows]) => <section key={id}><h4>{characterNames?.get(id) || id}</h4>{rows.map((edit, index) => <details key={`${text(edit.commitId)}-${index}`}><summary>{text(edit.kind)} · {text(edit.id)} · {text(edit.tool)} · {text(edit.commitId) || '未记录确认号'}</summary>{list(edit.fieldChanges).map((change, changeIndex) => <div key={changeIndex}><p><strong>{text(change.field)}</strong></p><p>修改前：</p><pre>{full(change.before)}</pre><p>修改后：</p><pre>{full(change.after)}</pre></div>)}<p>理由：{text(edit.reason) || '未填写'}</p></details>)}</section>)}
    <details className="run-submits"><summary>提交记录（{submits.length}）</summary><p className="field-help">这些是模型的提交工具调用，只有上方实际写库记录和确认号才代表保存成功。</p>{submits.map(tool => <details key={text(tool.toolCallId)}><summary>{text(tool.name)} · {toolStatus(tool.state)}</summary><pre>{full(tool.arguments)}</pre>{tool.result !== undefined && <pre>{full(tool.result)}</pre>}</details>)}</details>
  </section>
}

export function AgentRunPanel({ bookId, runId, mode, load, run, runs, assetEdits, characterNames, onOpenReport, onClose }: {
  bookId: string; runId?: string; mode: Mode; load: (bookId: string, runId?: string) => Promise<TraceData>
  run?: RunTraceRun; runs?: RunTraceRun[]; assetEdits?: Row[]; characterNames?: Map<string, string>
  onOpenReport?: () => void; onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const [saved, setSaved] = useState<TraceData>({ requests: [], snapshots: new Map() })
  const [tick, setTick] = useState(0)
  const [tab, setTab] = useState<'process' | 'result' | 'usage'>('process')
  const [activeRunId, setActiveRunId] = useState(runId ?? runs?.[0]?.id)
  const [windowKey, setWindowKey] = useState('')
  const [contextKey, setContextKey] = useState('')
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close() }, [])
  useEffect(() => subscribeTraceHub(() => setTick(value => value + 1)), [])
  const effectiveRunId = activeRunId ?? runId ?? runs?.[0]?.id
  useEffect(() => {
    let live = true
    void load(bookId, effectiveRunId).then(value => { if (live) setSaved(value) }).catch(() => { if (live) setSaved({ requests: [], snapshots: new Map(), warning: '运行日志读取失败。' }) })
    return () => { live = false }
  }, [bookId, effectiveRunId, load])
  const activeRun = runs?.find(item => item.id === effectiveRunId) ?? run
  const merged = useMemo(() => {
    void tick
    const snapshots = new Map(saved.snapshots)
    const requests = new Map(saved.requests.map(row => [text(row.requestId), row]))
    for (const session of traceSessions(bookId)) {
      if (effectiveRunId && session.identity.runId !== effectiveRunId) continue
      const live = session.snapshot()
      for (const row of live.snapshots) snapshots.set(text(row.snapshotId ?? row.id), row)
      for (const row of live.records) if (!effectiveRunId || row.runId === effectiveRunId) requests.set(text(row.requestId), row)
    }
    const warning = traceSessions(bookId).filter(session => !effectiveRunId || session.identity.runId === effectiveRunId).find(session => session.snapshot().warning)?.snapshot().warning ?? saved.warning
    return { requests: [...requests.values()].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt))), snapshots, leaseActive: saved.leaseActive, ...(warning ? { warning } : {}) }
  }, [bookId, effectiveRunId, saved, tick])
  const windows = useMemo<WindowGroup[]>(() => {
    if (mode === 'p3') return [{ key: 'session', label: '持续会话', contexts: [{ key: 'session', label: '持续会话', requests: merged.requests }] }]
    const map = new Map<string, WindowGroup>()
    for (const row of merged.requests) {
      const unit = text(row.unitId ?? row.workId)
      const characterId = text(row.characterId) || /^(?:profile|relations):(.+)$/.exec(unit)?.[1] || ''
      const stage = unit.split(':')[0] || 'other'
      const key = characterId ? `person:${characterId}` : `stage:${stage}`
      const label = characterId ? characterNames?.get(characterId) || characterId : stageLabel(stage)
      if (!map.has(key)) map.set(key, { key, label, contexts: [] })
      const window = map.get(key)!
      const contextId = text(row.contextId) || stage || 'default'
      const contextLabel = stageLabel(stage)
      let context = window.contexts.find(item => item.key === contextId)
      if (!context) { context = { key: contextId, label: contextLabel, requests: [] }; window.contexts.push(context) }
      context.requests.push(row)
    }
    return [...map.values()]
  }, [mode, merged.requests, characterNames])
  const activeWindow = windows.find(window => window.key === windowKey) ?? windows[0]
  const activeContext = activeWindow?.contexts.find(context => context.key === contextKey) ?? activeWindow?.contexts[0]
  const requests = activeContext?.requests ?? []
  const windowRequests = activeWindow?.contexts.flatMap(context => context.requests) ?? []
  const windowStats = windowRequests.reduce<{ input: number; output: number; cacheRead: number; cost: number }>((sum, row) => {
    const usage = record(row.usage)
    return { input: sum.input + (Number(usage.input) || 0), output: sum.output + (Number(usage.output) || 0), cacheRead: sum.cacheRead + (Number(usage.cacheRead) || 0), cost: sum.cost + (Number(usage.cost) || 0) }
  }, { input: 0, output: 0, cacheRead: 0, cost: 0 })
  const promptRequest = requests[0] ?? windowRequests[0]
  const promptInput = record(promptRequest?.input)
  const promptSnapshot = (id: unknown) => merged.snapshots.get(text(id))
  const promptText = (id: unknown) => text(promptSnapshot(id)?.content) || (id ? '[快照缺失或不完整]' : '未记录')
  const promptTools = list(promptInput.toolSchemaSnapshotId ? promptSnapshot(promptInput.toolSchemaSnapshotId)?.schema : [])
  const edits = list(activeRun?.report?.assetEdits ?? assetEdits)
  const activeCharacterId = activeWindow?.key.startsWith('person:') ? activeWindow.key.slice('person:'.length) : undefined
  const scopedEdits = activeCharacterId ? edits.filter(edit => text(edit.id) === activeCharacterId || text(edit.characterId) === activeCharacterId || (text(edit.kind) === 'relation' && text(edit.id).includes(activeCharacterId))) : mode === 'p2' ? [] : edits
  const latest = merged.requests.at(-1)
  const liveRunning = traceSessions(bookId).some(session => !session.closed && (!effectiveRunId || session.identity.runId === effectiveRunId))
  const runState = liveRunning ? '运行中' : merged.leaseActive ? '运行中（其他窗口）' : merged.requests.some(row => row.status === 'running') ? '已中断，可继续' : '已结束'
  const scrollLatest = () => {
    const lastWindow = windows.at(-1)
    if (lastWindow) { setWindowKey(lastWindow.key); setContextKey(lastWindow.contexts.at(-1)?.key ?? '') }
    requestAnimationFrame(() => body.current?.scrollTo({ top: body.current.scrollHeight, behavior: 'smooth' }))
  }
  const previousOf = (row: Row) => requests[requests.findIndex(item => item.requestId === row.requestId) - 1]
  return <dialog ref={ref} className="merge-dialog run-detail-dialog" aria-labelledby="agent-run-title" onCancel={event => event.preventDefault()}><header className="merge-dialog-heading"><h2 id="agent-run-title">整理详情</h2><button className="text-button" onClick={onClose}>关闭</button></header>
    <div ref={body} className="merge-dialog-body run-detail-body">
      <div className="run-heading-line"><p>书 {bookId}{effectiveRunId ? ` · 运行 ${effectiveRunId}` : ''} · {runState}</p>{!!runs?.length && runs.length > 1 && <select aria-label="选择运行" value={effectiveRunId} onChange={event => { setActiveRunId(event.target.value); setWindowKey(''); setContextKey('') }}>{runs.map(item => <option key={item.id} value={item.id}>{when(item.startedAt)} · {item.id}</option>)}</select>}</div>
      <div role="tablist" aria-label="整理详情视图">
        <button type="button" role="tab" aria-selected={tab === 'process'} className={tab === 'process' ? 'primary-button' : 'secondary-button'} onClick={() => setTab('process')}>运行过程</button>
        <button type="button" role="tab" aria-selected={tab === 'result'} className={tab === 'result' ? 'primary-button' : 'secondary-button'} onClick={() => setTab('result')}>修改结果</button>
        <button type="button" role="tab" aria-selected={tab === 'usage'} className={tab === 'usage' ? 'primary-button' : 'secondary-button'} onClick={() => setTab('usage')}>用量</button>
        {onOpenReport && <button type="button" className="secondary-button" onClick={onOpenReport}>查看完整整理报告</button>}
      </div>
      {merged.warning && <p role="status">{merged.warning}</p>}
      {!!saved.total && saved.total > merged.requests.length && <p className="field-help">仅显示最近 {merged.requests.length} 条请求（共 {saved.total} 条）。</p>}
      {tab === 'process' && <>
        {mode === 'p2' && windows.length > 0 && <div className="run-window-tabs" role="tablist" aria-label="人物窗口">{windows.map(window => <button type="button" role="tab" aria-selected={activeWindow?.key === window.key} className={activeWindow?.key === window.key ? 'primary-button' : 'secondary-button'} key={window.key} onClick={() => { setWindowKey(window.key); setContextKey(window.contexts[0]?.key ?? '') }}>{window.label}（{window.contexts.reduce((sum, context) => sum + context.requests.length, 0)}）</button>)}</div>}
        {!!activeWindow && activeWindow.contexts.length > 1 && <div className="run-context-tabs" role="tablist" aria-label="上下文">{activeWindow.contexts.map(context => <button type="button" role="tab" aria-selected={activeContext?.key === context.key} className={activeContext?.key === context.key ? 'secondary-button active' : 'secondary-button'} key={context.key} onClick={() => setContextKey(context.key)}>{context.label}（{context.requests.length}）</button>)}</div>}
        {!!promptRequest && <details className="run-context-prompt"><summary>窗口提示词与工具定义（只显示一次）</summary>
          <p>系统提示词</p><pre>{promptText(promptInput.systemPromptSnapshotId)}</pre><p>业务提示词</p><pre>{promptText(promptInput.businessPromptSnapshotId)}</pre><p>工具定义（{promptTools.length}）</p>{promptTools.map((tool, index) => <details key={index}><summary>{text(tool.name) || `工具 ${index + 1}`}</summary><pre>{full(tool)}</pre></details>)}
        </details>}
        {!!windowRequests.length && <p className="run-window-usage">本窗口 {windowRequests.length} 回合 · 输入 {windowStats.input}（缓存读 {windowStats.cacheRead}）· 输出 {windowStats.output} · 已知费用 {windowStats.cost.toFixed(6)} 美元</p>}
        {!requests.length && <p className="field-help">当前窗口还没有请求日志；旧版本运行可能没有完整明细。</p>}
        <div className="run-request-list">{requests.map(row => <RequestCard key={text(row.requestId)} row={row} snapshots={merged.snapshots} previous={previousOf(row)} />)}</div>
        {latest && <button type="button" className="secondary-button run-latest" onClick={scrollLatest}>回到最新</button>}
      </>}
      {tab === 'result' && <ResultView requests={windowRequests} edits={scopedEdits} characterNames={characterNames} />}
      {tab === 'usage' && <UsageView run={activeRun} />}
    </div>
  </dialog>
}
