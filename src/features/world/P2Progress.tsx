import type { WorldRun } from './types'
import { currentCharacter } from '../agents/p2History'
import { useP2Execution, type LoadP2Execution } from '../agents/useP2Execution'
import { executionStats } from '../agents/executionStats'
import { AgentActivity } from '../agents/AgentActivity'
import { records, text } from '../agents/contracts'
import type { Row } from '../agents/repository'

export function P2Progress({ bookId, run, load, phase, candidateCount, error }: { bookId: string; run: WorldRun; load: LoadP2Execution; phase?: string; candidateCount?: number; error?: string }) {
  const organization = run.organization!
  const step = organization.runStep ?? (organization.mode === 'profile' || organization.step === 'profiles' ? 'profiles' : organization.mode === 'relations' || organization.step === 'relations' ? 'relations' : 'scan')
  const current = currentCharacter([run])
  const { chain } = useP2Execution(bookId, current?.runId, step, current?.objectKey, load)
  const stats = executionStats(chain.requests)
  const items = step === 'profiles' ? organization.profileItems : organization.relationItems
  const completed = items.filter(item => item.status === 'checked').length
  const workId = step === 'scan' ? 'directory:identity' : current?.objectKey
  const tasks = records(run.tasks).filter(task => !workId || (task.input as Row | undefined)?.unitId === workId)
  const pageError = step === 'scan' ? organization.scanPages.find(page => page.lastError)?.lastError?.message : undefined
  const title = step === 'profiles' ? '人物资料整理' : step === 'relations' ? '人物关系整理' : '识别重复人物'
  return <section className="p2-progress" aria-label="人物整理进度">
    <header><h3>{title}</h3></header>
    <AgentActivity bookId={bookId} runId={run.id} workId={workId} tasks={tasks} status={run.status} phase={phase} pausedByUser={organization.pauseRequested} error={error || (run.status !== 'running' ? text(pageError) : undefined)} />
    {step === 'scan' ? <>
      <p>当前第 {Math.max(0, organization.scanPages.findIndex(page => page.pageId === organization.identityPageId)) + (organization.scanPages.length ? 1 : 0)} / {organization.scanPages.length} 页 · 待人工核对 {candidateCount ?? organization.candidateGroups.filter(group => group.status === 'pending').length} 组</p>
    </> : <>
      <p>{run.status === 'running' ? '正在整理' : '当前人物'}：<strong>{current?.label ?? (run.status === 'completed' ? '本次人物已处理完成' : '等待恢复')}</strong></p>
      {current && <p>已调用 API：{stats.requests} 次 · 输入 {stats.input ?? '待返回'} Token · 输出 {stats.output ?? '待返回'} Token{stats.pendingUsage ? '（当前请求用量待返回）' : ''}</p>}
      <div className="p2-progress-count"><span>已处理 <strong>{completed} / {items.length}</strong> 人</span><span>还有 {items.length - completed} 人未完成</span></div>
      <progress aria-label={`${title}进度`} value={completed} max={Math.max(1, items.length)} />
    </>}
  </section>
}
