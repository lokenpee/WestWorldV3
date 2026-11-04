import { useState } from 'react'
import type { AssetService } from './service'
import type { LegacyMigrationReport } from './legacyRelations'
import type { Row } from '../agents/repository'

const pageSize = 50

export function LegacyRelationReport({ bookId, service }: { bookId: string; service: AssetService }) {
  const [open, setOpen] = useState(false)
  const [runs, setRuns] = useState<Row[]>()
  const [selected, setSelected] = useState(0)
  const [page, setPage] = useState(0)
  const [error, setError] = useState('')
  async function show() {
    setError(''); setOpen(true)
    try { setRuns(await service.migrationReports(bookId)); setSelected(0); setPage(0) }
    catch (failure) { setError(failure instanceof Error ? failure.message : '读取迁移报告失败。') }
  }
  const run = runs?.[selected]
  const report = run?.result as LegacyMigrationReport | undefined
  const mappings = report?.recordMappings ?? []
  const visible = mappings.slice(page * pageSize, page * pageSize + pageSize)
  return <>
    <button type="button" className="text-button" onClick={() => void show()}>旧关系迁移报告</button>
    {open && <div className="relation-dialog-backdrop"><section role="dialog" aria-modal="true" aria-label="旧关系迁移报告" className="relation-dialog">
      <h4>旧关系迁移报告</h4>
      {error && <p className="field-error" role="alert">{error}</p>}
      {runs && !runs.length && <p className="field-help">本书没有历史关系迁移记录。</p>}
      {runs && runs.length > 1 && <label>迁移记录 <select value={selected} onChange={event => { setSelected(Number(event.target.value)); setPage(0) }}>{(runs ?? []).map((row, index) => <option key={String(row.id)} value={index}>{String(row.startedAt)} · {String(row.id)}</option>)}</select></label>}
      {report && <>
        <p className="field-help">输入 {report.counts.input} 条，归档 {report.counts.archived} 条，已投影 {report.counts.projected} 条，待核对 {report.counts.unresolved} 条，已排除 {report.counts.excluded} 条，语义冲突 {report.counts.conflicts} 条。旧记录只读，当前关系以人物对结果为准。</p>
        <table aria-label="旧关系处置清单"><thead><tr><th>旧记录</th><th>处置</th><th>人物对</th><th>原因</th></tr></thead><tbody>{visible.map(row => <tr key={row.id}><td>{row.id}</td><td>{row.disposition === 'converted' ? '已投影' : row.disposition === 'excluded' ? '已排除' : '待核对'}</td><td>{row.pairKeys.join('、') || '—'}</td><td>{row.issues.join('、') || '—'}</td></tr>)}</tbody></table>
        <p className="field-help">第 {page * pageSize + 1}–{Math.min(mappings.length, page * pageSize + visible.length)} 条，共 {mappings.length} 条。</p>
        <div className="editor-actions">
          <button type="button" className="secondary-button" disabled={page === 0} onClick={() => setPage(value => Math.max(0, value - 1))}>上一页</button>
          <button type="button" className="secondary-button" disabled={page * pageSize + pageSize >= mappings.length} onClick={() => setPage(value => value + 1)}>下一页</button>
        </div>
      </>}
      <div className="editor-actions"><button type="button" className="secondary-button" onClick={() => setOpen(false)}>关闭</button></div>
    </section></div>}
  </>
}
