import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createAssetService } from '../src/features/assets/service'
import { createModelService } from '../src/features/models/service'
import { defaultConfig } from '../src/features/models/types'
import { createWorldService } from '../src/features/world/service'
import { agentStream } from './support/agent-protocol'
import reviewPrompt from '../docs/v2/resources/v2.2/prompts/active/p2-asset-review.md?raw'
import { summarySchema, validate } from '../src/features/agents/contracts'

const opened: ReturnType<typeof createWorkspace>[] = []
const text = '船夫张三是长女张蕾的父亲。李沁是张三的妻子。'
it('P2提示词声明的逐项结论均可通过共用总结Schema', () => {
  const outcomes = [...reviewPrompt.matchAll(/`(\w+)`（(?:无需修改|已修改|待继续)）/g)].map(match => match[1])
  expect(outcomes).toHaveLength(3)
  for (const outcome of outcomes) expect(() => validate(summarySchema, { status: 'completed', summary: '核对结果', commitIds: [], remainingWorkIds: [], reviewedItems: [{ workItemId: 'asset_review:fullBook:character:C1', outcome, reason: '依据原文核对' }] })).not.toThrow()
})
afterEach(async () => {
  for (const workspace of opened.splice(0)) {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name)
  }
})

it.each(['completed', 'partial', 'needs_review', 'paging'])('P2全资产核对与继续：%s', async mode => {
  const prefix = `asset-review-${crypto.randomUUID()}`
  const workspace = createWorkspace({ settingsName: `${prefix}-settings`, bookPrefix: `${prefix}-book-` }); opened.push(workspace)
  await workspace.settings.books.put({ id: 'a', title: '核对样本', sourceFileName: 'a.txt', createdAt: new Date().toISOString() })
  const db = workspace.openBook('a')
  await db.chapters.put({ bookId: 'a', chapterIndex: '1', chapterName: '第一章', order: 0, charCount: text.length })
  await db.table('chapterTexts').put({ bookId: 'a', chapterIndex: '1', text })
  await db.table('extractionReceipts').bulkPut(['worldAssets', 'narrativeAssets'].map(substep => ({ key: `1:${substep}`, bookId: 'a', chapterIndex: '1', substep, inputFingerprint: 'fixture', originIds: [], committedAt: new Date().toISOString(), runId: 'p1' })))
  const assets = createAssetService(workspace)
  const a = await assets.create('a', 'character', { name: '张三', chapterIndex: '1', identity: '船夫' })
  const b = await assets.create('a', 'character', { name: '张蕾', chapterIndex: '1', identity: '长女' })
  const place = await assets.create('a', 'location', { name: '北京城', chapterIndex: '1', description: '西门' })
  const node = await assets.create('a', 'node', { name: '会面', summary: '张三与张蕾会面', chapterIndex: '1', quote: '船夫张三是长女张蕾的父亲。' })
  await assets.create('a', 'eventLine', { title: '信件', nodeIds: [node.id] })
  if (mode === 'paging') for (let i = 0; i < 54; i++) await assets.create('a', 'node', { name: `核对节点${i}`, summary: `节点${i}`, chapterIndex: '1', quote: '船夫张三是长女张蕾的父亲。' })
  const characters = await db.table('characters').toArray()
  const lifecycle = await db.table('assetLifecycle').toArray()
  const { extractedRelation } = await import('../src/features/assets/relations')
  await db.table('characterRelations').put(extractedRelation(a, { target: '张蕾', relationType: 'parent_child', forwardLabel: '父亲', reverseLabel: '女儿', direction: 'directed', chapterIndex: '1', quote: '船夫张三是长女张蕾的父亲' }, characters as never, lifecycle as never))
  const edited: string[] = []
  let resumed = false
  const reviewBatches: { id: string; kind: string }[][] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string)
    const users = body.messages.filter((row: { role: string }) => row.role === 'user').map((row: { content: string | { text: string }[] }) => typeof row.content === 'string' ? row.content : row.content.map((part: { text: string }) => part.text).join(''))
    const input = JSON.parse(users.find((value: string) => value.startsWith('{'))!)
    const replies = body.messages.filter((row: { role: string }) => row.role === 'tool').map((row: { content: string }) => { try { return JSON.parse(row.content) } catch { return {} } })
    if (input.phase === 'asset_review') {
      if (!replies.length) reviewBatches.push(input.workItems)
      if (!replies.length) return agentStream([
        { name: 'get_character_detail', args: { ids: input.workItems.filter((item: { kind: string }) => item.kind === 'character').map((item: { id: string }) => item.id) } },
        { name: 'get_location_detail', args: { ids: input.workItems.filter((item: { kind: string }) => item.kind === 'location').map((item: { id: string }) => item.id) } },
        ...Array.from({ length: Math.ceil(input.workItems.filter((item: { kind: string }) => item.kind === 'node').length / 20) }, (_, page) => ({ name: 'get_node_detail', args: { ids: input.workItems.filter((item: { kind: string }) => item.kind === 'node').slice(page * 20, (page + 1) * 20).map((item: { id: string }) => item.id) } })),
        { name: 'get_event_line_detail', args: { ids: input.workItems.filter((item: { kind: string }) => item.kind === 'eventLine').map((item: { id: string }) => item.id) } },
        ...input.workItems.filter((item: { kind: string }) => item.kind === 'relation').map((item: { fromId: string; toId: string }) => ({ name: 'get_character_relation', args: { fromId: item.fromId, toId: item.toId } })),
        { name: 'read_original', args: { chapter_indices: ['1'] } },
      ])
      const commit = replies.find((row: { ok?: boolean; commitId?: string }) => row.ok && row.commitId)
      if (!commit && !edited.length) {
        edited.push(a.id)
        return agentStream([{ name: 'edit_character', args: { operationKey: 'review-edit-1', id: a.id, expectedRevision: 1, patch: { identity: '船夫（原文核对）' }, reason: '原文明确张三是船夫', evidence: [{ chapterIndex: '1', quote: '船夫张三是长女张蕾的父亲' }] } }])
      }
      const partial = mode === 'partial' && !resumed
      return agentStream([{ name: 'submit_result', args: { status: partial ? 'partial' : 'completed', summary: '全资产核对结果', commitIds: commit ? [commit.commitId] : [], remainingWorkIds: partial ? input.workItems.filter((item: { kind: string }) => item.kind === 'location').map((item: { workItemId: string }) => item.workItemId) : [], reviewedItems: input.workItems.filter((item: { kind: string }) => !partial || item.kind !== 'location').map((item: { workItemId: string; kind: string; id: string }) => ({ workItemId: item.workItemId, outcome: item.kind === 'location' && mode === 'needs_review' && !resumed ? 'needs_review' : item.kind === 'character' && item.id === a.id ? 'changed' : 'no_change', reason: '依据原文核对' })) } }])
    }
    if (!replies.length) return agentStream([{ name: 'get_character_detail', args: { ids: input.workItems.filter((item: { kind: string }) => item.kind === 'character').map((item: { id: string }) => item.id) } }, { name: 'get_location_detail', args: { ids: input.workItems.filter((item: { kind: string }) => item.kind === 'location').map((item: { id: string }) => item.id) } }])
    return agentStream([{ name: 'submit_result', args: { status: 'completed', summary: '身份已核对', commitIds: [], remainingWorkIds: [], reviewedItems: input.workItems.map((item: { workItemId: string }) => ({ workItemId: item.workItemId, outcome: 'no_change', reason: '无需合并' })) } }])
  })
  const models = createModelService(workspace, { fetch: fetcher })
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://asset-review.invalid/v1', aggregationContextWindow: 65536 }, 'fake-key')
  const world = createWorldService(workspace, models, assets)
  await world.start('a')
  expect(world.state('a')?.error).toBeUndefined()
  const report = (await world.reports('a'))[0]
  const incomplete = mode === 'partial' || mode === 'needs_review'
  expect(report.status).toBe(incomplete ? 'paused' : 'completed')
  expect(report.coverage).toMatchObject({ total: 3, checked: 3, pendingIds: [] })
  expect(report.assetReview?.items.length).toBeGreaterThanOrEqual(5)
  expect(report.assetReview?.items.filter(item => item.status !== 'checked').map(item => item.id)).toEqual(incomplete ? [place.id] : [])
  expect(report.report.assetEdits).toEqual([expect.objectContaining({ tool: 'edit_character', id: a.id, actor: 'agent' })])
  expect(await db.table('characters').get(a.id)).toMatchObject({ identity: '船夫（原文核对）', revision: 2 })
  expect(await db.table('characters').get(b.id)).toMatchObject({ identity: '长女' })
  expect(await db.table('locations').get(place.id)).toMatchObject({ description: '西门' })
  if (mode === 'paging') {
    expect(reviewBatches.map(batch => batch.length)).toEqual([50, 10])
    expect(new Set(reviewBatches.flat().map(item => `${item.kind}:${item.id}`)).size).toBe(60)
  }
  if (incomplete) {
    expect(report.assetReview?.items.find(item => item.id === place.id)?.status).toBe('deferred')
    resumed = true
    reviewBatches.length = 0
    await world.start('a')
    expect((await world.reports('a'))[0].status).toBe('completed')
    expect(reviewBatches.flat().map(item => item.id)).toEqual([place.id])
    expect((await world.reports('a'))[0].report.assetEdits).toHaveLength(1)
  }
}, 30000)
