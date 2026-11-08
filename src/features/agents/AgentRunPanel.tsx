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
const status = (value: unknown) => ({ running: '进行中', succeeded: '成功', failed: '失败', cancelled: '取消', interrupted: '已中断' } as Record<string, string>)[text(value)] ?? text(value)
const toolStatus = (value: unknown) => ({ pending: '待执行', running: '执行中', succeeded: '成功', failed: '失败' } as Record<string, string>)[text(value)] ?? (text(value) || '待执行')
const when = (value: unknown) => text(value) ? new Date(text(value)).toLocaleString('zh-CN') : '未记录'
const full = (value: unknown) => {
  if (value === undefined) return '未记录'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) ?? String(value) } catch { return '无法显示该内容' }
}
const roleLabel = (role: unknown) => ({ system: 'SYSTEM', user: 'USER', assistant: 'ASSISTANT', toolResult: 'TOOL RESULT' } as Record<string, string>)[text(role)] ?? (text(role).toUpperCase() || 'MESSAGE')
const stageLabel = (stage: string) => ({ directory: '目录扫描', scan: '目录扫描', candidate: '疑似同人', profile: '人物资料', relations: '人物关系' } as Record<string, string>)[stage] ?? (stage || '其他工作')
const duration = (requests: Row[]) => {
  const starts = requests.map(row => Date.parse(text(row.startedAt))).filter(Number.isFinite)
  const ends = requests.map(row => Date.parse(text(row.finishedAt ?? row.modelFinishedAt ?? row.startedAt))).filter(Number.isFinite)
  if (!starts.length || !ends.length) return '未记录'
  return `${Math.max(0, Math.round((Math.max(...ends) - Math.min(...starts)) / 1000))} 秒`
}

function MessageBlock({ message, index }: { message: Row; index: number }) {
  const role = text(message.role)
  return <details className={`run-role run-role-${role || 'message'}`}>
    <summary>{roleLabel(role)}{message.toolName ? ` · ${text(message.toolName)}` : ''}{message.toolCallId ? ` · ${text(message.toolCallId)}` : ''} · 消息 {index + 1}</summary>
    <pre>{full(message.content)}</pre>
  </details>
}

export function ApiRequest({ row, index, snapshots }: { row: Row; index: number; snapshots: Map<string, Row> }) {
  const input = record(row.input)
  const messages = list(input.messages)
  const snapshot = (id: unknown) => snapshots.get(text(id))
  const systemSnapshot = snapshot(input.systemPromptSnapshotId)
  const businessSnapshot = snapshot(input.businessPromptSnapshotId)
  const toolSnapshot = snapshot(input.toolSchemaSnapshotId)
  const tools = list(toolSnapshot?.schema)
  const systemText = text(systemSnapshot?.content)
  const businessText = text(businessSnapshot?.content)
  const businessInSystem = !!businessText && systemText.includes(businessText)
  const calls = list(row.toolCalls)
  const toolResultTexts = calls.map(tool => full(tool.result ?? tool.resultPreview).trim())
  const assistantText = text(row.text)
  const showAssistantText = !!assistantText && !toolResultTexts.includes(assistantText.trim())
  const inputMessages = [...messages]
  if (systemSnapshot && !messages.some(message => text(message.role) === 'system')) inputMessages.unshift({ role: 'system', content: text(systemSnapshot.content) })
  return <section className="run-api" aria-label={`第 ${index + 1} 次 API 请求`}>
    <header className="run-api-heading">
      <strong>第 {index + 1} 次 API 请求</strong>
      <span>{when(row.startedAt)} · {status(row.status)} · {text(row.model) || '模型未记录'}</span>
      <span>输入 {num(record(row.usage).input)} · 输出 {num(record(row.usage).output)} · 总 {num(record(row.usage).totalTokens)}</span>
    </header>
    <div className="run-api-meta">执行 {text(row.executionId)} · 会话 {text(row.sessionId)} · 本回合耗时 {text(row.modelFinishedAt) ? `${Math.max(0, Math.round((Date.parse(text(row.modelFinishedAt)) - Date.parse(text(row.startedAt))) / 1000))} 秒` : '未记录'}</div>
    <section className="run-input-messages" aria-label="API 输入消息">
      <h4>API 输入</h4>
      {inputMessages.map((message, messageIndex) => <MessageBlock key={messageIndex} message={message} index={messageIndex} />)}
      {businessSnapshot && !businessInSystem && <details className="run-role run-role-business"><summary>BUSINESS PROMPT · 业务提示词</summary><pre>{businessText}</pre></details>}
      {tools.length > 0 && <details className="run-role run-role-tools"><summary>TOOLS · 工具定义（{tools.length}）</summary>{tools.map((tool, toolIndex) => <details key={toolIndex}><summary>{text(tool.name) || `工具 ${toolIndex + 1}`}</summary><pre>{full(tool)}</pre></details>)}</details>}
      {input.completeness === 'partial' && <p role="status">本次输入未完整保存：{text(input.incompleteReason) || '容量或引用限制'}。</p>}
      {!!input.missingRefs && <p role="status">缺失引用：{strings(input.missingRefs).join('、')}</p>}
    </section>
    <section className="run-assistant" aria-label="模型返回">
      <h4>ASSISTANT · 模型返回</h4>
      {text(row.thinking) && <details className="run-role run-role-thinking"><summary>THINKING · 推理内容</summary><pre>{text(row.thinking)}</pre></details>}
      {showAssistantText && <details className="run-role run-role-assistant"><summary>ASSISTANT · 文本回复</summary><pre>{assistantText}</pre></details>}
      {!showAssistantText && !text(row.thinking) && calls.length > 0 && <p className="field-help">本回合模型返回工具调用，没有额外文本。</p>}
      {calls.length > 0 ? calls.map(tool => <section className="run-tool-call" key={text(tool.toolCallId)}>
        <details className="run-role run-role-toolcall"><summary>TOOL CALL · {text(tool.name)} · {toolStatus(tool.state)}</summary><pre>{full(tool.arguments)}</pre></details>
        <div className="run-tool-execution">TOOL EXECUTION · 程序执行工具</div>
        <details className="run-role run-role-toolresult"><summary>TOOL RESULT · {text(tool.name)} · {toolStatus(tool.state)}{tool.isError ? ' · 错误' : ''}</summary>{tool.result === undefined && tool.resultPreview === undefined ? <p className="field-help">等待返回或未记录工具结果。</p> : <pre>{full(tool.result ?? tool.resultPreview)}</pre>}</details>
      </section>) : <p className="field-help">本回合没有工具调用。</p>}
      {!!row.error && <p role="alert">{full(row.error)}</p>}
    </section>
  </section>
}

export function Changes({ edits, characterNames }: { edits: Row[]; characterNames?: Map<string, string> }) {
  const groups = new Map<string, Row[]>()
  for (const edit of edits) {
    const id = text(edit.characterId) || text(edit.id)
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id)!.push(edit)
  }
  return <section className="run-changes"><h3>本次实际修改</h3>
    {!edits.length && <p className="field-help">本次没有实际写库修改。</p>}
    {[...groups.entries()].map(([id, rows]) => <section key={id}><h4>{characterNames?.get(id) || id}</h4>{rows.map((edit, index) => <section className="run-change" key={`${text(edit.commitId)}-${index}`}><h5>{text(edit.kind)} · {text(edit.id)} · {text(edit.tool)} · {text(edit.commitId) || '未记录确认号'}</h5>{list(edit.fieldChanges).map((change, changeIndex) => <div key={changeIndex}><p><strong>{text(change.field)}</strong></p><p>修改前：</p><pre>{full(change.before)}</pre><p>修改后：</p><pre>{full(change.after)}</pre></div>)}{!list(edit.fieldChanges).length && <p className="field-help">未记录字段差异。</p>}<p>理由：{text(edit.reason) || '未填写'}</p></section>)}</section>)}
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
      let context = window.contexts.find(item => item.key === contextId)
      if (!context) { context = { key: contextId, label: stageLabel(stage), requests: [] }; window.contexts.push(context) }
      context.requests.push(row)
    }
    return [...map.values()]
  }, [mode, merged.requests, characterNames])
  const activeWindow = windows.find(window => window.key === windowKey) ?? windows[0]
  const activeContext = activeWindow?.contexts.find(context => context.key === contextKey) ?? activeWindow?.contexts[0]
  const requests = activeContext?.requests ?? []
  const toolCount = requests.reduce((sum, row) => sum + list(row.toolCalls).filter(tool => ['running', 'succeeded', 'failed'].includes(text(tool.state))).length, 0)
  const stats = requests.reduce<{ input: number; output: number; cacheRead: number; total: number; cost: number }>((sum, row) => {
    const usage = record(row.usage)
    return { input: sum.input + (Number(usage.input) || 0), output: sum.output + (Number(usage.output) || 0), cacheRead: sum.cacheRead + (Number(usage.cacheRead) || 0), total: sum.total + (Number(usage.totalTokens) || 0), cost: sum.cost + (Number(usage.cost) || 0) }
  }, { input: 0, output: 0, cacheRead: 0, total: 0, cost: 0 })
  const edits = list(activeRun?.report?.assetEdits ?? assetEdits)
  const activeCharacterId = activeWindow?.key.startsWith('person:') ? activeWindow.key.slice('person:'.length) : undefined
  const scopedEdits = activeCharacterId ? edits.filter(edit => text(edit.id) === activeCharacterId || text(edit.characterId) === activeCharacterId || (text(edit.kind) === 'relation' && text(edit.id).includes(activeCharacterId))) : mode === 'p2' ? [] : edits
  const liveRunning = traceSessions(bookId).some(session => !session.closed && (!effectiveRunId || session.identity.runId === effectiveRunId))
  const runState = liveRunning ? '运行中' : merged.leaseActive ? '运行中（其他窗口）' : merged.requests.some(row => row.status === 'running') ? '已中断，可继续' : '已结束'
  const latest = merged.requests.at(-1)
  const scrollLatest = () => {
    const lastWindow = windows.at(-1)
    if (lastWindow) { setWindowKey(lastWindow.key); setContextKey(lastWindow.contexts.at(-1)?.key ?? '') }
    requestAnimationFrame(() => body.current?.scrollTo({ top: body.current.scrollHeight, behavior: 'smooth' }))
  }
  return <dialog ref={ref} className="merge-dialog run-detail-dialog" aria-labelledby="agent-run-title" onCancel={event => event.preventDefault()}><header className="merge-dialog-heading"><h2 id="agent-run-title">整理详情</h2><button className="text-button" onClick={onClose}>关闭</button></header>
    <div ref={body} className="merge-dialog-body run-detail-body">
      <div className="run-heading-line"><p>{mode === 'p2' ? 'P2 人物整理' : 'P3 叙事整理'} · {activeWindow?.label ?? '当前窗口'} · {runState}</p>{!!runs?.length && runs.length > 1 && <select aria-label="选择运行" value={effectiveRunId} onChange={event => { setActiveRunId(event.target.value); setWindowKey(''); setContextKey('') }}>{runs.map(item => <option key={item.id} value={item.id}>{when(item.startedAt)} · {item.id}</option>)}</select>}</div>
      {onOpenReport && <button type="button" className="secondary-button" onClick={onOpenReport}>查看完整整理报告</button>}
      {mode === 'p2' && windows.length > 0 && <div className="run-window-tabs" role="tablist" aria-label="人物窗口">{windows.map(window => <button type="button" role="tab" aria-selected={activeWindow?.key === window.key} className={activeWindow?.key === window.key ? 'primary-button' : 'secondary-button'} key={window.key} onClick={() => { setWindowKey(window.key); setContextKey(window.contexts[0]?.key ?? '') }}>{window.label}（{window.contexts.reduce((sum, context) => sum + context.requests.length, 0)}）</button>)}</div>}
      {!!activeWindow && activeWindow.contexts.length > 1 && <div className="run-context-tabs" role="tablist" aria-label="上下文">{activeWindow.contexts.map(context => <button type="button" role="tab" aria-selected={activeContext?.key === context.key} className={activeContext?.key === context.key ? 'secondary-button active' : 'secondary-button'} key={context.key} onClick={() => setContextKey(context.key)}>{context.label}（{context.requests.length}）</button>)}</div>}
      <section className="run-stats" aria-label="运行统计">
        <span>API 请求 <strong>{requests.length}</strong> 次</span><span>工具调用 <strong>{toolCount}</strong> 次</span><span>耗时 <strong>{duration(requests)}</strong></span><span>Token <strong>{stats.total}</strong>（输入 {stats.input} / 缓存 {stats.cacheRead} / 输出 {stats.output}）</span><span>费用 <strong>{stats.cost.toFixed(6)}</strong> 美元</span><span>模型 <strong>{text(requests.at(-1)?.model) || '未记录'}</strong></span>
      </section>
      {merged.warning && <p role="status">{merged.warning}</p>}
      {!!saved.total && saved.total > merged.requests.length && <p className="field-help">仅显示最近 {merged.requests.length} 条请求（共 {saved.total} 条）。</p>}
      {!requests.length && <p className="field-help">当前窗口还没有 API 请求记录；旧版本运行可能没有完整明细。</p>}
      <div className="run-api-list">{requests.map((row, index) => <ApiRequest key={text(row.requestId)} row={row} index={index} snapshots={merged.snapshots} />)}</div>
      {!!requests.length && <p className="run-end">{runState === '已结束' ? 'Agent 本次工作结束' : `当前状态：${runState}`}</p>}
      {latest && <button type="button" className="secondary-button run-latest" onClick={scrollLatest}>回到最新</button>}
      <Changes edits={scopedEdits} characterNames={characterNames} />
    </div>
  </dialog>
}
