import 'fake-indexeddb/auto'
import { existsSync, readFileSync } from 'node:fs'
import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { createWorkspace, type DatabaseScope } from '../src/lib/storage/workspace'
import { createAssetService } from '../src/features/assets/service'
import { createLegacyBook, character, legacyRelation, side, type LegacyBookSeed } from './support/legacy-book'
import { checksumOf, encodeBackup, inspectBackup, restoredTables } from '../src/features/backup/codec'
import { emptyTables, tableNames, type BookData } from '../src/features/backup/data'
import { effectivePairs, pairKeyOf } from '../src/features/assets/relations'
import type { CharacterRelationEdit, LegacyRelationRecord } from '../src/features/assets/types'

const opened: ReturnType<typeof createWorkspace>[] = []
function setup() {
  const prefix = `legacy-${crypto.randomUUID()}`
  const scope: DatabaseScope = { settingsName: `${prefix}-settings`, bookPrefix: `${prefix}-book-` }
  const workspace = createWorkspace(scope); opened.push(workspace)
  return { workspace, scope }
}
afterEach(async () => {
  for (const workspace of opened.splice(0)) {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name)
  }
})
const ts = '2026-10-31T00:00:00.000Z'
const person = (id: string, name: string) => character(id, name, { bookId: 'legacy' })
const relation = (id: string, left: unknown, right: unknown, extra: Record<string, unknown> = {}) => legacyRelation(id, left as Record<string, unknown>, right as Record<string, unknown>, { bookId: 'legacy', ...extra })

function baseline(): LegacyBookSeed {
  return {
    bookId: 'legacy',
    characters: [person('A', '抱琴'), person('B', '元春'), person('C', '元春'), person('D', '齐王'), person('E', '许绍真'), person('F', '彩屏'), person('G', '惜春')],
    relations: [
      relation('R-1', side('A', '抱琴'), side('B', '元春'), { kind: 'service', leftRole: 'servant', rightRole: 'lord', label: '侍女', status: 'active', verification: 'manual', evidence: [{ quote: '抱琴是元春的侍女。', quoteChapterIndex: '1', sourceChapterIndices: ['1'], quoteStatus: 'matched', raw: {} }] }),
      relation('R-2', side('A', '抱琴'), side('B', '元春'), { kind: 'service', leftRole: 'servant', rightRole: 'lord', label: '侍女', status: 'active', verification: 'legacy' }),
      relation('R-3', side('D', '齐王'), side('E', '许绍真'), { kind: 'authority', label: '府中典客', status: 'pending', verification: 'legacy', issues: ['roleUnclear'] }),
      relation('R-4', side('F', '彩屏'), side('G', '惜春'), { kind: 'friend', label: '朋友', status: 'excluded', verification: 'legacy', excludeReason: 'removed' }),
      relation('R-5', side('A', '抱琴'), side(null, '无名', 'unresolved'), { label: '旧识', status: 'pending', verification: 'legacy' }),
    ],
    compileProgress: [{ bookId: 'legacy', stage: 'P1', status: 'completed', totalChapters: 1, completedChapters: ['1'], failedChapters: [], updatedAt: ts, planVersion: '2.2' }],
  }
}

async function migratedBaseline() {
  const { workspace, scope } = setup()
  await createLegacyBook(scope, baseline(), 7, false)
  await workspace.settings.books.put({ id: 'legacy', title: '旧书', sourceFileName: 'old.txt', createdAt: ts })
  const db = workspace.openBook('legacy'); await db.open()
  return { workspace, scope, db }
}

describe('阶段A 历史关系原地升级', () => {
  it('A01/A02 历史7无编辑表可打开，按角色投影且不扩散同名', async () => {
    const { workspace, db } = await migratedBaseline()
    expect(db.verno).toBe(8)
    const archives = await db.table<LegacyRelationRecord>('legacyRelationRecords').toArray()
    expect(archives).toHaveLength(5)
    expect(await db.table('characterRelations').count()).toBe(0)
    const edits = await db.table<CharacterRelationEdit>('characterRelationEdits').toArray()
    const pairs = effectivePairs([], edits, await db.table('characters').toArray())
    const ab = pairs.find(row => row.pairKey === pairKeyOf('A', 'B'))!
    expect(ab).toMatchObject({ fromId: 'A', toId: 'B', directionUnclear: false })
    expect(ab.forwardLabels).toEqual(['仆从'])
    expect(ab.reverseLabels).toEqual(['主人'])
    expect(ab.legacyRecordIds.sort()).toEqual(['R-1', 'R-2'])
    expect(pairs.some(row => row.pairKey === pairKeyOf('A', 'C'))).toBe(false)
    const de = pairs.find(row => row.pairKey === pairKeyOf('D', 'E'))!
    expect(de).toMatchObject({ directionUnclear: true })
    expect(de.forwardLabels).toEqual(['府中典客'])
    expect(de.reverseLabels).toEqual(['府中典客'])
    expect(pairs.find(row => row.pairKey === pairKeyOf('F', 'G'))?.state).toBe('deleted')
    expect((await db.table<LegacyRelationRecord>('legacyRelationRecords').get('R-1'))!.original).toMatchObject({ label: '侍女', verification: 'manual', left: { characterId: 'A' } })
    expect(await db.table('compileProgress').get('P1')).toMatchObject({ status: 'completed', completedChapters: ['1'] })
    expect(await db.table('extractionReceipts').count()).toBe(2)
    expect((await db.table('pipelineRuns').toArray()).filter(row => (row.result as { kind?: string } | undefined)?.kind === 'legacy_relation_migration')).toHaveLength(1)
    workspace.closeBook('legacy'); const reopened = workspace.openBook('legacy'); await reopened.open()
    expect(await reopened.table('legacyRelationRecords').count()).toBe(5)
    expect((await reopened.table('pipelineRuns').toArray()).filter(row => (row.result as { kind?: string } | undefined)?.kind === 'legacy_relation_migration')).toHaveLength(1)
  })

  it('A03 当前编辑优先、排除不误删同对其他记录、合并后自连待核对', async () => {
    const { workspace, scope } = setup()
    const current = {
      id: 'R-CUR', bookId: 'legacy', originCharacterId: 'A', sourceName: '抱琴', targetName: '元春', relationType: 'service', forwardLabel: '仆从', reverseLabel: '主人', direction: 'directed', evidence: [], sourceId: 'A', targetIds: ['B'], revision: 1, createdAt: ts, updatedAt: ts,
    }
    const edit = { pairKey: pairKeyOf('A', 'B'), bookId: 'legacy', aId: 'A', bId: 'B', state: 'deleted', aToBLabels: [], bToALabels: [], directionUnclear: false, evidence: [], sourceRelationIds: ['R-CUR'], revision: 3, updatedAt: ts, updatedBy: 'manual', commitId: 'existing' }
    const seed = baseline()
    seed.relations!.push(relation('R-EX', side('F', '彩屏'), side('G', '惜春'), { kind: 'friend', label: '朋友', status: 'excluded', verification: 'legacy' }))
    seed.relations!.push(relation('R-FG', side('F', '彩屏'), side('G', '惜春'), { kind: 'friend', leftRole: 'friend', rightRole: 'friend', label: '朋友', status: 'active', verification: 'legacy' }))
    seed.relations!.push(relation('R-SELF', side('C', '元春'), side('B', '元春'), { kind: 'friend', label: '旧识', status: 'active', verification: 'legacy' }))
    seed.relations!.push(current as unknown as Record<string, unknown>)
    seed.lifecycle = [...seed.characters.map(row => ({ key: `character:${row.id}`, bookId: 'legacy', kind: 'character', originId: row.id, currentId: row.id, state: 'live', revision: 1, updatedAt: ts })), { key: 'character:B', bookId: 'legacy', kind: 'character', originId: 'B', state: 'merged', currentId: 'C', revision: 2, updatedAt: ts }]
    seed.edits = [edit]
    await createLegacyBook(scope, seed, 7, true)
    workspace.settings.books.put({ id: 'legacy', title: '旧书', sourceFileName: 'old.txt', createdAt: ts })
    const db = workspace.openBook('legacy'); await db.open()
    const edits = await db.table<CharacterRelationEdit>('characterRelationEdits').toArray()
    const ab = edits.find(row => row.pairKey === pairKeyOf('A', 'B'))!
    expect(ab).toMatchObject({ state: 'deleted', revision: 3, updatedBy: 'manual' })
    expect(ab.legacyRecordIds).toEqual([])
    const ac = edits.find(row => row.pairKey === pairKeyOf('A', 'C'))!
    expect(ac.legacyRecordIds?.sort()).toEqual(['R-1', 'R-2'])
    const pairs = effectivePairs(await db.table('characterRelations').toArray(), edits, await db.table('characters').toArray())
    expect(pairs.find(row => row.pairKey === pairKeyOf('F', 'G'))?.state).toBe('active')
    expect((await db.table<LegacyRelationRecord>('legacyRelationRecords').get('R-SELF'))!.disposition).toBe('unresolved')
    expect((await db.table<LegacyRelationRecord>('legacyRelationRecords').get('R-SELF'))!.issues).toContain('self_after_merge')
    expect(await db.table('characterRelations').get('R-CUR')).toMatchObject({ id: 'R-CUR', targetName: '元春' })
  })

  it('A04 未知结构报具体路径且不升级；空历史7正常升级；当前6保留编辑', async () => {
    {
      const { workspace, scope } = setup()
      await createLegacyBook(scope, { ...baseline(), relations: [{ id: 'X', foo: 1 }] }, 7, false)
      const db = workspace.openBook('legacy')
      await expect(db.open()).rejects.toThrow('characterRelations[0]')
      const raw = new Dexie(`${scope.bookPrefix}legacy`); await raw.open()
      expect(raw.verno).toBe(7)
      await raw.close()
    }
    {
      const { workspace, scope } = setup()
      await createLegacyBook(scope, { bookId: 'legacy', characters: [person('A', '甲')], relations: [] }, 7, false)
      const db = workspace.openBook('legacy'); await db.open()
      expect(db.verno).toBe(8)
      expect(await db.table('legacyRelationRecords').count()).toBe(0)
    }
    {
      const { workspace, scope } = setup()
      const current = { id: 'RC', bookId: 'legacy', originCharacterId: 'A', sourceName: '甲', targetName: '乙', relationType: 'friend', forwardLabel: '朋友', reverseLabel: '朋友', direction: 'bidirectional', evidence: [], sourceId: 'A', targetIds: ['B'], revision: 1, createdAt: ts, updatedAt: ts }
      const edit = { pairKey: pairKeyOf('A', 'B'), bookId: 'legacy', aId: 'A', bId: 'B', state: 'active', aToBLabels: ['朋友'], bToALabels: ['朋友'], directionUnclear: false, evidence: [], sourceRelationIds: ['RC'], revision: 2, updatedAt: ts, updatedBy: 'agent', commitId: 'c1' }
      await createLegacyBook(scope, { bookId: 'legacy', characters: [person('A', '甲'), person('B', '乙')], relations: [current], edits: [edit] }, 7, true)
      const db = workspace.openBook('legacy'); await db.open()
      expect(await db.table('characterRelations').get('RC')).toMatchObject({ targetName: '乙' })
      expect(await db.table('characterRelationEdits').get(pairKeyOf('A', 'B'))).toMatchObject({ state: 'active', updatedBy: 'agent' })
      expect(await db.table('legacyRelationRecords').count()).toBe(0)
    }
  })

  it('A05 写入失败回滚版本与数据；活租约暂缓，解除后重试成功', async () => {
    {
      const { workspace, scope } = setup()
      await createLegacyBook(scope, baseline(), 7, false)
      const failing = workspace.openBook('legacy')
      failing.table('legacyRelationRecords').hook('creating', () => { throw new Error('模拟迁移写入失败') })
      await expect(failing.open()).rejects.toThrow('模拟迁移写入失败')
      const raw = new Dexie(`${scope.bookPrefix}legacy`); await raw.open()
      expect(raw.verno).toBe(7)
      expect(await raw.table('characterRelations').count()).toBe(5)
      await raw.close(); workspace.closeBook('legacy')
      const retried = workspace.openBook('legacy'); await retried.open()
      expect(retried.verno).toBe(8)
      expect(await retried.table('legacyRelationRecords').count()).toBe(5)
    }
    {
      const { workspace, scope } = setup()
      await createLegacyBook(scope, baseline(), 7, false)
      const raw = new Dexie(`${scope.bookPrefix}legacy`); await raw.open()
      await raw.table('pipelineRuns').put({ id: 'lease:world', bookId: 'legacy', recordType: 'lease', lockKey: 'world', owner: 'x', runId: 'r', expiresAt: Date.now() + 30000 })
      await raw.close()
      const db = workspace.openBook('legacy')
      await expect(db.open()).rejects.toThrow('任务正在运行')
      const retry = new Dexie(`${scope.bookPrefix}legacy`); await retry.open(); await retry.table('pipelineRuns').delete('lease:world'); await retry.close()
      workspace.closeBook('legacy')
      const reopened = workspace.openBook('legacy'); await reopened.open()
      expect(reopened.verno).toBe(8)
    }
  })

  it('A08 迁移后编辑、删除与重复打开不复活', async () => {
    const { workspace } = await migratedBaseline()
    const assets = createAssetService(workspace)
    await workspace.settings.books.put({ id: 'legacy', title: '旧书', sourceFileName: 'old.txt', createdAt: ts })
    const ab = await assets.getRelationPair('legacy', 'A', 'B')
    await assets.saveRelationPair('legacy', { fromId: 'A', toId: 'B', forwardLabels: ['侍从'], reverseLabels: ['主人'], directionUnclear: false, evidence: [], reason: '人工核对', expectedFingerprint: ab.fingerprint, operationKey: 'k1' })
    const de = await assets.getRelationPair('legacy', 'D', 'E')
    await assets.deleteRelationPair('legacy', { fromId: 'D', toId: 'E', forwardLabels: [], reverseLabels: [], reason: '人工删除', expectedFingerprint: de.fingerprint, operationKey: 'k2' })
    workspace.closeBook('legacy')
    const db = workspace.openBook('legacy'); await db.open()
    const edits = await db.table<CharacterRelationEdit>('characterRelationEdits').toArray()
    expect(edits.find(row => row.pairKey === pairKeyOf('A', 'B'))).toMatchObject({ state: 'active', aToBLabels: ['侍从'] })
    expect(edits.find(row => row.pairKey === pairKeyOf('D', 'E'))).toMatchObject({ state: 'deleted' })
    expect(edits.find(row => row.pairKey === pairKeyOf('A', 'B'))!.legacyRecordIds?.sort()).toEqual(['R-1', 'R-2'])
  })

  it('A09 单角色只填一向；无角色与超限保留待核对', async () => {
    const { workspace, scope } = setup()
    const seed = baseline()
    seed.characters.push(person('H', '贾母'), person('I', '宝玉'))
    seed.relations!.push(relation('R-ONE', side('H', '贾母'), side('I', '宝玉'), { kind: 'parentChild', leftRole: 'grandmother', rightRole: null, label: '祖母', status: 'active', verification: 'legacy' }))
    seed.relations!.push(relation('R-LIMIT', side('H', '贾母'), side('C', '元春'), { kind: 'friend', label: 'x'.repeat(101), status: 'active', verification: 'legacy' }))
    await createLegacyBook(scope, seed, 7, false)
    const db = workspace.openBook('legacy'); await db.open()
    const edits = await db.table<CharacterRelationEdit>('characterRelationEdits').toArray()
    const hi = edits.find(row => row.pairKey === pairKeyOf('H', 'I'))!
    expect(hi.aToBLabels).toEqual(['祖母'])
    expect(hi.bToALabels).toEqual([])
    expect(edits.some(row => row.pairKey === pairKeyOf('H', 'C'))).toBe(false)
    const limit = await db.table<LegacyRelationRecord>('legacyRelationRecords').get('R-LIMIT')
    expect(limit).toMatchObject({ disposition: 'unresolved' })
    expect(limit!.issues).toContain('label_limit')
  })
})

function zipBook(data: BookData, formatVersion: 7 | 8, options: { omitEdits?: boolean; omitLegacy?: boolean } = {}) {
  const tables = tableNames.filter(name => name !== 'chapterTexts' && !(options.omitEdits && name === 'characterRelationEdits') && !(options.omitLegacy && name === 'legacyRelationRecords'))
  const files: Record<string, Uint8Array> = { 'data/book.json': strToU8(JSON.stringify(data.book)) }
  for (const name of tables) files[`data/${name}.json`] = strToU8(JSON.stringify(data.tables[name]))
  for (const row of data.tables.chapterTexts) files[`chapters/${String(row.chapterIndex).padStart(4, '0')}.txt`] = strToU8(String(row.text))
  const contents = ['book', ...tables]
  return { files, manifest: { format: 'westworld-v2', formatVersion, appVersion: '0.4.0', exportedAt: '2026-11-04T00:00:00.000Z', book: { id: data.book.id, title: data.book.title, chapterCount: data.tables.chapters.length }, contents, excludes: [], checksums: {} as Record<string, string> } }
}
async function zipWithChecksums(data: BookData, formatVersion: 7 | 8, options: { omitEdits?: boolean; omitLegacy?: boolean } = {}) {
  const { files, manifest } = zipBook(data, formatVersion, options)
  for (const [name, bytes] of Object.entries(files)) manifest.checksums[name] = await checksumOf(bytes)
  files['manifest.json'] = strToU8(JSON.stringify(manifest))
  return zipSync(files)
}

describe('阶段A 备份预检与往返', () => {
  it('A06 历史格式7缺编辑表按结构转换；当前7缺编辑表仍拒绝', async () => {
    const data: BookData = {
      book: { id: 'legacy', title: '旧书', sourceFileName: 'old.txt', createdAt: ts },
      tables: emptyTables(),
    }
    data.tables.chapters.push({ bookId: 'legacy', chapterIndex: '1', chapterName: '第一章', order: 0, charCount: '抱琴是元春的侍女。'.length })
    data.tables.chapterTexts.push({ bookId: 'legacy', chapterIndex: '1', text: '抱琴是元春的侍女。' })
    data.tables.characters.push(person('A', '抱琴'), person('B', '元春'))
    data.tables.assetLifecycle.push(...['A', 'B'].map(id => ({ key: `character:${id}`, bookId: 'legacy', kind: 'character', originId: id, currentId: id, state: 'live', revision: 1, updatedAt: ts })))
    data.tables.characterRelations.push(relation('R-H', side('A', '抱琴'), side('B', '元春'), { kind: 'service', leftRole: 'servant', rightRole: 'lord', label: '侍女', status: 'active', verification: 'manual' }))
    data.tables.compileProgress.push({ bookId: 'legacy', stage: 'P1', status: 'completed', totalChapters: 1, completedChapters: ['1'], failedChapters: [], updatedAt: ts, planVersion: '2.2' })
    const historical = await inspectBackup(await zipWithChecksums(data, 7, { omitEdits: true, omitLegacy: true }))
    expect(historical.errors).toEqual([])
    expect(historical.data!.tables.legacyRelationRecords).toHaveLength(1)
    expect(historical.data!.tables.characterRelations).toEqual([])
    expect(historical.data!.tables.characterRelationEdits).toHaveLength(1)

    data.tables.characterRelations = [{ id: 'R-C', bookId: 'legacy', originCharacterId: 'A', sourceName: '抱琴', targetName: '元春', relationType: 'service', forwardLabel: '仆从', reverseLabel: '主人', direction: 'directed', evidence: [], sourceId: 'A', targetIds: ['B'], revision: 1, createdAt: ts, updatedAt: ts }]
    const current = await inspectBackup(await zipWithChecksums(data, 7, { omitEdits: true, omitLegacy: true }))
    expect(current.ok).toBe(false)
    expect(current.errors[0]).toMatchObject({ code: 'CONTENTS' })
  })

  it('A07 格式8导出恢复保留旧归档、当前关系与删除状态', async () => {
    const { workspace } = await migratedBaseline()
    const db = workspace.openBook('legacy')
    const tables = emptyTables()
    for (const name of tableNames) tables[name] = await db.table(name).toArray()
    const exported = await encodeBackup({ book: { id: 'legacy', title: '旧书', sourceFileName: 'old.txt', createdAt: ts }, tables })
    expect(exported.manifest.formatVersion).toBe(8)
    const inspected = await inspectBackup(exported.bytes)
    expect(inspected.errors).toEqual([])
    expect(inspected.data!.tables.legacyRelationRecords).toHaveLength(5)
    const restored = await restoredTables(inspected.data!, 'restored')
    expect(restored.legacyRelationRecords).toHaveLength(5)
    expect(restored.legacyRelationRecords.every(row => row.bookId === 'restored')).toBe(true)
    expect(restored.characterRelationEdits.some(row => row.state === 'deleted')).toBe(true)
  })
})

const realBackup = '红楼之挽天test-2026-11-01T16-29-14-713Z-e6d75115.wwv2'
describe.skipIf(!existsSync(realBackup))('A10 真实备份副本', () => {
  it('1562条历史行全部归档，人工结果与人物节点数量保留', async () => {
    const inspected = await inspectBackup(new Uint8Array(readFileSync(realBackup)))
    expect(inspected.errors).toEqual([])
    expect(inspected.data!.tables.chapters).toHaveLength(138)
    expect(inspected.data!.tables.characters).toHaveLength(395)
    expect(inspected.data!.tables.nodes).toHaveLength(613)
    const archives = inspected.data!.tables.legacyRelationRecords as unknown as LegacyRelationRecord[]
    expect(archives).toHaveLength(1562)
    expect(archives.filter(row => (row.original as { verification?: string }).verification === 'manual')).toHaveLength(5)
    for (const id of ['R-1prf5f8', 'R-dfmw60', 'R-dfmw61', 'R-dfmw62', 'R-s4trg6']) expect(archives.find(row => row.id === id)).toBeTruthy()
    const edits = inspected.data!.tables.characterRelationEdits as unknown as CharacterRelationEdit[]
    expect(edits.length).toBeGreaterThan(0)
  }, 120000)
})
