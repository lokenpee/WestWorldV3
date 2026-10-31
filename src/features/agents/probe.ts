import { createMemoryAgentRepository } from './repository'
import { createAgentRuntime, type AgentRunner, type AgentTaskResult } from './runtime'
import { records } from './contracts'
import system from '../../../docs/v2/resources/v2.2/prompts/active/probe_system.txt?raw'
import assetPrompt from '../../../docs/v2/resources/v2.2/prompts/active/probe_asset.txt?raw'
import storyPrompt from '../../../docs/v2/resources/v2.2/prompts/active/probe_story.txt?raw'

export type ProbeSuite = 'asset' | 'story'
export interface ToolProbeOptions { signal?: AbortSignal; onProgress?: (progress: { suite: ProbeSuite; step: string }) => void }
export interface ProbeResult { suite: ProbeSuite; ok: boolean; error?: string; commitIds: string[]; readCalls: number; writeCalls: number; attempts: number; elapsedMs: number }
export async function runToolProbe(runner: AgentRunner, options: ToolProbeOptions = {}) {
  const results: ProbeResult[] = []
  for (const suite of ['asset', 'story'] as const) {
    if (options.signal?.aborted) break
    const bookId = `probe-${crypto.randomUUID()}`; const taskId = crypto.randomUUID(); const operationKey = crypto.randomUUID()
    const createdAt = new Date().toISOString(); const original = '第二章的沈青就是第一章的沈青。'
    const repo = createMemoryAgentRepository(bookId, {
      chapters: ['1', '2'].map((chapterIndex, order) => ({ bookId, chapterIndex, chapterName: `第${chapterIndex}章`, order, charCount: original.length })),
      chapterTexts: ['1', '2'].map(chapterIndex => ({ bookId, chapterIndex, text: original })),
      characters: suite === 'asset' ? ['C1-P001', 'C2-P001'].map(id => ({ id, bookId, name: '沈青', aliases: [], confidence: 1, revision: 1, createdBy: 'P1' })) : [],
    })
    options.onProgress?.({ suite, step: '准备隔离样本' })
    const prompt = (suite === 'asset' ? assetPrompt : storyPrompt).replaceAll('{taskId}', taskId).replaceAll('{operationKey}', operationKey)
    let outcome: AgentTaskResult | undefined
    try {
      outcome = await createAgentRuntime(runner).run(repo, { profile: suite === 'asset' ? 'asset_editor' : 'story_editor', phase: suite === 'asset' ? 'ai_identity' : 'window_link', probe: true, taskId, prompt, businessPrompt: system, workItems: [], input: { suite, taskId, operationKey }, signal: options.signal, maxRequests: 3, timeoutMs: 30000, maxTokens: 1024,
        onEvent: event => { if (event.type === 'tool_execution_start') options.onProgress?.({ suite, step: event.toolName }); else if (event.type === 'turn_start') options.onProgress?.({ suite, step: '模型生成' }) },
      })
      if (outcome.ok) await repo.transaction(false, async store => {
        const run = (await store.get('pipelineRuns', outcome!.runId))!
        if (records(run.appliedCommands).length !== 1 || outcome!.commitIds.length !== 1 || outcome!.summary?.commitIds[0] !== outcome!.commitIds[0]) throw new Error('提交确认与最终总结不一致。')
        if (suite === 'asset') {
          const keep = await store.get('characters', 'C1-P001'); const removed = await store.get('characters', 'C2-P001'); const mapping = await store.get('assetLifecycle', 'character:C2-P001')
          if (keep?.revision !== 2 || removed || mapping?.state !== 'merged' || mapping.currentId !== 'C1-P001' || outcome!.readCalls < 2) throw new Error('人物读取、合并或来源确认未通过。')
        } else {
          const memory = await store.get('storyEditorMemory', outcome!.sessionId!)
          if (memory?.revision !== 1 || memory.workingSummary !== '隔离探针摘要' || (await store.rows('nodes')).length || (await store.rows('eventLines')).length) throw new Error('工作记忆写入或叙事隔离确认未通过。')
        }
      })
      results.push({ suite, ok: outcome.ok, error: outcome.error, commitIds: outcome.commitIds, readCalls: outcome.readCalls, writeCalls: outcome.writeCalls, attempts: outcome.result?.attempts.length ?? 0, elapsedMs: outcome.result?.elapsedMs ?? Date.now() - Date.parse(createdAt) })
    } catch (error) { results.push({ suite, ok: false, error: error instanceof Error ? error.message : '隔离探测失败。', commitIds: outcome?.commitIds ?? [], readCalls: outcome?.readCalls ?? 0, writeCalls: outcome?.writeCalls ?? 0, attempts: outcome?.result?.attempts.length ?? 0, elapsedMs: Date.now() - Date.parse(createdAt) }) }
  }
  return { ok: results.length === 2 && results.every(result => result.ok), cancelled: !!options.signal?.aborted, results }
}
