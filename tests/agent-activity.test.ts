import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { activityView } from '../src/features/agents/activity'
import { AgentActivity } from '../src/features/agents/AgentActivity'

const task = { taskId: 't', stepsUsed: 3 }
const request = { requestId: 'r', taskId: 't', status: 'running', startedAt: '2026-11-13T00:00:00Z' }
it('同一请求从等待计时更新为工具动作，文字没有追加旧日志', () => {
  const input = { status: 'running', tasks: [task], requests: [request], now: Date.parse('2026-11-13T00:00:18Z') }
  expect(activityView(input)).toEqual({ message: '第 3 次 API · 等待模型回复 · 已等待 18 秒', active: true, failed: false })
  const returned = activityView({ ...input, requests: [{ ...request, modelFinishedAt: 'now', toolCalls: [{ name: 'get_character_detail', state: 'running' }] }] })
  expect(returned.message).toBe('第 3 次 API已返回 · 正在查询人物资料')
  expect(returned.message).not.toContain('等待')
})
it('余额错误即时显示，刷新后从任务恢复，主动暂停和完成停止动画', () => {
  const error = { message: '402: Insufficient Balance' }
  const live = activityView({ status: 'running', tasks: [task], requests: [{ ...request, status: 'failed', error }] })
  const restored = activityView({ status: 'paused', tasks: [{ ...task, lastError: error }] })
  expect(live).toEqual(restored)
  expect(live).toMatchObject({ active: false, failed: true })
  expect(live.message).toContain('接口余额不足')
  expect(activityView({ status: 'paused', pausedByUser: true, tasks: [{ ...task, lastError: error }] }).message).toBe('已暂停 · 当前进度已保存')
  expect(activityView({ status: 'completed', tasks: [{ ...task, lastError: error }] })).toMatchObject({ active: false, failed: false })
})
it('继续时新任务不沿用旧请求错误；只有实际接收内容才显示接收', () => {
  expect(activityView({ status: 'running', tasks: [{ taskId: 'new', stepsUsed: 0 }], requests: [request] }).message).toBe('正在准备整理…')
  expect(activityView({ status: 'running', tasks: [{ taskId: 'new', stepsUsed: 0 }], requests: [{ ...request, status: 'failed', error: { message: '旧请求失败' } }] }).message).toBe('正在准备整理…')
  expect(activityView({ status: 'running', requests: [{ ...request, thinking: '内容' }] }).message).toContain('正在接收模型回复')
})
it('主面板只渲染一个状态元素，长错误作为文本且可查看完整内容', () => {
  const html = renderToStaticMarkup(createElement(AgentActivity, { bookId: 'b', runId: 'r', status: 'paused', error: '<script>错误</script>' }))
  expect(html.match(/<p /g)).toHaveLength(1)
  expect(html).toContain('role="alert"')
  expect(html).toContain('&lt;script&gt;')
  expect(html).not.toContain('is-active')
})

it('未请求API的启动错误显示真实原因，不虚构API失败', () => {
  expect(activityView({ status: 'failed', error: '请先保存整理模型与密钥。' })).toEqual({ message: '整理暂时停止 · 请先保存整理模型与密钥。', active: false, failed: true })
})
