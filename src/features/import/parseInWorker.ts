import type { ParseNovel } from './previewLoader'
import type { ParsedNovel } from './text'

export const parseInWorker: ParseNovel = (bytes, encoding, pattern, signal) => new Promise((resolve, reject) => {
  signal.throwIfAborted()
  const worker = new Worker(new URL('./preview.worker.ts', import.meta.url), { type: 'module' })
  const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); worker.terminate() }
  const abort = () => { finish(); reject(new DOMException('预览已取消', 'AbortError')) }
  // User regex runs off the UI thread; a pathological expression can be stopped.
  const timer = setTimeout(() => { finish(); reject(new Error('分章处理耗时过长，请简化正则或减小文件后重试。')) }, 10000)
  worker.onmessage = (event: MessageEvent<{ ok: true; value: ParsedNovel } | { ok: false; message: string }>) => {
    finish()
    if (event.data.ok) resolve(event.data.value)
    else reject(new Error(event.data.message))
  }
  worker.onerror = () => { finish(); reject(new Error('无法运行分章处理，请刷新后重试。')) }
  signal.addEventListener('abort', abort, { once: true })
  worker.postMessage({ bytes, encoding, pattern }, [bytes])
})
