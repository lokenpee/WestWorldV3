import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { JsonValue } from '@earendil-works/pi-ai'
import type { AgentRepository, Row } from './repository'
import { canonical, hash, records, resultContracts, strings, summarySchema, text, toolContracts, validate, type Summary } from './contracts'
import { assertScope, readTool, toolBytes, type Scope } from './queries'
import { checkLease, commitCommand, saveTask, taskOf, validateReadSet, type CommitAck, type ReadSet } from './commands'

const tableOf: Record<string, string> = { get_character_detail: 'characters', get_location_detail: 'locations', get_node_detail: 'nodes', get_event_line_detail: 'eventLines', query_characters: 'characters', query_locations: 'locations', query_nodes: 'nodes', query_event_lines: 'eventLines', query_editor_notes: 'storyEditorNotes', get_editor_note_detail: 'storyEditorNotes' }
export function createAgentTools(repo: AgentRepository, scope: Scope, options: { afterCommit?: (ack: CommitAck) => Promise<void>; initialReadSet?: ReadSet } = {}) {
  const reads: ReadSet = structuredClone(options.initialReadSet ?? { records: [], queries: [] })
  let summary: Summary | undefined
  let readCalls = 0; let writeCalls = 0
  const tools: AgentTool[] = toolContracts[scope.profile].map(contract => ({ name: contract.name, description: contract.description, label: contract.name,
    parameters: scope.phase !== 'optimize' && ((contract.parameters as { properties?: Row }).properties)?.include_facts ? { ...contract.parameters, properties: { ...((contract.parameters as { properties?: Row }).properties), include_facts: { type: 'boolean', const: false } } } : contract.parameters,
    outputSchema: resultContracts.get(contract.name),
    async execute(toolCallId, parameters, signal) {
      assertScope(scope, repo.bookId); signal?.throwIfAborted(); validate(contract.parameters, parameters)
      if (toolBytes(parameters) > 65536) throw new Error('TOO_LARGE:工具参数超过单次处理上限。')
      const args = parameters as Row
      if (scope.probe && !(scope.profile === 'asset_editor' ? ['get_character_detail', 'read_original', 'commit_asset_changes'] : ['get_editor_memory', 'commit_story_changes']).includes(contract.name)) throw new Error('INVALID_ARGS:探针仅允许指定调用。')
      let value: Row
      if (contract.kind === 'write') {
        const ack = await commitCommand(repo, scope, contract.name, toolCallId, args, reads, signal)
        writeCalls++; await options.afterCommit?.(ack)
        value = ack as unknown as Row
      } else {
        value = await repo.transaction(false, async store => { await checkLease(store, scope, signal); return readTool(store, scope, contract.name, args, contract.maxResults) })
        if (toolBytes(value) > 65536) throw new Error('TOO_LARGE:工具结果超过单次返回上限。')
        const output = resultContracts.get(contract.name)
        if (output) validate(output, value, `INVALID_RESULT:${contract.name}返回结构不符合要求。`)
        const fingerprint = await hash(value)
        const query = { tool: contract.name, args: structuredClone(args), resultFingerprint: fingerprint }
        const at = reads.queries.findIndex(read => read.tool === query.tool && canonical(read.args) === canonical(query.args))
        if (at < 0) reads.queries.push(query); else reads.queries[at] = query
        await repo.transaction(true, async store => {
          await checkLease(store, scope, signal)
          const table = tableOf[contract.name]
          const items = records(value.data)
          if (table) for (const item of items) {
            if (item.fields_omitted) continue
            const id = strings(item.resolvedFrom)[0] || text(item.id); const resolvedId = text(item.id)
            const row = await store.get(table, resolvedId)
            const dependency = { table, id, resolvedId, revision: Number(row?.revision ?? 0), factFingerprint: await store.wait(hash(row ?? null)) }
            const index = reads.records.findIndex(read => read.table === table && read.id === id)
            if (index < 0) reads.records.push(dependency); else reads.records[index] = dependency
          }
          if (contract.name === 'read_original') for (const id of strings(value.chapters)) {
            const row = await store.get('chapterTexts', id)
            const dependency = { table: 'chapterTexts', id, resolvedId: row ? id : null, revision: 0, factFingerprint: await store.wait(hash(row ?? null)) }
            const index = reads.records.findIndex(read => read.table === 'chapterTexts' && read.id === id)
            if (index < 0) reads.records.push(dependency); else reads.records[index] = dependency
          }
          if (contract.name === 'get_editor_memory') {
            const id = text((value.memory as Row).id); const row = await store.get('storyEditorMemory', id)
            const dependency = { table: 'storyEditorMemory', id, resolvedId: row ? id : null, revision: Number(row?.revision ?? 0), factFingerprint: await store.wait(hash(row ?? null)) }
            const index = reads.records.findIndex(read => read.table === dependency.table && read.id === id)
            if (index < 0) reads.records.push(dependency); else reads.records[index] = dependency
          }
          await saveTask(store, scope, { readSet: reads })
        }); readCalls++
      }
      const output = resultContracts.get(contract.name)
      if (output) validate(output, value, `INVALID_RESULT:${contract.name}返回结构不符合要求。`)
      return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value, structuredContent: value as JsonValue }
    },
  }))
  tools.push({ name: 'submit_result', label: '提交任务总结', description: '汇总当前任务的真实提交确认和待处理项。', parameters: summarySchema,
    outputSchema: { type: 'object', properties: { accepted: { const: true }, status: { enum: ['completed', 'partial'] }, commitIds: { type: 'array', items: { type: 'string' }, uniqueItems: true } }, required: ['accepted', 'status', 'commitIds'], additionalProperties: false },
    async execute(_id, parameters, signal) {
      signal?.throwIfAborted(); validate(summarySchema, parameters)
      if (toolBytes(parameters) > 65536) throw new Error('TOO_LARGE:任务总结超过单次处理上限。')
      const proposed = parameters as unknown as Summary
      await repo.transaction(true, async store => {
        await checkLease(store, scope, signal)
        if (!scope.probe && scope.profile === 'story_editor') await validateReadSet(store, scope, reads)
        const { task } = await taskOf(store, scope)
        const actual = strings(task.appliedCommitIds)
        if (canonical([...actual].sort()) !== canonical([...proposed.commitIds].sort())) throw new Error('INVALID_ARGS:总结中的提交确认须与本任务真实提交一致。')
        const partition = [...proposed.reviewedItems.map(item => item.workItemId), ...proposed.remainingWorkIds]
        if (new Set(partition).size !== partition.length || canonical([...partition].sort()) !== canonical([...scope.workItemIds].sort()) || proposed.status === 'completed' && proposed.remainingWorkIds.length) throw new Error('INVALID_ARGS:总结须逐项说明已处理和待处理范围。')
        if (scope.probe && (!readCalls || !writeCalls || actual.length !== 1 || proposed.status !== 'completed')) throw new Error('INVALID_ARGS:探针须完成规定的读取、写入和最终确认。')
        const unreadLines = (scope.requiredLineIds ?? []).filter(id => !reads.records.some(read => read.table === 'eventLines' && (read.id === id || read.resolvedId === id)))
        if (unreadLines.length && proposed.status === 'completed') throw new Error(`INVALID_ARGS:已有事件线目录尚未读全，请分页查询后总结；待查询编号：${unreadLines.slice(0, 50).join('、')}`)
        if (!scope.probe) for (const item of proposed.reviewedItems) {
          const work = records((task.input as Row).workItems).find(work => work.workItemId === item.workItemId)
          const table = ({ character: 'characters', location: 'locations', node: 'nodes', eventLine: 'eventLines', note: 'storyEditorNotes' } as Record<string, string>)[text(work?.kind)]
          if (!work || !reads.records.some(read => read.table === table && (read.id === work.id || read.resolvedId === work.id))) throw new Error('INVALID_ARGS:完成总结须有实际读取依据。')
          const changed = records(task.reviewedItems).some(row => row.workItemId === item.workItemId && row.outcome === 'changed')
          if (item.outcome === 'changed' && (!actual.length || !changed)) throw new Error('INVALID_ARGS:修改结论缺少该项的真实写入依据。')
          if (item.outcome === 'no_change' && changed) throw new Error('INVALID_ARGS:该项资料已修改，请在总结中如实说明。')
        }
        await saveTask(store, scope, { reviewedItems: proposed.reviewedItems })
      })
      summary = proposed
      const value = { accepted: true, status: summary.status, commitIds: summary.commitIds }
      return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value, structuredContent: value as JsonValue }
    },
  })
  return { tools, reads, get summary() { return summary }, get readCalls() { return readCalls }, get writeCalls() { return writeCalls } }
}
