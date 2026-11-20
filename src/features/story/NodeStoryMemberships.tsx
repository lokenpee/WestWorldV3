import type { StoryMembership } from '../assets/types'
import './NodeStoryMemberships.css'

const emptyMembership: StoryMembership = { lineId: null, eventId: null }

export function NodeStoryMemberships({ memberships, lineTitle, eventTitle }: {
  memberships: readonly StoryMembership[]
  lineTitle: (id: string) => string | undefined
  eventTitle: (id: string) => string | undefined
}) {
  const rows = memberships.length ? memberships : [emptyMembership]
  return <table className="node-story-memberships" aria-label="剧情归属">
    <thead><tr><th scope="col">所属故事线</th><th scope="col">所属事件</th></tr></thead>
    <tbody>{rows.map(({ lineId, eventId }) => <tr key={JSON.stringify([lineId, eventId])}>
      <td>{lineId ? lineTitle(lineId) ?? lineId : ''}</td>
      <td>{eventId ? eventTitle(eventId) ?? eventId : ''}</td>
    </tr>)}</tbody>
  </table>
}
