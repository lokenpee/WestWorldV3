import { useCallback, useState } from 'react'
import { bookInterests, useLiveResult } from '../../hooks/useLiveResult'
import type { AssetService } from '../assets/service'
import type { EventLine, EventNode, StoryEvent } from '../assets/types'
import { outlineStatistics, usesOutline } from './outline'

export function OutlineView({ bookId, service, onNode }: { bookId: string; service: AssetService; onNode: (id: string) => void }) {
  const data = useLiveResult(useCallback(() => service.readContent(bookId, { kind: 'eventLine', network: true }), [bookId, service]), 0, bookInterests(bookId, ['nodes', 'eventLines', 'storyEvents', 'characters']))
  if (data.status === 'loading') return <p role="status">正在读取剧情大纲…</p>
  if (data.status === 'error') return <p role="alert">{data.message}</p>
  const { nodes, eventLines: lines, storyEvents: events = [], characters } = data.value
  const byNode = new Map(nodes.map(node => [node.id, node])), byEvent = new Map(events.map(event => [event.id, event]))
  const characterNames = new Map(characters.map(person => [person.id, person.name]))
  const members = (ids: string[]) => ids.flatMap(id => byNode.has(id) ? [byNode.get(id)!] : [])
  const statistics = (group: EventNode[]) => {
    const values = outlineStatistics(group)
    const people = [...values.characterIds.map(id => characterNames.get(id) ?? id), ...values.characterNames]
    return <small>章节 {values.chapters.join('、') || '—'} · 人物 {[...new Set(people)].join('、') || '—'} · 地点 {values.locationNames.join('、') || '—'}</small>
  }
  const links = (group: EventNode[]) => <ul>{group.map(node => <li key={node.id}><button type="button" className="text-button" onClick={() => onNode(node.id)}>{node.chapterName} · {node.name}</button></li>)}</ul>
  const showEvent = (event: StoryEvent) => <details key={event.id}><summary>{event.title}</summary><p><strong>概况：</strong>{event.summary || '待全书复核'}</p><p><strong>核心关键线索：</strong>{event.coreClue || '待全书复核'}</p>{statistics(members(event.nodeIds))}{links(members(event.nodeIds))}</details>
  const referenced = new Set(lines.filter(usesOutline).flatMap(line => line.eventIds ?? []))
  const unassigned = events.filter(event => !referenced.has(event.id))
  return <div aria-label="剧情大纲内容">
    {!lines.length && !events.length && <p>运行 P3 后可在这里查看剧情大纲。</p>}
    {lines.map(line => <details key={line.id}><summary>{line.title}{line.role === 'main' ? ' · 主线' : line.role === 'sub' ? ' · 支线' : ''}</summary>
      <p><strong>概况：</strong>{line.summary || '待全书复核'}</p><p><strong>核心关键线索：</strong>{line.coreClue || '待全书复核'}</p>
      {statistics(members(line.nodeIds))}
      {usesOutline(line) ? (line.eventIds ?? []).flatMap(id => byEvent.has(id) ? [showEvent(byEvent.get(id)!)] : []) : <><p>旧事件线</p>{links(members(line.nodeIds))}</>}
    </details>)}
    {!!unassigned.length && <details><summary>未归线事件</summary>{unassigned.map(showEvent)}</details>}
  </div>
}

export function OutlineEventMembers({ line, events, nodes, disabled, save }: {
  line: EventLine; events: StoryEvent[]; nodes: EventNode[]; disabled: boolean
  save: (event: StoryEvent, nodeIds: string[]) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function change(event: StoryEvent, ids: string[]) {
    setBusy(true); setMessage('')
    try { await save(event, ids); setMessage('事件成员已保存。') }
    catch (error) { setMessage(error instanceof Error ? error.message : '保存失败。') }
    finally { setBusy(false) }
  }
  const byNode = new Map(nodes.map(node => [node.id, node]))
  return <fieldset className="node-choices" disabled={disabled || busy}><legend>事件成员</legend>
    {events.filter(event => line.eventIds?.includes(event.id)).map(event => <details key={event.id}><summary>{event.title}</summary>
      <select aria-label={`向${event.title}添加节点`} value="" onChange={changeEvent => { const id = changeEvent.target.value; if (id) void change(event, [...event.nodeIds, id]) }}>
        <option value="">添加节点…</option>
        {nodes.filter(node => !event.nodeIds.includes(node.id)).map(node => <option key={node.id} value={node.id}>{node.chapterName} · {node.name}</option>)}
      </select>
      <ul>{event.nodeIds.map(id => <li key={id}>{byNode.get(id)?.name ?? id} <button type="button" className="text-button" onClick={() => void change(event, event.nodeIds.filter(nodeId => nodeId !== id))}>移除引用</button></li>)}</ul>
    </details>)}
    {message && <p role="status">{message}</p>}
  </fieldset>
}
