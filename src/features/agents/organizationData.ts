import type { AgentStore, Row } from './repository'
import type { Character, CharacterRelation } from '../assets/types'
import { pairFromPerspective } from '../assets/relations'
import { profileContent, reviewContext } from './organizationReview'

export async function profileWork(character: Character) {
  const content = profileContent(character as unknown as Row)
  return { ...content, id: character.id, revision: character.revision, fields: ['name', 'aliases', 'identity', 'profile', 'appearance', 'personality', 'background', 'speechStyleSample', 'mergeFacts', 'sourceChapters'] }
}

export async function relationWork(store: AgentStore, id: string, pairChecks: Row[] = []) {
  const context = await reviewContext(store)
  const person = context.byId.get(id)
  if (!person) return null
  const checks = new Map(pairChecks.map(pair => [String(pair.pairKey), pair]))
  const relations = context.pairs.filter(pair => pair.fromId === id || pair.toId === id).map(pair => {
    const targetId = pair.fromId === id ? pair.toId : pair.fromId
    const target = context.byId.get(targetId)
    const view = pairFromPerspective([pair], id, targetId, context.people)
    const checked = checks.get(view.pairKey)
    return {
      pairKey: view.pairKey, targetId, targetName: target?.name ?? '', targetIdentity: target?.identity ?? '',
      forwardLabels: view.forwardLabels, reverseLabels: view.reverseLabels, directionUnclear: view.directionUnclear,
      state: view.state, fingerprint: view.fingerprint, evidence: view.evidence,
      checked: checked?.outcome ? { outcome: checked.outcome, reason: checked.reason } : null,
    }
  })
  const raw = await store.rows('characterRelations') as unknown as CharacterRelation[]
  const unresolved = raw.filter(row => row.sourceId === id && !row.targetIds.length || row.targetIds.includes(id) && !row.sourceId)
    .map(row => ({ id: row.id, sourceName: row.sourceName, targetName: row.targetName, forwardLabel: row.forwardLabel, reverseLabel: row.reverseLabel, direction: row.direction, evidence: row.evidence }))
  return { id: person.id, name: person.name, identity: person.identity ?? '', revision: person.revision, relations, unresolved }
}
