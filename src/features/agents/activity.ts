import { records, text } from './contracts'
import type { Row } from './repository'

const actions: Record<string, string> = {
  get_character_detail: '正在查询人物资料', query_character_profile: '正在查询人物资料', query_character_catalog: '正在查阅人物目录',
  read_original: '正在查阅原文', get_character_relation: '正在查询人物关系', query_relation_work: '正在核对人物关系',
  query_candidate_groups: '正在查阅疑似组', save_identity_groups: '正在保存疑似组', navigate_identity_pages: '正在翻阅人物目录',
  submit_profile_review: '正在保存人物资料', edit_character: '正在保存人物资料', submit_relation_review: '正在保存人物关系',
  search_story_context: '正在查找相关事件', get_story_detail: '正在查阅事件详情', save_story_lines: '正在保存事件线', save_story_outline: '正在保存剧情大纲',
  save_story_notes: '正在保存线索', add_story_nodes: '正在补充事件节点', navigate_story_pages: '正在翻阅事件资料', finish_story_batch: '正在保存整理进度',
}
export function activityError(message: string) {
  if (/insufficient.balance|insufficient_balance|余额不足/i.test(message)) return '接口余额不足（402），请检查当前接口账户后继续'
  return message
}
export interface ActivityInput { status: string; requests?: Row[]; tasks?: Row[]; error?: string; pausedByUser?: boolean; phase?: string; now?: number }
export function activityView({ status, requests = [], tasks = [], error, pausedByUser, phase, now = Date.now() }: ActivityInput) {
  const latestTask = tasks.at(-1)
  const latest = [...requests].sort((a, b) => text(a.startedAt).localeCompare(text(b.startedAt)) || Number(a.requestOrdinal) - Number(b.requestOrdinal)).at(-1)
  const count = Math.max(tasks.reduce((sum, task) => sum + Number(task.stepsUsed ?? 0), 0), new Set(requests.map(row => row.requestId ?? row.id)).size)
  const prefix = count ? `第 ${count} 次 API` : 'API'
  const stop = (message: string, failed = false) => ({ message, active: false, failed })
  if (status === 'cancelled') return stop('已取消 · 已保存的进度保留')
  if (phase?.startsWith('暂停中')) return { message: '正在暂停 · 等待当前操作结束', active: true, failed: false }
  if (status === 'paused' && pausedByUser) return stop('已暂停 · 当前进度已保存')
  const storedError = text((latestTask?.lastError as Row | undefined)?.message)
  const currentError = text((latest?.error as Row | undefined)?.message)
  const failure = error || (status === 'completed' ? '' : status !== 'running' ? storedError || currentError : latest?.status === 'failed' && (!latestTask || latest.taskId === latestTask.taskId) ? currentError : '')
  if (failure) return stop(`${count && /模型|API|402|insufficient|余额/i.test(failure) ? `${prefix}失败` : '整理暂时停止'} · ${activityError(failure)}`, true)
  if (status === 'completed') return stop('已完成 · 本次整理结果已保存')
  if (status !== 'running') return stop(status === 'paused' ? '已暂停 · 当前进度已保存' : status === 'failed' ? '整理出错停止 · 请查看整理详情' : '等待开始整理', status === 'failed')
  if (!latest || latestTask && latest.taskId !== latestTask.taskId) return { message: '正在准备整理…', active: true, failed: false }
  const tools = records(latest.toolCalls)
  const tool = tools.find(row => row.state === 'running') ?? tools.find(row => row.state === 'pending')
  if (tool) return { message: `${prefix}已返回 · ${actions[text(tool.name)] ?? '正在执行工具操作'}`, active: true, failed: false }
  const failed = tools.findLast(row => row.state === 'failed')
  if (failed) return stop(`${prefix}已返回 · 工具执行失败，正在处理返回结果`, true)
  if (latest.modelFinishedAt || latest.status === 'succeeded') return { message: `${prefix}已返回 · 正在处理结果`, active: true, failed: false }
  const elapsed = Math.max(0, Math.floor((now - Date.parse(text(latest.startedAt))) / 1000))
  return { message: `${prefix} · ${latest.thinking || latest.text ? '正在接收模型回复' : '等待模型回复'} · 已等待 ${Number.isFinite(elapsed) ? elapsed : 0} 秒`, active: true, failed: false }
}
