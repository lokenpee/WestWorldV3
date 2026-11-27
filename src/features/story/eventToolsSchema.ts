import type { TSchema } from 'typebox'

export const isEventWorkflow = (mode: string) => ['link_node','review_event','review_boundaries','review_sequence'].includes(mode)
export const linkConfirmDescription = '当前节点已归入事件时提交 {"result":"completed"}；保留未归属时另填 unassigned_reason。'
export const eventDescriptions: Record<string,string> = {
  get_nodes: '按 node_ids 从全书读取指定节点，默认返回名称与详细经过。要核对引文、位置或归属，用 return_fields 指定 quote、source_position 或 event_ids。',
  get_event: '读取最新事件字段和完整成员列表 members，每项含 node_id 与 name。修改成员前核对完整列表。',
  search_prior_nodes: '仅在当前节点之前的详细经过中检索，含已有归属的节点。组内全中，组间任选。默认返回 node_id、summary，可用 return_fields 指定字段。最多返回最近 20 项。',
  search_nodes: '按详细经过字面匹配，组内全部满足、组间任一满足。区间不含端点。可搜全书。默认返回 node_id、name、summary，可用 return_fields 选择字段。最多 100 项；truncated 为 true 时缩小条件。',
  search_events: '按事件名称与概况字面匹配，组内全部满足、组间任一满足。最多返回100项。',
  edit_events: '整批保存事件。每项写明理由，可附证据节点。nodeIds 与 clues 均整组替换。首轮展开事件的完整成员可从时间表按 event_ids 取得。仅在目录中或版本已变化时，先读取最新完整成员。新建由程序分配编号，删除可附已有替代事件编号。',
  confirm: '当前事件已完成提交 completed。仅在连带确认其他事件时传 reviewed_event_ids，首轮已展开且版本仍有效的事件可直接确认，其余须先用 get_event 读全。待核实提交 pending_review 和非空 pending_issues，每项填写 issue、checked_scope、reason。',
}
const str = () => ({ type: 'string', minLength: 1 })
const list = (items: object, minItems = 1) => ({ type: 'array', minItems, items })
const ids = { ...list(str()), uniqueItems: true }
const obj = (properties: Record<string,object>, required = Object.keys(properties)) => ({
  type: 'object', additionalProperties: false, properties, required,
})
const groups = list(list(str()))
const options = (...values: string[]) => ({type: 'string', enum: values})
const nullableId = {anyOf:[str(),{type:'null'}]}
const nodeReturnFields = list(options('name','summary','detail','quote','source_position','event_ids'),0)
const fields = {
  name: str(), overview: str(), latest_progress: str(), unresolved: {type:'string'},
  clues: list(str(),0), status: options('进行中','暂时搁置','已闭环'), nodeIds: ids,
}
const shared = {reason: str(), evidence_node_ids: ids}
const editOperations = [
  obj({op:{const:'create'}, fields:obj(fields), ...shared}, ['op','fields','reason']),
  obj({op:{const:'update'}, event_id:str(), fields:{...obj(fields,[]),minProperties:1}, ...shared}, ['op','event_id','fields','reason']),
  obj({op:{const:'delete'}, event_id:str(), replacement_event_ids:ids, ...shared}, ['op','event_id','reason']),
]
export function eventToolsSchema(mode: string): Record<string, TSchema> {
  const review = mode !== 'link_node'
  const micro = mode==='review_sequence'
  const grouped = mode==='review_boundaries'
  const issues=list(obj({issue:str(),checked_scope:str(),reason:str()}))
  const completed=obj({result:{const:'completed'},...(grouped ? {reason:str()} : {})},['result'])
  const pending=obj({result:{const:'pending_review'},pending_issues:issues})
  const redirect=obj({result:{const:'return_to_macro'},event_ids:ids,evidence_node_ids:ids,reason:str()})
  return {
    get_nodes: obj({node_ids:ids, return_fields:nodeReturnFields}, ['node_ids']), get_event: obj({event_id:str()}),
    search_events: obj({groups, return_fields:list(options('name','overview','latest_progress','unresolved'),0)}, ['groups']),
    ...(review ? {
      search_nodes: obj({groups, after_node_id:nullableId, before_node_id:nullableId, exclude_event_id:nullableId,
        return_fields:list(options('name','summary','detail','event_ids','source_position'),0)}, ['groups']),
    } : {search_prior_nodes:obj({groups,return_fields:nodeReturnFields},['groups'])}),
    edit_events: obj({changes:list({oneOf:micro ? [editOperations[1]] : review ? editOperations : editOperations.slice(0,2)})}),
    confirm: micro || grouped ? {
      ...obj({result:micro ? options('completed','pending_review','return_to_macro') : options('completed','pending_review'),
        pending_issues:issues,reason:str(),...(micro && {event_ids:ids,evidence_node_ids:ids})},['result']),
      oneOf:micro ? [completed,pending,redirect] : [completed,pending],
    } : review
      ? {
          ...obj({result:options('completed','pending_review'), reviewed_event_ids:ids,
            pending_issues:list(obj({issue:str(),checked_scope:str(),reason:str()}))}, ['result']),
          oneOf: [
            {properties:{result:{const:'completed'}}, not:{required:['pending_issues']}},
            {properties:{result:{const:'pending_review'}}, required:['pending_issues'], not:{required:['reviewed_event_ids']}},
          ],
        }
      : obj({result:options('completed'), unassigned_reason:str()}, ['result']),
  } as unknown as Record<string, TSchema>
}
