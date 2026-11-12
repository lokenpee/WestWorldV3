import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { JsonValue } from '@earendil-works/pi-ai'
import type { AgentRepository, Row } from './repository'
import { canonical, hash, records, resultContracts, strings, summarySchema, text, toolContracts, validate, type Summary } from './contracts'
import { assertScope, readTool, toolBytes, type Scope } from './queries'
import { assetReviewTools, checkLease, commitCommand, relationTools, saveTask, taskOf, validateReadSet, type CommitAck, type ReadSet } from './commands'
import { noteOrganizationRead } from './organizationReview'

const tableOf: Record<string, string> = { get_character_detail: 'characters', get_location_detail: 'locations', get_node_detail: 'nodes', get_event_line_detail: 'eventLines', query_characters: 'characters', query_locations: 'locations', query_nodes: 'nodes', query_event_lines: 'eventLines', query_editor_notes: 'storyEditorNotes', get_editor_note_detail: 'storyEditorNotes' }
const initialToolNames = (scope: Scope): string[] | null => {
  if (scope.probe) return scope.profile === 'asset_editor'
    ? ['get_character_detail', 'read_original', 'commit_asset_changes', 'submit_result']
    : ['get_editor_memory', 'commit_story_changes', 'submit_result']
  if (scope.phase === 'character_organization') {
    if (!scope.workKind) return null
    return {
      directory: ['query_character_catalog', 'save_candidate_group', 'record_organization_progress', 'submit_result'],
      candidate: ['get_character_detail', 'get_location_detail', 'read_original', 'merge_assets', 'resolve_candidate_group', 'submit_result'],
      profile: ['query_character_profile', 'get_character_detail', 'read_original', 'edit_character', 'submit_profile_review'],
      relations: ['submit_relation_review', 'query_relation_work', 'read_original', 'get_character_relation', 'get_legacy_relation_records'],
    }[scope.workKind]
  }
  if (scope.phase === 'ai_identity') return ['query_characters', 'query_locations', 'get_character_detail', 'get_location_detail', 'read_original', 'commit_asset_changes', 'submit_result']
  if (scope.phase === 'asset_review') return scope.reviewScope === 'relations'
    ? ['get_character_relation', 'get_legacy_relation_records', 'get_character_detail', 'read_original', 'set_character_relation', 'delete_character_relation', 'submit_result']
    : ['get_character_detail', 'get_location_detail', 'get_node_detail', 'get_event_line_detail', 'get_character_relation', 'read_original', 'edit_character', 'edit_location', 'edit_event_node', 'edit_event_line', 'set_character_relation', 'delete_character_relation', 'submit_result']
  if (scope.profile === 'story_editor') return ['get_node_detail', 'query_nodes', 'query_event_lines', 'get_event_line_detail', 'read_original', 'get_editor_memory', 'query_editor_notes', 'get_editor_note_detail', 'search_story_context', 'commit_story_changes', 'submit_result']
  return null
}
export function createAgentTools(repo: AgentRepository, scope: Scope, options: { afterCommit?: (ack: CommitAck) => Promise<void>; initialReadSet?: ReadSet } = {}) {
  const reads: ReadSet = structuredClone(options.initialReadSet ?? { records: [], queries: [] })
  let summary: Summary | undefined
  let readCalls = 0; let writeCalls = 0
  let completedWork = false
  const relationOnly = scope.phase === 'asset_review' && scope.reviewScope === 'relations'
  const organization = scope.phase === 'character_organization'
  const workKind = scope.workKind
  // 模型只填写业务参数；执行入口继续兼容历史调用中的操作键和批次依据。
  const modelParameters = (name: string, schema: AgentTool['parameters']): AgentTool['parameters'] => {
    const properties = { ...((schema as { properties?: Row }).properties) }
    if (organization && ['submit_profile_review', 'submit_relation_review'].includes(name)) delete properties.operationKey
    if (organization && name === 'submit_relation_review') delete properties.basis
    if (scope.phase !== 'optimize' && !organization && properties.include_facts) properties.include_facts = { type: 'boolean', const: false }
    return { ...schema, properties }
  }
  const organizationAllows = (name: string) => {
    if (!organization) return true
    if (name === 'commit_asset_changes') return false
    if (name === 'record_organization_progress') return !workKind || ((workKind === 'directory' || workKind === 'candidate') && (!scope.organizationStep || ['scan', 'resolve'].includes(scope.organizationStep)))
    if (name === 'clear_candidate_groups') return !workKind || (workKind === 'candidate' && scope.organizationStep === 'resolve')
    if (name === 'submit_profile_review') return !workKind || workKind === 'profile'
    if (name === 'submit_relation_review') return !workKind || workKind === 'relations'
    return true
  }
  const contracts = toolContracts[scope.profile].filter(contract => organization
    ? organizationAllows(contract.name)
    : scope.phase === 'asset_review'
      ? contract.name !== 'commit_asset_changes'
      : !(assetReviewTools as readonly string[]).includes(contract.name) && contract.name !== 'get_character_relation')
    .filter(contract => !relationOnly || contract.kind !== 'write' || (relationTools as readonly string[]).includes(contract.name))
  const allTools: AgentTool[] = contracts.map(contract => ({ name: contract.name, description: contract.description, label: contract.name,
    parameters: modelParameters(contract.name, contract.parameters),
    outputSchema: resultContracts.get(contract.name),
    async execute(toolCallId, parameters, signal) {
      assertScope(scope, repo.bookId); signal?.throwIfAborted(); validate(contract.parameters, parameters)
      if (toolBytes(parameters) > 65536) throw new Error('TOO_LARGE:工具参数超过单次处理上限。')
      const args = structuredClone(parameters) as Row
      if (organization && (contract.name === 'submit_profile_review' || contract.name === 'submit_relation_review')) {
        const { operationKey: _key, ...payload } = args
        // 同一运行、人物工作项和内容使用稳定命令键，恢复或丢失回执后不会重复写库。
        args.operationKey = await hash({ runId: scope.runId, unitId: scope.unitId, tool: contract.name, payload })
      }
      if (scope.probe && !(scope.profile === 'asset_editor' ? ['get_character_detail', 'read_original', 'commit_asset_changes'] : ['get_editor_memory', 'commit_story_changes']).includes(contract.name)) throw new Error('INVALID_ARGS:探针仅允许指定调用。')
      let value: Row
      if (contract.kind === 'write') {
        const ack = await commitCommand(repo, scope, contract.name, toolCallId, args, reads, signal)
        if (ack.complete === true) completedWork = true
        writeCalls++; if (ack.commitId) await options.afterCommit?.(ack)
        value = ack as unknown as Row
      } else {
        const binding = organization && (contract.name === 'query_character_profile' || contract.name === 'query_relation_work')
        value = await repo.transaction(binding, async store => { await checkLease(store, scope, signal); return readTool(store, scope, contract.name, args, contract.maxResults) })
        // 省略编号只影响本次调用的便利写法；读集始终保存实际读取的人物身份。
        if (binding) args[contract.name === 'query_character_profile' ? 'id' : 'characterId'] = text((value.data as Row).id)
        if (toolBytes(value) > 65536) throw new Error('TOO_LARGE:工具结果超过单次返回上限。')
        const output = resultContracts.get(contract.name)
        if (output) validate(output, value, `INVALID_RESULT:${contract.name}返回结构不符合要求。`)
        const fingerprint = await hash(value)
        const query = { tool: contract.name, args: structuredClone(args), resultFingerprint: fingerprint }
        const at = reads.queries.findIndex(read => read.tool === query.tool && canonical(read.args) === canonical(query.args))
        if (at < 0) reads.queries.push(query); else reads.queries[at] = query
        await repo.transaction(true, async store => {
          await checkLease(store, scope, signal)
          const complete = await noteOrganizationRead(store, scope, contract.name, args, value)
          const table = tableOf[contract.name]
          const items = records(value.data)
          if (table) for (const item of items) {
            if (item.fields_omitted) continue
            if (organization && typeof item.charOffset === 'number' && !complete.has(text(item.id))) continue
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
          if (contract.name === 'get_character_relation') {
            const data = value.data as Row
            for (const id of [text(data.fromId), text(data.toId)]) {
              const row = await store.get('characters', id)
              const dependency = { table: 'characters', id, resolvedId: row ? id : null, revision: Number(row?.revision ?? 0), factFingerprint: await store.wait(hash(row ?? null)) }
              const index = reads.records.findIndex(read => read.table === 'characters' && read.id === id)
              if (index < 0) reads.records.push(dependency); else reads.records[index] = dependency
            }
          }
          await saveTask(store, scope, { readSet: reads })
        }); readCalls++
      }
      const output = resultContracts.get(contract.name)
      if (output) validate(output, value, `INVALID_RESULT:${contract.name}返回结构不符合要求。`)
      return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value, structuredContent: value as JsonValue, ...(value.ok === false ? { isError: true } : {}) }
    },
  }))
  const submitTool: AgentTool | undefined = (!organization || !workKind || workKind === 'directory' || workKind === 'candidate') ? { name: 'submit_result', label: '提交任务总结', description: '汇总当前任务的真实提交确认和待处理项。', parameters: summarySchema,
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
          const kind = text(work?.kind)
          if (kind === 'organization') continue
          const changed = records(task.reviewedItems).some(row => row.workItemId === item.workItemId && row.outcome === 'changed')
          if (kind === 'relation') {
            if (!work || !reads.queries.some(query => query.tool === 'get_character_relation' && text((query.args as Row).fromId) === text(work.fromId) && text((query.args as Row).toId) === text(work.toId))) throw new Error('INVALID_ARGS:关系结论须有实际读取本人物对的依据。')
            if (item.outcome === 'changed' && (!actual.length || !changed)) throw new Error('INVALID_ARGS:修改结论缺少该项的真实写入依据。')
            if (item.outcome === 'no_change' && changed) throw new Error('INVALID_ARGS:该项关系已修改，请在总结中如实说明。')
            continue
          }
          if (kind === 'legacy_relation') {
            if (!work || !reads.queries.some(query => query.tool === 'get_legacy_relation_records' && strings((query.args as Row).ids).includes(text(work.id)))) throw new Error('INVALID_ARGS:旧关系结论须实际读取该旧记录原值。')
            if (item.outcome === 'changed' && (!actual.length || !changed)) throw new Error('INVALID_ARGS:修改结论缺少该项的真实写入依据。')
            if (item.outcome === 'no_change' && changed) throw new Error('INVALID_ARGS:该旧关系已提交修改，请在总结中如实说明。')
            continue
          }
          if (kind === 'character_relation_scan') {
            if (!work || !reads.queries.some(query => query.tool === 'get_character_detail' && strings((query.args as Row).ids).includes(text(work.id)))) throw new Error('INVALID_ARGS:人物关系扫描须先读取该人物详情。')
            if (!reads.queries.some(query => query.tool === 'read_original')) throw new Error('INVALID_ARGS:人物关系扫描须实际读取相关原文。')
            if (item.outcome === 'changed' && (!actual.length || !changed)) throw new Error('INVALID_ARGS:修改结论缺少该项的真实写入依据。')
            if (item.outcome === 'no_change' && changed) throw new Error('INVALID_ARGS:该项已提交关系修改，请在总结中如实说明。')
            continue
          }
          const table = ({ character: 'characters', location: 'locations', node: 'nodes', eventLine: 'eventLines', note: 'storyEditorNotes' } as Record<string, string>)[kind]
          if (!work || !reads.records.some(read => read.table === table && (read.id === work.id || read.resolvedId === work.id))) throw new Error('INVALID_ARGS:完成总结须有实际读取依据。')
          if (item.outcome === 'changed' && (!actual.length || !changed)) throw new Error('INVALID_ARGS:修改结论缺少该项的真实写入依据。')
          if (item.outcome === 'no_change' && changed) throw new Error('INVALID_ARGS:该项资料已修改，请在总结中如实说明。')
        }
        await saveTask(store, scope, { reviewedItems: proposed.reviewedItems })
      })
      summary = proposed
      const value = { accepted: true, status: summary.status, commitIds: summary.commitIds }
      return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value, structuredContent: value as JsonValue }
    },
  } : undefined
  const selected = initialToolNames(scope)
  const catalogContracts = scope.probe && selected ? contracts.filter(contract => selected.includes(contract.name)) : contracts
  const catalog = new Map(catalogContracts.map(contract => [contract.name, contract]))
  const initialNames = new Set((selected ?? contracts.map(contract => contract.name)).filter(name => catalog.has(name)))
  if (submitTool && (!selected || selected.includes('submit_result'))) initialNames.add('submit_result')
  const activeNames = new Set(initialNames)
  const discoveryTools: AgentTool[] = [
    { name: 'get_tools', label: '查看可用工具', description: '列出当前任务允许但尚未开放的工具名称和简介；需要参数时再用 get_tools_detail。', parameters: { type: 'object', additionalProperties: false, properties: {} },
      async execute(_id, _parameters, signal) {
        assertScope(scope, repo.bookId); signal?.throwIfAborted()
        const value = { tools: [...catalog.values()].filter(contract => !activeNames.has(contract.name)).map(contract => ({ name: contract.name, description: contract.description, kind: contract.kind, active: false })) }
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value, structuredContent: value as JsonValue }
      } },
    { name: 'get_tools_detail', label: '查看工具详情', description: '传入工具名称，返回完整参数并开放该工具供下一次请求调用。', parameters: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', minLength: 1 } }, required: ['name'] },
      async execute(_id, parameters, signal) {
        assertScope(scope, repo.bookId); signal?.throwIfAborted()
        const name = text((parameters as Row).name)
        const contract = catalog.get(name)
        if (!contract) throw new Error(`INVALID_ARGS:工具不可用：${name || '未指定'}。请先调用 get_tools 查看当前任务可选工具。`)
        activeNames.add(name)
        const value = { name, description: contract.description, kind: contract.kind, parameters: modelParameters(name, contract.parameters), activated: true }
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value, structuredContent: value as unknown as JsonValue }
      } },
  ]
  const currentTools = () => [...allTools.filter(tool => activeNames.has(tool.name)), ...(submitTool && activeNames.has('submit_result') ? [submitTool] : []), ...discoveryTools]
  const activate = (name: string) => { if (!catalog.has(name)) return false; activeNames.add(name); return true }
  const tools = [...allTools, ...(submitTool ? [submitTool] : []), ...discoveryTools]
  return { tools, initialTools: currentTools(), currentTools, activate, reads, get summary() { return summary }, get readCalls() { return readCalls }, get writeCalls() { return writeCalls }, get completed() { return completedWork } }
}
