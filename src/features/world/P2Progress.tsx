import type { WorldRun } from './types'
import { currentCharacter } from '../agents/p2History'
import { useP2Execution, type LoadP2Execution } from '../agents/useP2Execution'
import { executionStats } from '../agents/executionStats'

export function P2Progress({ bookId, run, load, phase, candidateCount }: { bookId: string; run: WorldRun; load: LoadP2Execution; phase?: string; candidateCount?: number }) {
  const organization = run.organization!
  const step = organization.runStep ?? (organization.mode === 'profile' || organization.step === 'profiles' ? 'profiles' : organization.mode === 'relations' || organization.step === 'relations' ? 'relations' : 'scan')
  const current = currentCharacter([run])
  const { chain } = useP2Execution(bookId, current?.runId, step, current?.objectKey, load)
  const stats = executionStats(chain.requests)
  const items = step === 'profiles' ? organization.profileItems : organization.relationItems
  const completed = items.filter(item => item.status === 'checked').length
  const status = phase?.startsWith('暂停中') ? '正在暂停' : ({ running: '进行中', paused: '未完成（已暂停）', cancelled: '未完成（已取消）', failed: '未完成（出错停止）', completed: '已完成', degraded: '未完成' })[run.status]
  const title = step === 'profiles' ? '人物资料整理' : step === 'relations' ? '人物关系整理' : '识别重复人物'
  return <section className="p2-progress" aria-label="人物整理进度">
    <header><h3>{title}</h3><span role="status">{status}</span></header>
    {step === 'scan' ? <>
      <p>{organization.step === 'scan' ? '正在查找疑似重复人物' : run.status === 'completed' ? '重复人物识别已完成' : '正在核实疑似重复人物'}</p>
      <p>当前第 {Math.max(0, organization.scanPages.findIndex(page => page.pageId === organization.identityPageId)) + (organization.scanPages.length ? 1 : 0)} / {organization.scanPages.length} 页 · 待人工核对 {candidateCount ?? organization.candidateGroups.filter(group => group.status === 'pending').length} 组</p>
      <p>疑似组显示在下方候选区，AI不会直接合并人物。</p>
    </> : <>
      <p>{run.status === 'running' ? '正在整理' : '当前人物'}：<strong>{current?.label ?? (run.status === 'completed' ? '本次人物已处理完成' : '等待恢复')}</strong></p>
      {current && <p>已调用 API：{stats.requests} 次 · 输入 {stats.input ?? '待返回'} Token · 输出 {stats.output ?? '待返回'} Token{stats.pendingUsage ? '（当前请求用量待返回）' : ''}</p>}
      <div className="p2-progress-count"><span>已处理 <strong>{completed} / {items.length}</strong> 人</span><span>还有 {items.length - completed} 人未完成</span></div>
      <progress aria-label={`${title}进度`} value={completed} max={Math.max(1, items.length)} />
    </>}
    {organization.pauseNotice && <p role="status">{organization.pauseNotice}</p>}
  </section>
}
