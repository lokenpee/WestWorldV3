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
  const namesOf = (row: Character | LocationAsset) => kind === 'character'
    ? characterMatchNames(row)
    : [row.name, ...(row.aliases ?? [])].map(name => name.trim()).filter(Boolean)
  const normalizedNameSets = rows.map(row => new Set(namesOf(row).map(normalizeName).filter(Boolean)))
  const parent = rows.map((_, i) => i)
  const root = (i: number): number => parent[i] === i ? i : parent[i] = root(parent[i])
  const edges = new Map<string, Set<string>>()
  const pairKey = (a: number, b: number) => a < b ? `${a}|${b}` : `${b}|${a}`
  const addEdge = (a: number, b: number, reason: string) => {
    if (a === b) return
    parent[root(b)] = root(a)
    const key = pairKey(a, b)
    if (!edges.has(key)) edges.set(key, new Set())
    edges.get(key)!.add(reason)
  }
  // O1：原有主名相同或人物主名包含，保持原两两比较范围。
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const a = normalizedNames[i], b = normalizedNames[j]
    if (!a || !b) continue
    if (a === b) addEdge(i, j, '主名相同')
    else if (kind === 'character' && (a.includes(b) || b.includes(a))) addEdge(i, j, '主名包含')
  }
  const groups = () => { const result = new Map<number, number[]>(); rows.forEach((_, i) => { const r = root(i); if (!result.has(r)) result.set(r, []); result.get(r)!.push(i) }); return [...result.values()] }
  const matching = parameters.candidateMatching
  const strongNames = new Set(normalizedNames.filter(Boolean))
  const isStrong = (name: string) => name.length >= matching.distinctiveNameMinLength || strongNames.has(name)
  // O2：原有首轮分组后的整组别名相似度，保持对全部分组的比较；整组都是短泛称时不连接。
  const first = groups()
  const groupNames = first.map(indices => normalizeAliases(indices.flatMap(index => kind === 'character' ? characterMatchNames(rows[index]) : [rows[index].name, ...(rows[index].aliases ?? [])])))
  for (let i = 0; i < first.length; i++) for (let j = i + 1; j < first.length; j++) {
    if (normalizedAliasScore(groupNames[i], groupNames[j], 0.9) > 0.9 && (groupNames[i].some(isStrong) || groupNames[j].some(isStrong))) addEdge(first[i][0], first[j][0], '整组别名相似度大于0.9')
  }
  // 新增规则只使用称呼索引生成记录对，不改变 O1/O2 的输入。
  const index = new Map<string, number[]>()
  for (const [at, names] of normalizedNameSets.entries()) for (const name of names) {
    if (!index.has(name)) index.set(name, [])
    index.get(name)!.push(at)
  }
  // R1：主名与任意称呼精确相同。
  for (let at = 0; at < rows.length; at++) {
    const main = normalizedNames[at]
    if (!main) continue
    for (const other of index.get(main) ?? []) if (other !== at) addEdge(at, other, '主名与别名相同')
  }
  const rareDistinctive = (name: string) => name.length >= matching.distinctiveNameMinLength && (index.get(name)?.length ?? 0) <= matching.rareNameMaxRecords
  const strongShared = (name: string) => name.length >= matching.distinctiveNameMinLength
  // R3：稀有共享称呼。
  for (const [name, hits] of index) if (hits.length > 1 && rareDistinctive(name)) {
    for (let i = 0; i < hits.length; i++) for (let j = i + 1; j < hits.length; j++) addEdge(hits[i], hits[j], `共享稀有称呼：${name}`)
  }
  // R2：共享称呼重叠系数，至少一个有区分度称呼。
  const sharedByPair = new Map<string, string[]>()
  for (const [name, hits] of index) {
    if (hits.length < 2) continue
    for (let i = 0; i < hits.length; i++) for (let j = i + 1; j < hits.length; j++) {
      const key = pairKey(hits[i], hits[j])
      if (!sharedByPair.has(key)) sharedByPair.set(key, [])
      sharedByPair.get(key)!.push(name)
    }
  }
  for (const [key, shared] of sharedByPair) {
    if (shared.length < matching.minimumSharedNames || !shared.some(strongShared)) continue
    const [i, j] = key.split('|').map(Number)
    const smaller = Math.min(normalizedNameSets[i].size, normalizedNameSets[j].size)
    if (!smaller) continue
    const overlap = shared.length / smaller
    if (overlap > matching.overlapThreshold) addEdge(i, j, `称呼重叠 ${shared.length}/${smaller}`)
  }
  return groups().filter(group => group.length > 1).map(group => {
    const reasons = new Set<string>()
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) for (const reason of edges.get(pairKey(group[i], group[j])) ?? []) reasons.add(reason)
    const detail = reasons.size ? `命中：${[...reasons].join('；')}。` : '传递分组。'
    return { id: `${kind}:${group.map(i => rows[i].id).join('|')}`, kind, memberIds: group.map(i => rows[i].id), reason: `名称或别名符合候选规则。${detail}请核对身份和来源后选择实际合并成员。` }
  })
}
