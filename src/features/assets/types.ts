export type AssetKind = 'character' | 'location' | 'node' | 'eventLine'
export type RoleWeight = '主要人物' | '重要配角' | 'NPC' | '路人'
export const assetLabels: Record<AssetKind, string> = { character: '人物', location: '地点', node: '事件节点', eventLine: '事件线' }
export const assetTables = { character: 'characters', location: 'locations', node: 'nodes', eventLine: 'eventLines' } as const
export const roleWeights: RoleWeight[] = ['主要人物', '重要配角', 'NPC', '路人']

interface BaseAsset { id: string; bookId: string; revision: number; createdBy: 'P1' | 'P2' | 'P3' | 'manual' }
export interface Fact { id: string; field: string; text: string; chapters: string[] }
export interface Frequency { chapters: number; mentions: number; scopeChapters: number; percentile: number }
interface WorldAsset extends BaseAsset {
  name: string; aliases?: string[]; confidence: number; chapterIndex?: string; chapterName?: string
  verifiedAliases?: string[]
  sourceChapters?: string[]; manualSourceNote?: string; nameSource?: 'extracted' | 'automatic' | 'manual'; manualKeep?: boolean
  updatedAt?: string; mergeFacts?: Fact[]; mergeNotes?: string[]; optimizedFactIds?: string[]; optimizationFingerprint?: string; frequency?: Frequency
}
export interface Character extends WorldAsset {
  identity?: string; appearance?: string; personality?: string; background?: string; speechStyleSample?: string
  profile?: { age?: number; gender?: string; ageText?: string }
  roleWeight?: RoleWeight; roleWeightSource?: 'frequency' | 'manual'
  relations?: { target: string; relation_type: string; relation_label?: string; direction?: string }[]
}
export interface LocationAsset extends WorldAsset { description?: string }
export interface EventNode extends BaseAsset {
  name: string; summary: string; process?: string; chapterIndex: string; chapterName: string; quote: string; offset?: number
  order: number; actors: string[]; targets?: string[]; eventLineIds?: string[]; confidence: number
  actorIds?: string[]; targetCharacterIds?: string[]; quoteStatus?: 'matched' | 'unmatched' | 'empty'
  world_delta?: string[]; new_facts?: string[]; started_actions?: string[]; time_text?: string; time_hint?: string
  timeCoord?: string; timePrecision?: string
}
export interface EventLine extends BaseAsset {
  title: string; nodeIds: string[]; chapters: string[]; cause: string; process: string; result: string
  lineStatus: 'open' | 'closed'; updatedAt: string; timeRange?: string[]
}
export interface AssetByKind { character: Character; location: LocationAsset; node: EventNode; eventLine: EventLine }
export type Asset = AssetByKind[AssetKind]
export interface Lifecycle {
  key: string; bookId: string; kind: AssetKind; originId: string; currentId?: string
  state: 'live' | 'merged' | 'deleted'; revision: number; updatedAt: string
}
export interface AssetInput {
  name?: string; title?: string; aliases?: string[]; chapterIndex?: string; manualSourceNote?: string
  identity?: string; ageText?: string; appearance?: string; personality?: string; background?: string; speechStyleSample?: string
  roleWeight?: RoleWeight; description?: string; summary?: string; process?: string; quote?: string
  actors?: string[]; targets?: string[]; time_text?: string; time_hint?: string; world_delta?: string[]; new_facts?: string[]; started_actions?: string[]
  actorIds?: string[]; targetCharacterIds?: string[]
  participantIds?: string[]; unlinkedParticipants?: string[]
  nodeIds?: string[]; cause?: string; result?: string; lineStatus?: 'open' | 'closed'
}
export interface References { actorIds: string[]; ambiguities: { name: string; candidateIds: string[] }[]; missingNames: string[] }
export interface AssetSnapshot {
  characters: Character[]; locations: LocationAsset[]; nodes: EventNode[]; eventLines: EventLine[]
  lifecycle: Lifecycle[]; locks: { world: boolean; narrative: boolean }; references: Record<string, References>; lineCharacterIds: Record<string, string[]>
  manualMerges: import('./merge').ManualMergeRun[]
}
export class AssetError extends Error {
  readonly code: 'VALIDATION' | 'CONFLICT' | 'NOT_FOUND' | 'ASSET_DOMAIN_LOCKED' | 'SOURCE_MISSING'
  readonly field?: keyof AssetInput
  constructor(code: AssetError['code'], message: string, field?: keyof AssetInput) { super(message); this.name = 'AssetError'; this.code = code; this.field = field }
}
export const assetName = (asset: Asset) => 'title' in asset ? asset.title : asset.name
