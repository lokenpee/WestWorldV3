export const substeps = ['worldAssets', 'narrativeAssets'] as const
export type Substep = typeof substeps[number]
export const stepLabels: Record<Substep, string> = { worldAssets: '人物与地点', narrativeAssets: '事件节点' }
export type ExtractedRow = Record<string, unknown> & { name: string; confidence: number }
export interface ExtractionData { characters?: ExtractedRow[]; locations?: ExtractedRow[]; nodes?: ExtractedRow[] }
