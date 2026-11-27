import type { ReactNode } from 'react'
import { strings, text } from '../agents/contracts'
import type { EventTaskResult } from './eventTaskOutcome'

type Card = EventTaskResult['cards'][number]
type Member = Card['members'][number]

function MemberRow({member}:{member:Member}) {
  const title = <span>
    <span className="event-member-id">{member.id}</span> {member.name}
    {member.badge && <strong className="event-change-label">{member.badge}</strong>}
    {member.current && !member.badge && <span className="event-change-label">当前节点</span>}
  </span>
  return <li>{member.summary
    ? <details><summary>{title}</summary><p>{member.summary}</p></details>
    : title}</li>
}

function Members({members}:{members:Member[]}) {
  const focus = members.map(m => !!m.badge || m.current)
  const visible = members.map((_,i) => members.length <= 6 || focus[i] || focus[i-1] || focus[i+1])
  if (!visible.some(Boolean) && members.length) visible[0] = true
  const rows:ReactNode[] = []
  for (let i=0; i<members.length;) {
    const start = i++
    if (visible[start]) rows.push(<MemberRow key={members[start].id} member={members[start]} />)
    else {
      while (i<members.length && !visible[i]) i++
      rows.push(<li key={'gap:'+start}><details><summary>其余 {i-start} 个节点</summary>
        <ul>{members.slice(start,i).map(n=><MemberRow key={n.id} member={n} />)}</ul>
      </details></li>)
    }
  }
  return <ul className="event-outcome-members">{rows}</ul>
}

function EventCard({card}:{card:Card}) {
  const {action,fields,members,initialCount,resultCount,added,removed} = card
  const counts = [initialCount !== undefined && '原有 '+initialCount+' 个',added>0 && '加入 '+added+' 个',
    removed>0 && '移除 '+removed+' 个',resultCount !== undefined && '现有 '+resultCount+' 个'].filter(Boolean)
  const operations:Record<string,string> = {create:'新建',update:'更新',delete:'撤销'}
  return <details className="event-outcome-card">
    <summary><h4>{card.title} <span className="event-change-label">{action}</span></h4></summary>
    {card.latestOnly && <small>旧回执仅记录保存结果，部分原值或节点位置未记录。</small>}
    {fields.map(f=><p key={f.key}><b>{f.label}</b>（{f.previous === undefined ? '新建' : f.previous === '原值未记录' ? '保存值' : '修改'}）{' '}
      {f.previous !== undefined && <><span>{f.previous}</span> → </>}{f.value}</p>)}
    {card.edits.length === 0 && action === '已有事件' && <p>本轮未编辑此事件。</p>}
    <p><b>成员节点</b> {counts.join(' · ')}</p>
    <Members members={members} />
    <details><summary>事件编号与操作记录{card.edits.length > 0 && '（'+card.edits.length+' 次）'}</summary>
      <small>{card.id}</small>
      {card.edits.map((e,i)=><div key={i}>
        <b>{i+1}. {operations[e.op] ?? '保存'}</b> {text(e.delta.reason)}
        {(['added','removed','evidence_node_ids'] as const).map((key,j)=>{
          const ids = strings(e.delta[key])
          return ids.length ? <p key={key}>{['加入','移除','证据节点'][j]} · {ids.join('、')}</p> : null
        })}
      </div>)}
    </details>
  </details>
}

export function EventTaskOutcome({result}:{result:EventTaskResult}) {
  const heading = result.link ? '本节点处理结果' : '本事件复核结果'
  return <section className="narrative-review event-task-outcome" aria-label={heading}>
    <details>
      <summary><h3>{heading} <span className="event-result-state">{result.state}</span></h3></summary>
      {result.unassigned && <p>{result.unassigned}</p>}
      {result.issues.map((s,i)=><p key={i}>{s}</p>)}
      {result.cards.map(c=><EventCard key={c.id} card={c} />)}
      {!result.cards.length && !result.unassigned && !result.issues.length && <p>本任务暂无可展示的事件改动。</p>}
    </details>
  </section>
}
