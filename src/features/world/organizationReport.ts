import type { OrganizationState, PairCheck, WorldRun } from './types'

export const needsOrganizationReview = (run: WorldRun) => !!run.organization && run.organization.reviewVersion !== 2
export function organizationEdits(run: WorldRun, kind: 'character' | 'relation') {
  if (!run.organization?.reviewStartedAt) return []
  return (run.report.assetEdits ?? []).filter(edit => edit.kind === kind && edit.fieldChanges.length && edit.timestamp >= run.organization!.reviewStartedAt! && (kind !== 'character' || ['edit_character', 'submit_profile_review'].includes(String(edit.tool))))
}
export function visiblePairChecks(organization: OrganizationState): PairCheck[] {
  const id = organization.targetCharacterId
  if (!organization.mode || organization.mode === 'full' || !id) return organization.pairChecks
  return organization.pairChecks.filter(pair => {
    try { return (JSON.parse(pair.pairKey) as string[]).includes(id) } catch { return false }
  })
}
