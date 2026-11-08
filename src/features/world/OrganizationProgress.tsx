import type { AssetEditRecord } from '../assets/types'
import type { OrganizationItem, WorldRun } from './types'
import { needsOrganizationReview, organizationEdits } from './organizationReport'

const labels: Record<string, string> = { name: '姓名', aliases: '别名', identity: '身份', appearance: '外貌', personality: '性格', background: '背景', speechStyleSample: '说话样本', roleWeight: '人物层级', 'profile.age': '年龄', 'profile.ageText': '年龄描述', 'profile.gender': '性别', forwardLabels: '正向身份', reverseLabels: '反向身份', state: '关系状态', directionUnclear: '方向待核' }
const valueOf = (value: unknown) => value === undefined || value === null || value === '' ? '空' : Array.isArray(value) ? value.join('、') || '空' : typeof value === 'object' ? JSON.stringify(value) : String(value)
function Changes({ edits }: { edits: AssetEditRecord[] }) {
  return edits.map(edit => <div className="organization-change" key={edit.commitId}><p>{edit.reason}</p>{edit.fieldChanges.map((change, index) => <div key={index}><strong>{labels[change.field] ?? change.field}</strong><p>修改前：{valueOf(change.before)}</p><p>修改后：{valueOf(change.after)}</p></div>)}{edit.basis?.map((basis, index) => <p key={index}>依据：{basis.summary}（{basis.source.kind === 'asset' ? basis.source.id : basis.source.kind === 'chapter' ? `第${basis.source.chapterIndex}章` : basis.source.kind === 'relation' ? `${basis.source.fromId} ↔ ${basis.source.toId}` : basis.source.id}）</p>)}</div>)
}
export function OrganizationProgress({ run, running = false, details = false }: { run: WorldRun; running?: boolean; details?: boolean }) {
  const state = run.organization
  if (!state) return null
  const legacy = needsOrganizationReview(run)
  const index = ['scan', 'resolve'].includes(state.step) ? 0 : state.step === 'profiles' ? 1 : state.step === 'relations' ? 2 : 3
  const profiles = state.profileItems, relations = state.relationItems
  const profileEdits = organizationEdits(run, 'character'), relationEdits = organizationEdits(run, 'relation')
  const status = (step: number) => legacy && step > 0 ? '需重新检查' : index > step ? '已完成' : index < step ? '未开始' : running || run.status === 'running' ? '进行中' : run.status === 'failed' ? '未完成（已失败）' : run.status === 'cancelled' || run.status === 'paused' ? '未完成（已停止）' : '进行中'
  const checked = (items: OrganizationItem[]) => legacy ? 0 : items.filter(item => item.status === 'checked').length
  const counts = (items: OrganizationItem[], edits: AssetEditRecord[]) => <p>已检查 {checked(items)}/{items.length} 人 · 实际修改 {new Set(edits.map(edit => edit.id)).size}{edits === relationEdits ? ' 对' : ' 人'} · 无需修改 {legacy ? 0 : items.filter(item => item.status === 'checked' && item.outcome === 'no_change').length} 人 · 仍有疑点 {legacy ? 0 : items.filter(item => item.outcome === 'uncertain').length} 人 · 待处理 {items.length - checked(items)} 人</p>
  const groupIds = new Set([...state.candidateGroups.map(group => group.id), ...state.candidateDecisions.map(group => group.groupId)])
  const names = new Map([...profiles, ...relations].map(item => [item.id, item.name ?? item.id]))
  const otherEdits = (run.report.assetEdits ?? []).filter(edit => edit.kind !== 'character' && edit.kind !== 'relation')
  const historicalEdits = (run.report.assetEdits ?? []).filter(edit => (edit.kind === 'character' || edit.kind === 'relation') && state.reviewStartedAt && edit.timestamp < state.reviewStartedAt)
  return <section className="organization-progress" aria-label="人物整理进度"><h3>人物整理进度</h3>
    <p role={running ? 'status' : undefined}>当前：{legacy && index > 0 ? '待重新检查第二步人物资料及第三步人物关系' : index === 0 ? '第一步 · 识别与合并' : index === 1 ? '第二步 · 整理人物资料' : index === 2 ? '第三步 · 整理人物关系' : state.step === 'done' ? '三步整理及出场统计已完成' : '三步检查已完成，正在更新出场统计'}</p>
    {(legacy || state.repairNotice) && <p className="field-help">{legacy ? '旧版第二、三步的完成标记需要重新核对。继续时保留第一步成果，从人物资料开始。' : state.repairNotice}</p>}
    {state.pauseNotice && <p role="status">{state.pauseNotice}</p>}
    {(() => {
      const errors = [...state.scanPages, ...state.profileItems, ...state.relationItems, ...state.candidateGroups].filter(item => item.lastError)
      return errors.length ? <details><summary>待处理错误（{errors.length}）</summary>{errors.map((item, index) => <p key={index}>{'pageId' in item ? item.pageId : 'id' in item ? item.id : String((item as { id?: string }).id)}：{item.lastError!.message}{item.lastError!.action === 'defer' ? '（已留待，可继续重试）' : ''}</p>)}</details> : null
    })()}
    <section aria-label="第一步识别与合并"><h4>第一步：识别与合并 · {status(0)}</h4><p>目录扫描 {state.scanPages.filter(page => page.status === 'checked').length}/{state.scanPages.length} 页 · 疑似同人 {groupIds.size} 组 · 已合并 {state.candidateDecisions.filter(item => item.outcome === 'merged' || item.outcome === 'partial').length} 组 · 仍有疑点 {state.candidateDecisions.filter(item => item.outcome === 'uncertain').length} 组</p><p>{index > 0 && !state.candidateGroups.length ? '疑似组工作存储已清空，结论保留在报告。' : `疑似组待处理 ${state.candidateGroups.filter(group => group.status === 'pending').length} 组`}</p></section>
    <section aria-label="第二步人物资料"><h4>第二步：整理人物资料 · {status(1)}</h4>{counts(profiles, profileEdits)}
      {details && !!profiles.length && <details open={profileEdits.length > 0}><summary>人物资料结果与修改前后</summary>{profiles.map(item => {
        const edits = profileEdits.filter(edit => edit.id === item.id)
        return <article key={item.id}><h5>{item.name ?? item.id}（{item.id}）· {legacy ? '需重新检查' : edits.length ? item.outcome === 'uncertain' ? '已修改，仍有疑点' : '已修改' : item.status === 'pending' ? '待处理' : item.outcome === 'uncertain' ? '仍有疑点' : item.outcome === 'unavailable' ? '已不可用' : '无需修改'}</h5>{item.reason && <p>{item.reason}</p>}{!!item.uncertainFields?.length && <p>待查证字段：{item.uncertainFields.map(field => labels[field] ?? field).join('、')}</p>}<Changes edits={edits} /></article>
      })}</details>}
    </section>
    <section aria-label="第三步人物关系"><h4>第三步：整理人物关系 · {status(2)}</h4>{counts(relations, relationEdits)}<p>人物对已核对 {legacy ? 0 : state.pairChecks.filter(pair => pair.outcome).length}/{state.pairChecks.length} 对，同一人物对两端共用结果。</p>
      {details && (!!state.pairChecks.length || !!relations.length) && <details open={relationEdits.length > 0}><summary>人物关系核对结果与修改前后</summary>{state.pairChecks.map(pair => {
        const ids = JSON.parse(pair.pairKey) as string[]
        return <article key={pair.pairKey}><h5>{ids.map(id => names.get(id) ?? id).join(' ↔ ')} · {legacy || !pair.outcome ? '待处理' : pair.commitIds.length ? pair.outcome === 'uncertain' ? '已修改，仍有疑点' : '已修改' : pair.outcome === 'uncertain' ? '仍有疑点' : '无需修改'}</h5><p>{pair.reason}</p><Changes edits={relationEdits.filter(edit => edit.id === pair.pairKey)} />{pair.basis.map((basis, index) => <p key={index}>核对依据：{basis.summary}</p>)}</article>
      })}{relations.filter(item => item.reason).map(item => <p key={item.id}>{item.name ?? item.id}（{item.id}）：{item.reason}</p>)}</details>}
    </section>
    <p>出场统计{!legacy && state.step === 'done' && !state.statisticsPending ? '已更新' : '待更新'}</p>
    {details && !!otherEdits.length && <details><summary>其他资产实际修改（{otherEdits.length}）</summary><Changes edits={otherEdits} /></details>}
    {details && !!historicalEdits.length && <details><summary>第一步或重查前已保存的修改（{historicalEdits.length}）</summary><Changes edits={historicalEdits} /></details>}
  </section>
}
