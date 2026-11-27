import { useCallback } from 'react'
import { bookInterests, useLiveResult } from '../../hooks/useLiveResult'
import type { AssetService } from '../assets/service'

export function StoryEventDetails({ bookId, id, service, onNode }: {
  bookId: string; id: string; service: AssetService; onNode: (id: string) => void
}) {
  const data = useLiveResult(useCallback(() => service.eventDetails(bookId, id), [bookId, id, service]), 0,
    bookInterests(bookId, ['storyEvents', 'nodes', 'chapters', 'eventLines','pipelineRuns']))
  if (data.status === 'loading') return <p role="status">正在读取事件…</p>
  if (data.status === 'error') return <p role="alert">{data.message}</p>
  if (!data.value) return <p role="status">事件已移除。</p>
  const { event, nodes, lines, grounds } = data.value
  const chapters = new Map<string, typeof nodes>()
  for (const node of nodes) {
    const chapter = chapters.get(node.chapterIndex)
    if (chapter) chapter.push(node)
    else chapters.set(node.chapterIndex, [node])
  }
  const fields = [
    ['状态', event.status],
    ['概况', event.summary],
    ['最新进展', event.latestProgress],
    ['待解决问题', event.unresolved],
    ['关键线索', event.clues?.join('、')],
    ['所属故事线', lines.map(line => line.title).join('、') || '尚未归线'],
  ]
  return <article className="asset-editor" aria-label="事件详情">
    <header className="editor-heading"><div>
      <h3>{event.title}</h3>
      <small>事件 ID · {event.id}</small>
    </div></header>

    <dl className="asset-readonly-fields">
      {fields.map(([label, value]) => <div className="asset-field" key={label}>
        <dt>{label}</dt><dd>{value || '暂无记录'}</dd>
      </div>)}
    </dl>

    <fieldset className="node-characters">
      <legend>成员节点</legend>
      <p className="node-character-count">{chapters.size} 章 · {nodes.length} 个节点</p>
      {Array.from(chapters, ([index, members]) => {
        const chapterName = members[0].chapterName || '章节 ' + index
        return <section className="asset-member-chapter" key={index}>
          <h4>{chapterName}</h4>
          <ol>{members.map(node => {
            const ground = grounds[node.id]
            return <li key={node.id}>
              <button className="text-button" type="button" aria-label={chapterName+' · '+node.name} onClick={() => onNode(node.id)}>
                {node.name}
              </button>
              {node.summary && <p className="field-help">{node.summary}</p>}
              {ground && <details className="reference-info">
                <summary>归属依据</summary>
                <p>{ground.reason}</p>
                {!!ground.evidence.length && <p>证据节点　{ground.evidence.join('、')}</p>}
              </details>}
            </li>
          })}</ol>
        </section>
      })}
    </fieldset>
  </article>
}
