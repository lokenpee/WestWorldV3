import parameters from '../../../docs/v2/resources/algorithm-parameters.json'
import type { Character, LocationAsset } from '../assets/types'
import type { WorldKind } from '../assets/merge'
import { characterMatchNames, isContextualName } from '../assets/characterNames'

export interface Candidate { id: string; kind: WorldKind; memberIds: string[]; reason: string }
export function findExactNameGroups(kind: WorldKind, input: (Character | LocationAsset)[]): Candidate[] {
  const groups = new Map<string, string[]>()
  for (const row of input) { const name = row.name.trim(); if (!name) continue; if (!groups.has(name)) groups.set(name, []); groups.get(name)!.push(row.id) }
  return [...groups].filter(([, ids]) => ids.length > 1).map(([, ids]) => ({ id: `exact:${kind}:${[...ids].sort().join('|')}`, kind, memberIds: [...ids].sort(), reason: '完整主名相同，按当前规则自动机械合并。' }))
}
const expression = (value: string) => { const end = value.lastIndexOf('/'); return new RegExp(value.slice(1, end), value.slice(end + 1)) }
export function normalizeName(value: string) {
  const original = value.trim()
  let name = value.replace(expression(parameters.normalization.whitespaceRegex), ' ').trim()
  for (const replacement of parameters.normalization.suffixReplacements) name = name.replace(expression(replacement.regex), replacement.replacement)
  return (name || original).toLowerCase().replace(expression(parameters.normalization.punctuationRegex), '')
}
function distance(a: string, b: string) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) { const current = [i]; for (let j = 1; j <= b.length; j++) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); previous = current }
  return previous[b.length]
}
export function aliasScore(left: string[], right: string[]) {
  return normalizedAliasScore(normalizeAliases(left), normalizeAliases(right))
}
const normalizeAliases = (names: string[]) => [...new Set(names.map(normalizeName).filter(Boolean))].sort()
function normalizedAliasScore(a: string[], b: string[], minimum?: number) {
  const n = Math.max(a.length, b.length)
  if (!n) return 0
  const totalLength = [...a, ...b].reduce((sum, name) => sum + name.length, 0)
  if (minimum !== undefined) {
    const left = a.map(name => name.length).sort((x, y) => y - x), right = b.map(name => name.length).sort((x, y) => y - x)
    const upper = left.reduce((sum, length, index) => sum + Math.min(length, right[index] ?? 0), 0)
    if (2 * upper / totalLength <= minimum) return 0
  }
  const weights = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => a[i] && b[j] ? Math.max(a[i].length, b[j].length) - distance(a[i], b[j]) : 0))
  const u = Array(n + 1).fill(0), v = Array(n + 1).fill(0), p = Array(n + 1).fill(0), way = Array(n + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0; const min = Array(n + 1).fill(Infinity), used = Array(n + 1).fill(false)
    do {
      used[j0] = true; const i0 = p[j0]; let delta = Infinity, j1 = 0
      for (let j = 1; j <= n; j++) if (!used[j]) { const cost = -weights[i0 - 1][j - 1] - u[i0] - v[j]; if (cost < min[j]) { min[j] = cost; way[j] = j0 }; if (min[j] < delta) { delta = min[j]; j1 = j } }
      for (let j = 0; j <= n; j++) if (used[j]) { u[p[j]] += delta; v[j] -= delta } else min[j] -= delta
      j0 = j1
    } while (p[j0] !== 0)
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1 } while (j0)
  }
  const sum = p.slice(1).reduce((sum, i, j) => sum + weights[i - 1][j], 0)
  return 2 * sum / totalLength
}
export function findCandidates(kind: WorldKind, input: (Character | LocationAsset)[]): Candidate[] {
  const rows = [...input].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const normalizedNames = rows.map(row => kind === 'character' && isContextualName(row.name) ? '' : normalizeName(row.name))
  const parent = rows.map((_, i) => i)
  const root = (i: number): number => parent[i] === i ? i : parent[i] = root(parent[i])
  const connect = (a: number, b: number) => { parent[root(b)] = root(a) }
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const a = normalizedNames[i], b = normalizedNames[j]
    if (a && b && (a === b || kind === 'character' && (a.includes(b) || b.includes(a)))) connect(i, j)
  }
  const groups = () => { const result = new Map<number, number[]>(); rows.forEach((_, i) => { const r = root(i); if (!result.has(r)) result.set(r, []); result.get(r)!.push(i) }); return [...result.values()] }
  const first = groups()
  const groupNames = first.map(indices => normalizeAliases(indices.flatMap(index => kind === 'character' ? characterMatchNames(rows[index]) : [rows[index].name, ...(rows[index].aliases ?? [])])))
  for (let i = 0; i < first.length; i++) for (let j = i + 1; j < first.length; j++) {
    if (normalizedAliasScore(groupNames[i], groupNames[j], 0.9) > 0.9) connect(first[i][0], first[j][0])
  }
  return groups().filter(group => group.length > 1).map(group => ({ id: `${kind}:${group.map(i => rows[i].id).join('|')}`, kind, memberIds: group.map(i => rows[i].id), reason: '名称或别名符合候选规则，请核对身份和来源后选择实际合并成员。' }))
}
