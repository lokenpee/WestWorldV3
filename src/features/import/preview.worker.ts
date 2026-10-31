import { decodeNovel, splitChapters, type EncodingChoice } from './text'

self.onmessage = (event: MessageEvent<{ bytes: ArrayBuffer; encoding: EncodingChoice; pattern: string }>) => {
  try {
    const decoded = decodeNovel(event.data.bytes, event.data.encoding)
    self.postMessage({ ok: true, value: { ...decoded, chapters: splitChapters(decoded.text, event.data.pattern) } })
  } catch (error) {
    self.postMessage({ ok: false, message: error instanceof Error ? error.message : '分章失败，请检查文件和正则。' })
  }
}
