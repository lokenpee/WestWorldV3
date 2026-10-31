import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Value } from 'typebox/value'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createAssetService } from '../src/features/assets/service'
import { remapCharacterLinks } from '../src/features/assets/characterLinks'
import { formInput, formValues } from '../src/features/assets/form'

const workspaces: ReturnType<typeof createWorkspace>[] = []
async function setup() {
  const prefix = `assets-${crypto.randomUUID()}`
  const workspace = createWorkspace({ settingsName: `${prefix}-settings`, bookPrefix: `${prefix}-book-` })
  workspaces.push(workspace)
  await workspace.settings.books.bulkPut(['a', 'b'].map(id => ({ id, title: id, sourceFileName: `${id}.txt`, createdAt: '2026-10-25T00:00:00.000Z' })))
  const db = workspace.openBook('a')
  await db.chapters.bulkPut([
    { bookId: 'a', chapterIndex: '1', chapterName: '第一章', order: 0, charCount: 15 },
    { bookId: 'a', chapterIndex: '2', chapterName: '第二章', order: 1, charCount: 15 },
  ])
  await db.table('chapterTexts').bulkPut([
    { bookId: 'a', chapterIndex: '1', text: '沈青收到信。沈青把信交给掌柜。' },
    { bookId: 'a', chapterIndex: '2', text: '掌柜将信归还顾衡。顾衡道谢。' },
  ])
  return { workspace, db, service: createAssetService(workspace) }
}
afterEach(async () => {
  for (const workspace of workspaces.splice(0)) {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name)
  }
})

describe('资产人工维护', () => {
  it('统一人物表单保留两类归属、旧对象及事件字段，重复保存后可移除两类关联', async () => {
    const { service, db } = await setup()
    const actor = await service.create('a', 'character', { name: '沈青', aliases: ['老沈'], chapterIndex: '1' })
    const target = await service.create('a', 'character', { name: '顾衡', chapterIndex: '2' })
    const node = await service.create('a', 'node', { name: '交信', summary: '交信', chapterIndex: '1', quote: '沈青收到信。', process: '老沈交出密信。', actors: ['老沈'], targets: ['顾衡', '沈青', '密信', '码头'], world_delta: ['信件易主'], new_facts: ['落款是顾衡'], started_actions: ['沈青开始调查'], time_text: '清晨', time_hint: '翌日' })
    const line = await service.create('a', 'eventLine', { title: '书信', nodeIds: [node.id] })
    let state = await service.read('a')
    const values = formValues(state.nodes[0], state.characters)
    expect(values.participantIds.split('\n')).toEqual([actor.id, target.id])
    expect(formValues(state.nodes[0], []).participantIds.split('\n')).toEqual([actor.id, target.id])
    expect(values.unlinkedParticipants).toBe('')
    expect(values.process).toBe('老沈交出密信。\n涉及对象：密信、码头')
    let saved = await service.update('a', 'node', node.id, state.nodes[0].revision, formInput('node', values, false))
    expect(saved).toMatchObject({ actors: ['沈青'], actorIds: [actor.id], targets: ['顾衡', '沈青', '密信', '码头'], targetCharacterIds: [target.id, actor.id], quote: node.quote, new_facts: node.new_facts, world_delta: node.world_delta, started_actions: node.started_actions, time_text: '清晨', time_hint: '翌日' })
    saved = await service.update('a', 'node', node.id, saved.revision, formInput('node', formValues(saved, state.characters), false))
    expect(saved.process).toBe(values.process)
    const removed = formValues(saved, state.characters)
    removed.participantIds = target.id
    saved = await service.update('a', 'node', node.id, saved.revision, formInput('node', removed, false))
    expect(saved).toMatchObject({ actors: [], actorIds: [], targets: ['顾衡', '密信', '码头'], targetCharacterIds: [target.id] })
    state = await service.read('a')
    expect(state.lineCharacterIds[line.id]).toEqual([target.id])
    expect(await db.table('nodes').get(node.id)).not.toHaveProperty('participantIds')
    expect(await db.table('nodes').get(node.id)).not.toHaveProperty('unlinkedParticipants')
    expect(await db.table('chapterTexts').get('1')).toMatchObject({ text: '沈青收到信。沈青把信交给掌柜。' })
  })

  it('统一选择保存同名待确认称呼，确认身份、改名和删除后事件线同步', async () => {
    const { service } = await setup()
    const actor = await service.create('a', 'character', { name: '顾衡', chapterIndex: '1' })
    const first = await service.create('a', 'character', { name: '沈青', identity: '船夫', chapterIndex: '1' })
    const other = await service.create('a', 'character', { name: '沈青', identity: '药师', chapterIndex: '1' })
    let node = await service.create('a', 'node', { name: '会面', summary: '人物会面', chapterIndex: '1', participantIds: [actor.id], unlinkedParticipants: ['沈青', '来客'] })
    expect(node).toMatchObject({ actorIds: [actor.id], actors: ['顾衡', '沈青', '来客'] })
    const line = await service.create('a', 'eventLine', { title: '会面', nodeIds: [node.id] })
    let state = await service.read('a')
    node = state.nodes[0]
    expect(state.references[node.id].ambiguities).toHaveLength(1)
    expect(formValues(node, state.characters).unlinkedParticipants).toBe('沈青\n来客')
    node = await service.update('a', 'node', node.id, node.revision, { participantIds: [actor.id, first.id], unlinkedParticipants: ['来客'] })
    expect(node.actorIds).toEqual([actor.id, first.id])
    state = await service.read('a')
    await service.update('a', 'character', other.id, state.characters.find(row => row.id === other.id)!.revision, { name: '药师沈青' })
    state = await service.read('a')
    await service.update('a', 'character', first.id, state.characters.find(row => row.id === first.id)!.revision, { name: '船夫沈青' })
    state = await service.read('a')
    expect(state.nodes[0].actors).toEqual(['顾衡', '船夫沈青', '来客'])
    expect(state.lineCharacterIds[line.id]).toEqual([actor.id, first.id])
    await service.remove('a', 'character', first.id, state.characters.find(row => row.id === first.id)!.revision)
    state = await service.read('a')
    expect(state.nodes[0].actors).toEqual(['顾衡', '来客'])
    expect(state.lineCharacterIds[line.id]).toEqual([actor.id])
    const visitor = await service.create('a', 'character', { name: '来客', chapterIndex: '1' })
    state = await service.read('a')
    expect(state.lineCharacterIds[line.id]).toEqual([actor.id, visitor.id])
    node = state.nodes[0]
    await service.update('a', 'node', node.id, node.revision, { participantIds: [], unlinkedParticipants: [] })
    expect((await service.read('a')).lineCharacterIds[line.id]).toEqual([])
  })

  it('无编号的旧节点按别名恢复对象人物，选择同名的不同人物仍保存各自编号', async () => {
    const { service, db } = await setup()
    const first = await service.create('a', 'character', { name: '沈青', aliases: ['船夫'], chapterIndex: '1' })
    const other = await service.create('a', 'character', { name: '沈青', chapterIndex: '1' })
    const node = await service.create('a', 'node', { name: '交信', summary: '交信', chapterIndex: '1', actors: [], targets: ['船夫', '信'] })
    const legacy = { ...node }
    legacy.targets = ['船夫', '信']
    delete legacy.actorIds; delete legacy.targetCharacterIds
    await db.table('nodes').put(legacy)
    const state = await service.read('a')
    const values = formValues(state.nodes[0], state.characters)
    expect(values.participantIds).toBe(first.id)
    values.participantIds += `\n${other.id}`
    const saved = await service.update('a', 'node', node.id, state.nodes[0].revision, formInput('node', values, false))
    expect(saved).toMatchObject({ actorIds: [other.id], targetCharacterIds: [first.id], targets: ['沈青', '信'], process: '涉及对象：信' })
    expect(formValues(saved, state.characters).participantIds.split('\n').sort()).toEqual([first.id, other.id].sort())
  })

  it('统一选择拒绝失效人物和域锁，唯一别名自动关联，暂存称呼可移除', async () => {
    const { service, db } = await setup()
    const person = await service.create('a', 'character', { name: '沈青', aliases: ['老沈'], chapterIndex: '1' })
    let node = await service.create('a', 'node', { name: '收信', summary: '收信', chapterIndex: '1', participantIds: [], unlinkedParticipants: ['老沈', '旅人'] })
    expect(node).toMatchObject({ actorIds: [person.id], actors: ['沈青', '旅人'] })
    await expect(service.update('a', 'node', node.id, node.revision, { participantIds: ['missing'] })).rejects.toMatchObject({ code: 'VALIDATION', field: 'participantIds' })
    expect((await service.read('a')).nodes[0].revision).toBe(node.revision)
    node = await service.update('a', 'node', node.id, node.revision, { unlinkedParticipants: [] })
    expect(node.actors).toEqual(['沈青'])
    await db.table('pipelineRuns').put({ id: 'lease:narrative', recordType: 'lease', bookId: 'a', lockKey: 'narrative' })
    await expect(service.update('a', 'node', node.id, node.revision, { participantIds: [], unlinkedParticipants: [] })).rejects.toMatchObject({ code: 'ASSET_DOMAIN_LOCKED' })
    expect((await service.read('a')).nodes[0].actors).toEqual(['沈青'])
  })

  it('人物和地点保存后可重读；无章来源须说明；另一本书保持独立', async () => {
    const { service, db } = await setup()
    await expect(service.create('a', 'character', { name: '沈青' })).rejects.toMatchObject({ code: 'VALIDATION', field: 'manualSourceNote' })
    const person = await service.create('a', 'character', { name: ' 沈青 ', aliases: ['老沈'], chapterIndex: '1', ageText: '年过三旬' })
    const place = await service.create('a', 'location', { name: '码头', manualSourceNote: '作者补充', description: '临河的码头' })
    expect(person).toMatchObject({ name: '沈青', revision: 1, createdBy: 'manual', profile: { ageText: '年过三旬' } })
    expect(person.id).toMatch(/^U-/)
    expect(place).toMatchObject({ manualSourceNote: '作者补充', confidence: 0.5 })
    expect((await service.read('a')).characters).toHaveLength(1)
    expect((await service.read('b')).characters).toHaveLength(0)
    expect(await db.table('assetLifecycle').get(`character:${person.id}`)).toMatchObject({ state: 'live', currentId: person.id })
  })

  it('保存比较版本，失败无写；人物基础资料和只读关系保留', async () => {
    const { service, db } = await setup()
    const person = await service.create('a', 'character', { name: '沈青', chapterIndex: '1' })
    await db.table('characters').update(person.id, { nameSource: 'extracted', profile: { age: 35, gender: '男', ageText: '三十五岁' }, relations: [{ target: '顾衡', relation_type: 'friendship' }] })
    const updated = await service.update('a', 'character', person.id, 1, { name: '沈青', ageText: '年过三旬', identity: '船夫' })
    expect(updated).toMatchObject({ revision: 2, profile: { age: 35, gender: '男', ageText: '年过三旬' }, relations: [{ target: '顾衡', relation_type: 'friendship' }] })
    await expect(service.update('a', 'character', person.id, 1, { name: '旧表单覆盖' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(service.update('a', 'character', 'missing', 1, { name: '不存在' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await service.read('a')).characters[0].name).toBe('沈青')
    expect(updated.nameSource).toBe('extracted')
    expect(await service.update('a', 'character', person.id, updated.revision, { name: '船夫沈青' })).toMatchObject({ nameSource: 'manual' })
  })

  it('引文逐字校验、节点顺序自动计算、事件线按章节排序与双向关联', async () => {
    const { service } = await setup()
    const later = await service.create('a', 'node', { name: '交信', summary: '交给掌柜', chapterIndex: '1', quote: '沈青把信交给掌柜。', actors: ['沈青'] })
    const earlier = await service.create('a', 'node', { name: '收信', summary: '收到信', chapterIndex: '1', quote: '沈青收到信。', actors: ['沈青'] })
    const last = await service.create('a', 'node', { name: '归还', summary: '归还顾衡', chapterIndex: '2', quote: '掌柜将信归还顾衡。' })
    const line = await service.create('a', 'eventLine', { title: '书信', nodeIds: [last.id, later.id, earlier.id] })
    const state = await service.read('a')
    expect(state.nodes.find(node => node.id === earlier.id)?.order).toBe(0)
    expect(state.nodes.find(node => node.id === later.id)?.order).toBe(1)
    expect(line).toMatchObject({ nodeIds: [earlier.id, later.id, last.id], chapters: ['1', '2'] })
    expect(state.nodes.every(node => node.eventLineIds?.includes(line.id))).toBe(true)
    await expect(service.create('a', 'eventLine', { title: '坏线', nodeIds: ['missing'] })).rejects.toMatchObject({ code: 'VALIDATION', field: 'nodeIds' })
  })

  it('删除节点更新共享线、删除空线、清理反向引用并留墓碑', async () => {
    const { service, db } = await setup()
    const n = await service.create('a', 'node', { name: '收信', summary: '收信', chapterIndex: '1', quote: '沈青收到信。' })
    const other = await service.create('a', 'node', { name: '归还', summary: '归还', chapterIndex: '2', quote: '掌柜将信归还顾衡。' })
    const first = await service.create('a', 'eventLine', { title: '只含收信', nodeIds: [n.id] })
    const second = await service.create('a', 'eventLine', { title: '完整路径', nodeIds: [n.id, other.id] })
    const current = (await service.read('a')).nodes.find(node => node.id === n.id)!
    await service.remove('a', 'node', n.id, current.revision)
    const state = await service.read('a')
    expect(state.eventLines.map(line => line.id)).toEqual([second.id])
    expect(state.eventLines[0]).toMatchObject({ nodeIds: [other.id], chapters: ['2'] })
    expect(await db.table('assetLifecycle').get(`eventLine:${first.id}`)).toMatchObject({ state: 'deleted' })
    expect(await db.table('assetLifecycle').get(`node:${n.id}`)).not.toHaveProperty('currentId')
    await service.remove('a', 'eventLine', second.id, state.eventLines[0].revision)
    expect((await service.read('a')).nodes[0].eventLineIds).toEqual([])
  })

  it('同名人物按编号选择，关联不随另一同名人物改名而改变', async () => {
    const { service } = await setup()
    const first = await service.create('a', 'character', { name: '沈青', chapterIndex: '1' })
    const second = await service.create('a', 'character', { name: '沈青', manualSourceNote: '同名药师' })
    const node = await service.create('a', 'node', { name: '收信', summary: '收信', chapterIndex: '1', quote: '沈青收到信。', actors: ['沈青'] })
    let state = await service.read('a')
    expect(state.references[node.id]).toMatchObject({ actorIds: [], ambiguities: [{ name: '沈青', candidateIds: expect.arrayContaining([first.id, second.id]) }] })
    await service.update('a', 'node', node.id, node.revision, { actors: ['沈青'], actorIds: [first.id] })
    const current = state.characters.find(row => row.id === second.id)!
    await service.update('a', 'character', second.id, current.revision, { name: '药师沈青' })
    state = await service.read('a')
    expect(state.references[node.id].actorIds).toEqual([first.id])
    expect(state.nodes[0].actors).toEqual(['沈青'])
  })

  it('域锁拒绝全部同域人工写，允许另一域；释放后可保存', async () => {
    const { service, db } = await setup()
    const person = await service.create('a', 'character', { name: '沈青', chapterIndex: '1' })
    await db.table('pipelineRuns').put({ id: 'lease:world', recordType: 'lease', bookId: 'a', lockKey: 'world', owner: 'owner', runId: 'run', expiresAt: Date.now() + 300000 })
    await expect(service.create('a', 'location', { name: '码头', chapterIndex: '1' })).rejects.toMatchObject({ code: 'ASSET_DOMAIN_LOCKED' })
    await expect(service.update('a', 'character', person.id, person.revision, { roleWeight: '路人' })).rejects.toMatchObject({ code: 'ASSET_DOMAIN_LOCKED' })
    await expect(service.remove('a', 'character', person.id, person.revision)).rejects.toMatchObject({ code: 'ASSET_DOMAIN_LOCKED' })
    await service.create('a', 'node', { name: '收信', summary: '收信', chapterIndex: '1', quote: '沈青收到信。' })
    await db.table('pipelineRuns').delete('lease:world')
    await expect(service.update('a', 'character', person.id, person.revision, { roleWeight: '路人' })).resolves.toMatchObject({ roleWeight: '路人', roleWeightSource: 'manual' })
  })

  it('并发保存仅一个成功；墓碑与提取凭证在删除后保留', async () => {
    const { service, db } = await setup()
    const person = await service.create('a', 'character', { name: '沈青', chapterIndex: '1' })
    await db.table('extractionReceipts').put({ key: '1:worldAssets', originIds: [person.id] })
    const results = await Promise.allSettled([
      service.update('a', 'character', person.id, person.revision, { identity: '甲' }),
      service.update('a', 'character', person.id, person.revision, { identity: '乙' }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const current = (await service.read('a')).characters[0]
    await db.table('assetLifecycle').put({ key: 'character:origin', bookId: 'a', kind: 'character', originId: 'origin', currentId: person.id, state: 'merged', revision: 1 })
    await service.remove('a', 'character', person.id, current.revision)
    expect(await db.table('assetLifecycle').get('character:origin')).toMatchObject({ state: 'deleted' })
    expect(await db.table('extractionReceipts').get('1:worldAssets')).toBeDefined()
  })

  it('修改事实字段重建底稿，保留其他事实并清理优化缓存', async () => {
    const { service, db } = await setup()
    const person = await service.create('a', 'character', { name: '沈青', chapterIndex: '1' })
    await db.table('characters').update(person.id, { identity: '旧身份', mergeFacts: [{ id: 'old', field: 'identity', text: '旧身份', chapters: ['1'] }, { id: 'keep', field: 'appearance', text: '青衣', chapters: ['1'] }], optimizedFactIds: ['old', 'keep'], optimizationFingerprint: 'old-cache' })
    const result = await service.update('a', 'character', person.id, person.revision, { identity: '船夫；摆渡人' })
    expect(result.mergeFacts?.map(fact => fact.text).sort()).toEqual(['摆渡人', '船夫', '青衣'].sort())
    expect(result.optimizedFactIds).toEqual(['keep'])
    expect(result).not.toHaveProperty('optimizationFingerprint')
  })

  it('创建结果符合存储结构；事件线人物只读派生', async () => {
    const { service, db } = await setup()
    const person = await service.create('a', 'character', { name: '沈青', chapterIndex: '1' })
    await service.create('a', 'location', { name: '码头', chapterIndex: '1' })
    const node = await service.create('a', 'node', { name: '收信', summary: '收信', chapterIndex: '1', quote: '沈青收到信。', actors: ['沈青'] })
    const line = await service.create('a', 'eventLine', { title: '书信', nodeIds: [node.id] })
    const state = await service.read('a')
    expect(state.lineCharacterIds[line.id]).toEqual([person.id])
    expect(await db.table('eventLines').get(line.id)).not.toHaveProperty('characterIds')
    const schema = JSON.parse(readFileSync(new URL('../docs/v2/resources/v2.2/storage.schema.json', import.meta.url), 'utf8'))
    for (const [table, name] of [['characters', 'StoredCharacter'], ['locations', 'StoredLocation'], ['nodes', 'StoredNode'], ['eventLines', 'StoredEventLine'], ['assetLifecycle', 'AssetLifecycle']]) {
      for (const row of await db.table(table).toArray()) expect([...Value.Errors({ ...schema, $ref: `#/$defs/${name}` }, row)]).toEqual([])
    }
  })

  it('人工删除后的编号不能被新建复活', async () => {
    const { service } = await setup()
    const spy = vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001')
    try {
      const person = await service.create('a', 'character', { name: '沈青', chapterIndex: '1' })
      await service.remove('a', 'character', person.id, person.revision)
      await expect(service.create('a', 'character', { name: '沈青', chapterIndex: '1' })).rejects.toMatchObject({ code: 'CONFLICT' })
      expect((await service.read('a')).characters).toEqual([])
    } finally { spy.mockRestore() }
  })

  it('节点参考引文可空或不匹配，保存定位状态并保留节点内容', async () => {
    const { service } = await setup()
    const unmatched = await service.create('a', 'node', { name: '收信', summary: 'AI概述', chapterIndex: '1', quote: '改写后的引文' })
    expect(unmatched).toMatchObject({ name: '收信', summary: 'AI概述', quoteStatus: 'unmatched', quote: '改写后的引文' })
    expect(unmatched).not.toHaveProperty('offset')
    const empty = await service.create('a', 'node', { name: '补充事件', summary: '描述', chapterIndex: '1' })
    expect(empty).toMatchObject({ quote: '', quoteStatus: 'empty' })
    expect(empty).not.toHaveProperty('offset')
    const matched = await service.update('a', 'node', unmatched.id, unmatched.revision, { quote: '沈青收到信。' })
    expect(matched).toMatchObject({ quoteStatus: 'matched', offset: 0 })
  })

  it('人物改名和删除同步更新节点人物，原文章节与参考引文保留', async () => {
    const { service, db } = await setup()
    const first = await service.create('a', 'character', { name: '沈青', aliases: ['老沈'], chapterIndex: '1' })
    const other = await service.create('a', 'character', { name: '顾衡', chapterIndex: '2' })
    const node = await service.create('a', 'node', { name: '收信', summary: '收信', chapterIndex: '1', quote: '沈青收到信。', actors: ['老沈', '顾衡'], targets: ['老沈', '信'] })
    expect(node.actorIds).toEqual([first.id, other.id])
    const current = (await service.read('a')).characters.find(row => row.id === first.id)!
    await service.update('a', 'character', first.id, current.revision, { name: '张清' })
    let state = await service.read('a')
    expect(state.nodes[0]).toMatchObject({ actors: ['张清', '顾衡'], targets: ['张清', '信'], actorIds: [first.id, other.id] })
    const renamed = state.characters.find(row => row.id === first.id)!
    await service.remove('a', 'character', first.id, renamed.revision)
    state = await service.read('a')
    expect(state.nodes[0]).toMatchObject({ actors: ['顾衡'], actorIds: [other.id], targets: ['信'], targetCharacterIds: [], quote: '沈青收到信。' })
    expect(await db.table('chapterTexts').get('1')).toMatchObject({ text: '沈青收到信。沈青把信交给掌柜。' })
  })

  it('合并映射把张三替换为张清并去重，按编号保留其他人物', async () => {
    const { service } = await setup()
    const a = await service.create('a', 'character', { name: '张三', chapterIndex: '1' })
    const b = await service.create('a', 'character', { name: '张清', chapterIndex: '1' })
    const c = await service.create('a', 'character', { name: '李四', chapterIndex: '1' })
    const node = await service.create('a', 'node', { name: '会面', summary: '人物会面', chapterIndex: '1', actors: ['张三', '李四', '张清'], targets: ['张三'] })
    const state = await service.read('a')
    const mapped = remapCharacterLinks([node], state.characters, state.characters.filter(person => person.id !== a.id), new Map([[a.id, b.id]]))[0]
    expect(mapped).toMatchObject({ actors: ['张清', '李四'], actorIds: [b.id, c.id], targets: ['张清'], targetCharacterIds: [b.id] })
  })

  it('先建节点后补人物时绑定唯一姓名，之后删除仍能同步清理', async () => {
    const { service } = await setup()
    const node = await service.create('a', 'node', { name: '收信', summary: '收信', chapterIndex: '1', actors: ['沈青'] })
    expect(node.actorIds).toEqual([])
    const person = await service.create('a', 'character', { name: '沈青', chapterIndex: '1' })
    expect((await service.read('a')).nodes[0].actorIds).toEqual([person.id])
    await service.remove('a', 'character', person.id, person.revision)
    expect((await service.read('a')).nodes[0].actors).toEqual([])
  })
})
