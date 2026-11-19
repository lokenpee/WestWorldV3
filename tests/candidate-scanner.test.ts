import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, test, vi } from 'vitest'
import { findCandidates } from '../src/features/world/candidates'
import { findCandidates as before, aliasScore as beforeScore } from './fixtures/candidates-before-opt20'
import { aliasScore } from '../src/features/world/candidates'
import { scanCandidateRows, type ScanRequest, type ScanResponse } from '../src/features/world/candidateScanner'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createAssetService } from '../src/features/assets/service'
import { createModelService } from '../src/features/models/service'
import { createWorldService } from '../src/features/world/service'
import type { Character } from '../src/features/assets/types'

const person = (id: string, name: string, aliases: string[] = []): Character => ({ id, name, aliases, bookId: 'book', revision: 1, createdBy: 'P1', confidence: 1 })
const input = { characters: [person('A', '沈青', ['沈公子']), person('B', '沈青旧档', ['沈公子'])], locations: [] }
const opened: ReturnType<typeof createWorkspace>[] = []
class FakeWorker {
  static instances: FakeWorker[] = []
  request!: ScanRequest
  onmessage?: (event: MessageEvent<ScanResponse>) => void
  onerror?: () => void
  onmessageerror?: () => void
  terminated = false
  constructor() { FakeWorker.instances.push(this) }
  postMessage(request: ScanRequest) { this.request = request }
  terminate() { this.terminated = true }
  reply(patch: Partial<ScanResponse> = {}) { this.onmessage?.({ data: { bookId: this.request.bookId, requestId: this.request.requestId, ok: true, candidates: findCandidates('character', this.request.input.characters), ...patch } } as MessageEvent<ScanResponse>) }
}
afterEach(async () => {
  vi.unstubAllGlobals(); FakeWorker.instances = []
  for (const workspace of opened.splice(0)) {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name)
  }
})

test('固定种子400个目录与旧算法候选、理由及分数完全相等', () => {
  let seed = 123456
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n }
  const names = ['沈青', '沈青旧档', '北静王', '水溶', '王爷', '太后', '林姑父', '顾衡', '长安侯府', '如意郎君', 'A（旧档）', 'A ', '甲', '乙', '东院', '王府', '北静王爷', '甲😀', '甲😃', '', '　姓名']
  for (let run = 0; run < 200; run++) {
    const rows = Array.from({ length: random(30) }, (_, i) => person(String(i), names[random(names.length)], Array.from({ length: random(8) }, () => names[random(names.length)])))
    for (const kind of ['character', 'location'] as const) expect(findCandidates(kind, rows)).toEqual(before(kind, rows))
    const a = rows[0]?.aliases ?? [], b = rows[1]?.aliases ?? []
    expect(aliasScore(a, b)).toBe(beforeScore(a, b))
  }
})
test('Worker只收到名称字段，忽略其他书和旧请求，成功后释放', async () => {
  vi.stubGlobal('Worker', FakeWorker)
  const result = scanCandidateRows('book', input, new AbortController().signal)
  const worker = FakeWorker.instances[0]
  expect(Object.keys(worker.request.input.characters[0]).sort()).toEqual(['aliases', 'id', 'name'])
  worker.reply({ bookId: 'other' }); worker.reply({ requestId: 'old' })
  expect(worker.terminated).toBe(false)
  worker.reply()
  expect(await result).toEqual(findCandidates('character', input.characters))
  expect(worker.terminated).toBe(true)
})
test('取消终止线程，迟到消息无效，后一次扫描仍可完成', async () => {
  vi.stubGlobal('Worker', FakeWorker)
  const controller = new AbortController()
  const result = scanCandidateRows('book', input, controller.signal)
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort(); FakeWorker.instances[0].reply(); await rejected
  expect(FakeWorker.instances[0].terminated).toBe(true)
  const next = scanCandidateRows('book', input, new AbortController().signal)
  FakeWorker.instances[1].reply(); expect(await next).toHaveLength(1)
})
test('启动失败、线程错误及结果解码错误都释放并可重试', async () => {
  vi.stubGlobal('Worker', class { constructor() { throw new Error('启动失败') } })
  await expect(scanCandidateRows('book', input, new AbortController().signal)).rejects.toThrow('启动失败')
  vi.stubGlobal('Worker', FakeWorker)
  for (const fail of ['onerror', 'onmessageerror'] as const) {
    const request = scanCandidateRows('book', input, new AbortController().signal)
    const worker = FakeWorker.instances.at(-1)!
    const rejected = expect(request).rejects.toThrow('请重新扫描')
    worker[fail]!(); await rejected; expect(worker.terminated).toBe(true)
  }
})
async function setup() {
  const prefix = `candidate-${crypto.randomUUID()}`
  const workspace = createWorkspace({ settingsName: prefix, bookPrefix: prefix + '-' }); opened.push(workspace)
  await workspace.settings.books.put({ id: 'book', title: '测试', sourceFileName: 'test.txt', createdAt: '2026-11-19' })
  const db = workspace.openBook('book')
  await db.chapters.put({ bookId: 'book', chapterIndex: '1', chapterName: '第一章', order: 0, charCount: 1 })
  for (const substep of ['worldAssets', 'narrativeAssets']) await db.table('extractionReceipts').put({ key: `1:${substep}`, bookId: 'book', chapterIndex: '1', substep })
  await db.table('characters').bulkPut(input.characters)
  return { db, service: createWorldService(workspace, createModelService(workspace), createAssetService(workspace)) }
}
test('服务取消及新请求替代旧请求均不保存旧报告', async () => {
  vi.stubGlobal('Worker', FakeWorker)
  const { db, service } = await setup()
  const first = service.scan('book'); const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1))
  const second = service.scan('book')
  await rejected; await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(2))
  FakeWorker.instances[0].reply(); FakeWorker.instances[1].reply()
  expect(await second).toHaveLength(1)
  expect(await db.table('pipelineRuns').count()).toBe(1)
  const third = service.scan('book'); const cancelled = expect(third).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(3))
  service.cancelScan('book'); await cancelled
  expect(await db.table('pipelineRuns').count()).toBe(1)
})
test('计算期间名称变化拒绝过期结果；仅无关资料变化允许完成', async () => {
  vi.stubGlobal('Worker', FakeWorker)
  const { db, service } = await setup()
  const first = service.scan('book'); const rejected = expect(first).rejects.toThrow('名称已变化')
  await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1))
  await db.table('characters').update('A', { name: '另一人', revision: 2 })
  FakeWorker.instances[0].reply(); await rejected
  expect(await db.table('pipelineRuns').count()).toBe(0)
  const second = service.scan('book')
  await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(2))
  await db.table('characters').update('A', { background: '仅资料变化', revision: 3 })
  FakeWorker.instances[1].reply(); await second
  expect(await db.table('pipelineRuns').count()).toBe(1)
})
