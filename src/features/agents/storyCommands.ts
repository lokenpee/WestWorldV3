import type { AgentStore, Row } from './repository'
import { canonical, records, strings, text } from './contracts'
import type { Scope } from './queries'
import { lineSummary } from '../story/views'

export const storyWriteTools = ['save_story_lines', 'save_story_notes', 'add_story_nodes', 'save_story_outline'] as const
export const storyToolNames = ['search_story_context', 'get_story_detail', ...storyWriteTools.filter(name => name !== 'add_story_nodes'), 'finish_story_batch']
export const readingToolNames = storyToolNames.filter(name => name !== 'save_story_outline')
export const outlineToolNames = readingToolNames.map(name => name === 'save_story_lines' ? 'save_story_outline' : name)
export const isStoryWrite = (name: string) => (storyWriteTools as readonly string[]).includes(name)

/** 用事务内实际前后值记录资料修改，供详情与备份读取。 */
export async function storyAssetEdits(store: AgentStore, before: Map<string, Row>, name: string, args: Row, result: Row, commitId: string, timestamp: string): Promise<Row[]> {
  const edits: Row[] = []
  const ignored = new Set(['id', 'bookId', 'revision', 'updatedAt', 'createdBy', 'order', 'offset'])
  const tables = [['nodes', 'node'], ['eventLines', 'eventLine'], ...(name === 'save_story_outline' ? [['storyEvents', 'event']] : [])]
  for (const [table, kind] of tables) {
    const current = new Map((await store.rows(table)).map(row => [text(row.id), row]))
    const ids = new Set([...current.keys(), ...[...before.keys()].filter(key => key.startsWith(`${table}:`)).map(key => key.slice(table.length + 1))])
    for (const id of ids) {
      const old = before.get(`${table}:${id}`), next = current.get(id)
      const fieldChanges = [...new Set([...Object.keys(old ?? {}), ...Object.keys(next ?? {})])].filter(field => !ignored.has(field) && canonical(old?.[field]) !== canonical(next?.[field])).map(field => ({ field, before: old?.[field] ?? null, after: next?.[field] ?? null }))
      if (!fieldChanges.length) continue
      const operation = records(args.operations).find((op, index) => op.lineId === id || strings(op.mergeLineIds).includes(id) || strings(result.lineIds)[index] === id)
      edits.push({ commitId, tool: name, kind, id, fieldChanges, reason: text(operation?.reason) || text(args.reason) || (name === 'add_story_nodes' ? '根据已查阅原文补充事件。' : records(args.operations).map(op => text(op.reason)).filter(Boolean).join('；')), evidence: [], timestamp, actor: 'agent' })
    }
  }
  return edits
}

/** 在保存事务中补齐旧命令结构；省略字段使用当时已通过版本检查的旧值。 */
export async function storyPayload(store: AgentStore, scope: Scope, name: string, args: Row): Promise<Row> {
  if (name === 'add_story_nodes') return { new_nodes: records(args.nodes).map((node, index) => ({ ...node, quote: node.quote ?? '', client_id: `new:${index}` })), event_line_ops: [] }
  if (name === 'save_story_notes') {
    if (!records(args.notes).length && args.workingSummary === undefined) throw new Error('INVALID_ARGS:请提供线索或工作摘要。')
    const saved = await store.rows('storyEditorNotes')
    const notes: Row[] = records(args.notes).map(note => {
      const old = saved.find(row => row.sessionId === scope.sessionId && row.key === note.key)
      return { ...note, kind: note.kind ?? old?.kind ?? 'review', nodeIds: note.nodeIds ?? old?.nodeIds ?? [], lineIds: note.lineIds ?? old?.lineIds ?? [], ...(note.eventIds || old?.eventIds ? { eventIds: note.eventIds ?? old?.eventIds } : {}), evidence: note.evidence ?? old?.evidence ?? [] }
    })
    if (new Set(notes.map(note => note.key)).size !== notes.length) throw new Error('INVALID_ARGS:同一批线索的key须唯一。')
    return { event_line_ops: [], new_nodes: [], memory_update: { ...(args.workingSummary === undefined ? {} : { workingSummary: args.workingSummary }), notes } }
  }
  const ops: Row[] = []
  const targets = new Set<string>()
  for (const op of records(args.operations)) {
    const action = text(op.action), id = text(op.lineId)
    for (const target of [id, ...strings(op.mergeLineIds)].filter(Boolean)) {
      if (targets.has(target)) throw new Error('INVALID_ARGS:同一批中每条事件线只处理一次，请合并修改。')
      targets.add(target)
    }
    const old = id ? await store.get('eventLines', id) : undefined
    if (id && (!old || old.bookId !== scope.bookId)) throw new Error('SCOPE:事件线不存在或不属于当前书籍。')
    if (scope.workflow === 'story_pages_v3') {
      if (action === 'create' && (!text(op.title).trim() || !strings(op.nodeIds).length || typeof op.summary !== 'string')) throw new Error('INVALID_ARGS:新建请填写名称、节点和概述。')
      if (action !== 'create' && !id || action === 'append' && !strings(op.nodeIds).length || action === 'merge' && !strings(op.mergeLineIds).length) throw new Error('INVALID_ARGS:请填写目标事件线及本次节点或合并对象。')
    }
    if (action === 'update' && !['nodeIds', 'title', 'summary', 'lineStatus'].some(key => op[key] !== undefined)) throw new Error('INVALID_ARGS:请提供要调整的成员或内容。')
    const merging = action === 'merge' ? await Promise.all(strings(op.mergeLineIds).map(id => store.get('eventLines', id))) : []
    ops.push({ op: action, ...(id ? { line_id: id } : {}), ...(action === 'merge' ? { keep_line_id: id, merge_line_ids: op.mergeLineIds } : {}),
      ...(op.summary !== undefined ? { summary: op.summary } : action === 'merge' && [old, ...merging].some(row => row?.summary !== undefined) ? { summary: [...new Set([old, ...merging].filter((row): row is Row => !!row).map(lineSummary).filter(Boolean))].join('\n\n') } : old?.summary === undefined ? {} : { summary: old.summary }),
      ...(op.title === undefined ? {} : { title: op.title }), node_ids: op.nodeIds ?? old?.nodeIds,
      line_status: scope.workflow === 'story_pages_v3' ? old?.lineStatus ?? 'open' : op.lineStatus ?? ([old, ...merging].some(row => row?.lineStatus === 'open') ? 'open' : old?.lineStatus) ?? 'open',
      confidence: op.confidence, reason: op.reason, evidenceNodeIds: op.evidenceNodeIds })
  }
  return { event_line_ops: ops, new_nodes: [] }
}
