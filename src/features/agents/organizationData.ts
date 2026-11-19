import type { AgentStore, Row } from './repository'
import type { Character } from '../assets/types'
import { pairFromPerspective } from '../assets/relations'
import { profileContent, reviewContext } from './organizationReview'

export async function profileWork(character: Character) {
  const content: Row = profileContent(character as unknown as Row)
  delete content.mergeFacts
  return { ...content, id: character.id, revision: character.revision, fields: ['name', 'aliases', 'identity', 'profile', 'appearance', 'personality', 'background', 'speechStyleSample', 'sourceChapters'] }
}

const brief = (value: string | undefined) => (value ?? '').slice(0, 50)

export async function relationWork(store: AgentStore, id: string, pairChecks: Row[] = [], compact = false) {
  const context = await reviewContext(store)
  const person = context.byId.get(id)
  if (!person) return null
  const checks = new Map(pairChecks.map(pair => [String(pair.pairKey), pair]))
  const relations = (context.pairsByPerson.get(id) ?? []).map(pair => {
    const targetId = pair.fromId === id ? pair.toId : pair.fromId
    const target = context.byId.get(targetId)
    const view = pairFromPerspective([pair], id, targetId, context.people)
    const checked = checks.get(view.pairKey)
    const row: Row = {
      targetId, targetName: target?.name ?? '', identity: compact ? brief(target?.identity) : target?.identity ?? '',
      forward: view.forwardLabels, reverse: view.reverseLabels,
      state: view.state, fingerprint: view.fingerprint,
    }
    if (view.directionUnclear) row.unclear = true
    if (checked?.outcome) row.checked = { outcome: checked.outcome, reason: compact ? String(checked.reason ?? '').slice(0, 100) : checked.reason }
    if (!compact) row.evidence = view.evidence
    return row
  })
  const unlinkedRelations = (context.rawUnresolvedByPerson.get(id) ?? [])
    .map(row => {
      const item: Row = { sourceName: row.sourceName, targetName: row.targetName, forward: row.forwardLabel, reverse: row.reverseLabel, direction: row.direction }
      if (!compact) { item.id = row.id; item.evidence = row.evidence }
      return item
    })
  return { id: person.id, name: person.name, identity: compact ? brief(person.identity) : person.identity ?? '', revision: person.revision, relations, unlinkedRelations }
}

export async function relationOverview(store: AgentStore, id: string, pairChecks: Row[] = []) {
  return relationWork(store, id, pairChecks, true)
}
