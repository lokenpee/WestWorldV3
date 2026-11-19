import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { createLocalStorageServer } from '../src/features/local-storage/server'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createAssetService } from '../src/features/assets/service'
import { searchAssets, searchCharacters, type SearchAsset } from '../src/features/assets/search'
import { assetTables, type AssetKind } from '../src/features/assets/types'
import type { StorageCall } from '../src/features/local-storage/client'

test('opt19：地点首屏不读取其他三类资产与人物关系', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'westworld-opt19-'))
  const server = createLocalStorageServer(directory, { protect: value => value, unprotect: value => value })
  let collecting = false
  const calls: { action: string; table: string; bytes: number; metadata: boolean }[] = []
  const call: StorageCall = async body => { const value = await server.execute(body); if (collecting && !['begin', 'commit'].includes(String(body.action))) calls.push({ action: String(body.action), table: String(body.table ?? ''), metadata: !!(body.query as { keysOnly?: boolean })?.keysOnly, bytes: Buffer.byteLength(JSON.stringify(value ?? null)) }); return value as never }
  const workspace = createWorkspace({ settingsName: 'opt19', bookPrefix: 'opt19-' }, call)
  try {
    await workspace.settings.books.put({ id: 'book', title: '分页样本', sourceFileName: 'fixture.txt', createdAt: '2026-11-19' })
    const db = workspace.openBook('book'), service = createAssetService(workspace), base = { bookId: 'book', revision: 1, createdBy: 'P1', confidence: 1, chapterIndex: '1', chapterName: '第一章' }
    await db.chapters.put({ bookId: 'book', chapterIndex: '1', chapterName: '第一章', order: 0, charCount: 1 })
    await db.table('characters').bulkPut(Array.from({ length: 300 }, (_, i) => ({ ...base, id: `P${i}`, name: `人物${i}`, background: '人物经历'.repeat(1000) })))
    const locations = Array.from({ length: 1000 }, (_, i) => ({ ...base, id: `L${i}`, name: `地点${i}`, description: '地点介绍'.repeat(100) }))
    await db.table('locations').bulkPut(locations)
    await db.table('nodes').bulkPut(Array.from({ length: 600 }, (_, i) => ({ ...base, id: `N${i}`, name: `节点${i}`, summary: '事件摘要', process: '详细经过'.repeat(500), actors: [], targets: [], actorIds: [], targetCharacterIds: [], eventLineIds: [], order: i })))
    await db.table('eventLines').bulkPut(Array.from({ length: 100 }, (_, i) => ({ ...base, id: `E${i}`, title: `事件线${i}`, nodeIds: [`N${i}`], chapters: ['1'], cause: '', process: '', result: '', summary: '完整概述' })))
    const expected = searchAssets(locations as never, '').slice(0, 100).map(row => row.id)
    calls.length = 0; collecting = true
    const pageService = service as typeof service & { readAssetPage?: (bookId: string, kind: string, options: object) => Promise<{ items: { id: string }[] }> }
    const items = pageService.readAssetPage ? (await pageService.readAssetPage('book', 'location', { offset: 0, limit: 100 })).items : searchAssets((await service.readContent('book')).locations, '').slice(0, 100)
    collecting = false
    expect(items.map(row => row.id)).toEqual(expected)
    const result = { optimization: 19, sample: { characters: 300, locations: 1000, nodes: 600, eventLines: 100, firstPage: 100 }, returnedBytes: calls.reduce((sum, call) => sum + call.bytes, 0), reads: calls.map(call => ({ action: call.action, table: call.table })), items: items.length }
    if (process.env.WW_OPT19_RESULT) writeFileSync(process.env.WW_OPT19_RESULT, JSON.stringify(result, null, 2) + '\n')
    if (!pageService.readAssetPage) return
    const full = await service.readContent('book')
    for (const kind of Object.keys(assetTables) as AssetKind[]) {
      for (const query of ['', '1', '摘要', '地点介绍']) {
        const all = kind === 'character' ? searchCharacters(full.characters, query) : searchAssets<SearchAsset>(full[assetTables[kind]], query)
        const paged: string[] = []
        for (let offset = 0; offset < Math.max(1, all.length); offset += 100) {
          const page = await service.readAssetPage('book', kind, { query, offset, selectedIds: [full[assetTables[kind]][0].id, 'missing'] })
          expect(page.matched).toBe(all.length)
          expect(page.missingIds).toEqual(['missing'])
          paged.push(...page.items.map(row => row.id))
        }
        expect(paged).toEqual(all.map(row => row.id))
      }
      const selectedId = full[assetTables[kind]][0].id
      const detail = await service.readContent('book', { kind, selectedId })
      expect(detail[assetTables[kind]].find(row => row.id === selectedId)).toEqual(full[assetTables[kind]][0])
    }
    expect((await service.readAssetPage('book', 'character', { role: '主要人物' })).matched).toBe(0)
    expect((await service.readAssetPage('book', 'location', { offset: 2000 })).offset).toBe(900)
    const view = { kind: 'location' as const, selectedId: 'L0' }
    await service.readContent('book', view)
    calls.length = 0; collecting = true
    const cached = await service.readContent('book', view)
    collecting = false
    expect(cached.locations).toHaveLength(1)
    expect(cached.characters).toEqual([])
    expect(cached.nodes).toEqual([])
    expect(calls.filter(call => ['query', 'bulkGet'].includes(call.action) && !call.metadata)).toEqual([])
    await db.table('locations').update('L0', { description: '另一窗口已更新', revision: 2 })
    expect((await service.readContent('book', view)).locations[0].description).toBe('另一窗口已更新')
    await db.table('locations').delete('L0')
    expect((await service.readAssetPage('book', 'location', { selectedIds: ['L0', 'L999'] })).missingIds).toEqual(['L0'])
  } finally {
    workspace.close(); await server.close()
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('westworld-opt19-')) throw new Error('临时目录归属不符')
    rmSync(directory, { recursive: true, force: true })
  }
})
