// Logical addresses only: callers cannot choose files or SQL.
export const settingsSchema = { books: 'id', appSettings: 'key', credentials: 'providerId' } as const
export const bookSchema = {
  chapters: 'chapterIndex', chapterTexts: 'chapterIndex', characters: 'id', locations: 'id', nodes: 'id', eventLines: 'id',
  compileProgress: 'stage', storyEditorMemory: 'id', storyEditorNotes: 'id', storyEditorCheckpoints: 'id',
  storySessions: 'id', storySessionEntries: 'id', extractionReceipts: 'key', assetLifecycle: 'key', pipelineRuns: 'id',
  characterRelations: 'id', characterRelationEdits: 'pairKey', legacyRelationRecords: 'id',
} as const
export type QueryValue = string | number | Array<string | number>
export interface RecordQuery {
  index?: string; operator?: 'equals' | 'anyOf' | 'noneOf' | 'startsWith'; values?: QueryValue[]
  reverse?: boolean; offset?: number; limit?: number; keysOnly?: boolean
}
export const schemaFor = (scope: string): Record<string, string> => scope === 'settings' ? settingsSchema : bookSchema
export function assertAddress(scope: string, table: string) {
  if (scope !== 'settings' && !/^book:.{1,200}$/.test(scope)) throw new Error('无效书库存储范围。')
  if (!Object.hasOwn(schemaFor(scope), table)) throw new Error('无效存储表。')
}
export function indexValue(row: Record<string, unknown>, key: string, index?: string): unknown {
  if (!index || index === ':id') return key
  if (index.startsWith('[')) return index.slice(1, -1).split('+').map(field => row[field])
  return row[index]
}
export function matches(value: unknown, query: RecordQuery) {
  if (!query.operator) return true
  const found = (query.values ?? []).some(item => JSON.stringify(item) === JSON.stringify(value))
  return query.operator === 'startsWith' ? typeof value === 'string' && value.startsWith(String(query.values?.[0] ?? '')) : query.operator === 'noneOf' ? !found : found
}
