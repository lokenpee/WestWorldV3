import type { Character } from './types'

export function characterAgeText(profile: Character['profile']): string {
  return profile?.ageText?.trim() || (typeof profile?.age === 'number' ? `${profile.age}岁` : '')
}
