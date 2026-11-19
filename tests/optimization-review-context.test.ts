import { writeFileSync } from 'node:fs'
import { expect, test, vi } from 'vitest'
import { createMemoryAgentRepository, type AgentRepository, type Row } from '../src/features/agents/repository'
import { createAgentTools } from '../src/features/agents/tools'
import { createOrganizationStepState } from '../src/features/world/organization'
import * as review from '../src/features/agents/organizationReview'
import * as relations from '../src/features/assets/relations'
import type { Character, CharacterRelation } from '../src/features/assets/types'
import { createPairWriteContext, deleteCharacterPair, saveCharacterPair, type PairWriteInput } from '../src/features/assets/relationEdits'

const bookId = 'opt09-book', runId = 'opt09-run'
interface Measurements {
  name: string
  reviewContexts: number
  syncRelations: number
  syncRelationRows: number
  effectivePairs: number
  fullGraphBuilds: number
  effectiveRelationRows: number
  effectiveCharacterRows: number
  tableReads: Record<string, number>
  tableRows: Record<string, number>
}

test.each([false, true])('opt09：量化单人物查询和同人物多条关系提交（反向编号=%s）', async reverseIds => {
  const idOf = (index: number) => `${reverseIds && index === 0 ? 'Z' : 'C'}${String(index).padStart(3, '0')}`
  const people: Character[] = Array.from({ length: 120 }, (_, index) => ({
    id: idOf(index), bookId, name: `人物${index}`, identity: `身份${index}`, aliases: [],
    revision: 1, confidence: 1, createdBy: 'P1',
  }))
  const fact = (id: string, from: number, to: number): CharacterRelation => ({
    id, bookId, originCharacterId: idOf(from), sourceId: idOf(from), targetIds: [idOf(to)],
    sourceName: people[from]!.name, targetName: people[to]!.name,
    relationType: 'friend', forwardLabel: '朋友', reverseLabel: '朋友', direction: 'bidirectional',
    evidence: [], revision: 1, createdAt: '', updatedAt: '',
  })
  const facts = [
    ...Array.from({ length: 12 }, (_, index) => fact(`star-${index + 1}`, 0, index + 1)),
    ...Array.from({ length: 106 }, (_, index) => fact(`background-${index}`, index + 13, index + 14)),
    { ...fact('unlinked-out', 0, 1), targetName: '未登场甲', targetIds: [] },
    { ...fact('unlinked-in', 1, 0), originCharacterId: 'missing', sourceId: null, sourceName: '未登场乙' },
  ]
  let measuring: Measurements | undefined
  const all: Measurements[] = []
  const originalReview = review.reviewContext, originalSync = relations.syncRelations, originalPairs = relations.effectivePairs
  const spies = [
    vi.spyOn(review, 'reviewContext').mockImplementation(async (...args) => {
      if (measuring) measuring.reviewContexts++
      return originalReview(...args)
    }),
    vi.spyOn(relations, 'syncRelations').mockImplementation((...args) => {
      if (measuring) { measuring.syncRelations++; measuring.syncRelationRows += args[0].length }
      return originalSync(...args)
    }),
    vi.spyOn(relations, 'effectivePairs').mockImplementation((...args) => {
      if (measuring) {
        measuring.effectivePairs++; measuring.effectiveRelationRows += args[0].length
        measuring.effectiveCharacterRows += args[2].length
        if (args[0].length === facts.length && args[2].length === people.length) measuring.fullGraphBuilds++
      }
      return originalPairs(...args)
    }),
  ]
  async function fixture() {
    const base = createMemoryAgentRepository(bookId, {
      characters: people as unknown as Row[], characterRelations: facts as unknown as Row[],
      characterRelationEdits: [{
        pairKey: relations.pairKeyOf(idOf(0), idOf(12)), bookId, aId: idOf(0), bId: idOf(12),
        state: 'deleted', aToBLabels: [], bToALabels: [], directionUnclear: false, evidence: [],
        sourceRelationIds: ['star-12'], revision: 1, updatedAt: '', updatedBy: 'manual', commitId: 'seed-deleted',
      }],
      pipelineRuns: [{
        id: runId, bookId, recordType: 'run', stage: 'P2', phase: 'character_organization',
        workflow: 'character_organization_v1', status: 'running', report: {}, commandIntents: [], appliedCommands: [],
        tasks: [{ taskId: 'task', workItemIds: [`organization:relations:${idOf(0)}`], phase: 'character_organization',
          input: { workItems: [] }, appliedCommitIds: [], reviewedItems: [], readSet: { records: [], queries: [] } }],
      }, { id: 'lease:world', bookId, recordType: 'lease', lockKey: 'world', owner: 'owner', runId, expiresAt: Date.now() + 60_000 }],
    })
    const repo: AgentRepository = { ...base, transaction: (write, work, lease) => base.transaction(write, store => work({
      ...store,
      async rows(table) {
        const rows = await store.rows(table)
        if (measuring) {
          measuring.tableReads[table] = (measuring.tableReads[table] ?? 0) + 1
          measuring.tableRows[table] = (measuring.tableRows[table] ?? 0) + rows.length
        }
        return rows
      },
    }), lease) }
    await repo.transaction(true, async store => {
      const organization = await createOrganizationStepState(store, 'relations', 'all')
      organization.activeWork = {
        id: `relations:${idOf(0)}`, kind: 'relations', characterId: idOf(0), contextId: 'relations',
        status: 'running', requestCount: 0, draft: null, commitIds: [], dataVersion: 1,
      }
      await store.put('pipelineRuns', { ...(await store.get('pipelineRuns', runId))!, organization })
    })
    const tools = createAgentTools(repo, {
      bookId, profile: 'asset_editor', phase: 'character_organization', workflow: 'character_organization_v1',
      runId, taskId: 'task', owner: 'owner', workItemIds: [`organization:relations:${idOf(0)}`],
      contextId: 'relations', unitId: `relations:${idOf(0)}`, workKind: 'relations',
    }).tools
    const execute = async (name: string, args: Row) => {
      const response = await tools.find(tool => tool.name === name)!.execute(`${name}-${JSON.stringify(args)}`, args) as { content: { text: string }[] }
      return JSON.parse(response.content[0]!.text) as Row
    }
    return { repo, execute }
  }
  async function measure<T>(name: string, work: () => Promise<T>) {
    const sample: Measurements = { name, reviewContexts: 0, syncRelations: 0, syncRelationRows: 0,
      effectivePairs: 0, fullGraphBuilds: 0, effectiveRelationRows: 0, effectiveCharacterRows: 0,
      tableReads: {}, tableRows: {} }
    measuring = sample
    try { return await work() } finally { measuring = undefined; all.push(sample) }
  }
  try {
    for (const changes of [1, 8]) {
      const { repo, execute } = await fixture()
      {
        const query = () => execute('query_relation_work', { characterId: idOf(0), limit: 50 })
        const queried = changes === 8 ? await measure('query_one_character', query) : await query()
        const data = queried.data as Row, neighbors = data.relations as Row[]
        expect(data.total).toBe(12)
        expect(neighbors.map(row => row.targetId)).toEqual(Array.from({ length: 12 }, (_, index) => idOf(index + 1)))
        expect(neighbors.find(row => row.targetId === idOf(12))).toMatchObject({ state: 'deleted', forward: [], reverse: [] })
        expect(data.unlinkedRelations).toEqual([
          { sourceName: people[0]!.name, targetName: '未登场甲', forward: '朋友', reverse: '朋友', direction: 'bidirectional' },
          { sourceName: '未登场乙', targetName: people[0]!.name, forward: '朋友', reverse: '朋友', direction: 'bidirectional' },
        ])
      }
      const ack = await measure(`submit_${changes}_pairs`, () => execute('submit_relation_review', {
        changes: Array.from({ length: changes }, (_, index) => ({
          targetId: idOf(index + 1), action: 'set', forwardLabels: ['师父'], reverseLabels: ['徒弟'], reason: '固定样本关系修改',
        })), done: true, reason: '当前人物关系完成',
      }))
      expect(ack).toMatchObject({ ok: true, changed: true, complete: true, failed: [] })
      expect(ack.applied).toHaveLength(changes)
      await repo.transaction(false, async store => {
        expect((await store.get('characters', idOf(0)))!.revision).toBe(changes + 1)
        for (let index = 1; index <= changes; index++) {
          expect((await store.get('characters', idOf(index)))!.revision).toBe(2)
          expect(await store.get('characterRelationEdits', relations.pairKeyOf(idOf(0), idOf(index))))
            .toMatchObject({ aToBLabels: [reverseIds ? '徒弟' : '师父'], bToALabels: [reverseIds ? '师父' : '徒弟'], revision: 1 })
        }
      })
      // 下一次工具调用必须看到前一次提交，不可复用旧邻接结果或旧版本指纹。
      const queried = await execute('query_relation_work', { characterId: idOf(0), targetIds: [idOf(1)] })
      const current = await repo.transaction(false, store => review.reviewContext(store))
      expect((queried.data as { relations: Row[] }).relations[0]).toMatchObject({
        forward: ['师父'], reverse: ['徒弟'], fingerprint: current.pairs.find(pair => pair.pairKey === relations.pairKeyOf(idOf(0), idOf(1)))!.fingerprint,
      })
    }
    const result = { optimization: 9, sample: { characters: people.length, relationFacts: facts.length,
      currentCharacterNeighbors: 12, unresolvedRelations: 2, deletedPairs: 1 }, measurements: all }
    if (process.env.WW_OPT09_EXPECT !== 'before') {
      expect(all.find(row => row.name === 'submit_8_pairs')!.fullGraphBuilds).toBe(3)
      expect(all.find(row => row.name === 'submit_8_pairs')!.tableReads.characterRelations).toBe(3)
      expect(all.find(row => row.name === 'query_one_character')!.tableReads.characterRelations).toBe(1)
    }
    if (!reverseIds && process.env.WW_OPT09_RESULT) writeFileSync(process.env.WW_OPT09_RESULT, `${JSON.stringify(result, null, 2)}\n`)
    console.log(JSON.stringify(result))
  } finally { measuring = undefined; for (const spy of spies) spy.mockRestore() }
})

test('事务内人物对快照与原全量写入的新增、反向、多目标、删除、恢复及冲突结果相等', async () => {
  const characters = ['A', 'B', 'C', 'Z'].map(id => ({ id, name: id, bookId, revision: 1, aliases: [], confidence: 1, createdBy: 'P1' as const }))
  const facts: CharacterRelation[] = [{ id: 'multi', originCharacterId: 'A', relationType: 'family', revision: 1, createdAt: '', updatedAt: '', bookId, sourceId: 'A', targetIds: ['B', 'C'], sourceName: 'A', targetName: '同名', forwardLabel: '长辈', reverseLabel: '晚辈', evidence: [], direction: 'bidirectional' }]
  const run = async (cached: boolean) => {
    const repo = createMemoryAgentRepository(bookId, { characters, characterRelations: facts as unknown as Row[] })
    return repo.transaction(true, async store => {
      const context = cached ? createPairWriteContext(store, characters as Character[], facts as CharacterRelation[], []) : undefined
      const results = []
      const steps = [
        ['Z', 'A', 'set'], ['Z', 'B', 'set'], ['B', 'A', 'set'], ['Z', 'A', 'set'],
        ['Z', 'B', 'delete'], ['Z', 'B', 'delete'], ['Z', 'B', 'set'],
      ] as const
      for (const [index, [fromId, toId, action]] of steps.entries()) {
        const currentPeople = await store.rows('characters') as unknown as Character[]
        const edits = await store.rows('characterRelationEdits')
        const current = relations.pairFromPerspective(relations.effectivePairs(facts as CharacterRelation[], edits as never, currentPeople), fromId, toId, currentPeople)
        const input: PairWriteInput = { bookId, fromId, toId, forwardLabels: ['师父'], reverseLabels: ['徒弟'], reason: '固定差分样本', actor: 'agent', commitId: `commit-${index}`, tool: 'fixture', expectedFingerprint: current.fingerprint }
        const result = await (action === 'set' ? saveCharacterPair : deleteCharacterPair)(store, input, context)
        results.push(result)
        if (index === 0) await expect(saveCharacterPair(store, { ...input, forwardLabels: ['新标签'] }, context)).rejects.toThrow('CONFLICT')
      }
      return { results, characters: await store.rows('characters'), edits: await store.rows('characterRelationEdits') }
    })
  }
  const stable = (value: unknown) => JSON.parse(JSON.stringify(value, (key, value) => ['timestamp', 'updatedAt'].includes(key) ? undefined : value))
  expect(stable(await run(true))).toEqual(stable(await run(false)))
})
