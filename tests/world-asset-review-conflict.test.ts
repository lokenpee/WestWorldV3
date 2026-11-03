import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createAssetService } from '../src/features/assets/service'
import { createModelService } from '../src/features/models/service'
import { defaultConfig } from '../src/features/models/types'
import { createWorldService } from '../src/features/world/service'
import { agentStream } from './support/agent-protocol'

const opened: ReturnType<typeof createWorkspace>[] = []
const text = '船夫沈青在码头收到顾衡的来信。'
afterEach(async () => {
  for (const workspace of opened.splice(0)) {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name)
  }
})

it('P3占用叙事资源时P2暂缓叙事项并保留待继续，已提交世界项不回滚', async () => {
  const prefix = `asset-review-conflict-${crypto.randomUUID()}`
  const workspace = createWorkspace({ settingsName: `${prefix}-settings`, bookPrefix: `${prefix}-book-` }); opened.push(workspace)
  await workspace.settings.books.put({ id: 'a', title: '冲突样本', sourceFileName: 'a.txt', createdAt: new Date().toISOString() })
  const db = workspace.openBook('a')
  await db.chapters.put({ bookId: 'a', chapterIndex: '1', chapterName: '第一章', order: 0, charCount: text.length })
  await db.table('chapterTexts').put({ bookId: 'a', chapterIndex: '1', text })
  await db.table('extractionReceipts').bulkPut(['worldAssets', 'narrativeAssets'].map(substep => ({ key: `1:${substep}`, bookId: 'a', chapterIndex: '1', substep, inputFingerprint: 'fixture', originIds: [], committedAt: new Date().toISOString(), runId: 'p1' })))
  const assets = createAssetService(workspace)
  await assets.create('a', 'character', { name: '沈青', chapterIndex: '1', identity: '船夫' })
  const node = await assets.create('a', 'node', { name: '收信', summary: '沈青收信', chapterIndex: '1', quote: '船夫沈青在码头收到顾衡的来信。' })
  await db.table('pipelineRuns').put({ id: 'lease:narrative', recordType: 'lease', bookId: 'a', lockKey: 'narrative', owner: 'p3-owner', runId: 'p3-run', expiresAt: Date.now() + 60000 })
  let attempted = false
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string)
    const users = body.messages.filter((row: { role: string }) => row.role === 'user').map((row: { content: string | { text: string }[] }) => typeof row.content === 'string' ? row.content : row.content.map((part: { text: string }) => part.text).join(''))
    const input = JSON.parse(users.find((value: string) => value.startsWith('{'))!)
    const replies = body.messages.filter((row: { role: string }) => row.role === 'tool').map((row: { content: string }) => { try { return JSON.parse(row.content) } catch { return {} } })
    if (input.phase === 'asset_review') {
      if (!replies.length) return agentStream([
        { name: 'get_character_detail', args: { ids: input.workItems.filter((item: { kind: string }) => item.kind === 'character').map((item: { id: string }) => item.id) } },
        { name: 'get_node_detail', args: { ids: input.workItems.filter((item: { kind: string }) => item.kind === 'node').map((item: { id: string }) => item.id) } },
        { name: 'read_original', args: { chapter_indices: ['1'] } },
      ])
      if (!attempted) {
        attempted = true
        return agentStream([{ name: 'edit_event_node', args: { operationKey: 'node-edit', id: node.id, expectedRevision: Number((await db.table('nodes').get(node.id)).revision), patch: { summary: '沈青收到顾衡来信' }, reason: '原文支持', evidence: [{ chapterIndex: '1', quote: '船夫沈青在码头收到顾衡的来信' }] } }])
      }
    }
    if (!replies.length) return agentStream([{ name: 'get_character_detail', args: { ids: input.workItems.map((item: { id: string }) => item.id) } }])
    return agentStream([{ name: 'submit_result', args: { status: 'completed', summary: '核对完成', commitIds: [], remainingWorkIds: [], reviewedItems: input.workItems.map((item: { workItemId: string }) => ({ workItemId: item.workItemId, outcome: 'no_change', reason: '核对' })) } }])
  })
  const models = createModelService(workspace, { fetch: fetcher })
  await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://asset-review-conflict.invalid/v1', aggregationContextWindow: 65536 }, 'fake-key')
  const world = createWorldService(workspace, models, assets)
  await world.start('a')
  const report = (await world.reports('a'))[0]
  expect(report.status).toBe('paused')
  expect(report.assetReview?.items.find(item => item.id === node.id)?.status).toBe('deferred')
  expect(await db.table('nodes').get(node.id)).toMatchObject({ summary: '沈青收信' })
  expect(await db.table('pipelineRuns').get('lease:narrative')).toMatchObject({ owner: 'p3-owner' })
}, 30000)
