import type { WorldRun } from './types'

export const needsOrganizationReview = (run: WorldRun) => !!run.organization && run.organization.reviewVersion !== 2
export function organizationEdits(run: WorldRun, kind: 'character' | 'relation') {
  if (!run.organization?.reviewStartedAt) return []
  return (run.report.assetEdits ?? []).filter(edit => edit.kind === kind && edit.fieldChanges.length && edit.timestamp >= run.organization!.reviewStartedAt! && (kind !== 'character' || ['edit_character', 'submit_profile_review'].includes(String(edit.tool))))
}
