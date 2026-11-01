import { expect, it } from 'vitest'
import { createMemoryAgentRepository } from '../src/features/agents/repository'
import { acceptIdentityMerge, coverageFingerprint, identityWorkId, saveIdentityQueue } from '../src/features/world/queue'

it('派生统计变化保留身份覆盖，原文变化使依赖该章的覆盖失效', async () => {
  const person = { id: 'person', bookId: 'book', name: '沈青', revision: 1, roleWeightSource: 'frequency', roleWeight: 'NPC' }
  const chapter = { bookId: 'book', chapterIndex: '1', text: '沈青是船夫。' }
  const repo = createMemoryAgentRepository('book', {
    characters: [person], chapterTexts: [chapter],
    pipelineRuns: [{ id: 'run', bookId: 'book', coverageItems: [{
      workItemId: 'ai_identity:fullBook:character:person', status: 'checked',
      coveredFingerprint: await coverageFingerprint('characters', person),
      dependencies: { records: [{ table: 'chapterTexts', id: '1', resolvedId: '1', factFingerprint: await coverageFingerprint('chapterTexts', chapter) }], queries: [] },
    }] }],
  })
  await repo.transaction(true, store => store.put('characters', { ...person, revision: 2, roleWeight: '主要人物', frequency: { mentions: 100 } }))
  expect((await saveIdentityQueue(repo, 'run')).coverage.checked).toBe(1)
  await repo.transaction(true, store => store.put('chapterTexts', { ...chapter, text: '沈青是药师。' }))
  expect((await saveIdentityQueue(repo, 'run')).coverage.checked).toBe(0)
})

it('旧成功项仅因浏览目录而失效时恢复完成；自身内容变化仍待处理', async () => {
  const people = ['A', 'B'].map(id => ({ id, name: id, bookId: 'book', revision: 1 }))
  const records = await Promise.all(people.map(async row => ({ table: 'characters', id: row.id, resolvedId: row.id, factFingerprint: await coverageFingerprint('characters', row) })))
  const repo = createMemoryAgentRepository('book', { characters: people, pipelineRuns: [{ id: 'run', bookId: 'book', coverageItems: [{
    workItemId: identityWorkId('character', 'A'), kind: 'character', id: 'A', status: 'pending', taskId: 'old-success', outcome: 'no_change',
    coveredFingerprint: await coverageFingerprint('characters', people[0]), dependencies: { records, queries: [{ tool: 'query_characters', args: {} }, { tool: 'get_character_detail', args: { ids: ['A'] } }] },
  }] }] })
  await repo.transaction(true, store => store.put('characters', { ...people[1], aliases: ['其他称呼'] }))
  expect((await saveIdentityQueue(repo, 'run')).items.find(item => item.id === 'A')?.status).toBe('checked')
  await repo.transaction(true, store => store.put('characters', { ...people[0], identity: '新身份' }))
  expect((await saveIdentityQueue(repo, 'run')).items.find(item => item.id === 'A')?.status).toBe('pending')
})

it('实际打开的候选详情被人工修改时保留复核要求', async () => {
  const a = { id: 'A', name: 'A', bookId: 'book' }, b = { id: 'B', name: 'B', bookId: 'book' }
  const repo = createMemoryAgentRepository('book', { characters: [a, b], pipelineRuns: [{ id: 'run', bookId: 'book', coverageItems: [{
    workItemId: identityWorkId('character', 'A'), id: 'A', kind: 'character', status: 'checked', coveredFingerprint: await coverageFingerprint('characters', a),
    dependencies: { records: [{ table: 'characters', id: 'B', resolvedId: 'B', factFingerprint: await coverageFingerprint('characters', b) }], queries: [{ tool: 'get_character_detail', args: { ids: ['B'] } }] },
  }] }] })
  await repo.transaction(true, store => store.put('characters', { ...b, identity: '新身份' }))
  expect((await saveIdentityQueue(repo, 'run')).items.find(item => item.id === 'A')?.status).toBe('pending')
})

it('已确认合并同步保留目标、旧编号依赖和失败报告', async () => {
  const people = ['A', 'B', 'C'].map(id => ({ id, name: id, bookId: 'book', revision: 1 }))
  const dependencies = { records: await Promise.all(people.map(async row => ({ table: 'characters', id: row.id, resolvedId: row.id, factFingerprint: await coverageFingerprint('characters', row) }))), queries: [{ tool: 'get_character_detail', args: { ids: ['A', 'B', 'C'] } }] }
  const coverageItems = await Promise.all(people.map(async row => ({ workItemId: identityWorkId('character', row.id), kind: 'character', id: row.id, status: row.id === 'A' ? 'checked' : 'pending', coveredFingerprint: await coverageFingerprint('characters', row), dependencies })))
  const repo = createMemoryAgentRepository('book', { characters: people, pipelineRuns: [{ id: 'run', bookId: 'book', coverageItems, report: { failed: ['B：先前提交失败', '其他故障'] } }] })
  await repo.transaction(true, async store => {
    await store.put('characters', { ...people[1], aliases: ['C'], revision: 2 })
    await store.remove('characters', 'C')
    await acceptIdentityMerge(store, 'run', 'merge-task', 'character', ['B', 'C'], 'B', { records: [], queries: [] })
  })
  const queue = await saveIdentityQueue(repo, 'run')
  expect(queue.coverage).toEqual({ total: 2, checked: 2, pendingIds: [] })
  expect(queue.coverageItems.find(item => item.id === 'C')?.status).toBe('skipped')
  expect(await repo.transaction(false, store => store.get('pipelineRuns', 'run'))).toMatchObject({ report: { failed: ['其他故障'] } })
})

it('P3维护节点关联和修订号时保留P2结论，节点正文变化才复核', async () => {
  const person = { id: 'person', bookId: 'book', name: '沈青', revision: 1 }
  const node = { id: 'node', bookId: 'book', summary: '沈青送信', revision: 1, eventLineIds: [] }
  const repo = createMemoryAgentRepository('book', { characters: [person], nodes: [node], pipelineRuns: [{ id: 'run', bookId: 'book', coverageItems: [{ workItemId: identityWorkId('character', 'person'), kind: 'character', id: 'person', status: 'checked', coveredFingerprint: await coverageFingerprint('characters', person), dependencies: { records: [{ table: 'nodes', id: 'node', resolvedId: 'node', factFingerprint: await coverageFingerprint('nodes', node) }], queries: [{ tool: 'get_node_detail', args: { ids: ['node'] } }] } }] }] })
  await repo.transaction(true, store => store.put('nodes', { ...node, revision: 2, eventLineIds: ['new-line'] }))
  expect((await saveIdentityQueue(repo, 'run')).coverage.checked).toBe(1)
  await repo.transaction(true, store => store.put('nodes', { ...node, revision: 3, summary: '送信者是另一人' }))
  expect((await saveIdentityQueue(repo, 'run')).coverage.checked).toBe(0)
})
