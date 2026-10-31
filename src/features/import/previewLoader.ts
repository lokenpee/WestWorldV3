import { validateFiles, type EncodingChoice, type NovelPreview, type ParsedNovel } from './text'

export type PickedFile = Pick<File, 'name' | 'size' | 'arrayBuffer'>
export type ParseNovel = (bytes: ArrayBuffer, encoding: EncodingChoice, pattern: string, signal: AbortSignal) => Promise<ParsedNovel>

export class PreviewLoader {
  private generation = 0
  private controller?: AbortController
  private readonly parse: ParseNovel

  constructor(parse: ParseNovel) { this.parse = parse }

  reset() { this.generation += 1; this.controller?.abort() }

  async load(files: readonly PickedFile[], encoding: EncodingChoice, pattern: string): Promise<NovelPreview | null> {
    this.reset()
    const generation = this.generation
    const controller = new AbortController()
    this.controller = controller
    try {
      validateFiles(files)
      const file = files[0]
      const bytes = await file.arrayBuffer()
      const byteLength = bytes.byteLength
      if (generation !== this.generation) return null
      const parsed = await this.parse(bytes, encoding, pattern, controller.signal)
      return generation === this.generation ? { ...parsed, fileName: file.name, byteLength, pattern } : null
    } catch (error) {
      if (generation !== this.generation) return null
      throw error
    }
  }
}
