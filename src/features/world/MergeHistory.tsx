import type { Row } from '../agents/repository'
import { LazyDetails } from '../agents/LazyDetails'
import { mergeHistoryRecords } from './mergeHistoryRecords'
import { strings, text } from '../agents/contracts'

export function MergeHistory({ runs }: { runs: Row[] }) {
  const groups = mergeHistoryRecords(runs)
  return <section className="p2-merge-history" aria-label="合并历史">
    {([true, false] as const).map(automatic => <section key={String(automatic)}><h3>{automatic ? '代码自动合并记录' : '合并记录'}</h3>
      {groups.filter(group => group.automatic === automatic).map(group => <LazyDetails key={text(group.key)} summary={<>组合：{strings(group.memberIds).map((id, index) => `${strings(group.memberNames)[index] || id}（${id}）`).join('、')} <small>{group.at ? new Date(text(group.at)).toLocaleString('zh-CN') : ''}</small></>}>{() => <>
        <h4>合并后的结果</h4><p>名称：{text(group.canonicalName)}（{text(group.keepId)}）</p>
        <p>别名：{strings(group.aliases).join('、') || '无'}</p><p>来源章节：{strings(group.sourceChapters).join('、') || '未记录'}</p>
        {strings(group.conflicts).map((conflict, index) => <p key={index}>{conflict}</p>)}
      </>}</LazyDetails>)}
      {!groups.some(group => group.automatic === automatic) && <p className="field-help">暂无合并记录。</p>}
    </section>)}
  </section>
}
