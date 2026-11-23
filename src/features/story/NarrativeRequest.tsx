import { useState } from 'react'
import { LazyDetails } from '../agents/LazyDetails'
import {
  displayContent,
  messageRows,
  requestRecord,
  requestRows,
  toolDeclaration,
  toolResultContent,
} from '../agents/requestPresentation'
import type { Row } from '../agents/repository'

const statuses: Record<string, string> = {
  succeeded: '成功',
  completed: '成功',
  running: '进行中',
  failed: '失败',
  cancelled: '取消',
  interrupted: '中断',
  pending: '等待执行',
}
const status = (value: unknown) => statuses[String(value)] ?? String(value ?? '待返回')
const roleName: Record<string, string> = {
  system: '系统提示词',
  developer: '开发者指令',
  assistant: '历史模型回复',
  tool: '历史工具返回',
  toolResult: '历史工具返回',
  user: '用户消息',
}

function TaskMaterial({ content }: { content: string }) {
  let parsed: Row
  try {
    parsed = JSON.parse(content)
  } catch {
    return <pre>{content}</pre>
  }
  const legacyLabels: Record<string, string> = {
    mode: '任务类型',
    part: '任务环节',
    targets: '本次资料',
    outline: '初始目录',
    config: '运行参数',
    openDoubts: '未决疑点',
    periodIds: '本周期范围',
  }
  return (
    <>
      {Object.entries(parsed).map(([key, value]) => (
        <LazyDetails
          key={key}
          summary={(legacyLabels[key] ?? key) + (Array.isArray(value) ? '（' + value.length + ' 项）' : '')}
        >
          {() => <pre>{displayContent(value)}</pre>}
        </LazyDetails>
      ))}
    </>
  )
}
function RawRequest({ bodies }: { bodies: Row }) {
  const ids = Object.keys(bodies)
  const [picked, setPicked] = useState('')
  if (!ids.length) return <p className="field-help">此记录未保存完整的 API 请求体原文。</p>
  const selected = ids.includes(picked) ? picked : ids[ids.length - 1]
  return (
    <LazyDetails summary="完整 API 请求原文">
      {() => (
        <>
          {ids.length > 1 && (
            <label>
              传输尝试{' '}
              <select value={selected} onChange={(e) => setPicked(e.target.value)}>
                {ids.map((id, i) => (
                  <option key={id} value={id}>
                    第 {i + 1} 次
                  </option>
                ))}
              </select>
            </label>
          )}
          <pre>{String(bodies[selected])}</pre>
        </>
      )}
    </LazyDetails>
  )
}

export function NarrativeRequest({
  request,
  snapshots,
  ordinal,
  previousHashes,
}: {
  request: Row
  snapshots: Map<string, Row>
  ordinal: number
  previousHashes: unknown
}) {
  const input = requestRecord(request.input)
  const thinking = requestRecord(requestRecord(input.requestParameters).thinking)
  const actual = input.messageFormat === 'provider-request/v1'
  const snapshot = snapshots.get(String(input.toolSchemaSnapshotId))
  const tools = requestRows(snapshot?.schema).map(toolDeclaration)
  const calls = requestRows(request.toolCalls).flatMap<Row & { name: string }>((call) => {
      const name = [call.name, call.toolName, call.toolCallId].find(
        (value) => typeof value === 'string' && value.trim()
      )
      return typeof name === 'string' ? [{ ...call, name }] : []
    }),
    usage = requestRecord(request.usage)
  const seen = new Map<string, number>()
  if (Array.isArray(previousHashes))
    for (const hash of previousHashes) seen.set(hash, (seen.get(hash) ?? 0) + 1)
  const names = new Map<string, string>()
  const rows = requestRows(input.messages).flatMap((source, i) => {
    const hash = Array.isArray(input.messageHashes) ? input.messageHashes[i] : undefined,
      count = seen.get(hash) ?? 0
    if (count) seen.set(hash, count - 1)
    return messageRows([source]).map((message) => {
      const content = displayContent(message.content ?? message)
      const role = String(message.role ?? message.type ?? '消息')
      const fn = requestRows(message.tool_calls).map((call) => ({
        id: call.id,
        name: requestRecord(call.function).name,
      }))
      for (const part of requestRows(message.content))
        if (part.type === 'toolCall') fn.push({ id: part.id, name: part.name })
      for (const call of fn) names.set(String(call.id), String(call.name))
      const placeholder = role === 'user' && /^\[第 \d+ 轮\]/.test(content)
      const material = role === 'user' && /^\{\s*"(任务说明|mode)"/.test(content)
      const title = placeholder ? '历史占位' : material ? '任务材料' : (roleName[role] ?? role)
      const tool = names.get(String(message.tool_call_id ?? message.toolCallId))
      const action = fn.map((c) => c.name).join('、') || tool
      const delta =
        !actual || !hash
          ? ''
          : count
            ? '沿用'
            : ordinal === 1 || Array.isArray(previousHashes)
              ? placeholder
                ? '本次替换'
                : '本次新增'
              : ''
      return { message, title, role, action, delta, content, placeholder }
    })
  })
  const messages = (fixed: boolean) =>
    rows.map((r, i) => {
      if (['system', 'developer'].includes(r.role) !== fixed) return null
      return (
        <LazyDetails
          key={i}
          className={'run-role run-role-' + r.role}
          summary={
            <>
              <span className="run-message-number">{i + 1}</span>
              <strong>{r.title}</strong> {r.action} <small>{r.delta}</small>
              {r.placeholder && <span> · {r.content.split('\n')[0].slice(0, 96)}</span>}
            </>
          }
        >
          {() => (
            <>
              {r.message.reasoning_content != null && (
                <pre>{displayContent(r.message.reasoning_content)}</pre>
              )}
              {r.title === '任务材料' ? (
                <TaskMaterial content={r.content} />
              ) : (
                <pre>{r.message.tool_calls ? displayContent(r.message) : r.content}</pre>
              )}
            </>
          )}
        </LazyDetails>
      )
    })
  return (
    <section
      className="narrative-request run-api-content"
      aria-label={'API ' + String(ordinal).padStart(2, '0')}
    >
      <h3>
        第 {ordinal} 次请求 · {status(request.status)}
      </h3>
      <p>
        {String(request.model ?? '')} · {new Date(String(request.startedAt)).toLocaleString('zh-CN')} · 输入{' '}
        {typeof usage.totalTokens === 'number' && typeof usage.output === 'number'
          ? usage.totalTokens - usage.output
          : '待返回'}{' '}
        token · 缓存读取 {String(usage.cacheRead ?? '待返回')} · 输出 {String(usage.output ?? '待返回')} token
      </p>
      <h4>{actual ? '发送给 API' : '调用前保存的上下文'}</h4>
      {messages(true)}
      <LazyDetails className="run-role run-role-tools" summary={'可调用工具（' + tools.length + '）'}>
        {() =>
          tools.length ? (
            tools.map((t, i) => (
              <LazyDetails key={i} summary={String(t.name)}>
                {() => <pre>{displayContent(t)}</pre>}
              </LazyDetails>
            ))
          ) : (
            <p>{snapshot ? '本次没有工具定义。' : '未保存工具定义。'}</p>
          )
        }
      </LazyDetails>
      <LazyDetails className="run-role run-request-parameters" summary="请求参数">
        {() => <pre>{displayContent(input.requestParameters)}</pre>}
      </LazyDetails>
      {messages(false)}
      {input.completeness === 'partial' || input.missingRefs ? (
        <p role="status">输入记录不完整。{String(input.incompleteReason ?? '')}</p>
      ) : null}
      <RawRequest bodies={requestRecord(input.rawBodies)} />
      <h4>模型回复</h4>
      {request.thinking ? (
        <LazyDetails summary="模型返回的推理内容">{() => <pre>{String(request.thinking)}</pre>}</LazyDetails>
      ) : (
        <p className="field-help">
          {thinking.type === 'disabled'
            ? '本次请求关闭了推理。'
            : request.status === 'running'
              ? '等待模型返回推理内容…'
              : '本次未记录到可展示的推理内容。'}
        </p>
      )}
      {request.text ? <pre>{String(request.text)}</pre> : null}
      {calls.map((c, i) => (
        <LazyDetails key={i} className="run-role run-role-toolcall" summary={'调用 ' + c.name}>
          {() => <pre>{displayContent(c.arguments)}</pre>}
        </LazyDetails>
      ))}
      {!calls.length && !request.text && !request.thinking && (
        <p>{request.status === 'running' ? '等待模型回复…' : '未记录回复正文或工具调用。'}</p>
      )}
      {request.error ? <p role="alert">{displayContent(request.error)}</p> : null}
      {!!calls.length && (
        <>
          <h4>本次工具返回</h4>
          {calls.map((c, i) => (
            <LazyDetails
              key={i}
              className="run-role run-role-toolresult"
              summary={c.name + ' · ' + (c.isError ? '失败' : status(c.state))}
            >
              {() => {
                const body = toolResultContent(c.result ?? c.resultPreview)
                const truncated = body.includes('the response hit the output token limit')
                return <pre>{truncated ? '模型达到本次输出上限，工具未执行。\n\n' + body : body}</pre>
              }}
            </LazyDetails>
          ))}
        </>
      )}
    </section>
  )
}
