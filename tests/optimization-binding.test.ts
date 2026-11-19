import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { writeFileSync } from 'node:fs'
import { expect, test, vi } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createModelService } from '../src/features/models/service'
import { createExtractionService } from '../src/features/extraction/service'
import { defaultConfig } from '../src/features/models/types'
import { agentStream } from './support/agent-protocol'
import type { Character, CharacterRelation, EventNode } from '../src/features/assets/types'

const counts = vi.hoisted(() => ({ nodes: [] as number[], relations: [] as number[] }))
vi.mock('../src/features/assets/characterLinks', async original => {
  const module = await original<typeof import('../src/features/assets/characterLinks')>()
  return { ...module, remapCharacterLinks: (...args: Parameters<typeof module.remapCharacterLinks>) => { counts.nodes.push(args[0].length); return module.remapCharacterLinks(...args) } }
})
vi.mock('../src/features/assets/relations', async original => {
  const module = await original<typeof import('../src/features/assets/relations')>()
  return { ...module, syncRelations: (...args: Parameters<typeof module.syncRelations>) => { counts.relations.push(args[0].length); return module.syncRelations(...args) } }
})

test('opt05：新增人物只影响迟到姓名和同名歧义，计量实际重绑定规模', async () => {
  const prefix = `opt05-${crypto.randomUUID()}`
  const workspace = createWorkspace({ settingsName: prefix, bookPrefix: `${prefix}-book-` })
  try {
    const bookId = 'a', now = new Date().toISOString(), db = workspace.openBook(bookId)
    await workspace.settings.books.put({ id: bookId, title: '绑定量化', sourceFileName: 'test.txt', createdAt: now })
    await db.chapters.put({ bookId, chapterIndex: '1', chapterName: '第一章', order: 0, charCount: 9 })
    await db.table('chapterTexts').put({ bookId, chapterIndex: '1', text: '迟到人物见到人物1。' })
    await db.table('compileProgress').put({ bookId, stage: 'P1', status: 'idle', totalChapters: 1, completedChapters: [], failedChapters: [], updatedAt: now })
    const people: Character[] = Array.from({ length: 300 }, (_, i) => ({ id: `P${i}`, bookId, name: `人物${i}`, aliases: [], revision: 1, confidence: 1, createdBy: 'P1' }))
    const nodes: EventNode[] = Array.from({ length: 2000 }, (_, i) => {
      const person = people[2 + i % 298]
      const mention = i === 0 ? '迟到人物' : i === 1 ? '人物1' : person.name
      const ids = i === 0 ? [] : i === 1 ? ['P1'] : [person.id]
      return { id: `N${i}`, bookId, name: `事件${i}`, summary: '事件概述', actors: [mention], actorIds: ids, actorBindings: [{ mention, ids }], targets: [], targetCharacterIds: [], chapterIndex: '1', chapterName: '第一章', order: i, quote: '', eventLineIds: [], revision: 1, confidence: 1, createdBy: 'P1' }
    })
    const relations: CharacterRelation[] = Array.from({ length: 6000 }, (_, i) => {
      const person = people[2 + i % 298]
      return { id: `R${i}`, bookId, originCharacterId: 'P0', sourceId: 'P0', sourceName: '人物0', targetName: i === 0 ? '迟到人物' : i === 1 ? '人物1' : person.name,
        targetIds: i === 0 ? [] : i === 1 ? ['P1'] : [person.id], forwardLabel: '朋友', reverseLabel: '朋友', relationType: 'friendship', direction: 'bidirectional', evidence: [], revision: 1, createdAt: now, updatedAt: now }
    })
    await db.table('characters').bulkPut(people)
    await db.table('nodes').bulkPut(nodes)
    await db.table('characterRelations').bulkPut(relations)
    counts.nodes.length = 0; counts.relations.length = 0
    const fetcher = vi.fn<typeof fetch>(async () => agentStream([{ name: 'submit_result', args: { characters: [{ name: '迟到人物', confidence: 1 }, { name: '人物1', confidence: 1 }], locations: [] } }]))
    const models = createModelService(workspace, { fetch: fetcher, wait: async (_ms, signal) => signal.throwIfAborted() })
    await models.settings.save({ ...defaultConfig, providerId: 'custom', baseUrl: 'https://opt05-fixture.invalid/v1', extractionModel: 'test' }, 'fixture-only')
    const service = createExtractionService(workspace, models)
    const start = performance.now()
    await service.retry(bookId, '1', 'worldAssets')
    const elapsedMs = performance.now() - start
    expect(service.state(bookId)?.error).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(await db.table('nodes').get('N0')).toMatchObject({ actorIds: ['C1-P001'], revision: 2 })
    expect(await db.table('nodes').get('N1')).toMatchObject({ actorIds: expect.arrayContaining(['P1', 'C1-P002']), revision: 2 })
    expect(await db.table('nodes').get('N2')).toEqual(nodes[2])
    expect(await db.table('characterRelations').get('R0')).toMatchObject({ targetIds: ['C1-P001'], revision: 2 })
    expect(await db.table('characterRelations').get('R1')).toMatchObject({ targetIds: expect.arrayContaining(['P1', 'C1-P002']), revision: 2 })
    expect(await db.table('characterRelations').get('R2')).toEqual(relations[2])
    const result = { peopleBefore: 300, nodes: nodes.length, relations: relations.length, reboundNodes: counts.nodes.reduce((a, b) => a + b, 0), reboundRelations: counts.relations.reduce((a, b) => a + b, 0), changedNodes: 2, changedRelations: 2, elapsedMs: +elapsedMs.toFixed(2) }
    if (process.env.WW_OPT05_RESULT) writeFileSync(process.env.WW_OPT05_RESULT, JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify(result))
  } finally {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name === prefix || name.startsWith(`${prefix}-book-`)) await Dexie.delete(name)
  }
}, 60000)
