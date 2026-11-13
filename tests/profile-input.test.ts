import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { Character } from '../src/features/assets/types'
import { createMemoryAgentRepository, type Row } from '../src/features/agents/repository'
import { profileWork } from '../src/features/agents/organizationData'
import { profileContent } from '../src/features/agents/organizationReview'
import { readTool, type Scope } from '../src/features/agents/queries'
import { createAgentTools } from '../src/features/agents/tools'
import { hash } from '../src/features/agents/contracts'
import { organizationPrompt } from '../src/features/world/organizationPrompt'

const person: Character = {
  id: 'A', bookId: 'profile-input', name: '样本人物', aliases: [], identity: '船夫', profile: { ageText: '约三十岁' },
  revision: 1, confidence: 1, createdBy: 'P1', chapterIndex: '1', chapterName: '第一章', sourceChapters: ['1'],
  mergeFacts: [{ id: 'fact-only', field: 'identity', text: '仅在底稿中存在的测试标记', chapters: ['1'] }],
}

function fixture() {
  const scope: Scope = { bookId: person.bookId, runId: 'run', taskId: 'task', owner: 'owner', profile: 'asset_editor', phase: 'character_organization', workKind: 'profile', unitId: 'profile:A', workItemIds: [] }
  const repo = createMemoryAgentRepository(person.bookId, {
    characters: [structuredClone(person) as unknown as Row],
    chapters: [{ chapterIndex: '1', bookId: person.bookId, chapterName: '第一章', order: 0 }],
    pipelineRuns: [
      { id: 'lease:world', bookId: person.bookId, owner: scope.owner, runId: scope.runId, expiresAt: Date.now() + 60000 },
      { id: scope.runId, bookId: person.bookId, status: 'running', report: { assetEdits: [] }, tasks: [{ taskId: scope.taskId, input: { workItems: [] }, appliedCommitIds: [], reviewedItems: [] }], commandIntents: [], appliedCommands: [], organization: {
        step: 'profiles', revision: 1, profileItems: [{ id: person.id, status: 'pending', commitIds: [] }],
        activeWork: { id: 'profile:A', kind: 'profile', characterId: person.id, dataVersion: 1, commitIds: [] },
      } },
    ],
  })
  const adapter = createAgentTools(repo, scope)
  const submit = async (args: Row) => {
    const result = await adapter.tools.find(tool => tool.name === 'submit_profile_review')!.execute(crypto.randomUUID(), args)
    return JSON.parse(result.content.filter(part => part.type === 'text').map(part => part.text).join('')) as Row
  }
  return { repo, scope, submit }
}

it('预载和资料查询不暴露mergeFacts，底层事实及内部内容指纹保持不变', async () => {
  const { repo, scope } = fixture()
  const original = structuredClone(person)
  const beforeFingerprint = await hash(profileContent(person as unknown as Row))
  const preload = await profileWork(person)
  const queried = await repo.transaction(true, store => readTool(store, scope, 'query_character_profile', {}))
  for (const value of [preload, queried]) {
    expect(JSON.stringify(value)).not.toContain('mergeFacts')
    expect(JSON.stringify(value)).not.toContain('仅在底稿中存在的测试标记')
    expect(JSON.stringify(value)).toContain('船夫')
  }
  expect(person).toEqual(original)
  const stored = await repo.transaction(false, store => store.get('characters', person.id))
  expect(stored?.mergeFacts).toEqual(original.mergeFacts)
  expect(await hash(profileContent(stored!))).toBe(beforeFingerprint)
  expect(profileContent(stored!)).toHaveProperty('mergeFacts', original.mergeFacts)
})

it('旧工作项数据生成资料提示时剔除底稿、版本和内部字段清单，不修改旧数据', () => {
  const data = { ...structuredClone(person), fields: ['identity', 'mergeFacts', 'sourceChapters'] }
  const before = structuredClone(data)
  const prompt = organizationPrompt({ kind: 'profile', characterId: person.id, summary: person.name, data })
  expect(prompt).not.toContain('mergeFacts')
  expect(prompt).not.toContain('仅在底稿中存在的测试标记')
  expect(prompt).not.toContain('"revision"')
  expect(prompt).not.toContain('"fields"')
  expect(prompt).toContain('船夫')
  expect(data).toEqual(before)
})

it('七个字段超过提示词字数仍完整保存，不截断、不拒绝提交', async () => {
  const { repo, submit } = fixture()
  const patch = { aliases: ['别'.repeat(51)], ageText: '岁'.repeat(21), identity: '身'.repeat(151), appearance: '貌'.repeat(201), personality: '性'.repeat(151), background: '背'.repeat(301), speechStyleSample: '话'.repeat(301) }
  expect(await submit({ patch, done: true, reason: '固定响应验证字数仅为提示词约束' })).toMatchObject({ ok: true, changed: true, complete: true })
  const stored = await repo.transaction(false, store => store.get('characters', person.id))
  const { ageText, ...flat } = patch
  expect(stored).toMatchObject({ ...flat, profile: { ageText } })
})

it('空提交准确说明未修改，已有修改后空提交完成仍保留已修改结果', async () => {
  const empty = fixture()
  expect(await empty.submit({ patch: {}, done: true })).toMatchObject({ ok: true, changed: false, outcome: 'no_change', summary: '本次未修改，已结束检查。' })
  const modified = fixture()
  expect(await modified.submit({ patch: { identity: '青石渡船夫' }, done: false })).toMatchObject({ ok: true, changed: true, done: false })
  const result = await modified.submit({ patch: {}, done: true })
  expect(result).toMatchObject({ ok: true, outcome: 'changed', complete: true })
  expect(result.summary).not.toBe('本次未修改，已结束检查。')
})

it('资料提示词明确七项字数目标并保留工具外说明空间', () => {
  const prompt = readFileSync(new URL('../docs/v2/resources/v2.2/prompts/active/p2-organization-profiles.md', import.meta.url), 'utf8')
  for (const [field, limit] of [['别名', 50], ['年龄描述', 20], ['身份', 150], ['外貌', 200], ['性格', 150], ['背景', 300], ['原话片段', 300]] as const) {
    expect(prompt).toMatch(new RegExp(`${field}[^\\n]*${limit}`))
  }
  expect(prompt).not.toContain('不发额外结束总结')
  expect(prompt).not.toContain('不要另发结束总结')
  expect(prompt).toMatch(/可以[^\n]*工具调用之外[^\n]*说明/)
})
