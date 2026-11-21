import type { TSchema } from 'typebox'

type Operation = TSchema & { properties: Record<string, unknown> & { op: { const: string } } }
type OutlineParameters = TSchema & { properties: { operations: { items: { oneOf: Operation[] } }; reason?: unknown } }

export const outlineOperations = (schema: TSchema) => (schema as OutlineParameters).properties.operations.items.oneOf

/** 模型侧共享字段，执行时仍按各操作分别验证。 */
export const quickOutlineOps = ['attach_nodes', 'detach_nodes']
export function compactOutlineParameters(schema: TSchema, quick = false): TSchema {
  const parameters = (schema as OutlineParameters).properties
  const operations = outlineOperations(schema).filter(rule => quick ? quickOutlineOps.includes(rule.properties.op.const) : !['activate_legacy_line', 'rename_event'].includes(rule.properties.op.const))
  const fields = Object.assign({}, ...operations.map(rule => rule.properties)) as Record<string, unknown>
  delete fields.summary
  delete fields.coreClue
  return { ...schema, properties: { reason: parameters.reason, operations: { ...parameters.operations,
    items: { type: 'object', additionalProperties: false, required: ['op'], properties: { ...fields, op: { enum: operations.map(rule => rule.properties.op.const) } } } } } } as TSchema
}

export const linkingDetailDescription = '按编号读取故事线、事件、节点或待复核事项。事项也可通过当前会话中的 key 读取。长内容可分页。'
