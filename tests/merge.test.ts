import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { Value } from 'typebox/value'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createAssetService } from '../src/features/assets/service'
import { formInput, formValues } from '../src/features/assets/form'

const opened: ReturnType<typeof createWorkspace>[] = []
async function setup() {
  const prefix = `merge-${crypto.randomUUID()}`
  const workspace = createWorkspace({ settingsName: `${prefix}-settings`, bookPrefix: `${prefix}-book-` })
  opened.push(workspace)
  await workspace.settings.books.put({ id: 'book', title: '合并测试', sourceFileName: '小说.txt', createdAt: '2026-10-25T00:00:00.000Z' })
  const service = createAssetService(workspace)
  const first = await service.create('book', 'character', { name: '张三', aliases: ['三哥'], manualSourceNote: '第一份资料', identity: '船夫；摆渡人', background: '住在河边', ageText: '年过三旬' })
  const keep = await service.create('book', 'character', { name: '张清', aliases: ['阿清'], manualSourceNote: '第二份资料', identity: '船夫', appearance: '青衣' })
  return { workspace, db: workspace.openBook('book'), service, first, keep }
}
afterEach(async () => {
  for (const workspace of opened.splice(0)) {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name)
  }
})

describe('人物地点批量合并', () => {
  it('预览不写入，主名和保留编号分别选择，资料精确去重', async () => {
    const { service, first, keep, db } = await setup()
    const preview = await service.previewMerge('book', 'character', { memberIds: [first.id, keep.id], keepId: keep.id, canonicalName: '新主名' })
    expect(preview.result).toMatchObject({ id: keep.id, name: '新主名', identity: '船夫；摆渡人', appearance: '青衣', background: '住在河边' })
    expect(preview.result.aliases).toEqual(expect.arrayContaining(['张三', '张清', '三哥', '阿清']))
    expect(await db.table('characters').count()).toBe(2)
    expect(await db.table('pipelineRuns').count()).toBe(0)
    expect((await service.read('book')).characters.find(person => person.id === keep.id)?.name).toBe('张清')
  })

  it('合并原子更新人物、历史映射、节点关联和持久报告', async () => {
    const { service, workspace, db, first, keep } = await setup()
    await db.chapters.put({ bookId: 'book', chapterIndex: '1', chapterName: '第一章', charCount: 12, order: 0 })
    await db.table('chapterTexts').put({ bookId: 'book', chapterIndex: '1', text: '张三和张清在码头见面。' })
    const other = await service.create('book', 'character', { name: '李四', manualSourceNote: '其他人物' })
    const node = await service.create('book', 'node', { name: '会面', summary: '人物会面', chapterIndex: '1', actors: ['张三', '李四', '张清'], targets: ['张三'] })
    const state = await service.read('book')
    await service.update('book', 'node', node.id, node.revision, formInput('node', formValues(node, state.characters), false))
    await db.table('assetLifecycle').put({ key: 'character:origin', bookId: 'book', kind: 'character', originId: 'origin', currentId: first.id, state: 'merged', revision: 1, updatedAt: new Date().toISOString() })
    await db.table('assetLifecycle').put({ key: 'character:older', bookId: 'book', kind: 'character', originId: 'older', currentId: 'origin', state: 'merged', revision: 1, updatedAt: new Date().toISOString() })
    const preview = await service.previewMerge('book', 'character', { memberIds: [first.id, keep.id], keepId: keep.id, canonicalName: '张清' })
    const result = await service.confirmMerge('book', 'character', preview.request)
    expect(result.asset).toMatchObject({ id: keep.id, name: '张清', manualKeep: true, nameSource: 'manual' })
    expect((await service.read('book')).nodes.find(row => row.id === node.id)).toMatchObject({ actors: ['张清', '李四'], actorIds: [keep.id, other.id], targetCharacterIds: [keep.id] })
    expect(await db.table('assetLifecycle').get('character:origin')).toMatchObject({ currentId: keep.id, state: 'merged' })
    expect(await db.table('assetLifecycle').get('character:older')).toMatchObject({ currentId: keep.id, state: 'merged' })
    expect(await db.table('assetLifecycle').get(`character:${first.id}`)).toMatchObject({ currentId: keep.id, state: 'merged' })
    expect(result.run.report.beforeCounts.characters).toBe(3)
    expect(result.run.report.afterCounts.characters).toBe(2)
    workspace.close()
    const reopened = createWorkspace(workspace.scope); opened.push(reopened)
    expect((await createAssetService(reopened).read('book')).manualMerges[0].id).toBe(result.run.id)
  })

  it('预览后资料变化时整组拒绝，刷新预览后可提交', async () => {
    const { service, db, first, keep } = await setup()
    const request = { memberIds: [first.id, keep.id], keepId: keep.id, canonicalName: '张清' }
    const preview = await service.previewMerge('book', 'character', request)
    await service.update('book', 'character', first.id, preview.request.expectedRevisions[first.id], { background: '新资料' })
    await expect(service.confirmMerge('book', 'character', preview.request)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await db.table('characters').count()).toBe(2)
    expect(await db.table('pipelineRuns').count()).toBe(0)
    const fresh = await service.previewMerge('book', 'character', request)
    expect((await service.confirmMerge('book', 'character', fresh.request)).asset.background).toContain('新资料')
  })

  it('非法选择、缺失条目、空主名和跨类型选择被拒绝', async () => {
    const { service, first, keep } = await setup()
    const location = await service.create('book', 'location', { name: '码头', manualSourceNote: '地点' })
    await expect(service.previewMerge('book', 'character', { memberIds: [first.id], keepId: first.id, canonicalName: '张三' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(service.previewMerge('book', 'character', { memberIds: [first.id, keep.id], keepId: 'missing', canonicalName: '张清' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(service.previewMerge('book', 'character', { memberIds: [first.id, keep.id], keepId: keep.id, canonicalName: ' ' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(service.previewMerge('book', 'character', { memberIds: [first.id, location.id], keepId: first.id, canonicalName: '张三' })).rejects.toMatchObject({ code: 'CONFLICT' })
    const preview = await service.previewMerge('book', 'character', { memberIds: [first.id, keep.id], keepId: keep.id, canonicalName: '张清' })
    await service.remove('book', 'character', first.id, preview.request.expectedRevisions[first.id])
    await expect(service.confirmMerge('book', 'character', preview.request)).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('地点合并保留描述来源；人物基础资料冲突可追查', async () => {
    const { service, db, first, keep } = await setup()
    await db.table('characters').update(first.id, { profile: { age: 35, gender: '男', ageText: '年过三旬' }, roleWeight: '重要配角', roleWeightSource: 'manual' })
    await db.table('characters').update(keep.id, { profile: { age: 36, gender: '男' } })
    const preview = await service.previewMerge('book', 'character', { memberIds: [first.id, keep.id], keepId: keep.id, canonicalName: '张清' })
    expect(preview.result.profile).toMatchObject({ age: 36, gender: '男', ageText: '年过三旬' })
    expect(preview.conflicts.join('')).toContain('年龄')
    const a = await service.create('book', 'location', { name: '码头', manualSourceNote: '来源甲', description: '临河；石阶' })
    const b = await service.create('book', 'location', { name: '青石码头', manualSourceNote: '来源乙', description: '石阶；渡船停泊处' })
    const proposed = await service.previewMerge('book', 'location', { memberIds: [a.id, b.id], keepId: b.id, canonicalName: '青石码头' })
    expect((await service.confirmMerge('book', 'location', proposed.request)).asset).toMatchObject({ description: '石阶；渡船停泊处；临河', aliases: ['码头'] })
  })

  it('世界锁与并发提交只允许一次合并；记录符合存储契约', async () => {
    const { service, db, first, keep } = await setup()
    const preview = await service.previewMerge('book', 'character', { memberIds: [first.id, keep.id], keepId: keep.id, canonicalName: '张清' })
    await db.table('pipelineRuns').put({ id: 'lease:world', recordType: 'lease', bookId: 'book', lockKey: 'world' })
    await expect(service.confirmMerge('book', 'character', preview.request)).rejects.toMatchObject({ code: 'ASSET_DOMAIN_LOCKED' })
    await db.table('pipelineRuns').delete('lease:world')
    const results = await Promise.allSettled([service.confirmMerge('book', 'character', preview.request), service.confirmMerge('book', 'character', preview.request)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const schema = JSON.parse(readFileSync(new URL('../docs/v2/resources/v2.2/storage.schema.json', import.meta.url), 'utf8'))
    for (const [table, name] of [['characters', 'StoredCharacter'], ['pipelineRuns', 'PipelineRun'], ['assetLifecycle', 'AssetLifecycle']]) for (const row of await db.table(table).toArray()) expect([...Value.Errors({ ...schema, $ref: `#/$defs/${name}` }, row)]).toEqual([])
  })

  it('报告写入失败时人物、映射和节点关联全部回滚', async () => {
    const { service, db, first, keep } = await setup()
    await db.chapters.put({ bookId: 'book', chapterIndex: '1', chapterName: '第一章', order: 0, charCount: 2 })
    await db.table('chapterTexts').put({ bookId: 'book', chapterIndex: '1', text: '会面' })
    const node = await service.create('book', 'node', { name: '会面', summary: '会面', chapterIndex: '1', actors: ['张三'] })
    const preview = await service.previewMerge('book', 'character', { memberIds: [first.id, keep.id], keepId: keep.id, canonicalName: '张清' })
    const failReport = (_key: unknown, row: { stage?: string }) => { if (row.stage === 'manual_merge') throw new Error('模拟报告保存失败') }
    db.table<{ stage?: string }>('pipelineRuns').hook('creating', failReport)
    try { await expect(service.confirmMerge('book', 'character', preview.request)).rejects.toThrow('模拟报告保存失败') }
    finally { db.table('pipelineRuns').hook('creating').unsubscribe(failReport) }
    expect(await db.table('characters').count()).toBe(2)
    expect(await db.table('assetLifecycle').get(`character:${first.id}`)).toMatchObject({ state: 'live', currentId: first.id })
    expect((await service.read('book')).nodes.find(row => row.id === node.id)?.actorIds).toEqual([first.id])
    expect(await db.table('pipelineRuns').count()).toBe(0)
  })

  it('未参与合并的同名人物及其节点关联保持原样', async () => {
    const { service, db, first, keep } = await setup()
    const outsider = await service.create('book', 'character', { name: '张三', manualSourceNote: '另一位同名人物' })
    await db.chapters.put({ bookId: 'book', chapterIndex: '1', chapterName: '第一章', order: 0, charCount: 2 })
    await db.table('chapterTexts').put({ bookId: 'book', chapterIndex: '1', text: '会面' })
    const node = await service.create('book', 'node', { name: '另一人的事件', summary: '事件', chapterIndex: '1', actors: ['张三'], actorIds: [outsider.id] })
    const preview = await service.previewMerge('book', 'character', { memberIds: [first.id, keep.id], keepId: keep.id, canonicalName: '张清' })
    await service.confirmMerge('book', 'character', preview.request)
    const mergedNode = (await service.read('book')).nodes.find(row => row.id === node.id)!
    expect([...(mergedNode.actorIds ?? [])].sort()).toEqual([keep.id, outsider.id].sort())
    expect([...mergedNode.actors].sort()).toEqual(['张三', '张清'].sort())
  })
})
