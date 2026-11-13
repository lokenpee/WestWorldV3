import { LazyDetails } from './LazyDetails'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Row } from './repository'
import { subscribeTraceHub, traceSessions } from './trace'
import { displayContent, messageRows, toolDeclaration, toolResultContent } from './requestPresentation'
import './AgentRunPanel.css'

export interface TraceData { requests: Row[]; snapshots: Map<string, Row>; warning?: string; leaseActive?: boolean; total?: number }
export interface RunTraceRun { id: string; status?: string; startedAt?: string; requestLedger?: readonly unknown[]; report?: { assetEdits?: readonly unknown[] } }
type Mode = 'p2' | 'p3'
interface ContextGroup { key: string; label: string; requests: Row[] }
interface WindowGroup { key: string; label: string; contexts: ContextGroup[] }

const text = (value: unknown) => typeof value === 'string' ? value : ''
const record = (value: unknown): Row => value && typeof value === 'object' ? value as Row : {}
const list = (value: unknown): Row[] => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') as Row[] : []
const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
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
const roleLabel = (role: unknown) => ({ system: 'SYSTEM', user: 'USER', assistant: 'ASSISTANT', tool: 'TOOL RESULT', toolResult: 'TOOL RESULT' } as Record<string, string>)[text(role)] ?? (text(role).toUpperCase() || 'MESSAGE')
const stageLabel = (stage: string) => ({ directory: '目录扫描', scan: '目录扫描', candidate: '疑似同人', profile: '人物资料', relations: '人物关系' } as Record<string, string>)[stage] ?? (stage || '其他工作')
const duration = (requests: Row[]) => {
  const starts = requests.map(row => Date.parse(text(row.startedAt))).filter(Number.isFinite)
  const ends = requests.map(row => Date.parse(text(row.finishedAt ?? row.modelFinishedAt ?? row.startedAt))).filter(Number.isFinite)
  if (!starts.length || !ends.length) return '未记录'
  return `${Math.max(0, Math.round((Math.max(...ends) - Math.min(...starts)) / 1000))} 秒`
}

function MessageBlock({ message, index }: { message: Row; index: number }) {
  const role = text(message.role)
  const calls = list(message.tool_calls)
  return <LazyDetails className={`run-role run-role-${role || 'message'}`} summary={<> <span className="run-message-number">{index + 1}</span>{roleLabel(role)}{message.toolName ? ` · ${text(message.toolName)}` : ''} </>}>{() => <>
    {message.reasoning_content != null && <LazyDetails summary={<> 随消息发送的推理内容 </>}>{() => <><pre>{displayContent(message.reasoning_content)}</pre></>}</LazyDetails>}
    {message.content != null && <pre>{displayContent(message.content)}</pre>}
    {message.content == null && !calls.length && message.reasoning_content == null && <pre>{displayContent(message)}</pre>}
    {calls.map((call, callIndex) => <div key={callIndex}><p>TOOL CALL · {text(record(call.function).name)}</p><pre>{displayContent(record(call.function).arguments)}</pre></div>)}
  </>}</LazyDetails>
}

export function ApiRequest({ row, index, snapshots }: { row: Row; index: number; snapshots: Map<string, Row> }) {
  const input = record(row.input)
  const messages = messageRows(list(input.messages))
  const actualRequest = input.messageFormat === 'provider-request/v1'
  const systemSnapshot = snapshots.get(text(input.systemPromptSnapshotId))
  const toolSnapshot = snapshots.get(text(input.toolSchemaSnapshotId))
  const tools = list(toolSnapshot?.schema).map(toolDeclaration)
  const toolNames = stringList(toolSnapshot?.toolNames)
  const calls = list(row.toolCalls)
  if (!actualRequest && systemSnapshot && !messages.some(message => message.role === 'system')) messages.unshift({ role: 'system', content: systemSnapshot.content })
  return <LazyDetails className="run-api execution-api-call" open={index === 0} aria-label={`第 ${index + 1} 次 API 请求`} summaryClassName="run-api-heading" summary={<> <strong>API {String(index + 1).padStart(2, '0')}</strong><span>{status(row.status)} · {when(row.startedAt)}</span><span>{calls.length ? `${calls.length} 次工具调用` : '文本回复'}</span> </>}>{() => <>
    <div className="run-api-content">
      {!actualRequest && <p className="field-help run-history-note">历史记录 · 输入来自当时保存的上下文</p>}
      <section className="run-input-messages" aria-label="API 输入消息">
        <h4><span className="run-flow-mark">↑</span>发送给 API</h4>
        {messages.map((message, messageIndex) => <MessageBlock key={messageIndex} message={message} index={messageIndex} />)}
        <LazyDetails className="run-role run-role-tools" summary={<> TOOLS · 可调用工具（{tools.length || toolNames.length}） </>}>{() => <>{tools.length ? tools.map((tool, toolIndex) => <LazyDetails className="run-tool-definition" key={toolIndex} summary={<> {text(tool.name) || `工具 ${toolIndex + 1}`} </>}>{() => <><pre>{full(tool)}</pre></>}</LazyDetails>) : <p className="field-help">{toolSnapshot ? toolNames.length ? `仅保存工具名称：${toolNames.join('、')}` : '本次没有工具定义。' : '本次未保存工具定义快照。'}</p>}</>}</LazyDetails>
        {Object.keys(record(input.requestParameters)).length > 0 && <LazyDetails className="run-role run-request-parameters" summary={<> 请求参数 </>}>{() => <><pre>{full(input.requestParameters)}</pre></>}</LazyDetails>}
        {input.completeness === 'partial' && <p role="status">本次输入未完整保存：{text(input.incompleteReason) || '容量或引用限制'}。</p>}
        {!!input.missingRefs && <p role="status">缺失引用：{strings(input.missingRefs).join('、')}</p>}
      </section>
      <section className="run-assistant" aria-label="API 返回">
        <h4><span className="run-flow-mark">↓</span>API 返回 <small>ASSISTANT</small></h4>
        {text(row.thinking) && <LazyDetails className="run-role run-role-thinking" summary={<> 推理内容 </>}>{() => <><pre>{text(row.thinking)}</pre></>}</LazyDetails>}
        {text(row.text) && <div className="run-reply"><pre>{text(row.text)}</pre></div>}
        {calls.map((tool, callIndex) => <LazyDetails className="run-role run-role-toolcall" key={text(tool.toolCallId) || callIndex} summary={<> TOOL CALL · {text(tool.name)} </>}>{() => <><pre>{displayContent(tool.arguments)}</pre></>}</LazyDetails>)}
        {!text(row.text) && !text(row.thinking) && !calls.length && <p className="field-help">{row.status === 'running' ? '等待 API 返回…' : '没有记录到返回内容。'}</p>}
        {!!row.error && <p role="alert">{full(row.error)}</p>}
      </section>
      {calls.length > 0 && <section className="run-tool-results" aria-label="工具执行结果">
        <h4><span className="run-flow-mark">↳</span>工具执行结果</h4>
        {calls.map((tool, callIndex) => <LazyDetails className="run-role run-role-toolresult" key={text(tool.toolCallId) || callIndex} summary={<> TOOL RESULT · {text(tool.name)}<span className={tool.isError || tool.state === 'failed' ? 'field-error run-result-state' : 'run-result-state'}>{tool.isError ? '失败' : toolStatus(tool.state)}</span> </>}>{() => <>{tool.result === undefined && tool.resultPreview === undefined ? <p className="field-help">等待返回或未记录工具结果。</p> : <pre>{toolResultContent(tool.result ?? tool.resultPreview)}</pre>}</>}</LazyDetails>)}
      </section>}
    </div>
  </>}</LazyDetails>
}

export function Changes({ edits, characterNames, sideBySide = false }: { edits: Row[]; characterNames?: Map<string, string>; sideBySide?: boolean }) {
  if (sideBySide) {
    const names = (edit: Row) => {
      const id = text(edit.id)
      if (edit.kind === 'relation') { try { return (JSON.parse(id) as string[]).map(id => `${characterNames?.get(id) || id}（${id}）`).join(' ↔ ') } catch { return id } }
      return `${characterNames?.get(id) || id}（${id}）`
    }
    const fieldLabel = (field: string) => ({ forwardLabels: '正向称谓', reverseLabels: '反向称谓', forwardLabel: '正向称谓', reverseLabel: '反向称谓', name: '姓名', aliases: '别名', identity: '身份', appearance: '外貌', personality: '性格', background: '经历', speechStyleSample: '说话特点', state: '关系状态', directionUnclear: '方向不明' } as Record<string, string>)[field] ?? field
    return <section className="run-changes"><h3>本次实际修改</h3>
      {!edits.length && <p className="field-help">本次没有实际写库修改。</p>}
      {edits.map((edit, index) => <article className="p2-change" key={`${text(edit.commitId)}:${index}`}>
        <h4>对象：{names(edit)}</h4>
        <div className="p2-change-columns">{(['before', 'after'] as const).map(side => <section key={side}><h5>{side === 'before' ? '修改前' : '修改后'}</h5>{list(edit.fieldChanges).map((change, at) => <div key={at}><strong>{fieldLabel(text(change.field))}</strong><pre>{full(change[side])}</pre></div>)}</section>)}</div>
        <p>理由：{text(edit.reason) || '未填写'}</p>
        {edit.evidenceStatus === 'unverified' && <p className="field-help">依据尚未核实。</p>}
      </article>)}
    </section>
  }
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
