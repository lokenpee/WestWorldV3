import type { TSchema } from 'typebox'
import { Value } from 'typebox/value'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { Fact } from '../assets/types'
import { estimateTextTokens } from '../agents/context'
import { withOutputDiscipline } from '../agents/output-discipline'
import type { OptimizationDraft, QualityReview } from './types'

export function qualityRequest(draft: OptimizationDraft, facts: Fact[]) {
  const prompt = withOutputDiscipline('你是独立的世界资产档案复核员。逐项比较原始事实、此前资料与整编稿，检查独有信息遗漏、同义重复、真实分歧被抹平、无依据新增、错误别名及多人合称。事实编号齐全不等于含义保留。时间变化应带条件保留，近义措辞应合为一项。只判断本稿，不修改事实或原文。发现问题时给出具体字段、事实编号和说明，approved=false；没有问题时approved=true且issues为空。使用submit_result提交。')
  const ids = facts.map((_, index) => `F${index + 1}`)
  const schema = { type: 'object', additionalProperties: false, required: ['approved', 'summary', 'issues'], properties: {
    approved: { type: 'boolean' }, summary: { type: 'string', minLength: 1 },
    issues: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind', 'field', 'factIds', 'message'], properties: {
      kind: { type: 'string', enum: ['omission', 'duplicate', 'contradiction', 'unsupported', 'alias_error', 'composite_entity'] },
      field: { type: 'string', enum: [...Object.keys(draft.before), 'name', 'aliases'] }, factIds: { type: 'array', uniqueItems: true, items: { type: 'string', enum: ids } }, message: { type: 'string', minLength: 1 },
    } } },
  } } as unknown as TSchema
  const input = { stage: 'P2', phase: 'quality_review', kind: draft.kind, name: draft.name, before: draft.before, beforeAliases: draft.beforeAliases, proposedName: draft.proposedName, afterAliases: draft.afterAliases, after: draft.after, notes: draft.notes, facts: facts.map((fact, index) => ({ ...fact, id: ids[index] })) }
  const validate = (message: AssistantMessage): QualityReview => {
    const calls = message.content.filter(part => part.type === 'toolCall')
    if (calls.length !== 1 || calls[0].name !== 'submit_result' || !Value.Check(schema, calls[0].arguments)) throw new Error('复核须提交完整的判断与具体问题。')
    const review = calls[0].arguments as unknown as QualityReview
    if (review.approved !== (review.issues.length === 0) || !review.summary.trim() || review.issues.some(issue => !issue.message.trim())) throw new Error('复核结论与问题清单须一致。')
    return { ...review, issues: review.issues.map(issue => ({ ...issue, factIds: issue.factIds.map(id => facts[ids.indexOf(id)].id) })) }
  }
  return { prompt, input, schema, validate, estimatedTokens: estimateTextTokens(prompt + JSON.stringify(input) + JSON.stringify(schema)) + 128, estimatedOutputTokens: 2048 }
}
