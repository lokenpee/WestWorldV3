import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { createLocalStorageServer } from '../src/features/local-storage/server'
import type { StorageCall } from '../src/features/local-storage/client'
import type { StoredRecord } from '../src/features/local-storage/contracts'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createModelService } from '../src/features/models/service'
import { defaultConfig } from '../src/features/models/types'
import { createExtractionService } from '../src/features/extraction/service'
import { updateCharacterTiers } from '../src/features/world/statistics'
import { updateFrequencies } from '../src/features/assets/derive'
import type { Character, LocationAsset } from '../src/features/assets/types'
import { agentStream } from './support/agent-protocol'

interface Sample {
  name: string
  textReadRequests: number
  textRows: number
  textCharacters: number
  textResponseBytes: number
  metadataRequests: number
  elapsedMs: number
}

test('opt06：真实存储测量冷、热、单章重提、正文修改、新名称和歧义变化', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'westworld-opt06-'))
  const server = createLocalStorageServer(directory, { protect: value => Buffer.from(value).toString('base64'), unprotect: value => Buffer.from(value, 'base64').toString() })
  let collecting: Sample | undefined
  const call: StorageCall = async body => {
    const response = JSON.parse(JSON.stringify(await server.execute(JSON.parse(JSON.stringify(body))) ?? null))
    if (collecting && body.table === 'chapterTexts' && ['get', 'query'].includes(String(body.action))) {
      const rows = (body.action === 'get' ? response ? [response] : [] : response) as StoredRecord[]
      const withText = rows.filter(row => typeof row.value.text === 'string')
      const metadataOnly = body.action === 'query' && (body.query as { keysOnly?: boolean } | undefined)?.keysOnly
      if (metadataOnly) collecting.metadataRequests += 1
      else collecting.textReadRequests += 1
      collecting.textRows += withText.length
      collecting.textCharacters += withText.reduce((sum, row) => sum + String(row.value.text).length, 0)
      collecting.textResponseBytes += Buffer.byteLength(JSON.stringify(response))
    }
    return response
  }
  const workspace = createWorkspace({ settingsName: 'opt06', bookPrefix: 'opt06-' }, call)
  // 第二个工作区共用正式存储协议，不依赖通知已送达来发现正文修改。
  const secondWorkspace = createWorkspace({ settingsName: 'opt06-second', bookPrefix: 'opt06-second-' }, call)
  const samples: Sample[] = []
  try {
    const bookId = 'sample', now = '2026-11-19T00:00:00.000Z', chunkCount = 200, chunkLength = 8000
    const db = workspace.openBook(bookId), secondDb = secondWorkspace.openBook(bookId)
    await workspace.settings.books.put({ id: bookId, title: '统计量化样本', sourceFileName: 'sample.txt', createdAt: now })
    const chapters = Array.from({ length: chunkCount }, (_, index) => ({ bookId, chapterIndex: `${Math.floor(index / 2) + 1}.${index % 2 + 1}`, chapterName: `第${Math.floor(index / 2) + 1}章`, order: index, charCount: chunkLength }))
    const sentence = '张三丰与张三在南山镇相遇，阿张说老沈见到沈青，林老沈、娘娘与错别名未作回应。陈青松和陈青在南山休息。'
    const texts = chapters.map((chapter, index) => ({ bookId, chapterIndex: chapter.chapterIndex, text: `${sentence}人物${String(index % 30).padStart(2, '0')}。`.padEnd(chunkLength, '文') }))
    const person = (id: string, name: string, extra: Partial<Character> = {}): Character => ({ id, bookId, name, confidence: 1, revision: 1, createdBy: 'P1', ...extra })
    await db.chapters.bulkPut(chapters)
    await db.table('chapterTexts').bulkPut(texts)
    await db.table('characters').bulkPut([
      person('short', '张三', { verifiedAliases: ['阿张'], roleWeight: '路人', roleWeightSource: 'manual' }),
      person('shen', '沈青', { aliases: ['错别名'], verifiedAliases: ['老沈', '林老沈', '娘娘'], roleWeight: '重要配角', roleWeightSource: 'agent' }),
      person('li', '李明', { verifiedAliases: ['林老沈'] }),
      person('chen-short', '陈青'), person('chen-long', '陈青松'),
      ...Array.from({ length: 30 }, (_, index) => person(`p${index}`, `人物${String(index).padStart(2, '0')}`)),
    ])
    await db.table('locations').bulkPut(['南山', '南山镇'].map((name, index) => ({ id: `place-${index}`, bookId, name, confidence: 1, revision: 1, createdBy: 'P1' })))
    await db.table('compileProgress').put({ bookId, stage: 'P1', status: 'idle', totalChapters: chunkCount, completedChapters: [], failedChapters: [], updatedAt: now })
    const fetcher = vi.fn<typeof fetch>(async () => agentStream([{ name: 'submit_result', args: { characters: [], locations: [] } }]))
    const models = createModelService(workspace, { fetch: fetcher, wait: async (_ms, signal) => signal.throwIfAborted() })
    await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://opt06-fixture.invalid/v1', extractionModel: 'test' }, 'fixture-only')
    const extraction = createExtractionService(workspace, models)
    const tier = () => updateCharacterTiers(workspace, bookId, new AbortController())
    const extract = () => extraction.extractChapter(bookId, '1.1', 'worldAssets')
    async function assertStatistics() {
      const currentTexts = await db.table<{ chapterIndex: string; text: string }>('chapterTexts').toArray()
      for (const [table, characters] of [['characters', true], ['locations', false]] as const) {
        const current = await db.table<Character | LocationAsset>(table).toArray()
        const expected = updateFrequencies(current, currentTexts, characters)
        expect(current.map(row => ({ id: row.id, frequency: row.frequency, roleWeight: (row as Character).roleWeight, roleWeightSource: (row as Character).roleWeightSource })))
          .toEqual(expected.map(row => ({ id: row.id, frequency: row.frequency, roleWeight: (row as Character).roleWeight, roleWeightSource: (row as Character).roleWeightSource })))
      }
      expect(await db.table('characters').get('short')).toMatchObject({ roleWeight: '路人', roleWeightSource: 'manual', frequency: { scopeChapters: 100 } })
      expect(await db.table('characters').get('shen')).toMatchObject({ roleWeight: '重要配角', roleWeightSource: 'agent' })
    }
    async function measure(name: string, work: () => Promise<unknown>) {
      const sample: Sample = { name, textReadRequests: 0, textRows: 0, textCharacters: 0, textResponseBytes: 0, metadataRequests: 0, elapsedMs: 0 }
      collecting = sample
      const started = performance.now()
      try { await work() } finally { sample.elapsedMs = +(performance.now() - started).toFixed(2); collecting = undefined }
      expect(extraction.state(bookId)?.error).toBeUndefined()
      await assertStatistics()
      samples.push(sample)
    }
    const beforeExtractionCalls = fetcher.mock.calls.length
    await measure('cold_single_chapter_extract', extract)
    await measure('same_chapter_reextract', extract)
    expect(fetcher).toHaveBeenCalledTimes(beforeExtractionCalls + 2)
    const beforeRecord = await call<StoredRecord>({ action: 'get', scope: `book:${bookId}`, table: 'chapterTexts', key: '1.2' })
    const changedText = String(beforeRecord.value.text).replace('张三丰', '沈青丰')
    expect(changedText.length).toBe(String(beforeRecord.value.text).length)
    await secondDb.table('chapterTexts').put({ ...beforeRecord.value, text: changedText })
    const afterRecord = await call<StoredRecord>({ action: 'get', scope: `book:${bookId}`, table: 'chapterTexts', key: '1.2' })
    expect(afterRecord.version).toBeGreaterThan(beforeRecord.version)
    await measure('cross_window_same_length_text_change', extract)
    expect(fetcher).toHaveBeenCalledTimes(beforeExtractionCalls + 3)
    const shortBeforeLong = (await db.table<Character>('characters').get('short'))!.frequency!.mentions
    await db.table('characters').put(person('long', '张三丰'))
    await measure('new_long_name_in_old_chapters', extract)
    expect((await db.table<Character>('characters').get('short'))!.frequency!.mentions).toBeLessThan(shortBeforeLong)
    expect((await db.table<Character>('characters').get('long'))!.frequency!.mentions).toBe(199)
    const shenBeforeAmbiguity = (await db.table<Character>('characters').get('shen'))!.frequency!.mentions
    const li = (await db.table<Character>('characters').get('li'))!
    await db.table('characters').put({ ...li, verifiedAliases: [...li.verifiedAliases!, '老沈'], revision: li.revision + 1 })
    await measure('same_names_owner_becomes_ambiguous', extract)
    expect((await db.table<Character>('characters').get('shen'))!.frequency!.mentions).toBe(shenBeforeAmbiguity - chunkCount)
    const currentLi = (await db.table<Character>('characters').get('li'))!
    await db.table('characters').put({ ...currentLi, identity: '只修改身份描述', revision: currentLi.revision + 1 })
    await measure('unrelated_asset_edit', extract)
    expect(fetcher).toHaveBeenCalledTimes(beforeExtractionCalls + 6)
    await measure('manual_tiers_reference', tier)
    const result = { chunks: chunkCount, sourceChapters: 100, textCharacters: chunkCount * chunkLength, fixedModelCalls: fetcher.mock.calls.length, samples }
    if (process.env.WW_OPT06_RESULT) writeFileSync(process.env.WW_OPT06_RESULT, JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify(result))
  } finally {
    workspace.close(); secondWorkspace.close(); await server.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 60000)
