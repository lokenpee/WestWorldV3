import { expect, it } from 'vitest'
import { normalizeCharacterNames } from '../src/features/assets/characterNames'
import { bindCharacterNames, characterCandidates } from '../src/features/assets/characterLinks'
import { resolveReferences } from '../src/features/assets/derive'
import { fuseWorldAssets } from '../src/features/assets/merge'
import { findCandidates } from '../src/features/world/candidates'
import { optimizationRequest } from '../src/features/world/optimization'
import { createMemoryAgentRepository } from '../src/features/agents/repository'
import { readTool, type Scope } from '../src/features/agents/queries'
import type { Character, EventNode } from '../src/features/assets/types'

const person = (id: string, name: string, aliases: string[] = []): Character => ({ id, name, aliases, bookId: 'book', revision: 1, confidence: 1, createdBy: 'P1', sourceChapters: ['1'] })
it('旧档案的通用别称不再自动绑定，限定称呼与人工选择仍有效', () => {
  const people = [person('a', '林如海', ['爸爸', '姑父', '林姑父']), person('b', '太后', ['娘娘'])]
  for (const name of ['爸爸', '姑父', '太后', '娘娘']) expect(characterCandidates(name, people)).toEqual([])
  expect(characterCandidates('林姑父', people).map(row => row.id)).toEqual(['a'])
  expect(bindCharacterNames(['太后'], people, ['b'])).toEqual({ ids: ['b'], names: ['太后'] })
  const node = { id: 'n', actors: ['爸爸', '太后'], targets: [] } as unknown as EventNode
  expect(resolveReferences([node], people).n.actorIds).toEqual([])
  expect(resolveReferences([{ ...node, actorIds: ['b'] }], people).n.actorIds).toEqual(['b'])
})

it('相同职务主名不生成机械合并候选，真实别名仍可生成候选', () => {
  expect(findCandidates('character', [person('a', '太后'), person('b', '太后')])).toEqual([])
  expect(findCandidates('character', [person('a', '甲', ['娘娘']), person('b', '乙', ['娘娘'])])).toEqual([])
  expect(findCandidates('character', [person('a', '林如海'), person('b', '林如海')])).toHaveLength(1)
})

it('合并与整编保留称谓说明，通用称谓不会重新写回别名', async () => {
  const old = { ...person('a', '林如海', ['爸爸', '林姑父']), identity: '官员', mergeFacts: [{ id: 'F-old', field: 'identity', text: '官员', chapters: ['1'] }] }
  const normalized = normalizeCharacterNames(old)
  expect(normalizeCharacterNames(normalized)).toEqual(normalized)
  expect(normalized.mergeFacts.some(fact => fact.text === '原文称谓：爸爸')).toBe(true)
  const merged = fuseWorldAssets('character', [old, person('b', '姑父')], 'a', '林如海').result
  expect(merged.aliases).toEqual(['林姑父'])
  expect(merged.identity).toContain('姑父')
  expect(merged.mergeFacts?.some(fact => fact.text === '原文称谓：姑父')).toBe(true)
  const request = await optimizationRequest('character', old)
  expect(JSON.stringify(request.input)).toContain('原文称谓：爸爸')
  const schema = request.schema as unknown as { properties: { entities: { properties: Record<string, { properties: { entity: { properties: { aliases: { items: { enum: string[] } } } } } }> } } }
  expect(schema.properties.entities.properties.a.properties.entity.properties.aliases.items.enum).toEqual(['林如海', '林姑父'])
  expect(old.aliases).toEqual(['爸爸', '林姑父'])
})

it('AI查询旧档案收到整理后的称谓，数据库原记录保持可追溯', async () => {
  const old = person('a', '宋皇后', ['娘娘', '宋娘娘'])
  const repo = createMemoryAgentRepository('book', { characters: [old as unknown as Record<string, unknown>] })
  const scope: Scope = { bookId: 'book', profile: 'asset_editor', phase: 'ai_identity', runId: 'run', taskId: 'task', owner: 'owner', workItemIds: [] }
  const detail = await repo.transaction(false, store => readTool(store, scope, 'get_character_detail', { ids: ['a'] }))
  expect(detail.data).toMatchObject([{ aliases: ['宋娘娘'], identity: '原文称谓：娘娘' }])
  const list = await repo.transaction(false, store => readTool(store, scope, 'query_characters', {}))
  expect(list.data).toMatchObject([{ aliases: ['宋娘娘'], identityHint: '原文称谓：娘娘' }])
  expect(await repo.transaction(false, store => store.get('characters', 'a'))).toMatchObject({ aliases: ['娘娘', '宋娘娘'] })
})
